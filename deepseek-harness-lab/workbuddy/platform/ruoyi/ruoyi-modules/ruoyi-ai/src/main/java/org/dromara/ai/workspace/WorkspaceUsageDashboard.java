package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Aggregates employee Core relay events without exposing prompts or raw audit metadata. */
@Component
@RequiredArgsConstructor
public class WorkspaceUsageDashboard {
    private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");
    private static final String SOURCE = "CORE_MODEL_RELAY";
    /** The response intentionally caps the ranked user table; summary and daily totals remain uncapped. */
    private static final int USER_LIMIT = 100;

    private static final String CALLS = """
        WITH params AS (
            SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date AS to_day,
                   (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
                       - (CAST(? AS integer) - 1) AS from_day
        ), starts AS (
            SELECT DISTINCT ON (event.actor_user_id, event.metadata->>'callId')
                   event.actor_user_id AS user_id,
                   event.metadata->>'callId' AS call_id,
                   event.metadata->>'costStatus' AS cost_status,
                   event.created_at AS started_at,
                   (event.created_at AT TIME ZONE 'Asia/Shanghai')::date AS day
            FROM ai_security_event event CROSS JOIN params
            WHERE event.action = 'model.relay.started'
              AND event.metadata->>'callId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              AND event.created_at >= (params.from_day::timestamp AT TIME ZONE 'Asia/Shanghai')
              AND event.created_at < ((params.to_day + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')
            ORDER BY event.actor_user_id, event.metadata->>'callId', event.created_at, event.id
        ), finishes AS (
            SELECT DISTINCT ON (event.actor_user_id, event.metadata->>'callId')
                   event.actor_user_id AS user_id,
                   event.metadata->>'callId' AS call_id,
                   event.metadata->>'status' AS status,
                   event.metadata->>'costStatus' AS cost_status,
                   event.metadata->>'usageReported' = 'true' AS usage_reported,
                   CASE WHEN event.metadata->>'inputTokens' ~ '^[0-9]{1,18}$'
                        THEN (event.metadata->>'inputTokens')::bigint END AS input_tokens,
                   CASE WHEN event.metadata->>'outputTokens' ~ '^[0-9]{1,18}$'
                        THEN (event.metadata->>'outputTokens')::bigint END AS output_tokens
            FROM ai_security_event event
            JOIN starts ON starts.user_id = event.actor_user_id
                       AND starts.call_id = event.metadata->>'callId'
                       AND event.created_at >= starts.started_at
            WHERE event.action = 'model.relay.finished'
              AND event.metadata->>'status' IN ('COMPLETED', 'FAILED', 'CANCELLED')
              AND event.created_at <= CURRENT_TIMESTAMP
            ORDER BY event.actor_user_id, event.metadata->>'callId', event.created_at DESC, event.id DESC
        ), calls AS (
            SELECT starts.user_id, starts.call_id, starts.started_at, starts.day,
                   finishes.status, finishes.usage_reported,
                   finishes.input_tokens, finishes.output_tokens,
                   COALESCE(finishes.usage_reported, false)
                       AND finishes.input_tokens IS NOT NULL
                       AND finishes.output_tokens IS NOT NULL AS tokens_known,
                   COALESCE(finishes.cost_status, starts.cost_status) AS cost_status,
                   CASE WHEN finishes.call_id IS NOT NULL THEN finishes.status
                        WHEN starts.started_at > CURRENT_TIMESTAMP - INTERVAL '10 minutes' THEN 'INFLIGHT'
                        ELSE 'INCOMPLETE' END AS effective_status
            FROM starts LEFT JOIN finishes
              ON finishes.user_id = starts.user_id AND finishes.call_id = starts.call_id
        )
        """;

    private final JdbcTemplate jdbc;

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Dashboard load(int days) {
        if (days < 1 || days > 90) throw new WorkspaceDenied(400, "InvalidPeriod");
        LocalDate to = LocalDate.now(ZONE);
        LocalDate from = to.minusDays(days - 1L);

        Summary summary = jdbc.queryForObject(CALLS + """
            SELECT (SELECT count(*) FROM sys_user WHERE status='0' AND del_flag='0') AS enabled_users,
                   count(DISTINCT user_id) AS active_users,
                   count(*) AS requests,
                   count(*) FILTER (WHERE effective_status='COMPLETED') AS completed,
                   count(*) FILTER (WHERE effective_status='FAILED') AS failed,
                   count(*) FILTER (WHERE effective_status='CANCELLED') AS cancelled,
                   count(*) FILTER (WHERE effective_status='INFLIGHT') AS inflight,
                   count(*) FILTER (WHERE effective_status='INCOMPLETE') AS incomplete,
                   count(*) FILTER (WHERE tokens_known) AS reported_requests,
                   count(*) FILTER (WHERE NOT tokens_known) AS unknown_token_requests,
                   COALESCE(sum(input_tokens) FILTER (WHERE tokens_known), 0) AS input_tokens,
                   COALESCE(sum(output_tokens) FILTER (WHERE tokens_known), 0) AS output_tokens,
                   count(*) FILTER (WHERE cost_status IS NULL OR cost_status='UNKNOWN') AS unknown_cost_requests
            FROM calls
            """, this::summary, days);

        Map<LocalDate, Daily> populatedDays = new LinkedHashMap<>();
        jdbc.query(CALLS + """
            SELECT day, count(*) AS requests,
                   count(*) FILTER (WHERE effective_status='COMPLETED') AS completed,
                   count(*) FILTER (WHERE effective_status='FAILED') AS failed,
                   count(*) FILTER (WHERE effective_status='CANCELLED') AS cancelled,
                   COALESCE(sum(input_tokens) FILTER (WHERE tokens_known), 0) AS input_tokens,
                   COALESCE(sum(output_tokens) FILTER (WHERE tokens_known), 0) AS output_tokens
            FROM calls GROUP BY day ORDER BY day
            """, rs -> {
                LocalDate day = rs.getObject("day", LocalDate.class);
                populatedDays.put(day, daily(rs, day));
            }, days);
        List<Daily> daily = new ArrayList<>(days);
        for (LocalDate day = from; !day.isAfter(to); day = day.plusDays(1)) {
            daily.add(populatedDays.getOrDefault(day, new Daily(day.toString(), 0, 0, 0, 0, 0, 0)));
        }

        List<UserUsage> users = jdbc.query(CALLS + """
            SELECT calls.user_id::text AS user_id, users.nick_name,
                   count(*) AS requests,
                   count(*) FILTER (WHERE effective_status='COMPLETED') AS completed,
                   count(*) FILTER (WHERE effective_status='FAILED') AS failed,
                   count(*) FILTER (WHERE effective_status='CANCELLED') AS cancelled,
                   COALESCE(sum(input_tokens) FILTER (WHERE tokens_known), 0) AS input_tokens,
                   COALESCE(sum(output_tokens) FILTER (WHERE tokens_known), 0) AS output_tokens,
                   count(*) FILTER (WHERE NOT tokens_known) AS unknown_token_requests,
                   max(started_at) AS last_used_at
            FROM calls JOIN sys_user users ON users.user_id = calls.user_id
            GROUP BY calls.user_id, users.nick_name
            ORDER BY requests DESC, last_used_at DESC, calls.user_id
            LIMIT ?
            """, this::user, days, USER_LIMIT);
        return new Dashboard(new Period(from.toString(), to.toString(), ZONE.getId()), SOURCE,
            summary, daily, users);
    }

    private Summary summary(ResultSet rs, int row) throws SQLException {
        return new Summary(number(rs, "enabled_users"), number(rs, "active_users"),
            number(rs, "requests"), number(rs, "completed"), number(rs, "failed"),
            number(rs, "cancelled"), number(rs, "inflight"), number(rs, "incomplete"),
            number(rs, "reported_requests"), number(rs, "unknown_token_requests"),
            number(rs, "input_tokens"), number(rs, "output_tokens"),
            number(rs, "unknown_cost_requests"));
    }

    private Daily daily(ResultSet rs, LocalDate day) throws SQLException {
        return new Daily(day.toString(), number(rs, "requests"), number(rs, "completed"),
            number(rs, "failed"), number(rs, "cancelled"), number(rs, "input_tokens"),
            number(rs, "output_tokens"));
    }

    private UserUsage user(ResultSet rs, int row) throws SQLException {
        return new UserUsage(rs.getString("user_id"), rs.getString("nick_name"),
            number(rs, "requests"), number(rs, "completed"), number(rs, "failed"),
            number(rs, "cancelled"), number(rs, "input_tokens"), number(rs, "output_tokens"),
            number(rs, "unknown_token_requests"), rs.getTimestamp("last_used_at").toInstant().toString());
    }

    private long number(ResultSet rs, String column) throws SQLException {
        Number value = (Number) rs.getObject(column);
        return value == null ? 0L : value.longValue();
    }

    public record Dashboard(Period period, String source, Summary summary,
                            List<Daily> daily, List<UserUsage> users) { }
    public record Period(String from, String to, String timezone) { }
    public record Summary(long enabledUsers, long activeUsers, long requests, long completed,
                          long failed, long cancelled, long inflight, long incomplete,
                          long reportedRequests, long unknownTokenRequests, long inputTokens,
                          long outputTokens, long unknownCostRequests) { }
    public record Daily(String day, long requests, long completed, long failed, long cancelled,
                        long inputTokens, long outputTokens) { }
    public record UserUsage(String userId, String nickName, long requests, long completed,
                            long failed, long cancelled, long inputTokens, long outputTokens,
                            long unknownTokenRequests, String lastUsedAt) { }
}

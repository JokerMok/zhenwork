package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** Aggregates employee Core relay events without exposing prompts or raw audit metadata. */
@Component
@RequiredArgsConstructor
public class WorkspaceUsageDashboard {
    private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");
    private static final String SOURCE = "CORE_MODEL_RELAY";
    /** The response intentionally caps the ranked user table; summary and daily totals remain uncapped. */
    private static final int USER_LIMIT = 100;

    /** Materialize the bounded event set before pairing starts and finishes. */
    private static final String CALLS = """
        WITH params AS (
            SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
                       - (CAST(? AS integer) - 1) AS from_day
        ), events AS MATERIALIZED (
            SELECT event.id, event.actor_user_id AS user_id,
                   event.metadata->>'callId' AS call_id, event.action,
                   event.metadata->>'status' AS status,
                   event.metadata->>'costStatus' AS cost_status,
                   event.metadata->>'usageReported' = 'true' AS usage_reported,
                   CASE WHEN event.metadata->>'inputTokens' ~ '^[0-9]{1,18}$'
                        THEN (event.metadata->>'inputTokens')::bigint END AS input_tokens,
                   CASE WHEN event.metadata->>'outputTokens' ~ '^[0-9]{1,18}$'
                        THEN (event.metadata->>'outputTokens')::bigint END AS output_tokens,
                   event.created_at
            FROM ai_security_event event CROSS JOIN params
            WHERE event.action IN ('model.relay.started', 'model.relay.finished')
              AND event.metadata->>'callId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              AND event.created_at >= (params.from_day::timestamp AT TIME ZONE 'Asia/Shanghai')
              AND event.created_at <= CURRENT_TIMESTAMP
        ), starts AS MATERIALIZED (
            SELECT DISTINCT ON (event.user_id, event.call_id)
                   event.user_id, event.call_id, event.cost_status,
                   event.created_at AS started_at,
                   (event.created_at AT TIME ZONE 'Asia/Shanghai')::date AS day
            FROM events event
            WHERE event.action = 'model.relay.started'
            ORDER BY event.user_id, event.call_id, event.created_at, event.id
        ), finishes AS MATERIALIZED (
            SELECT DISTINCT ON (event.user_id, event.call_id)
                   event.user_id, event.call_id, event.status, event.cost_status,
                   event.usage_reported, event.input_tokens, event.output_tokens
            FROM events event
            WHERE event.action = 'model.relay.finished'
              AND event.status IN ('COMPLETED', 'FAILED', 'CANCELLED')
            ORDER BY event.user_id, event.call_id, event.created_at DESC, event.id DESC
        )
        SELECT starts.user_id::text AS user_id, COALESCE(users.nick_name, '已删除用户') AS nick_name,
               starts.started_at, starts.day,
               CASE WHEN finishes.call_id IS NOT NULL THEN finishes.status
                    WHEN starts.started_at > CURRENT_TIMESTAMP - INTERVAL '10 minutes' THEN 'INFLIGHT'
                    ELSE 'INCOMPLETE' END AS effective_status,
               COALESCE(finishes.usage_reported, false)
                   AND finishes.input_tokens IS NOT NULL
                   AND finishes.output_tokens IS NOT NULL AS tokens_known,
               COALESCE(finishes.input_tokens, 0) AS input_tokens,
               COALESCE(finishes.output_tokens, 0) AS output_tokens,
               COALESCE(finishes.cost_status, starts.cost_status) AS cost_status
        FROM starts
        LEFT JOIN sys_user users ON users.user_id = starts.user_id
        LEFT JOIN finishes ON finishes.user_id = starts.user_id AND finishes.call_id = starts.call_id
        ORDER BY starts.started_at, starts.user_id, starts.call_id
        """;

    private final JdbcTemplate jdbc;

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Dashboard load(int days) {
        if (days < 1 || days > 90) throw new WorkspaceDenied(400, "InvalidPeriod");
        LocalDate to = LocalDate.now(ZONE);
        LocalDate from = to.minusDays(days - 1L);

        jdbc.execute("SET LOCAL statement_timeout = '10s'");
        long enabledUsers = Objects.requireNonNull(jdbc.queryForObject(
            "SELECT count(*) FROM sys_user WHERE status='0' AND del_flag='0'", Long.class));
        List<Call> calls = jdbc.query(CALLS, this::call, days);
        Set<String> activeUsers = new HashSet<>();
        Counts total = new Counts();
        Map<LocalDate, Counts> populatedDays = new HashMap<>();
        Map<String, UserCounts> populatedUsers = new HashMap<>();
        long reportedRequests = 0, unknownTokenRequests = 0, unknownCostRequests = 0;
        for (Call call : calls) {
            activeUsers.add(call.userId());
            total.add(call);
            populatedDays.computeIfAbsent(call.day(), ignored -> new Counts()).add(call);
            populatedUsers.computeIfAbsent(call.userId(), ignored ->
                new UserCounts(call.userId(), call.nickName())).add(call);
            if (call.tokensKnown()) reportedRequests++;
            else unknownTokenRequests++;
            if (call.costStatus() == null || "UNKNOWN".equals(call.costStatus())) unknownCostRequests++;
        }
        Summary summary = new Summary(enabledUsers, activeUsers.size(), total.requests, total.completed,
            total.failed, total.cancelled, total.inflight, total.incomplete, reportedRequests,
            unknownTokenRequests, total.inputTokens, total.outputTokens, unknownCostRequests);

        List<Daily> daily = new ArrayList<>(days);
        for (LocalDate day = from; !day.isAfter(to); day = day.plusDays(1)) {
            Counts counts = populatedDays.getOrDefault(day, new Counts());
            daily.add(new Daily(day.toString(), counts.requests, counts.completed, counts.failed,
                counts.cancelled, counts.inputTokens, counts.outputTokens));
        }
        List<UserUsage> users = populatedUsers.values().stream()
            .sorted(Comparator.comparingLong((UserCounts value) -> value.counts.requests).reversed()
                .thenComparing((UserCounts value) -> value.lastUsedAt, Comparator.reverseOrder())
                .thenComparing(value -> value.userId))
            .limit(USER_LIMIT).map(UserCounts::toUsage).toList();
        return new Dashboard(new Period(from.toString(), to.toString(), ZONE.getId()), SOURCE,
            summary, daily, users);
    }

    private Call call(ResultSet rs, int row) throws SQLException {
        return new Call(rs.getString("user_id"), rs.getString("nick_name"),
            rs.getObject("day", LocalDate.class), rs.getTimestamp("started_at").toInstant(),
            rs.getString("effective_status"), rs.getBoolean("tokens_known"),
            number(rs, "input_tokens"), number(rs, "output_tokens"), rs.getString("cost_status"));
    }

    private long number(ResultSet rs, String column) throws SQLException {
        Number value = (Number) rs.getObject(column);
        return value == null ? 0L : value.longValue();
    }

    private static class Counts {
        long requests, completed, failed, cancelled, inflight, incomplete, inputTokens, outputTokens;
        void add(Call call) {
            requests++;
            switch (call.status()) {
                case "COMPLETED" -> completed++;
                case "FAILED" -> failed++;
                case "CANCELLED" -> cancelled++;
                case "INFLIGHT" -> inflight++;
                default -> incomplete++;
            }
            if (call.tokensKnown()) {
                inputTokens += call.inputTokens();
                outputTokens += call.outputTokens();
            }
        }
    }

    private static final class UserCounts {
        final String userId, nickName;
        final Counts counts = new Counts();
        long unknownTokenRequests;
        Instant lastUsedAt = Instant.EPOCH;
        UserCounts(String userId, String nickName) { this.userId = userId; this.nickName = nickName; }
        void add(Call call) {
            counts.add(call);
            if (!call.tokensKnown()) unknownTokenRequests++;
            if (call.startedAt().isAfter(lastUsedAt)) lastUsedAt = call.startedAt();
        }
        UserUsage toUsage() {
            return new UserUsage(userId, nickName, counts.requests, counts.completed, counts.failed,
                counts.cancelled, counts.inputTokens, counts.outputTokens, unknownTokenRequests,
                lastUsedAt.toString());
        }
    }

    public record Dashboard(Period period, String source, Summary summary,
                            List<Daily> daily, List<UserUsage> users) { }
    private record Call(String userId, String nickName, LocalDate day, Instant startedAt,
                        String status, boolean tokensKnown, long inputTokens, long outputTokens,
                        String costStatus) { }
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

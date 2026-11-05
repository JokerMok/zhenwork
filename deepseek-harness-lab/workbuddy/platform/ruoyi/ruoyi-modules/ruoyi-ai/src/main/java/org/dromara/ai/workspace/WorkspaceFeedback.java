package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/** Links employee feedback to control-authoritative execution metadata without copying task content. */
@Service
@RequiredArgsConstructor
public class WorkspaceFeedback {
    private static final Set<String> CATEGORIES = Set.of(
        "correct", "data_calculation", "citation", "tool", "artifact", "other");
    private static final Set<String> STATUSES = Set.of("NEW", "IN_PROGRESS", "RESOLVED", "CLOSED");
    private static final Set<String> TASK_STATES = Set.of("completed", "partial");
    private static final Pattern TASK_ID = Pattern.compile("[A-Za-z0-9_-]{1,100}");
    private static final Pattern SENSITIVE = Pattern.compile(
        "(?i)(?:authorization|password|api[_-]?key|access[_-]?token|cookie|secret)\\s*[:=]|Bearer\\s+[A-Za-z0-9._-]{12,}|sk-[A-Za-z0-9]{12,}");

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final AiResourceGuard resources;
    private final WorkspaceModelAccess models;
    private final WorkspaceSkills skills;
    private final WorkspaceMcpAccess mcps;
    private final WorkspaceToolAccess tools;

    public record Create(
        String taskId,
        UUID attemptId,
        String category,
        String note,
        String actualTaskState,
        List<String> actualTools,
        List<UUID> artifactVersionIds
    ) {}
    public record Capture(String taskId, UUID attemptId, UUID assistantId) {}
    public record Update(
        String status,
        String badcaseDescription,
        String rootCause,
        String causeEvidence,
        String expectedResult,
        String resolution,
        Integer expectedVersion
    ) {}
    public record Recheck(
        String checkDescription,
        String expectedResult,
        String actualResult,
        String evidence,
        String result
    ) {}

    public Map<String, Object> capture(long user, Capture input) {
        requireTask(input.taskId());
        if (input.attemptId() == null || input.assistantId() == null)
            throw new WorkspaceDenied(400, "InvalidFeedbackProvenance");
        var assistant = resources.require(input.assistantId(), user, AiResourceGuard.Action.USE);
        if (!"ASSISTANT".equals(assistant.get("resource_type")))
            throw new WorkspaceDenied(400, "AssistantRequired");
        int assistantVersion = ((Number) assistant.get("published_version")).intValue();
        var config = JsonUtils.parseMap(resources.version(
            input.assistantId(), assistantVersion, user, AiResourceGuard.Action.USE).get("config").toString());
        UUID modelId = uuid(config.get("modelId"), "InvalidAssistantModel");
        var model = models.model(user, modelId);
        List<Map<String, Object>> resolvedSkills = skills.resolve(config.get("skillIds"), user);
        List<Map<String, Object>> resolvedMcps = mcps.resolve(config.get("mcpIds"), user);
        List<Map<String, Object>> resolvedTools = tools.resolve(config.get("toolIds"), resolvedSkills, user);
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO ai_task_feedback_provenance(
              id,owner_user_id,task_id,attempt_id,assistant_id,assistant_version,
              model_id,model_version,provider_id,provider_version,skills,mcps,tools)
            VALUES(?,?,?,?,?,?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb)
            ON CONFLICT(owner_user_id,task_id,attempt_id) DO NOTHING
            """,
            id, user, input.taskId(), input.attemptId(), input.assistantId(), assistantVersion,
            modelId, number(model, "model_version"), model.get("provider_id"), number(model, "provider_version"),
            JsonUtils.toJsonString(project(resolvedSkills, "id", "name", "version")),
            JsonUtils.toJsonString(project(resolvedMcps,
                "id", "version", "connectionId", "connectionAuthVersion", "allowedTools")),
            JsonUtils.toJsonString(project(resolvedTools, "id", "version", "type", "typeVersion")));
        UUID stored = jdbc.queryForObject("""
            SELECT id FROM ai_task_feedback_provenance
            WHERE owner_user_id=? AND task_id=? AND attempt_id=?
            """, UUID.class, user, input.taskId(), input.attemptId());
        return Map.of("captured", true, "id", stored.toString());
    }

    public Map<String, Object> create(long user, Create input) {
        requireTask(input.taskId());
        if (input.attemptId() == null || !CATEGORIES.contains(Objects.toString(input.category(), ""))
            || !TASK_STATES.contains(Objects.toString(input.actualTaskState(), "")))
            throw new WorkspaceDenied(400, "InvalidFeedback");
        String normalizedNote = optional(input.note(), 500, "InvalidFeedbackNote");
        String note = normalizedNote == null ? "" : normalizedNote;
        List<String> actualTools = toolNames(input.actualTools());
        List<UUID> artifactVersions = artifactVersions(input.artifactVersionIds());
        return tx.execute(status -> {
            var old = jdbc.queryForList("""
                SELECT * FROM ai_feedback
                WHERE owner_user_id=? AND task_id=? AND attempt_id=? FOR UPDATE
                """, user, input.taskId(), input.attemptId());
            if (!old.isEmpty()) {
                var row = old.getFirst();
                if (!Objects.equals(row.get("category"), input.category()) || !Objects.equals(row.get("note"), note)
                    || !Objects.equals(row.get("actual_task_state"), input.actualTaskState())
                    || !jsonListEquals(row.get("actual_tools"), actualTools, String.class)
                    || !jsonListEquals(row.get("artifact_version_ids"), artifactVersions.stream().map(UUID::toString).toList(), String.class))
                    throw new WorkspaceDenied(409, "FeedbackAlreadySubmitted");
                return employeeDto(row);
            }
            UUID id = UUID.randomUUID();
            jdbc.update("""
                INSERT INTO ai_feedback(id,owner_user_id,task_id,attempt_id,provenance_id,category,note,
                  actual_task_state,actual_tools,artifact_version_ids)
                VALUES(?,?,?,?,(SELECT id FROM ai_task_feedback_provenance
                  WHERE owner_user_id=? AND task_id=? AND attempt_id=?),?,?,?,?::jsonb,?::jsonb)
                """, id, user, input.taskId(), input.attemptId(), user, input.taskId(), input.attemptId(),
                input.category(), note, input.actualTaskState(), JsonUtils.toJsonString(actualTools),
                JsonUtils.toJsonString(artifactVersions.stream().map(UUID::toString).toList()));
            audit(user, "feedback.created", id, Map.of(
                "taskId", input.taskId(), "attemptId", input.attemptId().toString(),
                "category", input.category(), "status", "NEW"));
            return employeeDto(jdbc.queryForMap("SELECT * FROM ai_feedback WHERE id=?", id));
        });
    }

    public Map<String, Object> mine(long user, String taskId, UUID attemptId) {
        requireTask(taskId);
        if (attemptId == null) throw new WorkspaceDenied(400, "InvalidFeedback");
        var rows = jdbc.queryForList("""
            SELECT * FROM ai_feedback WHERE owner_user_id=? AND task_id=? AND attempt_id=?
            """, user, taskId, attemptId);
        return rows.isEmpty() ? null : employeeDto(rows.getFirst());
    }

    public List<Map<String, Object>> list(String status, String category, int page) {
        if (page < 1 || page > 1000) throw new WorkspaceDenied(400, "InvalidPage");
        String selectedStatus = blank(status);
        String selectedCategory = blank(category);
        if (selectedStatus != null && !STATUSES.contains(selectedStatus))
            throw new WorkspaceDenied(400, "InvalidFeedbackStatus");
        if (selectedCategory != null && !CATEGORIES.contains(selectedCategory))
            throw new WorkspaceDenied(400, "InvalidFeedbackCategory");
        StringBuilder sql = new StringBuilder("""
            SELECT f.id::text,f.owner_user_id::text,f.task_id,f.attempt_id::text,f.category,f.status,
              f.actual_task_state,f.record_version,f.created_at,f.updated_at,f.closed_at,
              p.assistant_id::text,p.assistant_version,p.model_id::text,p.model_version
            FROM ai_feedback f LEFT JOIN ai_task_feedback_provenance p ON p.id=f.provenance_id WHERE 1=1
            """);
        List<Object> args = new ArrayList<>();
        if (selectedStatus != null) { sql.append(" AND f.status=?"); args.add(selectedStatus); }
        if (selectedCategory != null) { sql.append(" AND f.category=?"); args.add(selectedCategory); }
        sql.append(" ORDER BY f.created_at DESC,f.id DESC LIMIT 30 OFFSET ?");
        args.add((page - 1) * 30);
        var rows = jdbc.queryForList(sql.toString(), args.toArray());
        rows.forEach(row -> row.put("conversation_path", "/#/conversation/" + row.get("task_id")));
        return rows;
    }

    public Map<String, Object> detail(UUID id) {
        var rows = jdbc.queryForList("""
            SELECT f.*,p.id AS provenance_id,p.assistant_id,p.assistant_version,p.model_id,p.model_version,
              p.provider_id,p.provider_version,p.skills::text,p.mcps::text,p.tools::text,p.captured_at
            FROM ai_feedback f LEFT JOIN ai_task_feedback_provenance p ON p.id=f.provenance_id
            WHERE f.id=?
            """, id);
        if (rows.size() != 1) throw new WorkspaceDenied(404, "FeedbackNotFound");
        var row = rows.getFirst();
        Map<String, Object> result = new LinkedHashMap<>();
        for (String key : List.of("id", "owner_user_id", "task_id", "attempt_id", "category", "note",
            "status", "actual_task_state", "badcase_description", "root_cause", "cause_evidence", "expected_result", "resolution", "resolution_revision",
            "record_version", "handled_by", "created_at", "updated_at", "closed_at"))
            result.put(key, printable(row.get(key)));
        result.put("actual_tools", jsonList(row.get("actual_tools"), String.class));
        result.put("artifact_version_ids", jsonList(row.get("artifact_version_ids"), String.class));
        result.put("conversation_path", "/#/conversation/" + row.get("task_id"));
        result.put("provenance", provenance(row));
        result.put("rechecks", jdbc.queryForList("""
            SELECT id::text,resolution_revision,check_description,expected_result,actual_result,evidence,
              result,checked_by::text,checked_at FROM ai_feedback_recheck
            WHERE feedback_id=? ORDER BY checked_at DESC,id DESC
            """, id));
        result.put("model_usage", usage(row));
        return result;
    }

    public Map<String, Object> update(long actor, UUID id, Update input) {
        if (input == null || input.expectedVersion() == null || input.expectedVersion() < 1)
            throw new WorkspaceDenied(400, "InvalidFeedbackUpdate");
        String target = Objects.toString(input.status(), "").toUpperCase(Locale.ROOT);
        if (!STATUSES.contains(target)) throw new WorkspaceDenied(400, "InvalidFeedbackStatus");
        String badcase = optional(input.badcaseDescription(), 2000, "InvalidBadcaseDescription");
        String rootCause = optional(input.rootCause(), 2000, "InvalidRootCause");
        String causeEvidence = optional(input.causeEvidence(), 1000, "InvalidCauseEvidence");
        String expected = optional(input.expectedResult(), 2000, "InvalidExpectedResult");
        String resolution = optional(input.resolution(), 2000, "InvalidFeedbackResolution");
        return tx.execute(status -> {
            var rows = jdbc.queryForList("SELECT * FROM ai_feedback WHERE id=? FOR UPDATE", id);
            if (rows.size() != 1) throw new WorkspaceDenied(404, "FeedbackNotFound");
            var row = rows.getFirst();
            int version = ((Number) row.get("record_version")).intValue();
            if (version != input.expectedVersion()) throw new WorkspaceDenied(409, "FeedbackVersionConflict");
            String current = row.get("status").toString();
            if ("CLOSED".equals(current)) throw new WorkspaceDenied(409, "FeedbackClosed");
            if (!transition(current, target)) throw new WorkspaceDenied(409, "FeedbackStatusTransitionInvalid");
            boolean contentChanged = !Objects.equals(blank(row.get("badcase_description")), badcase)
                || !Objects.equals(blank(row.get("root_cause")), rootCause)
                || !Objects.equals(blank(row.get("cause_evidence")), causeEvidence)
                || !Objects.equals(blank(row.get("expected_result")), expected)
                || !Objects.equals(blank(row.get("resolution")), resolution);
            int revision = ((Number) row.get("resolution_revision")).intValue();
            if (contentChanged || ("RESOLVED".equals(current) && "IN_PROGRESS".equals(target))) revision++;
            if (("RESOLVED".equals(target) || "CLOSED".equals(target))
                && (badcase == null || rootCause == null || causeEvidence == null
                    || expected == null || resolution == null))
                throw new WorkspaceDenied(409, "FeedbackResolutionIncomplete");
            if ("CLOSED".equals(target) && !closeReady(id, revision))
                throw new WorkspaceDenied(409, "FeedbackRecheckRequired");
            jdbc.update("""
                UPDATE ai_feedback SET status=?,badcase_description=?,root_cause=?,cause_evidence=?,expected_result=?,resolution=?,
                  resolution_revision=?,record_version=record_version+1,handled_by=?,updated_at=NOW(),
                  closed_at=CASE WHEN ?='CLOSED' THEN NOW() ELSE NULL END WHERE id=?
                """, target, badcase, rootCause, causeEvidence, expected, resolution, revision, actor, target, id);
            audit(actor, "CLOSED".equals(target) ? "feedback.closed" : "feedback.updated", id,
                Map.of("status", target, "resolutionRevision", revision));
            return detail(id);
        });
    }

    public Map<String, Object> recheck(long actor, UUID id, Recheck input) {
        if (input == null || !Set.of("PASSED", "FAILED").contains(Objects.toString(input.result(), "")))
            throw new WorkspaceDenied(400, "InvalidFeedbackRecheck");
        String description = required(input.checkDescription(), 500, "InvalidFeedbackRecheck");
        String expected = required(input.expectedResult(), 1000, "InvalidFeedbackRecheck");
        String actual = required(input.actualResult(), 1000, "InvalidFeedbackRecheck");
        String evidence = required(input.evidence(), 1000, "InvalidFeedbackRecheck");
        return tx.execute(status -> {
            var rows = jdbc.queryForList("SELECT * FROM ai_feedback WHERE id=? FOR UPDATE", id);
            if (rows.size() != 1) throw new WorkspaceDenied(404, "FeedbackNotFound");
            var feedback = rows.getFirst();
            if (!"RESOLVED".equals(feedback.get("status")))
                throw new WorkspaceDenied(409, "FeedbackRecheckNotAvailable");
            int revision = ((Number) feedback.get("resolution_revision")).intValue();
            UUID recheck = UUID.randomUUID();
            jdbc.update("""
                INSERT INTO ai_feedback_recheck(id,feedback_id,resolution_revision,check_description,
                  expected_result,actual_result,evidence,result,checked_by)
                VALUES(?,?,?,?,?,?,?,?,?)
                """, recheck, id, revision, description, expected, actual, evidence, input.result(), actor);
            audit(actor, "feedback.rechecked", id,
                Map.of("result", input.result(), "resolutionRevision", revision, "recheckId", recheck.toString()));
            return detail(id);
        });
    }

    static boolean transition(String current, String target) {
        if (Objects.equals(current, target)) return true;
        return switch (current) {
            case "NEW" -> "IN_PROGRESS".equals(target);
            case "IN_PROGRESS" -> "RESOLVED".equals(target);
            case "RESOLVED" -> Set.of("IN_PROGRESS", "CLOSED").contains(target);
            default -> false;
        };
    }

    private boolean closeReady(UUID id, int revision) {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT COALESCE((SELECT result='PASSED' FROM ai_feedback_recheck
              WHERE feedback_id=? AND resolution_revision=?
              ORDER BY checked_at DESC,id DESC LIMIT 1),FALSE)
            """, Boolean.class, id, revision));
    }

    private List<Map<String, Object>> usage(Map<String, Object> feedback) {
        if (feedback.get("captured_at") == null) return List.of();
        return jdbc.queryForList("""
            SELECT id::text,resource_id::text AS model_id,metadata->>'callId' AS call_id,
              metadata->>'modelCode' AS model_code,metadata->>'status' AS status,
              (metadata->>'usageReported')::boolean AS usage_reported,
              (metadata->>'inputTokens')::bigint AS input_tokens,
              (metadata->>'outputTokens')::bigint AS output_tokens,
              metadata->>'costStatus' AS cost_status,created_at
            FROM ai_security_event WHERE actor_user_id=? AND action='model.relay.finished'
              AND metadata->>'conversationId'=? AND created_at>=? AND created_at<=?
            ORDER BY created_at,id
            """, feedback.get("owner_user_id"), feedback.get("task_id"),
            feedback.get("captured_at"), feedback.get("created_at"));
    }

    private Map<String, Object> provenance(Map<String, Object> row) {
        if (row.get("provenance_id") == null) return null;
        Map<String, Object> value = new LinkedHashMap<>();
        for (String key : List.of("assistant_id", "assistant_version", "model_id", "model_version",
            "provider_id", "provider_version", "captured_at")) value.put(key, printable(row.get(key)));
        value.put("skills", JsonUtils.parseArray(row.get("skills").toString(), Map.class));
        value.put("mcps", JsonUtils.parseArray(row.get("mcps").toString(), Map.class));
        value.put("tools", JsonUtils.parseArray(row.get("tools").toString(), Map.class));
        return value;
    }

    private Map<String, Object> employeeDto(Map<String, Object> row) {
        Map<String, Object> value = new LinkedHashMap<>();
        for (String key : List.of("id", "task_id", "attempt_id", "category", "note", "status",
            "resolution", "created_at", "updated_at")) value.put(key, printable(row.get(key)));
        return value;
    }

    private void audit(long actor, String action, UUID id, Map<String, Object> metadata) {
        jdbc.update("""
            INSERT INTO ai_security_event(id,actor_user_id,action,resource_id,metadata)
            VALUES(?,?,?,?,?::jsonb)
            """, UUID.randomUUID(), actor, action, id, JsonUtils.toJsonString(metadata));
    }

    private static List<Map<String, Object>> project(List<Map<String, Object>> rows, String... fields) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (var row : rows) {
            Map<String, Object> item = new LinkedHashMap<>();
            for (String field : fields) if (row.containsKey(field)) item.put(field, row.get(field));
            result.add(item);
        }
        return result;
    }

    private static Number number(Map<String, Object> row, String key) {
        Object value = row.get(key);
        if (!(value instanceof Number number)) throw new WorkspaceDenied(503, "FeedbackProvenanceUnavailable");
        return number;
    }

    private static List<String> toolNames(List<String> value) {
        if (value == null || value.size() > 100) throw new WorkspaceDenied(400, "InvalidFeedbackTools");
        LinkedHashSet<String> result = new LinkedHashSet<>();
        for (String item : value) {
            if (item == null || item.isBlank() || item.length() > 200
                || item.codePoints().anyMatch(Character::isISOControl))
                throw new WorkspaceDenied(400, "InvalidFeedbackTools");
            result.add(item);
        }
        return List.copyOf(result);
    }

    private static List<UUID> artifactVersions(List<UUID> value) {
        if (value == null || value.size() > 100 || value.stream().anyMatch(Objects::isNull))
            throw new WorkspaceDenied(400, "InvalidFeedbackArtifacts");
        return List.copyOf(new LinkedHashSet<>(value));
    }

    private static <T> List<T> jsonList(Object value, Class<T> type) {
        if (value == null) return List.of();
        return JsonUtils.parseArray(value.toString(), type);
    }

    private static <T> boolean jsonListEquals(Object stored, List<T> expected, Class<T> type) {
        return Objects.equals(jsonList(stored, type), expected);
    }

    private static UUID uuid(Object value, String error) {
        try { return UUID.fromString(Objects.toString(value, "")); }
        catch (Exception ignored) { throw new WorkspaceDenied(400, error); }
    }

    private static void requireTask(String value) {
        if (value == null || !TASK_ID.matcher(value).matches()) throw new WorkspaceDenied(400, "InvalidTaskId");
    }

    private static String required(String value, int max, String error) {
        String normalized = blank(value);
        if (normalized == null || normalized.length() > max || SENSITIVE.matcher(normalized).find())
            throw new WorkspaceDenied(400, error);
        return normalized;
    }

    private static String optional(String value, int max, String error) {
        String normalized = blank(value);
        if (normalized != null && (normalized.length() > max || SENSITIVE.matcher(normalized).find()))
            throw new WorkspaceDenied(400, error);
        return normalized;
    }

    private static String blank(Object value) {
        if (value == null) return null;
        String text = value.toString().trim();
        return text.isEmpty() ? null : text;
    }

    private static Object printable(Object value) {
        return value instanceof UUID || value instanceof java.sql.Timestamp ? value.toString() : value;
    }
}

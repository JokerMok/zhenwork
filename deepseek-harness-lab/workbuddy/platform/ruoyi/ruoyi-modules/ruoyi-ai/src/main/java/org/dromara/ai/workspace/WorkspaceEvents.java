package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.*;

@Service
@RequiredArgsConstructor
public class WorkspaceEvents {
    private final JdbcTemplate jdbc;
    /** Caller owns the surrounding transaction; the session row lock serializes sequence assignment. */
    public void append(UUID session,UUID run,UUID event,String type,Map<String,Object> payload) {
        jdbc.queryForObject("SELECT next_sequence FROM ai_session WHERE id=? FOR UPDATE",Long.class,session);
        if(Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM ai_event WHERE event_id=?)",Boolean.class,event)))return;
        Long sequence=jdbc.queryForObject("UPDATE ai_session SET next_sequence=next_sequence+1,updated_at=NOW() WHERE id=? RETURNING next_sequence",Long.class,session);
        jdbc.update("INSERT INTO ai_event(event_id,session_id,run_id,sequence,event_type,payload) VALUES(?,?,?,?,?,?::jsonb)",event,session,run,sequence,type,JsonUtils.toJsonString(payload));
    }
    public List<Map<String,Object>> after(UUID session,long sequence,int limit) {
        return jdbc.query("SELECT * FROM ai_event WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?",(r,n)->{
            Map<String,Object> event=new LinkedHashMap<>();event.put("eventId",r.getString("event_id"));event.put("sessionId",r.getString("session_id"));event.put("runId",r.getString("run_id"));event.put("sequence",Long.toString(r.getLong("sequence")));event.put("type",r.getString("event_type"));event.put("protocolVersion",r.getInt("protocol_version"));event.put("timestamp",r.getTimestamp("created_at").toInstant().toString());event.put("payload",JsonUtils.parseMap(r.getString("payload")));return event;
        },session,sequence,Math.min(500,Math.max(1,limit)));
    }
}

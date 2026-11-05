package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.*;

/** Immutable, version-bound receipts from the trusted Host's read-only Core probe. */
@Service
@RequiredArgsConstructor
public class WorkspaceSkillDependencyChecks {
    private static final Set<String> STATES=Set.of("READY","MISSING","INCOMPATIBLE","UNVERIFIED");
    private static final Set<String> ECOSYSTEMS=Set.of("node","python");
    private static final Map<String,Integer> SEVERITY=Map.of("READY",0,"UNVERIFIED",1,"INCOMPATIBLE",2,"MISSING",3);
    private final JdbcTemplate jdbc;
    private final AiResourceGuard guard;

    public record Declaration(String ecosystem,String name,String requested,String source,String installed,String state) {}

    public Map<String,Object> record(UUID id,long actor,int version,String packageSha256,String runtimeFingerprint,String state,List<Declaration> declarations) {
        var resource=guard.require(id,actor,AiResourceGuard.Action.USE);
        if(!"SKILL".equals(resource.get("resource_type")))throw new WorkspaceDenied(400,"SkillResourceRequired");
        if(resource.get("published_version")==null||((Number)resource.get("published_version")).intValue()!=version)
            throw new WorkspaceDenied(409,"DependencyCheckVersionChanged");
        var versionRow=guard.version(id,version,actor,AiResourceGuard.Action.USE);
        Map<String,Object> config=JsonUtils.parseMap(versionRow.get("config").toString());
        if(!validHash(packageSha256)||!packageSha256.equals(config.get("packageSha256")))
            throw new WorkspaceDenied(409,"DependencyCheckPackageChanged");
        if(runtimeFingerprint==null||!runtimeFingerprint.matches("sha256:[0-9a-f]{64}"))
            throw new WorkspaceDenied(400,"InvalidRuntimeFingerprint");
        List<Map<String,Object>> normalized=normalize(declarations);
        String aggregate=normalized.stream().map(item->item.get("state").toString())
            .max(Comparator.comparingInt(SEVERITY::get)).orElse("READY");
        if(!STATES.contains(state)||!aggregate.equals(state))throw new WorkspaceDenied(400,"InvalidDependencyCheck");
        Map<String,Object> metadata=new LinkedHashMap<>();metadata.put("resourceVersion",version);
        metadata.put("packageSha256",packageSha256);metadata.put("runtimeFingerprint",runtimeFingerprint);
        metadata.put("state",state);metadata.put("declarations",normalized);
        UUID receipt=UUID.randomUUID();
        jdbc.update("INSERT INTO ai_security_event(id,actor_user_id,action,resource_id,metadata) VALUES(?,?,'skill.dependency.checked',?,?::jsonb)",
            receipt,actor,id,JsonUtils.toJsonString(metadata));
        Map<String,Object> result=new LinkedHashMap<>(metadata);result.put("resourceId",id.toString());result.put("receiptId",receipt.toString());
        return Collections.unmodifiableMap(result);
    }

    public Map<String,Object> current(UUID id,long actor) {
        var resource=guard.require(id,actor,AiResourceGuard.Action.EDIT);
        if(!"SKILL".equals(resource.get("resource_type")))throw new WorkspaceDenied(400,"SkillResourceRequired");
        int version=((Number)resource.get("latest_version")).intValue();
        Map<String,Object> config=JsonUtils.parseMap(guard.version(id,version,actor,AiResourceGuard.Action.EDIT).get("config").toString());
        String packageSha256=Objects.toString(config.get("packageSha256"),"");
        if(!validHash(packageSha256))return null;
        var rows=jdbc.queryForList("SELECT id::text,metadata::text,created_at::text FROM ai_security_event WHERE resource_id=? AND action='skill.dependency.checked' AND metadata->>'resourceVersion'=? AND metadata->>'packageSha256'=? ORDER BY created_at DESC,id DESC LIMIT 1",
            id,Integer.toString(version),packageSha256);
        if(rows.isEmpty())return null;
        var row=rows.getFirst();Map<String,Object> result=new LinkedHashMap<>(JsonUtils.parseMap(row.get("metadata").toString()));
        result.put("resourceId",id.toString());result.put("receiptId",row.get("id"));result.put("checkedAt",row.get("created_at"));
        return Collections.unmodifiableMap(result);
    }

    private List<Map<String,Object>> normalize(List<Declaration> declarations) {
        if(declarations==null||declarations.size()>100)throw new WorkspaceDenied(400,"InvalidDependencyCheck");
        List<Map<String,Object>> result=new ArrayList<>();
        for(Declaration item:declarations) {
            if(item==null||!ECOSYSTEMS.contains(item.ecosystem())||!text(item.name(),200)||!text(item.requested(),500)||
                !text(item.source(),400)||item.installed()!=null&&!text(item.installed(),200)||!STATES.contains(item.state()))
                throw new WorkspaceDenied(400,"InvalidDependencyCheck");
            Map<String,Object> value=new LinkedHashMap<>();value.put("ecosystem",item.ecosystem());value.put("name",item.name());
            value.put("requested",item.requested());value.put("source",item.source());
            if(item.installed()!=null)value.put("installed",item.installed());value.put("state",item.state());result.add(Collections.unmodifiableMap(value));
        }
        return List.copyOf(result);
    }
    private boolean text(String value,int max){return value!=null&&!value.isBlank()&&value.length()<=max&&value.codePoints().noneMatch(Character::isISOControl);}
    private boolean validHash(String value){return value!=null&&value.matches("[0-9a-f]{64}");}
}

package org.dromara.ai.workspace;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import lombok.RequiredArgsConstructor;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.constructor.SafeConstructor;
import java.util.*;

@Service
@RequiredArgsConstructor
public class WorkspaceSkills {
    private final AiResourceGuard guard;
    private final JdbcTemplate jdbc;
    public static Map<String,Object> parse(String markdown){
        if(markdown==null||markdown.length()>24000||markdown.indexOf('\0')>=0)throw new WorkspaceDenied(400,"InvalidSkillMarkdown");String text=markdown.replace("\r\n","\n");if(!text.startsWith("---\n"))throw new WorkspaceDenied(400,"SkillFrontmatterRequired");int end=text.indexOf("\n---\n",4);if(end<0||end>6000)throw new WorkspaceDenied(400,"InvalidSkillFrontmatter");
        Map<?,?> front;try{var options=new LoaderOptions();options.setMaxAliasesForCollections(0);options.setAllowDuplicateKeys(false);options.setNestingDepthLimit(8);options.setCodePointLimit(6000);Object parsed=new Yaml(new SafeConstructor(options)).load(text.substring(4,end));if(!(parsed instanceof Map<?,?> map))throw new IllegalArgumentException();front=map;}catch(Exception e){throw new WorkspaceDenied(400,"InvalidSkillFrontmatter");}
        if(!Set.of("name","description","version","requiredTools","dependencies").containsAll(front.keySet()))throw new WorkspaceDenied(400,"UnsupportedSkillManifestField");
        String name=Objects.toString(front.get("name"),""),description=Objects.toString(front.get("description"),""),instruction=text.substring(end+5).trim();
        if(!name.matches("[a-z0-9]+(?:-[a-z0-9]+)*")||name.length()>80||description.isBlank()||description.length()>500||instruction.isBlank()||instruction.length()>16000)throw new WorkspaceDenied(400,"InvalidSkillManifest");
        String version=Objects.toString(front.get("version"),"1.0.0");if(!version.matches("[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-zA-Z0-9.-]+)?"))throw new WorkspaceDenied(400,"InvalidSkillVersion");
        var manifest=Map.of("schemaVersion",1,"name",name,"description",description,"version",version,"requiredTools",ids(front.get("requiredTools")),"dependencies",ids(front.get("dependencies")));
        return Map.of("format","SKILL_MD_V1","source",text,"manifest",manifest,"instruction",instruction);
    }
    private static List<String> ids(Object value){if(value==null)return List.of();if(!(value instanceof List<?> list)||list.size()>8)throw new WorkspaceDenied(400,"InvalidSkillDependencies");List<String> result=new ArrayList<>();for(Object item:list)try{result.add(UUID.fromString(item.toString()).toString());}catch(Exception e){throw new WorkspaceDenied(400,"InvalidSkillDependencies");}if(new HashSet<>(result).size()!=result.size())throw new WorkspaceDenied(400,"DuplicateSkillDependency");return result;}
    public List<Map<String,Object>> resolve(Object input,long user){List<Map<String,Object>> skills=new ArrayList<>();Set<UUID> seen=new HashSet<>(),visiting=new HashSet<>();for(String id:ids(input))visit(UUID.fromString(id),user,skills,seen,visiting);Set<String> names=new HashSet<>();for(var skill:skills)if(!names.add(skill.get("name").toString()))throw new WorkspaceDenied(400,"DuplicateSkillName");return skills;}
    private void visit(UUID id,long user,List<Map<String,Object>> output,Set<UUID> seen,Set<UUID> visiting){
        if(visiting.contains(id))throw new WorkspaceDenied(400,"SkillDependencyCycle");if(seen.contains(id))return;if(visiting.size()>8||seen.size()>=16)throw new WorkspaceDenied(400,"SkillDependencyLimit");visiting.add(id);
        var r=guard.require(id,user,AiResourceGuard.Action.USE);if(!"SKILL".equals(r.get("resource_type")))throw new WorkspaceDenied(400,"SkillResourceRequired");int version=((Number)r.get("published_version")).intValue();var config=JsonUtils.parseMap(guard.version(id,version,user,AiResourceGuard.Action.USE).get("config").toString());Map<String,Object> manifest=(Map<String,Object>)config.get("manifest");
        for(String dependency:ids(manifest.get("dependencies")))visit(UUID.fromString(dependency),user,output,seen,visiting);
        output.add(Map.of("id",id.toString(),"version",version,"authVersion",r.get("auth_version"),"name",manifest.get("name"),"description",manifest.get("description"),"instruction",config.get("instruction"),"requiredTools",ids(manifest.get("requiredTools"))));visiting.remove(id);seen.add(id);
    }
    public void checkHistory(UUID session,long user){for(var pin:jdbc.queryForList("SELECT DISTINCT p.resource_id,p.version,p.auth_version FROM ai_run_resource p JOIN ai_run r ON r.id=p.run_id WHERE r.session_id=?",session))guard.pinned((UUID)pin.get("resource_id"),((Number)pin.get("version")).intValue(),((Number)pin.get("auth_version")).longValue(),user);}
}

package org.dromara.ai.workspace;

import cn.dev33.satoken.annotation.SaIgnore;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.dromara.common.core.domain.R;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/ai")
public class WorkspaceBrandController {
    private final JdbcTemplate jdbc;
    private final WorkspacePrincipal principals;
    private final String clientId;
    private final String serverId;
    private final String requiredOrigin;
    private final WorkspaceBrandAssets assets;
    public WorkspaceBrandController(JdbcTemplate jdbc,WorkspacePrincipal principals,@Value("${workspace.browser-client-id}") String clientId,@Value("${workspace.server-id:}") String serverId,@Value("${workspace.public-origin}") String requiredOrigin,WorkspaceBrandAssets assets) {
        this.jdbc=jdbc;this.principals=principals;this.clientId=clientId;this.serverId=serverId;this.requiredOrigin=requiredOrigin;this.assets=assets;
    }
    public record BrandInput(@NotBlank @Size(max=80) String productName,@NotBlank @Size(max=100) String companyName,
        @NotBlank @Size(max=100) String loginTitle,@Size(max=300) String loginSubtitle,
        @NotBlank @Pattern(regexp="#[0-9a-fA-F]{6}") String primaryColor,String logoAssetId,String faviconAssetId,
        @Size(max=300) String supportText,@Size(max=200) String copyright,long expectedVersion) {}

    @SaIgnore
    @GetMapping("/brand")
    public R<Map<String,Object>> get() { return R.ok(read()); }

    @SaIgnore
    @GetMapping("/bootstrap")
    public R<Map<String,Object>> bootstrap() { return R.ok(Map.of("brand",read(),"clientId",clientId,"protocolVersion",2,"serverId",serverId,"requiredOrigin",requiredOrigin)); }

    private Map<String,Object> read() {
        return jdbc.queryForObject("SELECT config::text,version FROM ai_brand WHERE singleton=TRUE",(row,n)->{
            Map<String,Object> config=new LinkedHashMap<>(JsonUtils.parseMap(row.getString(1)));
            config.put("version",row.getLong(2));return config;
        });
    }

    @PutMapping("/brand")
    @Transactional
    public R<Map<String,Object>> update(@Valid @RequestBody BrandInput input) {
        var actor=principals.require("ai:brand:admin");
        assets.validate(input.logoAssetId());assets.validate(input.faviconAssetId());
        Map<String,Object> config=new LinkedHashMap<>();
        config.put("productName",input.productName());config.put("companyName",input.companyName());
        config.put("loginTitle",input.loginTitle());config.put("loginSubtitle",input.loginSubtitle());
        config.put("primaryColor",input.primaryColor());config.put("logoAssetId",input.logoAssetId());config.put("faviconAssetId",input.faviconAssetId());
        config.put("supportText",input.supportText());config.put("copyright",input.copyright());
        int updated=jdbc.update("UPDATE ai_brand SET config=?::jsonb,version=version+1,updated_by=?,updated_at=NOW() WHERE singleton=TRUE AND version=?",JsonUtils.toJsonString(config),actor.userId(),input.expectedVersion());
        if(updated!=1)throw new WorkspaceDenied(409,"VersionConflict");
        return R.ok(read());
    }
}

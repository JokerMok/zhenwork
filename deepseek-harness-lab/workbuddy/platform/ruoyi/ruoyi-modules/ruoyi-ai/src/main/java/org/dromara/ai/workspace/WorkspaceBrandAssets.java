package org.dromara.ai.workspace;
import cn.dev33.satoken.annotation.SaIgnore;
import lombok.RequiredArgsConstructor;
import org.dromara.common.core.domain.R;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.http.*;
import javax.imageio.ImageIO;
import java.io.*;
import java.util.*;
@RestController
@RequestMapping("/ai")
@RequiredArgsConstructor
public class WorkspaceBrandAssets {
 private final WorkspacePrincipal principals;private final WorkspaceFileStore files;private final JdbcTemplate jdbc;private final TransactionTemplate tx;
 @PostMapping(value="/admin/brand/assets",consumes=MediaType.MULTIPART_FORM_DATA_VALUE) public R<?> upload(@RequestPart MultipartFile file){long user=principals.require("ai:brand:admin").userId();byte[] input=WorkspaceFileStore.upload(file,1024*1024),output;int width,height;try(var stream=ImageIO.createImageInputStream(new ByteArrayInputStream(input))){var readers=ImageIO.getImageReaders(stream);if(!readers.hasNext())throw new Exception();var reader=readers.next();try{reader.setInput(stream,true,true);String format=reader.getFormatName().toLowerCase(Locale.ROOT);if(!Set.of("png","jpeg","jpg").contains(format))throw new Exception();width=reader.getWidth(0);height=reader.getHeight(0);if(width<16||height<16||width>1024||height>1024||width*height>1048576)throw new Exception();var image=reader.read(0);var bytes=new ByteArrayOutputStream();if(!ImageIO.write(image,"png",bytes))throw new Exception();output=bytes.toByteArray();if(output.length>2*1024*1024)throw new Exception();}finally{reader.dispose();}}catch(Exception e){throw new WorkspaceDenied(400,"InvalidBrandImage");}UUID id=tx.execute(status->files.save(user,"BRAND",null,null,"brand.png","image/png",output));return R.ok(Map.of("id",id.toString(),"width",width,"height",height));}
 public void validate(String value){if(value==null)return;try{var f=files.row(UUID.fromString(value));if(!"BRAND".equals(f.get("purpose")))throw new Exception();}catch(Exception e){throw new WorkspaceDenied(400,"InvalidBrandAsset");}}
 @SaIgnore
 @GetMapping("/brand/assets/{id}") public ResponseEntity<byte[]> read(@PathVariable UUID id){if(!Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM ai_brand WHERE singleton AND (config->>'logoAssetId'=? OR config->>'faviconAssetId'=?))",Boolean.class,id.toString(),id.toString())))throw new WorkspaceDenied(404,"BrandAssetNotFound");var f=files.row(id);if(!"BRAND".equals(f.get("purpose")))throw new WorkspaceDenied(404,"BrandAssetNotFound");return ResponseEntity.ok().contentType(MediaType.IMAGE_PNG).header("X-Content-Type-Options","nosniff").header(HttpHeaders.CACHE_CONTROL,"public, max-age=3600").body(files.bytes(f));}
}

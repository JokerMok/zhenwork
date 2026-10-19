package org.dromara.ai.workspace;
import org.dromara.common.mybatis.utils.IdGeneratorUtil;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import java.nio.*;
import java.nio.charset.*;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.*;
@Service
public class WorkspaceFileStore {
 private final JdbcTemplate jdbc;private final Path folder;
 public WorkspaceFileStore(JdbcTemplate jdbc,@Value("${workspace.secret-key-file}") String secretFile){this.jdbc=jdbc;folder=Path.of(secretFile).toAbsolutePath().getParent().resolve("uploads");}
 public static String hash(byte[] bytes){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}catch(Exception e){throw new IllegalStateException();}}
 public static String filename(MultipartFile file){String name=file.getOriginalFilename();if(name==null||name.length()>120||name.isBlank()||name.startsWith(".")||name.contains("..")||name.chars().anyMatch(c->c<32||c==127)||name.contains("/")||name.contains("\\")||!name.equals(name.trim()))throw new WorkspaceDenied(400,"InvalidFilename");return name;}
 public static byte[] upload(MultipartFile file,int max){if(file.isEmpty()||file.getSize()>max)throw new WorkspaceDenied(413,"FileSizeLimitExceeded");try{return file.getBytes();}catch(Exception e){throw new WorkspaceDenied(400,"FileReadFailed");}}
 public static String text(String name,byte[] bytes){if(!name.toLowerCase(Locale.ROOT).matches(".*\\.(txt|md|csv|json)"))throw new WorkspaceDenied(400,"UnsupportedFileType");try{String text=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();if(text.indexOf('\0')>=0||text.isBlank())throw new Exception();return text.startsWith("\uFEFF")?text.substring(1):text;}catch(Exception e){throw new WorkspaceDenied(400,"Utf8TextRequired");}}
 public UUID save(long user,String purpose,UUID resource,UUID session,String name,String media,byte[] bytes){jdbc.queryForObject("SELECT user_id FROM sys_user WHERE user_id=? FOR UPDATE",Long.class,user);if(jdbc.queryForObject("SELECT COALESCE(sum(byte_size),0) FROM ai_file WHERE owner_user_id=? AND deleted_at IS NULL",Long.class,user)+bytes.length>50L*1024*1024)throw new WorkspaceDenied(413,"StorageQuotaExceeded");UUID id=UUID.randomUUID(),key=UUID.randomUUID();long oss=IdGeneratorUtil.nextLongId();try{Files.createDirectories(folder);Files.setPosixFilePermissions(folder,PosixFilePermissions.fromString("rwx------"));Files.write(folder.resolve(key.toString()),bytes,StandardOpenOption.CREATE_NEW);Files.setPosixFilePermissions(folder.resolve(key.toString()),PosixFilePermissions.fromString("rw-------"));}catch(Exception e){throw new WorkspaceDenied(503,"FileStorageUnavailable");}
  // Native OSS metadata contains opaque identifiers; employee filenames/content remain behind Workspace ACL.
  jdbc.update("INSERT INTO sys_oss(oss_id,file_name,original_name,file_suffix,url,service,create_by,create_time) VALUES(?,?,?,?,?,'workspace-private',?,NOW())",oss,key.toString(),id.toString(),"","/api/ai/files/"+id+"/download",user);
  jdbc.update("INSERT INTO ai_file(id,oss_id,owner_user_id,purpose,resource_id,session_id,filename,media_type,byte_size,sha256,storage_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)",id,oss,user,purpose,resource,session,name,media,bytes.length,hash(bytes),key);return id;
 }
 public Map<String,Object> row(UUID id){var rows=jdbc.queryForList("SELECT * FROM ai_file WHERE id=? AND deleted_at IS NULL",id);if(rows.size()!=1)throw new WorkspaceDenied(404,"FileNotFound");return rows.getFirst();}
 public byte[] bytes(Map<String,Object> file){try{Path p=folder.resolve(file.get("storage_key").toString());if(Files.isSymbolicLink(p)||!Files.isRegularFile(p,LinkOption.NOFOLLOW_LINKS))throw new Exception();byte[] bytes=Files.readAllBytes(p);if(bytes.length!=((Number)file.get("byte_size")).longValue()||!hash(bytes).equals(file.get("sha256")))throw new Exception();return bytes;}catch(Exception e){throw new WorkspaceDenied(503,"FileIntegrityUnavailable");}}
 public Map<String,Object> dto(Map<String,Object> file){return Map.of("id",file.get("id").toString(),"filename",file.get("filename"),"byteSize",file.get("byte_size"),"sha256",file.get("sha256"),"purpose",file.get("purpose"));}
}

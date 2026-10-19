package org.dromara.ai.workspace;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.http.*;
import org.dromara.common.core.domain.R;
import java.nio.charset.StandardCharsets;
import java.util.*;
@RestController
@RequestMapping("/ai")
@RequiredArgsConstructor
public class WorkspaceFileController {
 private final WorkspacePrincipal principals;private final WorkspaceKnowledgeAccess access;private final WorkspaceFileStore files;private final WorkspaceConversations conversations;private final WorkspaceEvents events;private final WorkspaceKnowledge knowledge;private final JdbcTemplate jdbc;private final TransactionTemplate tx;
 @GetMapping("/knowledge/{base}/documents") public R<?> documents(@PathVariable UUID base,@RequestParam(defaultValue="1") int page){return R.ok(knowledge.documents(base,principals.current().userId(),page));}
 @PostMapping(value="/knowledge/{base}/documents",consumes=MediaType.MULTIPART_FORM_DATA_VALUE) public R<?> upload(@PathVariable UUID base,@RequestPart MultipartFile file,@RequestParam UUID idempotencyKey,@RequestParam(required=false) UUID documentId,@RequestParam(required=false) Integer expectedVersion){return R.ok(knowledge.upload(base,documentId,expectedVersion,idempotencyKey,principals.current().userId(),file));}
 @GetMapping("/knowledge/{base}/jobs") public R<?> jobs(@PathVariable UUID base){return R.ok(knowledge.jobs(base,principals.current().userId()));}
 @GetMapping("/knowledge/{base}/search") public R<?> search(@PathVariable UUID base,@RequestParam String query){return R.ok(knowledge.search(base,principals.current().userId(),query));}
 @GetMapping("/knowledge/documents/{id}/versions/{version}") public R<?> preview(@PathVariable UUID id,@PathVariable int version){return R.ok(knowledge.preview(id,version,principals.current().userId()));}
 @PostMapping("/knowledge/documents/{id}/reindex") public R<?> reindex(@PathVariable UUID id){return R.ok(knowledge.reindex(id,principals.current().userId()));}
 @DeleteMapping("/knowledge/documents/{id}") public R<?> delete(@PathVariable UUID id){knowledge.remove(id,principals.current().userId());return R.ok();}
 @GetMapping("/citations/{id}") public R<?> citation(@PathVariable UUID id){return R.ok(knowledge.citation(id,principals.current()));}
 @GetMapping("/files/{id}/download") public ResponseEntity<byte[]> download(@PathVariable UUID id){var actor=principals.current();var f=access.file(id,actor.userId());if(f.get("session_id")!=null)conversations.authorizeSession((UUID)f.get("session_id"),actor);byte[] bytes=files.bytes(f);access.file(id,actor.userId());jdbc.update("INSERT INTO ai_security_event(id,actor_user_id,action,resource_id,metadata) VALUES(?,?,'file.downloaded',?,jsonb_build_object('fileId',?::text))",UUID.randomUUID(),actor.userId(),f.get("resource_id"),id.toString());return ResponseEntity.ok().header(HttpHeaders.CACHE_CONTROL,"no-store").header("X-Content-Type-Options","nosniff").header(HttpHeaders.CONTENT_DISPOSITION,ContentDisposition.attachment().filename(f.get("filename").toString(),StandardCharsets.UTF_8).build().toString()).contentType(MediaType.TEXT_PLAIN).body(bytes);}
 @PostMapping(value="/sessions/{session}/files",consumes=MediaType.MULTIPART_FORM_DATA_VALUE) public R<?> attachment(@PathVariable UUID session,@RequestPart MultipartFile file){var actor=principals.current();conversations.authorizeSession(session,actor);String name=WorkspaceFileStore.filename(file);byte[] bytes=WorkspaceFileStore.upload(file,65536);WorkspaceFileStore.text(name,bytes);return R.ok(tx.<Map<String,Object>>execute(status->{jdbc.queryForObject("SELECT id FROM ai_session WHERE id=? FOR UPDATE",UUID.class,session);conversations.authorizeSession(session,actor);if(jdbc.queryForObject("SELECT count(*) FROM ai_file WHERE session_id=? AND deleted_at IS NULL",Integer.class,session)>=5)throw new WorkspaceDenied(409,"AttachmentLimitExceeded");if(Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM ai_run WHERE session_id=? AND status IN('QUEUED','RUNNING','WAITING_APPROVAL'))",Boolean.class,session)))throw new WorkspaceDenied(409,"RunAlreadyActive");UUID id=files.save(actor.userId(),"CHAT",null,session,name,"text/plain; charset=utf-8",bytes);return files.dto(files.row(id));}));}
 @DeleteMapping("/sessions/{session}/files/{id}") public R<?> deleteAttachment(@PathVariable UUID session,@PathVariable UUID id){var actor=principals.current();conversations.owned(session,actor.userId());var f=access.file(id,actor.userId());if(!session.equals(f.get("session_id")))throw new WorkspaceDenied(404,"FileNotFound");jdbc.update("UPDATE ai_file SET deleted_at=NOW(),auth_version=auth_version+1 WHERE id=?",id);conversations.revokeFile(id);return R.ok();}
 public Map<String,Object> readAttachment(String grant,UUID id){var run=conversations.checkGrant(grant,true);if(!Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM ai_run_file WHERE run_id=? AND file_id=?)",Boolean.class,run.get("id"),id)))throw new WorkspaceDenied(403,"AttachmentNotSelected");var f=access.file(id,((Number)run.get("owner_user_id")).longValue());String text=new String(files.bytes(f),StandardCharsets.UTF_8);conversations.checkGrant(grant,true);return Map.of("id",id.toString(),"filename",f.get("filename"),"content",text,"sha256",f.get("sha256"));}
}

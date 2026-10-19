package org.dromara.ai.workspace;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.context.event.EventListener;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import java.util.*;
@Service
@org.springframework.scheduling.annotation.EnableScheduling
@RequiredArgsConstructor
public class WorkspaceKnowledgeJobs {
 private final JdbcTemplate jdbc;private final TransactionTemplate tx;private volatile boolean ready;
 @EventListener(ApplicationReadyEvent.class) public void recover(){jdbc.update("UPDATE ai_knowledge_job SET status='QUEUED',error_code='RecoveredAfterRestart' WHERE status='RUNNING'");ready=true;}
 @Scheduled(fixedDelay=1000) public void work(){if(!ready)return;var job=tx.execute(status->{var rows=jdbc.queryForList("SELECT * FROM ai_knowledge_job WHERE status='QUEUED' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED");if(rows.isEmpty())return null;var j=rows.getFirst();jdbc.update("UPDATE ai_knowledge_job SET status='RUNNING',error_code=NULL WHERE id=?",j.get("id"));return j;});if(job==null)return;
  try{tx.executeWithoutResult(status->{UUID doc=(UUID)job.get("document_id");int version=((Number)job.get("version")).intValue();var rows=jdbc.queryForList("SELECT d.deleted_at,v.text_content FROM ai_knowledge_document d JOIN ai_knowledge_document_version v ON v.document_id=d.id WHERE d.id=? AND v.version=? FOR UPDATE OF d",doc,version);if(rows.isEmpty()||rows.getFirst().get("deleted_at")!=null){jdbc.update("UPDATE ai_knowledge_job SET status='CANCELLED',finished_at=NOW() WHERE id=?",job.get("id"));return;}
   String text=rows.getFirst().get("text_content").toString();int chunk=0,line=1;StringBuilder buffer=new StringBuilder();int startLine=1;for(String row:text.split("\\n",-1)){if(buffer.length()+row.length()>1000&&!buffer.isEmpty()){put(doc,version,chunk++,startLine,line-1,buffer.toString());buffer.setLength(0);startLine=line;}if(row.length()>1000){if(!buffer.isEmpty()){put(doc,version,chunk++,startLine,line-1,buffer.toString());buffer.setLength(0);}for(int offset=0;offset<row.length();offset+=800)put(doc,version,chunk++,line,line,row.substring(offset,Math.min(row.length(),offset+1000)));startLine=line+1;}else buffer.append(row).append('\n');line++;}if(!buffer.isEmpty())put(doc,version,chunk,startLine,line-1,buffer.toString());
   jdbc.update("UPDATE ai_knowledge_document_version SET status='READY' WHERE document_id=? AND version=?",doc,version);jdbc.update("UPDATE ai_knowledge_document SET indexed_version=GREATEST(COALESCE(indexed_version,0),?),updated_at=NOW() WHERE id=?",version,doc);jdbc.update("UPDATE ai_knowledge_job SET status='COMPLETED',finished_at=NOW() WHERE id=?",job.get("id"));
  });}catch(Exception e){jdbc.update("UPDATE ai_knowledge_job SET status='FAILED',error_code='IndexingFailed',finished_at=NOW() WHERE id=?",job.get("id"));jdbc.update("UPDATE ai_knowledge_document_version SET status='ERROR' WHERE document_id=? AND version=?",job.get("document_id"),job.get("version"));}
 }
 private void put(UUID doc,int version,int chunk,int start,int end,String content){jdbc.update("INSERT INTO ai_knowledge_index(document_id,version,chunk_index,line_start,line_end,content) VALUES(?,?,?,?,?,?) ON CONFLICT(document_id,version,chunk_index) DO UPDATE SET content=EXCLUDED.content,line_start=EXCLUDED.line_start,line_end=EXCLUDED.line_end",doc,version,chunk,start,end,content);}
}

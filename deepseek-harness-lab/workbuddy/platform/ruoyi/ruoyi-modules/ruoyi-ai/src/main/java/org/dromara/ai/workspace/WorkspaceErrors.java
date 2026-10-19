package org.dromara.ai.workspace;

import org.dromara.common.core.domain.R;
import org.springframework.core.annotation.Order;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@Order(-10)
@RestControllerAdvice
public class WorkspaceErrors {
    @ExceptionHandler(WorkspaceDenied.class)
    public ResponseEntity<R<Void>> denied(WorkspaceDenied e) {
        return ResponseEntity.status(e.status).body(R.fail(e.status,e.getMessage()));
    }
}

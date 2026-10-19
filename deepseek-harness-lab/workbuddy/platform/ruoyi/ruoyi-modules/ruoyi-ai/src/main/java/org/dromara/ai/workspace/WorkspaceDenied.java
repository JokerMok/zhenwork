package org.dromara.ai.workspace;

public class WorkspaceDenied extends RuntimeException {
    public final int status;
    public WorkspaceDenied(int status,String code){super(code);this.status=status;}
}

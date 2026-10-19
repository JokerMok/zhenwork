package org.dromara.ai.workspace;
import lombok.RequiredArgsConstructor;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.*;
import org.springframework.stereotype.Component;
import org.springframework.jdbc.core.JdbcTemplate;
import org.dromara.common.core.domain.R;
import org.dromara.common.core.domain.PageResult;
import org.dromara.common.mybatis.core.page.PageQuery;
import org.dromara.common.mybatis.core.query.QueryBuilder;
import org.dromara.system.domain.SysOss;
import org.dromara.system.domain.bo.SysOssBo;
import org.dromara.system.domain.vo.SysOssVo;
import org.dromara.system.mapper.SysOssMapper;
import org.dromara.system.service.ISysOssService;
import java.util.*;
/** Preserve native cloud OSS behavior while private Workspace objects use their own ACL routes. */
@Aspect
@Component
@RequiredArgsConstructor
public class WorkspacePrivateOss {
 private final JdbcTemplate jdbc;private final WorkspacePrincipal principals;private final SysOssMapper mapper;private final ISysOssService oss;
 @Around("execution(* org.dromara.system.controller.system.SysOssController.list(..))")
 public Object list(ProceedingJoinPoint call){principals.require("system:oss:list");var bo=(SysOssBo)call.getArgs()[0];var pageQuery=(PageQuery)call.getArgs()[1];pageQuery.setPageSize(Math.min(100,Math.max(1,pageQuery.getPageSize()==null?30:pageQuery.getPageSize())));var params=bo.getParams();var query=QueryBuilder.lambda(SysOss.class).likeIfText(SysOss::getFileName,bo.getFileName()).likeIfText(SysOss::getOriginalName,bo.getOriginalName()).eqIfText(SysOss::getFileSuffix,bo.getFileSuffix()).eqIfText(SysOss::getUrl,bo.getUrl()).betweenParams(SysOss::getCreateTime,params,"beginCreateTime","endCreateTime").eqIfPresent(SysOss::getCreateBy,bo.getCreateBy()).eqIfText(SysOss::getService,bo.getService()).orderByAsc(SysOss::getOssId).build().ne(SysOss::getService,"workspace-private");var page=mapper.selectVoPage(pageQuery.build(),query);List<Long> ids=page.getRecords().stream().map(SysOssVo::getOssId).toList();return R.ok(PageResult.build(ids.isEmpty()?List.of():oss.listByIds(ids),page.getTotal()));}
 @Around("execution(* org.dromara.system.controller.system.SysOssController.listByIds(..)) || execution(* org.dromara.system.service.impl.SysOssServiceImpl.download(..)) || execution(* org.dromara.system.service.impl.SysOssServiceImpl.deleteWithValidByIds(..))")
 public Object protect(ProceedingJoinPoint call)throws Throwable{Object input=call.getArgs()[0];Collection<?> ids=input instanceof Collection<?> c?c:input instanceof Object[] a?Arrays.asList(a):List.of(input);for(Object id:ids)if(Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM sys_oss WHERE oss_id=? AND service='workspace-private')",Boolean.class,Long.valueOf(id.toString()))))throw new WorkspaceDenied(404,"PrivateFileUseWorkspaceRoute");return call.proceed();}
}

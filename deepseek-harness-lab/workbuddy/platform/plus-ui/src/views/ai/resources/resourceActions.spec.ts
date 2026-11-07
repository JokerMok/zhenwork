import {describe,expect,it} from 'vitest';
import {activationReason,publicationReason} from './resourceActions';
const draft={version:2,publishedVersion:1,visibility:'PRIVATE',enabled:true,reviewState:'DRAFT'};
describe('resource next actions',()=>{
  it('allows activating a new draft but explains an already active draft',()=>{
    expect(activationReason(draft)).toBe('');
    expect(activationReason({...draft,publishedVersion:2})).toBe('当前已激活此版本');
  });
  it('retains withdrawal before changing a published resource',()=>{
    expect(activationReason({...draft,visibility:'ENTERPRISE_PUBLIC'})).toBe('需先撤回发布');
    expect(publicationReason({...draft,visibility:'ENTERPRISE_PUBLIC',publishedVersion:2})).toBe('此版本已发布');
  });
  it('keeps pending review and unavailable states out of duplicate submission',()=>{
    expect(publicationReason({...draft,reviewState:'PENDING'})).toBe('等待审核结果');
    expect(publicationReason({...draft,enabled:false})).toBe('请先启用资源');
    expect(publicationReason({...draft,securityDisabled:true})).toBe('资源已被安全停用');
  });
  it('allows submission of an enabled new draft',()=>expect(publicationReason(draft)).toBe(''));
});

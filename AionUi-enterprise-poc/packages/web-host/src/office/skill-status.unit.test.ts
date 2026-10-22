import { expect, test, vi } from 'vitest';
import { checkEnterpriseSkill } from './skill-status.js';
const id = '11111111-1111-4111-8111-111111111111';
const loaded = [{ id, name: 'shared-tool', version: 2 }];
test('enterprise Skill readiness requires current USE and matching loaded version', async () => {
  const client = { resources: vi.fn().mockResolvedValue([{ id, name: '共享能力', version: 2 }]), authorizedResource: vi.fn().mockResolvedValue({ version: 2 }) };
  await expect(checkEnterpriseSkill(client, 'shared-tool', loaded, ['shared-tool'])).resolves.toMatchObject({ available: true, authorized: true, version: 2, reason: 'READY' });
  client.resources.mockResolvedValue([]);
  await expect(checkEnterpriseSkill(client, 'shared-tool', loaded, ['shared-tool'])).resolves.toMatchObject({ available: false, reason: 'UNAVAILABLE_OR_REVOKED' });
  expect(client.authorizedResource).toHaveBeenCalledTimes(1);
});
test('a stale or missing runtime never becomes ready just because it is granted', async () => {
  const client = { resources: async () => [{ id, name: '共享能力', version: 3 }], authorizedResource: async () => ({ version: 3 }) };
  await expect(checkEnterpriseSkill(client, id, loaded, ['shared-tool'])).resolves.toMatchObject({ authorized: true, available: false, reason: 'RUNTIME_REFRESH_REQUIRED' });
  await expect(checkEnterpriseSkill(client, id, [{ ...loaded[0], version: 3 }], [])).resolves.toMatchObject({ available: false });
});
test('a grant withdrawn between listing and checking returns unavailable', async () => {
  const client = { resources: async () => [{ id, name: '共享能力', version: 2 }], authorizedResource: async () => { throw Error('revoked'); } };
  await expect(checkEnterpriseSkill(client, id, loaded, ['shared-tool'])).resolves.toMatchObject({ available: false, reason: 'UNAVAILABLE_OR_REVOKED' });
});

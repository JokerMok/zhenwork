import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { enterpriseManagedResourcePath } from '../enterprise-resource-runtime.js';
import { DEFAULT_EMPLOYEE_PREFERENCES, nativeRunPreferences } from './preferences.js';

test('a native turn stays pinned when the evidence log reaches capacity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'employee-preference-capacity-'));
  const actor = { serverId: 'fixture', userId: '17' };
  try {
    const file = path.join(path.dirname(await enterpriseManagedResourcePath(root, actor)), 'employee-preferences.json');
    const previous = { ...DEFAULT_EMPLOYEE_PREFERENCES, version: 1 };
    const current = { ...previous, version: 2 };
    const first = { conversation: 'first', turnId: 'turn_01234567', preferences: previous };
    const finished = { conversation: 'finished', turnId: 'turn_01234568', preferences: previous };
    await writeFile(
      file,
      JSON.stringify({
        current,
        nativeRuns: [
          first,
          finished,
          ...Array.from({ length: 198 }, (_, index) => ({
            conversation: 'finished-' + index,
            turnId: 'turn_01234568',
            preferences: previous,
          })),
        ],
      }),
      { mode: 0o600 }
    );

    const runtime = async (id: string) => (id === first.conversation ? first.turnId : null);
    expect(await nativeRunPreferences(root, actor, 'new-conversation', 'turn_01234569', runtime)).toEqual(current);
    expect(await nativeRunPreferences(root, actor, first.conversation, first.turnId, runtime)).toEqual(previous);
    expect(
      (JSON.parse(await readFile(file, 'utf8')).nativeRuns as Array<{ conversation: string }>).find(
        (item) => item.conversation === finished.conversation
      )
    ).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

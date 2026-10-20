import { Writable } from 'node:stream';
import { beforeEach, expect, test, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { generateOfficeArtifact } from './generate.js';

let payload = '';
function successfulChild(result = Buffer.from('artifact')): Record<string, unknown> {
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      payload += Buffer.from(chunk).toString('utf8');
      callback();
    },
  });
  stdin.once('finish', () => queueMicrotask(() => execFileMock.mock.calls.at(-1)?.[3](null, result, Buffer.alloc(0))));
  return { stdin };
}

beforeEach(() => {
  payload = '';
  delete process.env.ZHENWORK_OFFICE_PYTHON;
  execFileMock.mockReset();
  execFileMock.mockImplementation(() => successfulChild());
});

test('uses the fixed host interpreter and sends only bounded JSON through stdin', async () => {
  const input = {
    format: 'xlsx' as const,
    title: 'Quarterly review',
    table: { headers: ['Source', 'Formula-like text'], rows: [['https://example.com/source', '=1+1']] },
  };
  await expect(generateOfficeArtifact(input)).resolves.toEqual(Buffer.from('artifact'));
  const [file, args, options] = execFileMock.mock.calls[0];
  expect(file).toBe('/opt/zhenwork-office/bin/python');
  expect(args).toHaveLength(2);
  expect(args[0]).toBe('-c');
  expect(options).toMatchObject({ encoding: 'buffer', timeout: 20_000, maxBuffer: 10 * 1024 * 1024 + 1 });
  expect(JSON.parse(payload)).toEqual(input);
  expect(args[1]).toContain("cell.data_type='s'");
  expect(args[1]).not.toMatch(/\b(?:eval|exec)\s*\(/);
  expect(args[1]).not.toMatch(/\b(?:subprocess|socket|requests|urllib)\b/);
});

test('allows only an explicit absolute interpreter override from the host environment', async () => {
  process.env.ZHENWORK_OFFICE_PYTHON = '/usr/bin/python3';
  await generateOfficeArtifact({ format: 'pdf', paragraphs: ['Source: https://example.com'] });
  expect(execFileMock.mock.calls[0][0]).toBe('/usr/bin/python3');
  process.env.ZHENWORK_OFFICE_PYTHON = 'python3';
  await expect(generateOfficeArtifact({ format: 'pdf', title: 'Report' })).rejects.toThrow(
    'OFFICE_PYTHON_PATH_INVALID'
  );
});

test('rejects oversized structures, text and explicit formulas before spawning Python', async () => {
  await expect(
    generateOfficeArtifact({ format: 'xlsx', table: { headers: [], rows: Array.from({ length: 1001 }, () => []) } })
  ).rejects.toThrow('OFFICE_ROW_LIMIT_1000');
  await expect(
    generateOfficeArtifact({ format: 'xlsx', table: { headers: [], rows: [[...Array(41).fill('x')]] } })
  ).rejects.toThrow('OFFICE_COLUMN_LIMIT_40');
  await expect(
    generateOfficeArtifact({
      format: 'pptx',
      slides: Array.from({ length: 31 }, (_, index) => ({ title: String(index) })),
    })
  ).rejects.toThrow('OFFICE_SLIDE_LIMIT_30');
  await expect(generateOfficeArtifact({ format: 'docx', paragraphs: ['x'.repeat(8001)] })).rejects.toThrow(
    'OFFICE_PARAGRAPHS_INVALID'
  );
  await expect(
    generateOfficeArtifact({ format: 'xlsx', table: { headers: [], rows: [[{ formula: '=SUM(A1:A2)' } as never]] } })
  ).rejects.toThrow('OFFICE_FORMULAS_NOT_SUPPORTED');
  await expect(generateOfficeArtifact({ format: 'pdf', paragraphs: ['x'.repeat(64 * 1024)] })).rejects.toThrow(
    'OFFICE_INPUT_LIMIT_64KB'
  );
  expect(execFileMock).not.toHaveBeenCalled();
});

test('rejects documents without visible content but accepts a visible numeric cell', async () => {
  await expect(generateOfficeArtifact({ format: 'pdf' })).rejects.toThrow('OFFICE_CONTENT_REQUIRED');
  await expect(
    generateOfficeArtifact({ format: 'docx', title: ' \n ', table: { headers: [''], rows: [[null, '  ']] } })
  ).rejects.toThrow('OFFICE_CONTENT_REQUIRED');
  await expect(
    generateOfficeArtifact({ format: 'xlsx', sheets: [{ name: 'Named but empty', rows: [[]] }] })
  ).rejects.toThrow('OFFICE_CONTENT_REQUIRED');
  await expect(generateOfficeArtifact({ format: 'pptx', slides: [{ title: '', paragraphs: ['  '] }] })).rejects.toThrow(
    'OFFICE_CONTENT_REQUIRED'
  );
  expect(execFileMock).not.toHaveBeenCalled();
  await expect(generateOfficeArtifact({ format: 'xlsx', table: { headers: [], rows: [[0]] } })).resolves.toEqual(
    Buffer.from('artifact')
  );
});

test('preserves only the safe Python exception category', async () => {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    const stdin = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    stdin.once('finish', () =>
      queueMicrotask(() =>
        callback(
          new Error('unsafe details'),
          Buffer.alloc(0),
          Buffer.from('OFFICE_GENERATION_FAILED:ModuleNotFoundError\n/private/customer.xlsx')
        )
      )
    );
    return { stdin };
  });
  const error = await generateOfficeArtifact({ format: 'pdf', title: 'Report' }).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe('OFFICE_GENERATION_FAILED:ModuleNotFoundError');
  expect((error as Error).message).not.toContain('/private/customer.xlsx');
});

test('enforces the output ceiling even if the child callback returns too many bytes', async () => {
  execFileMock.mockImplementation(() => successfulChild(Buffer.alloc(10 * 1024 * 1024 + 1)));
  await expect(generateOfficeArtifact({ format: 'docx', title: 'Too large' })).rejects.toThrow(
    'OFFICE_OUTPUT_LIMIT_10MB'
  );
});

test('the fixed Python program parses without importing optional artifact libraries', async () => {
  await generateOfficeArtifact({ format: 'pdf', title: 'Static syntax check' });
  const script = execFileMock.mock.calls[0][1][1] as string;
  const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  expect(() =>
    execFileSync('/usr/bin/python3', ['-c', 'import sys;compile(sys.stdin.read(),"<office-generator>","exec")'], {
      input: script,
    })
  ).not.toThrow();
});

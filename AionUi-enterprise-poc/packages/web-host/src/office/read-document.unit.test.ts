import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { beforeEach, expect, test, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { readOfficeDocument } from './read-document.js';

let stdin = Buffer.alloc(0);

function successfulChild(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const input = new Writable({
    write(chunk, _encoding, callback) {
      stdin = Buffer.concat([stdin, Buffer.from(chunk)]);
      callback();
    },
  });
  input.once('finish', () =>
    queueMicrotask(() => {
      const args = execFileMock.mock.calls.at(-1)?.[1] as string[];
      const result = {
        format: args[2],
        sourceSha256: createHash('sha256').update(stdin).digest('hex'),
        start: Number(args[3]),
        limit: Number(args[4]),
        locations: [],
        ...extra,
      };
      execFileMock.mock.calls.at(-1)?.[3](null, Buffer.from(JSON.stringify(result)), Buffer.alloc(0));
    })
  );
  return { stdin: input };
}

beforeEach(() => {
  stdin = Buffer.alloc(0);
  delete process.env.ZHENWORK_OFFICE_PYTHON;
  execFileMock.mockReset();
  execFileMock.mockImplementation(() => successfulChild());
});

test('uses a fixed program, sends only source bytes through stdin and returns verified location data', async () => {
  const bytes = Buffer.from('%PDF-1.4 private source bytes');
  await expect(readOfficeDocument('/authorized/research.pdf', bytes, { start: 2, limit: 3 })).resolves.toMatchObject({
    format: 'pdf',
    sourceName: 'research.pdf',
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    start: 2,
    limit: 3,
    locations: [],
  });
  const [file, args, options] = execFileMock.mock.calls[0];
  expect(file).toBe('/opt/zhenwork-office/bin/python');
  expect(args.slice(0, 2)).toEqual(['-c', expect.any(String)]);
  expect(args.slice(2)).toEqual(['pdf', '2', '3', 'pdf']);
  expect(args).not.toContain('/authorized/research.pdf');
  expect(options).toMatchObject({ encoding: 'buffer', timeout: 30_000, maxBuffer: 256 * 1024 + 1 });
  expect(stdin).toEqual(bytes);
  expect(args[1]).toContain('read_only=True');
  expect(args[1]).toContain('data_only=False');
  expect(args[1]).toContain("['pdftotext'");
  expect(args[1]).toContain("['pdftoppm'");
  expect(args[1]).toContain("['tesseract'");
  expect(args[1]).toContain('TemporaryDirectory');
  expect(args[1]).not.toMatch(/\b(?:eval|exec)\s*\(/);
  expect(args[1]).not.toMatch(/\b(?:socket|requests|urllib|httpx)\b/);
});

test('accepts only a trusted absolute interpreter override', async () => {
  process.env.ZHENWORK_OFFICE_PYTHON = '/usr/bin/python3';
  await readOfficeDocument('notes.txt', Buffer.from('hello'));
  expect(execFileMock.mock.calls[0][0]).toBe('/usr/bin/python3');
  process.env.ZHENWORK_OFFICE_PYTHON = 'python3';
  await expect(readOfficeDocument('notes.txt', Buffer.from('hello'))).rejects.toThrow('OFFICE_PYTHON_PATH_INVALID');
});

test('rejects unsupported formats, invalid ranges and oversized input before spawning Python', async () => {
  await expect(readOfficeDocument('legacy.doc', Buffer.from('x'))).rejects.toThrow('OFFICE_LEGACY_FORMAT_UNSUPPORTED');
  await expect(readOfficeDocument('archive.zip', Buffer.from('x'))).rejects.toThrow('OFFICE_READ_FORMAT_UNSUPPORTED');
  await expect(readOfficeDocument('report.pdf', Buffer.from('x'), { start: -1 })).rejects.toThrow(
    'OFFICE_READ_START_INVALID'
  );
  await expect(readOfficeDocument('report.pdf', Buffer.from('x'), { limit: 6 })).rejects.toThrow(
    'OFFICE_READ_LIMIT_1_TO_5'
  );
  await expect(readOfficeDocument('report.pdf', Buffer.alloc(50 * 1024 * 1024 + 1))).rejects.toThrow(
    'OFFICE_READ_INPUT_LIMIT_50MB'
  );
  expect(execFileMock).not.toHaveBeenCalled();
});

test('preserves only a safe Python exception category', async () => {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    const input = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    input.once('finish', () =>
      queueMicrotask(() =>
        callback(
          new Error('unsafe details'),
          Buffer.alloc(0),
          Buffer.from('OFFICE_READ_FAILED:ModuleNotFoundError\n/private/customer.pdf traceback')
        )
      )
    );
    return { stdin: input };
  });
  const error = await readOfficeDocument('report.pdf', Buffer.from('source')).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe('OFFICE_READ_FAILED:ModuleNotFoundError');
  expect((error as Error).message).not.toContain('/private/customer.pdf');
});

test('rejects oversized or unverifiable child output', async () => {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    const input = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    input.once('finish', () => queueMicrotask(() => callback(null, Buffer.alloc(256 * 1024 + 1), Buffer.alloc(0))));
    return { stdin: input };
  });
  await expect(readOfficeDocument('report.pdf', Buffer.from('source'))).rejects.toThrow(
    'OFFICE_READ_OUTPUT_LIMIT_256KB'
  );
  execFileMock.mockImplementation(() => successfulChild({ sourceSha256: '0'.repeat(64) }));
  await expect(readOfficeDocument('report.pdf', Buffer.from('source'))).rejects.toThrow('OFFICE_READ_RESULT_INVALID');
});

test('the fixed Python program compiles without importing optional document libraries', async () => {
  await readOfficeDocument('document.docx', Buffer.from('static syntax check'));
  const script = execFileMock.mock.calls[0][1][1] as string;
  const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  expect(() =>
    execFileSync('/usr/bin/python3', ['-c', 'import sys;compile(sys.stdin.read(),"<office-reader>","exec")'], {
      input: script,
    })
  ).not.toThrow();
});

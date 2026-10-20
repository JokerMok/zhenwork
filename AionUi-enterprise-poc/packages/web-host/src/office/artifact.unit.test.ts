import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { inspectArtifact } from './artifact.js';

function archive(entries: Record<string, string>): Buffer {
  return execFileSync('python3', [
    '-c',
    'import io,sys,json,zipfile;b=io.BytesIO();z=zipfile.ZipFile(b,"w");[z.writestr(n,t) for n,t in json.loads(sys.argv[1]).items()];z.close();sys.stdout.buffer.write(b.getvalue())',
    JSON.stringify(entries),
  ]);
}

test('accepts real Office XML containers and rejects prose disguised as Office files', async () => {
  for (const [extension, part] of [
    ['xlsx', 'xl/workbook.xml'],
    ['docx', 'word/document.xml'],
    ['pptx', 'ppt/presentation.xml'],
  ]) {
    const bytes = archive({ '[Content_Types].xml': '<Types/>', [part]: '<document/>' });
    await expect(inspectArtifact('result.' + extension, bytes)).resolves.toMatchObject({
      valid: true,
      format: extension,
    });
    await expect(inspectArtifact('result.' + extension, Buffer.from('The task is complete.'))).rejects.toThrow(
      'INVALID_OFFICE_ARTIFACT'
    );
  }
});

test('rejects unrelated ZIPs and malformed Office XML', async () => {
  await expect(inspectArtifact('result.xlsx', archive({ 'text.txt': 'hello' }))).rejects.toThrow(
    'INVALID_OFFICE_ARTIFACT'
  );
  await expect(
    inspectArtifact('result.xlsx', archive({ '[Content_Types].xml': '<broken>', 'xl/workbook.xml': '<workbook/>' }))
  ).rejects.toThrow('INVALID_OFFICE_ARTIFACT');
});

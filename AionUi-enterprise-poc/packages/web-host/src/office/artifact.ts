import { execFile } from 'node:child_process';
import path from 'node:path';

const inspect = `import io,json,sys,zipfile,xml.etree.ElementTree as E,subprocess
b=sys.stdin.buffer.read(52428801);ext=sys.argv[1]
try:
 if len(b)>52428800:raise ValueError('FILE_LIMIT_50MB')
 if ext=='.pdf':
  if not b.startswith(b'%PDF-') or b'%%EOF' not in b[-4096:]:raise ValueError('INVALID_PDF_FILE')
  r=subprocess.run(['pdfinfo','-'],input=b,capture_output=True,timeout=10)
  if r.returncode:raise ValueError('INVALID_PDF_FILE')
  pages=next(int(l.split(':',1)[1]) for l in r.stdout.decode().splitlines() if l.startswith('Pages:'))
  if pages<1:raise ValueError('INVALID_PDF_FILE')
  print(json.dumps({'valid':True,'format':'pdf','pages':pages,'byteSize':len(b)}))
 else:
  required={'.xlsx':'xl/workbook.xml','.docx':'word/document.xml','.pptx':'ppt/presentation.xml'}
  if ext not in required:raise ValueError('OFFICE_FORMAT_REQUIRED')
  with zipfile.ZipFile(io.BytesIO(b)) as z:
   infos=z.infolist()
   if len(infos)>10000 or sum(i.file_size for i in infos)>209715200:raise ValueError('OFFICE_EXPANSION_LIMIT')
   for name in ['[Content_Types].xml',required[ext]]:
    i=z.getinfo(name)
    if i.file_size>10485760:raise ValueError('OFFICE_XML_LIMIT')
    E.fromstring(z.read(name))
   if z.testzip() is not None:raise ValueError('OFFICE_CRC_INVALID')
   print(json.dumps({'valid':True,'format':ext[1:],'parts':len(infos),'byteSize':len(b)}))
except Exception as e:
 print(json.dumps({'valid':False,'error':str(e)[:150]}));sys.exit(2)
`;

/** Validate actual Office containers and PDF structure before publishing a result. */
export async function inspectArtifact(name: string, bytes: Buffer, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'python3',
      ['-c', inspect, path.extname(name).toLowerCase()],
      { timeout: 20000, maxBuffer: 8192, signal, killSignal: 'SIGKILL' },
      (error, stdout) => {
        if(signal?.aborted){reject(new Error('ARTIFACT_VALIDATION_CANCELLED'));return;}
        let result: Record<string, unknown>;
        try {
          result = JSON.parse(stdout);
        } catch {
          reject(new Error('ARTIFACT_VALIDATION_UNAVAILABLE'));
          return;
        }
        if (error || result.valid !== true) {
          reject(new Error('INVALID_OFFICE_ARTIFACT: ' + String(result.error || 'validation failed')));
          return;
        }
        resolve(result);
      }
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(bytes);
  });
}

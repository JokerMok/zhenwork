import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { presentationPython } from './index.js';

const render = String.raw`import os,sys,subprocess,pathlib,resource
root=pathlib.Path(sys.argv[1]);page=int(sys.argv[2]);profile=root/'profile';profile.mkdir()
(profile/'user').mkdir();(profile/'user/registrymodifications.xcu').write_text('<oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateMode" oor:op="fuse"><value>3</value></prop></item></oor:items>')
def limits():
 resource.setrlimit(resource.RLIMIT_AS,(1024*1024*1024,1024*1024*1024));resource.setrlimit(resource.RLIMIT_CPU,(25,25));resource.setrlimit(resource.RLIMIT_FSIZE,(24*1024*1024,24*1024*1024))
env={**os.environ,'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','SAL_USE_VCLPLUGIN':'svp'}
subprocess.run([os.environ.get('ZHENWORK_OFFICE_RENDERER','/usr/bin/libreoffice'),'-env:UserInstallation='+profile.as_uri(),'--headless','--nologo','--nodefault','--nolockcheck','--convert-to','pdf:impress_pdf_Export','--outdir',str(root),str(root/'input.pptx')],env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=25,preexec_fn=limits)
pdf=root/'input.pdf'
if not pdf.exists() or pdf.stat().st_size>20*1024*1024:raise ValueError('PPT_PREVIEW_PDF_LIMIT')
subprocess.run([os.environ.get('ZHENWORK_PDFTOPPM','/usr/bin/pdftoppm'),'-f',str(page),'-l',str(page),'-singlefile','-scale-to','1280','-png',str(pdf),str(root/'slide')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10,preexec_fn=limits)
if (root/'slide.png').stat().st_size>4*1024*1024:raise ValueError('PPT_PREVIEW_IMAGE_LIMIT')
`;

/** Version-bound visual conversion; no shared cache, daemon or third-party upload. */
export async function previewPresentation(bytes: Buffer, start: number) {
  const info = await presentationPython('inspect', bytes);
  const count = Number(info.slideCount);
  if (start >= count) throw new Error('PREVIEW_PAGE_INVALID');
  const disk = await statfs(os.tmpdir());
  if (Number(disk.bavail) * Number(disk.bsize) < 2 * 1024 ** 3 + 64 * 1024 ** 2)
    throw new Error('PPT_PREVIEW_DISK_BUDGET');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zhenwork-ppt-preview-'));
  try {
    await writeFile(path.join(directory, 'input.pptx'), bytes, { mode: 0o600 });
    const python = process.env.ZHENWORK_OFFICE_PYTHON?.trim() || '/opt/zhenwork-office/bin/python';
    await new Promise<void>((resolve, reject) => {
      const child = spawn(python, ['-c', render, directory, String(start + 1)], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
      });
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
      }, 32000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(
          new Error(
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'PPT_PREVIEW_RENDERER_UNAVAILABLE'
              : 'PPT_PREVIEW_FAILED'
          )
        );
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error('PPT_PREVIEW_RENDERER_UNAVAILABLE_OR_FAILED'));
      });
    });
    const png = await readFile(path.join(directory, 'slide.png'));
    if (png.length > 4 * 1024 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error('PPT_PREVIEW_IMAGE_INVALID');
    const slides = info.slides as Array<{
      title: string;
      objects: Array<{ kind: string; text?: string; rows?: string[][]; title?: string; categories?: string[]; series?: Array<{ name: string; values: string[] }> }>;
    }>;
    return {
      format: 'pptx',
      visualMode: 'libreoffice',
      start,
      totalLocations: count,
      nextStart: start + 1 < count ? start + 1 : null,
      slideTitles: slides.map((s, i) => ({ value: i, label: `${i + 1}. ${s.title || String(i + 1)}` })),
      visualPages: [{ slide: start + 1, image: 'data:image/png;base64,' + png.toString('base64') }],
      locations: [
        {
          location: { kind: 'slide', slide: start + 1 },
          texts: slides[start].objects.filter((x) => x.kind === 'text').map((x) => ({ text: x.text || '' })),
          tables: [
            ...slides[start].objects.filter((x) => x.kind === 'table').map((x) => ({ rows: x.rows || [] })),
            ...slides[start].objects.filter(x => x.kind === 'chart').map(x => ({ rows: [[x.title || '', ...(x.series || []).map(s => s.name)], ...(x.categories || []).map((category, index) => [category, ...(x.series || []).map(s => s.values[index])])] })),
          ],
        },
      ],
      layoutBoundary: 'LibreOffice visual rendering; not Microsoft PowerPoint/WPS compatibility acceptance.',
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

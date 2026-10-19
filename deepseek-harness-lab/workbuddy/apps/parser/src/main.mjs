// This process runs in a fresh no-network, read-only container with no secrets or host mounts.
import process from 'node:process';import {Buffer} from 'node:buffer';import console from 'node:console';
/* global AbortSignal */
import yauzl from 'yauzl';
const MAX_TEXT=1024*1024;
// Library diagnostic text may contain document content; stdout is reserved for the bounded protocol.
const out=process.stdout.write.bind(process.stdout);console.log=console.warn=console.error=()=>{};
function fail(code){throw Error(code)}
function guardText(value){if(typeof value!=='string'||!value.trim())fail('NoText');if(Buffer.byteLength(value)>MAX_TEXT)fail('DocumentTooLarge');return value.split(String.fromCharCode(0)).join('').trim();}
async function inspectZip(buffer,type){
 const root={docx:'word/document.xml',xlsx:'xl/workbook.xml',pptx:'ppt/presentation.xml'}[type];let found=false,bytes=0,count=0;
 await new Promise((resolve,reject)=>{yauzl.fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(error,zip)=>{if(error)return reject(Error('UnsafeDocument'));const stop=code=>{zip.close();reject(Error(code));};zip.on('error',()=>stop('UnsafeDocument'));zip.on('end',()=>found?resolve():reject(Error('UnsupportedFile')));zip.on('entry',entry=>{
  if(++count>500||entry.uncompressedSize>10*1024*1024||(bytes+=entry.uncompressedSize)>20*1024*1024||entry.generalPurposeBitFlag&1)return stop('DocumentTooLarge');
  if(/(?:^|\/)\.\.(?:\/|$)|^\/|\\|vbaProject|embeddings\/|activeX\/|externalLinks\/|\.exe$|\.dll$/i.test(entry.fileName))return stop('UnsafeDocument');if(entry.fileName===root)found=true;
  if(!/\.(?:xml|rels)$/i.test(entry.fileName)){zip.readEntry();return;}zip.openReadStream(entry,(error,stream)=>{if(error)return stop('UnsafeDocument');let text='',actual=0;stream.on('data',chunk=>{actual+=chunk.length;if(actual>10*1024*1024){stream.destroy();stop('DocumentTooLarge');return;}text+=chunk.toString('utf8');});stream.on('error',()=>stop('UnsafeDocument'));stream.on('end',()=>{if(/<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External["']/i.test(text))return stop('UnsafeDocument');zip.readEntry();});});
 });zip.readEntry();});});
}
async function pdf(buffer){
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const task=getDocument({data:new Uint8Array(buffer),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,stopAtErrors:true,verbosity:0,cMapUrl:"/app/node_modules/pdfjs-dist/cmaps/",cMapPacked:true,standardFontDataUrl:"/app/node_modules/pdfjs-dist/standard_fonts/"});let doc;
 try{doc=await task.promise;if(doc.numPages>200)fail('DocumentTooLarge');const nonempty=v=>v instanceof Map?v.size>0:!!v&&Object.keys(v).length>0;if(nonempty(await doc.getJSActions())||nonempty(await doc.getAttachments())||doc.isPureXfa)fail('UnsafeDocument');
  const pages=[];let length=0;for(let pageNumber=1;pageNumber<=doc.numPages;pageNumber++){const page=await doc.getPage(pageNumber);if(nonempty(await page.getJSActions()))fail('UnsafeDocument');const annotations=await page.getAnnotations();if(annotations.some(a=>a.actions||['RichMedia','FileAttachment','Screen','Movie','Sound'].includes(a.subtype)))fail('UnsafeDocument');const content=await page.getTextContent();const text=content.items.map(x=>typeof x.str==='string'?x.str+(x.hasEOL?'\n':' '):'').join('');length+=Buffer.byteLength(text);if(length>MAX_TEXT)fail('DocumentTooLarge');pages.push({page:pageNumber,text});page.cleanup();}
  if(!pages.some(p=>p.text.trim()))fail('NoText');return {text:guardText(pages.map(p=>`[第 ${p.page} 页]\n${p.text}`).join('\n\n')),pages:pages.map(p=>({page:p.page,characters:p.text.length})),parser:'pdfjs-dist@6.3.289'};
 }catch(e){if(e.name==='PasswordException')fail('EncryptedDocument');throw e;}finally{await task.destroy();}
}
async function office(buffer,type){await inspectZip(buffer,type);const {OfficeParser}=await import('officeparser');const warnings=[];const ast=await OfficeParser.parseOffice(buffer,{fileType:type,ocr:false,extractAttachments:false,includeRawContent:false,ignoreNotes:false,ignoreHeadersAndFooters:false,decompressionLimits:{maxUncompressedBytes:20*1024*1024,maxZipEntries:500,maxTableCells:100000},abortSignal:AbortSignal.timeout(15000),onWarning:w=>warnings.push(w.code||'ParserWarning')});const value=await ast.to('text',{imageMode:'none'});return {text:guardText(value.value),parser:'officeparser@8.0.0',warnings:[...new Set(warnings)].slice(0,10)};}
try{let size=0;const chunks=[];for await(const chunk of process.stdin){size+=chunk.length;if(size>29*1024*1024)fail('DocumentTooLarge');chunks.push(chunk);}const q=JSON.parse(Buffer.concat(chunks).toString());if(!['pdf','docx','xlsx','pptx'].includes(q.type)||typeof q.data!=='string')fail('UnsupportedFile');const data=Buffer.from(q.data,'base64');if(data.length>20*1024*1024)fail('DocumentTooLarge');const result=q.type==='pdf'?await pdf(data):await office(data,q.type);out(JSON.stringify({ok:true,...result})+'\n');}
catch(e){const known=['UnsupportedFile','UnsafeDocument','DocumentTooLarge','NoText','EncryptedDocument'];out(JSON.stringify({ok:false,error:known.includes(e.message)?e.message:e.name==='AbortError'?'Timeout':'ParserError'})+'\n');process.exitCode=1;}

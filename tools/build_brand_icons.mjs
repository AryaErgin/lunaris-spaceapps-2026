// Rebuild only the favicon derivatives. Requires Node24+ and a local Chrome;
// no npm packages, image services, or network assets are used.
// Run: node tools/build_brand_icons.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {access,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,delimiter,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),source=join(root,'web/favicon.svg');
const sizes=[16,32],signature=Buffer.from('89504e470d0a1a0a','hex');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function chromeExecutable(){
  const defaults=process.platform==='win32'?[join(process.env.PROGRAMFILES??'C:/Program Files','Google/Chrome/Application/chrome.exe'),join(process.env.LOCALAPPDATA??'','Google/Chrome/Application/chrome.exe')]:process.platform==='darwin'?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']:['google-chrome','chromium','chromium-browser'];
  for(const candidate of process.env.LUNARIS_CHROME?[process.env.LUNARIS_CHROME]:defaults){
    const paths=candidate.includes('/')||candidate.includes('\\')?[candidate]:(process.env.PATH??'').split(delimiter).map(directory=>join(directory,candidate));
    for(const path of paths)try{await access(path);return path;}catch{}
  }
  throw Error('Chrome was not found. Set LUNARIS_CHROME to its executable path.');
}
assert.equal(typeof WebSocket,'function','Use Node24+ with its built-in WebSocket.');
const svg=await readFile(source,'utf8'),profile=await mkdtemp(join(tmpdir(),'lunaris-brand-icons-'));
const executable=await chromeExecutable();
const browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--disable-extensions','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
let socket,stderr='',startupError;
browser.stderr.on('data',data=>{stderr=(stderr+data).slice(-1200);});browser.on('error',error=>{startupError=error;});
try{
  let port;const began=Date.now();
  while(!port&&Date.now()-began<20000){
    if(startupError)throw startupError;
    try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];}catch{await pause(50);}
  }
  if(!port)throw Error('Chrome startup timed out. '+stderr);
  const tabs=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
  socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await once(socket,'open');
  let sequence=0;const pending=new Map();
  socket.addEventListener('message',({data})=>{const message=JSON.parse(data),callback=pending.get(message.id);if(callback){pending.delete(message.id);message.error?callback.reject(Error(JSON.stringify(message.error))):callback.resolve(message.result);}});
  const command=(method,params={})=>new Promise((resolveResult,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Chrome command timed out: '+method));},20000);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolveResult(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id,method,params}));
  });
  await command('Network.enable');await command('Network.setBlockedURLs',{urls:['http://*','https://*']});
  const images=[];
  for(const size of sizes){
    const expression=`(async()=>{
      const document=new DOMParser().parseFromString(${JSON.stringify(svg)},'image/svg+xml');
      if(document.querySelector('parsererror')||document.documentElement.localName!=='svg')throw Error('Invalid SVG source.');
      const element=document.documentElement;element.setAttribute('width','${size}');element.setAttribute('height','${size}');
      const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(element)],{type:'image/svg+xml'}));
      try{
        const image=new Image();await new Promise((ok,no)=>{image.onload=ok;image.onerror=()=>no(Error('SVG image failed to decode.'));image.src=url;});
        const canvas=window.document.createElement('canvas');canvas.width=canvas.height=${size};
        const context=canvas.getContext('2d',{alpha:true,colorSpace:'srgb'});context.clearRect(0,0,${size},${size});context.drawImage(image,0,0,${size},${size});
        const pixels=context.getImageData(0,0,${size},${size}).data;if(!pixels.some((value,index)=>index%4===3&&value>0))throw Error('SVG rendered no visible pixels.');
        return canvas.toDataURL('image/png').split(',')[1];
      }finally{URL.revokeObjectURL(url);}
    })()`;
    const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
    const bytes=Buffer.from(result.result.value,'base64');assert(bytes.subarray(0,8).equals(signature));
    assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);images.push({size,bytes});
  }
  // Standard ICONDIR + two ICONDIRENTRY records, each containing its own PNG.
  // Render each size independently: do not downsample the32px image to16px.
  const header=Buffer.alloc(6),entries=Buffer.alloc(16*images.length);header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);
  let offset=header.length+entries.length;
  images.forEach(({size,bytes},index)=>{const at=index*16;entries[at]=entries[at+1]=size;entries.writeUInt16LE(1,at+4);entries.writeUInt16LE(32,at+6);entries.writeUInt32LE(bytes.length,at+8);entries.writeUInt32LE(offset,at+12);offset+=bytes.length;});
  const ico=Buffer.concat([header,entries,...images.map(image=>image.bytes)]);
  assert.equal(ico.readUInt16LE(0),0);assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),2);
  for(const{size,bytes}of images){const output=join(root,`web/favicon-${size}.png`);await writeFile(output,bytes);console.log(`web/favicon-${size}.png: ${size}x${size}, ${bytes.length} bytes, SHA256 ${digest(bytes)}`);}
  await writeFile(join(root,'web/favicon.ico'),ico);console.log(`web/favicon.ico: 16x16 +32x32 PNG frames, ${ico.length} bytes, SHA256 ${digest(ico)}`);
  console.log(`Source SHA256 ${digest(Buffer.from(svg))}; ${(await command('Browser.getVersion')).product}`);
}finally{
  socket?.close();browser.kill();
  // Keep this uniquely owned OS-temp profile rather than issue a recursive
  // Windows deletion against a computed directory. It contains no user session.
  console.log('Isolated temporary Chrome profile: '+profile);
}

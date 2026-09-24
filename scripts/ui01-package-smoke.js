"use strict";
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),assert=require("node:assert/strict"),{spawn}=require("node:child_process");
const output=path.resolve("ui-verification/ui01-2.1");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-link-ui01-package-"));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let child,socket;
async function connect(){
 const exe=path.resolve(process.env.CODEX_LINK_SMOKE_EXE || "dist/win-unpacked/Codex Link.exe");
 child=spawn(exe,[`--user-data-dir=${path.join(root,"profile")}`,"--remote-debugging-port=4399"],{windowsHide:true,stdio:"ignore",env:{...process.env,CODEX_LINK_CONFIG_FILE:path.join(root,"config.json"),CODEX_LINK_ALLOW_TEST_INSTANCE:"1"}});
 let target;
 for(let n=0;n<150;n++){
  try{target=(await(await fetch("http://127.0.0.1:4399/json/list")).json()).find(t=>t.type==="page"&&t.url.startsWith("http://127.0.0.1:"));if(target)break;}catch{}
  if(child.exitCode!==null)throw Error("Packaged app exited: "+child.exitCode);
  await delay(100);
 }
 assert.ok(target,"Packaged app page must start");
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 let id=0;const callbacks=new Map();
 socket.onmessage=e=>{const m=JSON.parse(e.data);if(callbacks.has(m.id)){const c=callbacks.get(m.id);callbacks.delete(m.id);m.error?c.reject(Error(m.error.message)):c.resolve(m.result);}};
 async function send(method,params={}){return new Promise((resolve,reject)=>{const key=++id;callbacks.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method,params}));});}
 async function run(expression){const r=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result?.value;}
 async function until(expression){for(let n=0;n<150;n++){if(await run(expression))return;await delay(100);}throw Error("Timeout: "+expression);}
 await until('typeof state !== "undefined" && state.audit && state.config');
 return {run,send,until,url:target.url};
}
async function close(client){try{await Promise.race([client.send("Browser.close"),delay(1000)]);}catch{}socket?.close();for(let n=0;n<30&&child.exitCode===null;n++)await delay(100);if(child.exitCode===null)child.kill();}
(async()=>{
 try{await fetch("http://127.0.0.1:4399/json/version");throw Error("Debug port is already occupied");}catch(e){if(e.message==="Debug port is already occupied")throw e;}
 const fixture=await(await fetch("http://127.0.0.1:4391/api/config")).json();assert.match(fixture.codexHome,/codex-link-ui01-/);
 fixture.cloudDir=path.join(root,"backups");fixture.appearance={theme:"light",reduceMotion:false};fs.writeFileSync(path.join(root,"config.json"),JSON.stringify(fixture));
 let client=await connect();
 const identity=await client.run('({title:document.title,desktop:window.codexLinkDesktop?.isDesktop,css:!!document.querySelector("link[href*=ui01]"),source:state.config.codexHome})');assert.equal(identity.title,"Codex Link 2.1");assert.equal(identity.desktop,true);assert.equal(identity.css,true);
 await client.run('switchView("backup");document.querySelector("#createBackupButton").click()');await client.until('state.backups.length === 1');
 await client.run('switchView("settings");document.querySelector("[data-ui01-theme=dark]").click();document.querySelector("#ui01ReduceMotion").click()');await client.until('document.querySelector("#ui01AppearanceStatus").textContent.includes("已保存")');
 const firstOrigin=new URL(client.url).origin;await close(client);await delay(400);client=await connect();
 await client.run('window.ui01.ready');assert.equal(await client.run('document.body.dataset.theme'),"dark");assert.equal(await client.run('document.body.dataset.reduceMotion'),"true");assert.equal(await client.run('state.backups.length'),1);
 const shot=await client.send("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(output,"packaged-dark.png"),Buffer.from(shot.data,"base64"));
 const report={passed:true,version:"2.1.0",identity,firstOrigin,secondOrigin:new URL(client.url).origin,checks:["packaged desktop bridge","UI-01 assets included","real backup creation","appearance survives full application restart","backup persists after restart"],fixture:root,date:new Date().toISOString()};
 fs.writeFileSync(path.join(output,"package-smoke.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));await close(client);
})().catch(e=>{console.error(e);socket?.close();if(child&&child.exitCode===null)child.kill();process.exitCode=1;});

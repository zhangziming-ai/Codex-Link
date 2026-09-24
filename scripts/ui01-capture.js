"use strict";
const fs=require("node:fs"),path=require("node:path");
const {app,BrowserWindow}=require("electron");
const width=Number(process.argv[2] || 1440),height=Number(process.argv[3] || 1000);
const output=path.join(process.cwd(),"ui-verification","ui01-2.1",process.argv[2] ? `${width}x${height}` : "");
fs.mkdirSync(output,{recursive:true});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 await app.whenReady();
 const win=new BrowserWindow({width,height,useContentSize:true,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});
 const errors=[];win.webContents.on("console-message",(_event,details)=>{if(details?.level==="error")errors.push(details.message);});
 await win.loadURL("http://127.0.0.1:4391");
 await delay(1400);
 await win.webContents.executeJavaScript('document.querySelector("[data-ui01-theme=light]").click();');
 const reports=[];
 for(const view of ["overview","backup","restore","manager","settings"]){
  await win.webContents.executeJavaScript('switchView("'+view+'");');
  if(view==="restore")await win.webContents.executeJavaScript('(async()=>{document.querySelector("#restoreSnapshotInput").value=state.backups[0].snapshotDir;resetRestoreSelection();await restorePlan();if(!state.restorePlan)throw new Error("Restore plan failed during capture");})()');
  await delay(700);
  const shot=await win.webContents.capturePage();fs.writeFileSync(path.join(output,view+".png"),shot.toPNG());
  reports.push(await win.webContents.executeJavaScript('({view:document.body.dataset.currentView,title:document.querySelector("#viewTitle").textContent,bodyWidth:document.body.scrollWidth,viewport:innerWidth,errors:document.querySelector("#backupResult").textContent,overflow:[...document.querySelectorAll(".view.active *")].filter(e=>{let r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left<0)}).slice(0,15).map(e=>({tag:e.tagName,id:e.id,cls:e.className}))})'));
 }
 fs.writeFileSync(path.join(output,"capture-report.json"),JSON.stringify({reports,errors},null,2));
 console.log(JSON.stringify({output,reports,errors}));win.destroy();app.quit();
})().catch(e=>{console.error(e);app.exit(1)});

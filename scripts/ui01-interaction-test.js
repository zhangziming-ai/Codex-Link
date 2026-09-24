"use strict";
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const {app,BrowserWindow}=require("electron");
const output=path.join(process.cwd(),"ui-verification","ui01-2.1");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 await app.whenReady();
 const win=new BrowserWindow({width:1440,height:1000,useContentSize:true,show:false,webPreferences:{partition:"ui01-regression",contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});
 const run=code=>win.webContents.executeJavaScript(code);
 async function until(code){for(let n=0;n<120;n++){if(await run(code))return;await delay(100);}throw Error("Timed out: "+code);}
 const checks=[];
 async function check(name,fn){await fn();checks.push(name);console.log("PASS "+name);}
 await win.loadURL("http://127.0.0.1:4391");
 await until('state.audit && state.backups.length > 0');
 const source=await run('state.config.codexHome');
 assert.match(source,/codex-link-ui01-[^\\/]+[\\/]source$/); // Never exercise backup writes on a real user profile.
 await check("navigation exposes each selected page",async()=>{
  for(const view of ["overview","backup","restore","manager","settings"]){await run(`document.querySelector('[data-view="${view}"]').click()`);assert.equal(await run('document.querySelector(".view.active").id'),view);}
 });
 await check("appearance and reduced motion survive reload",async()=>{
  await run('document.querySelector("[data-ui01-theme=dark]").click();document.querySelector("#ui01ReduceMotion").click()');
  assert.equal(await run('document.body.dataset.theme'),"dark");
  await until('document.querySelector("#ui01AppearanceStatus").textContent.includes("已保存")');
  await win.reload();await until('state.audit && state.backups.length > 0');
  assert.equal(await run('document.body.dataset.theme'),"dark");
  assert.equal(await run('document.body.dataset.reduceMotion'),"true");
  assert.equal(await run('(async()=>{const config=await (await fetch("/api/config")).json();return config.appearance.theme})()'),"dark");
  assert.match(await run('document.querySelector(".brand-mark-motion").src'),/brand-glass-still\.png$/);
  await run('switchView("settings")');await delay(300);fs.writeFileSync(path.join(output,"settings-dark.png"),(await win.webContents.capturePage()).toPNG());
  await run('document.querySelector("[data-ui01-theme=light]").click();document.querySelector("#ui01ReduceMotion").click()');
 });
 await check("snapshot search and detail selection agree",async()=>{
  await run('switchView("manager");document.querySelectorAll("[data-select-backup]")[1].click()');
  assert.equal(await run('document.querySelector("#managerBackupDetail [data-use-backup]").dataset.useBackup === state.backups[1].snapshotDir'),true);
  await run('const search=document.querySelector("#ui01BackupSearch");search.value="no-such-snapshot";search.dispatchEvent(new Event("input",{bubbles:true}))');
  assert.equal(await run('document.querySelectorAll("#backupList .snapshot-card").length'),0);
  assert.equal(await run('document.querySelector("#backupList").textContent.includes("没有匹配")'),true);
  await run('document.querySelector("#ui01BackupSearch").value="";document.querySelector("#ui01BackupSearch").dispatchEvent(new Event("input",{bubbles:true}))');
 });
 await check("backup selection is live and credentials stay excluded",async()=>{
  await run('switchView("backup");document.querySelector("[data-include=memories]").click()');
  assert.equal(await run('selectedInclude().memories'),false);
  assert.equal(await run('document.querySelector("[data-include=auth]").disabled'),true);
  await run('document.querySelector("#resetRecommendedButton").click()');assert.equal(await run('selectedInclude().memories'),true);
 });
 await check("preview and create use the real isolated backup service",async()=>{
  await run('document.querySelector("#previewBackupButton").click()');
  await until('state.backupOperation?.finishedAt && document.querySelector("#backupResult").textContent.includes("snapshotDir")');
  const before=await run('state.backups.length');
  await run('document.querySelector("#createBackupButton").click()');
  await until(`state.backups.length === ${before+1}`);
  assert.equal(await run('document.querySelector("#ui01BackupCount").textContent'),String(before+1).padStart(2,"0"));
 });
 await check("restore plans expose live item selection without writing user data",async()=>{
  await run('document.querySelector("#restoreSnapshotInput").value=state.backups[0].snapshotDir;resetRestoreSelection();switchView("restore")');
  await run('restorePlan()');
  assert.equal(await run('state.restoreAvailableItems.length > 0'),true);
  await run('document.querySelector("#restoreClearButton").click()');
  assert.equal(await run('state.restoreSelectedItemIds.size'),0);
  await run('document.querySelector("#restoreSelectAllButton").click()');
  assert.equal(await run('state.restoreSelectedItemIds.size > 0'),true);
 });
 await check("one selected conversation restores into the isolated target",async()=>{
  await run('document.querySelector("#restoreClearButton").click()');
  const item=await run('state.restoreAvailableItems.find(item=>item.kind === "conversation" && item.restorable).id');
  await run(`document.querySelector('[data-restore-item="' + CSS.escape(${JSON.stringify(item)}) + '"]').click()`);
  await run('restorePlan()');
  const plan=await run('({canExecute:state.restorePlan.canExecute,mode:state.restorePlan.restoreMode,target:state.restorePlan.targetCodexHome,selected:state.restorePlan.restoreSelection.selectedItemIds})');
  assert.equal(plan.mode,"isolated_test");assert.match(plan.target,/CodexLink-Restore-Test/);assert.equal(plan.canExecute,true);assert.deepEqual(plan.selected,[item]);
  await run('window.confirm=()=>true;document.querySelector("#restoreExecuteButton").click()');
  await until('state.restoreOperation?.finishedAt');
  assert.equal(await run('state.restoreOperation.progress'),100);
  assert.equal(await run('document.querySelector("#restoreSummary").textContent.includes("恢复完成")'),true);
 });
 await check("errors remain visible on settings",async()=>{
  await run('switchView("settings");showError(new Error("UI-01 test error"))');
  assert.equal(await run('document.querySelector("#ui01Error").hidden'),false);
  await run('document.querySelector("#ui01Error button").click()');assert.equal(await run('document.querySelector("#ui01Error").hidden'),true);
 });
 fs.writeFileSync(path.join(output,"interaction-report.json"),JSON.stringify({passed:true,checks,fixture:source,date:new Date().toISOString()},null,2));
 win.destroy();app.quit();
})().catch(e=>{console.error(e);app.exit(1)});

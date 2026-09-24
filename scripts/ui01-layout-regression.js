"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const output = path.resolve("ui-verification/ui01-2.1");
fs.mkdirSync(output, { recursive: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 900, height: 620, useContentSize: true, show: false,
    webPreferences: {
      partition: "ui01-layout-21", contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false, offscreen: true
    }
  });
  const run = async (code) => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (error) { console.error("Renderer script failed:", code, errors); throw error; }
  };
  const checks = [];
  const errors = [];
  win.webContents.on("console-message", (_event, details) => {
    if (details?.level === "error") errors.push(details.message);
  });
  const check = async (name, fn) => {
    await fn();
    checks.push(name);
    console.log("PASS " + name);
  };
  const shot = async (name) => {
    fs.writeFileSync(path.join(output, name + ".png"), (await win.webContents.capturePage()).toPNG());
  };
  await win.loadURL("http://127.0.0.1:4391");
  for (let i = 0; i < 100 && !(await run("state.backups.length > 0")); i++) await delay(100);
  assert.ok(await run("state.backups.length > 0"));
  assert.match(await run("state.config.codexHome"), /codex-link-ui01-[^\\/]+[\\/]source$/);

  await check("busy backup status remains legible at 900x620", async () => {
    await run(`switchView("backup");document.querySelector("#backupResultVisual").classList.add("busy");document.querySelector("#backupResultVisualTitle").textContent="正在创建备份";document.querySelector("#backupResultVisualBody").textContent="正在写入对话记录 · rollout-2026-09-09T18-36-13-01a085bd-5663-7f53-9429-93c81537455.jsonl";document.querySelector("#backupProgress").hidden=false;document.querySelector("#backupProgressPercent").textContent="80%";`);
    await delay(500);
    await run('document.querySelector(".backup-result-panel").scrollIntoView({block:"start",behavior:"instant"})');
    await delay(300);
    const result = await run(`(() => { const main=document.querySelector(".main"), panel=document.querySelector(".backup-result-panel"), title=document.querySelector("#backupResultVisualTitle"); const a=panel.getBoundingClientRect(),b=title.getBoundingClientRect(); return {bodyWidth:document.body.scrollWidth, viewport:innerWidth, viewportHeight:innerHeight, position:getComputedStyle(panel).position, panel:a.toJSON(), title:b.toJSON(), scrollTop:main.scrollTop}; })()`);
    assert.equal(result.bodyWidth, result.viewport);
    assert.equal(result.position, "static");
    assert.ok(result.title.left >= result.panel.left && result.title.right <= result.panel.right);
    assert.ok(result.title.top >= result.panel.top);
    assert.ok(result.panel.top < result.viewportHeight, "busy backup panel must be reachable in viewport");
    await shot("backup-busy-900x620");
  });

  await check("busy backup status fits a 402px preview", async () => {
    win.setContentSize(402, 874);
    await delay(400);
    await run('document.querySelector(".backup-result-panel").scrollIntoView({block:"start",behavior:"instant"})');
    await delay(300);
    const result = await run(`(() => {const card=document.querySelector(".backup-result-panel").getBoundingClientRect(),title=document.querySelector("#backupResultVisualTitle").getBoundingClientRect();return{width:document.body.scrollWidth,viewport:innerWidth,card:card.toJSON(),title:title.toJSON()}})()`);
    assert.equal(result.width, result.viewport);
    assert.ok(result.card.top < 874 && result.title.top >= result.card.top);
    assert.ok(result.title.right <= result.card.right);
    await shot("backup-busy-402x874");
    win.setContentSize(900, 620);
    await delay(300);
  });

  await check("large restore selection uses one page scroll and one conversation scroll", async () => {
    await run(`(async()=>{document.querySelector("#restoreSnapshotInput").value=state.backups[0].snapshotDir;resetRestoreSelection();switchView("restore");await restorePlan();if(!state.restorePlan)throw Error("Restore plan missing");const base=state.restoreAvailableItems.filter(item=>item.kind==="conversation");for(let n=0;n<20;n++)for(const item of base)state.restoreAvailableItems.push({...item,id:item.id+"-layout-"+n});state.restoreExpandedGroups.add("projects");const first=base[0];state.restoreOpenProjectIds.add(restoreProjectKey(first));renderRestoreSelection();})()`);
    const result = await run(`(() => { const main=document.querySelector(".main"),groups=document.querySelector("#restoreSelectionGroups"),project=groups.querySelector('[data-restore-group-key="projects"]'),body=project.querySelector(".restore-selection-group-body"),conversations=project.querySelector(".restore-project-conversations:not([hidden])"),next=project.nextElementSibling; return {bodyWidth:document.body.scrollWidth,viewport:innerWidth,groupsOverflow:getComputedStyle(groups).overflowY,groupsClient:groups.clientHeight,groupsScroll:groups.scrollHeight,bodyOverflow:getComputedStyle(body).overflowY,bodyClient:body.clientHeight,bodyScroll:body.scrollHeight,conversationsClient:conversations.clientHeight,conversationsScroll:conversations.scrollHeight,projectBottom:project.getBoundingClientRect().bottom,nextTop:next?.getBoundingClientRect().top,mainScroll:main.scrollHeight,mainClient:main.clientHeight}; })()`);
    assert.equal(result.bodyWidth, result.viewport);
    assert.equal(result.groupsOverflow, "visible");
    assert.equal(result.bodyOverflow, "visible");
    assert.ok(result.groupsScroll <= result.groupsClient + 1);
    assert.ok(result.bodyScroll <= result.bodyClient + 1);
    assert.ok(result.conversationsScroll > result.conversationsClient);
    assert.ok(result.nextTop >= result.projectBottom - 1);
    assert.ok(result.mainScroll > result.mainClient);
    await run('document.querySelector(".restore-project-conversations:not([hidden])").scrollTop=150;document.querySelector("#restoreSelectionGroups").scrollIntoView({block:"start"})');
    await delay(450);
    await shot("restore-expanded-900x620");
  });

  await check("manager detail scrolls away instead of covering later content", async () => {
    win.setContentSize(1340, 860);
    await delay(450);
    await run('switchView("manager");document.querySelector(".manager-detail-panel").scrollIntoView({block:"start"})');
    await delay(450);
    const before = await run('({view:document.body.dataset.currentView,top:document.querySelector(".manager-detail-panel").getBoundingClientRect().top,position:getComputedStyle(document.querySelector(".manager-detail-panel")).position,bodyWidth:document.body.scrollWidth,viewport:innerWidth})');
    assert.equal(before.view, "manager");
    await run('document.querySelector(".main").scrollTop+=500');
    const after = await run('({top:document.querySelector(".manager-detail-panel").getBoundingClientRect().top,scrollTop:document.querySelector(".main").scrollTop})');
    assert.equal(before.position, "static");
    assert.equal(before.bodyWidth, before.viewport);
    assert.ok(before.top - after.top > 300);
    assert.ok(after.scrollTop > 0);
    await delay(300);
    await shot("manager-scrolled-1340x860");
  });

  assert.deepEqual(errors, []);
  const report = { passed: true, checks, errors, date: new Date().toISOString() };
  fs.writeFileSync(path.join(output, "layout-regression.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  win.destroy();
  app.quit();
})().catch((error) => { console.error(error); app.exit(1); });

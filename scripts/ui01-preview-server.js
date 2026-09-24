"use strict";
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const fixtureRoot=fs.mkdtempSync(path.join(os.tmpdir(),"codex-link-ui01-"));
const source=path.join(fixtureRoot,"source"),cloud=path.join(fixtureRoot,"backups");
for(const dir of ["sessions","archived_sessions","memories","skills","projects"])fs.mkdirSync(path.join(source,dir),{recursive:true});
fs.writeFileSync(path.join(source,"config.toml"),'model = "codex-link-ui01-test"\n');
fs.writeFileSync(path.join(source,"AGENTS.md"),"# UI-01 fixture rules\n");
for(let n=1;n<=12;n++){
 const folder=n<=10?"sessions":"archived_sessions";
 const cwd=path.join(source,"projects",n%2?"Design":"Research");fs.mkdirSync(cwd,{recursive:true});
 const data=[{type:"session_meta",timestamp:"2026-09-08T06:32:00.000Z",payload:{id:"ui01-session-"+n,cwd}},{type:"event_msg",payload:{type:"user_message",message:n%2?"界面设计与排版研究":"资料整理与项目规划"}}];
 fs.writeFileSync(path.join(source,folder,"session-"+n+".jsonl"),data.map(JSON.stringify).join("\n")+"\n");
}
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(path.join(source,"state_5.sqlite"));
db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, title TEXT)");
const insert=db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)");
for(let n=1;n<=12;n++)insert.run("ui01-session-"+n,path.join(source,"projects",n%2?"Design":"Research"),path.join(source,n<=10?"sessions":"archived_sessions","session-"+n+".jsonl"),n%2?"界面设计与排版研究":"资料整理与项目规划");
db.close();
for(const [name,title] of [["design-notes","界面设计笔记"],["research-plan","项目研究计划"],["storyboard","分镜结构"]]){
 fs.mkdirSync(path.join(source,"skills",name),{recursive:true});
 fs.writeFileSync(path.join(source,"skills",name,"SKILL.md"),"---\nname: "+name+"\ndescription: "+title+"\n---\n# "+title+"\n");
}
fs.writeFileSync(path.join(source,"memories","preferences.md"),"# 偏好\n圆润玻璃与艺术排版。\n");
process.env.CODEX_LINK_CONFIG_FILE=path.join(fixtureRoot,"config.json");
const backend=require("../server");
const config=backend.saveConfig({...backend.loadConfig(),codexHome:source,cloudDir:cloud,retainSnapshots:10});
for(let n=0;n<3;n++){fs.appendFileSync(path.join(source,"memories","preferences.md"),"\n记录 "+n);backend.createSnapshot({...config,dryRun:false});}
backend.server.listen(4391,"127.0.0.1",()=>console.log(JSON.stringify({url:"http://127.0.0.1:4391",fixtureRoot,source,cloud,config:process.env.CODEX_LINK_CONFIG_FILE})));

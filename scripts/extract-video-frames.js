"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { app, BrowserWindow } = require("electron");

const videoPath = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(process.cwd(), "video-frames"));
const frameCount = Math.max(3, Math.min(12, Number(process.argv[4] || 6)));

if (!fs.existsSync(videoPath)) {
  console.error(`Video not found: ${videoPath}`);
  process.exit(2);
}

app.commandLine.appendSwitch("disable-gpu");

app.whenReady().then(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const win = new BrowserWindow({
    show: false,
    width: 960,
    height: 540,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      webSecurity: false
    }
  });

  const source = pathToFileURL(videoPath).href;
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#05070b}
    video{display:block;width:100%;height:100%;object-fit:contain;background:#05070b}
  </style><video id="video" preload="auto" muted src="${source}"></video>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const metadata = await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const v=document.getElementById("video");
    const done=()=>resolve({duration:v.duration,width:v.videoWidth,height:v.videoHeight});
    if(v.readyState>=1) done();
    else {
      v.addEventListener("loadedmetadata",done,{once:true});
      v.addEventListener("error",()=>reject(new Error("video metadata failed")),{once:true});
    }
  })`, true);

  const times = Array.from({ length: frameCount }, (_, index) =>
    metadata.duration * (index / Math.max(1, frameCount - 1)) * 0.96
  );
  const frames = [];

  for (let index = 0; index < times.length; index += 1) {
    const time = times[index];
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const v=document.getElementById("video");
      const done=()=>requestAnimationFrame(()=>requestAnimationFrame(resolve));
      v.addEventListener("seeked",done,{once:true});
      v.addEventListener("error",()=>reject(new Error("video seek failed")),{once:true});
      v.currentTime=${JSON.stringify(time)};
    })`, true);
    const image = await win.webContents.capturePage();
    const fileName = `frame-${String(index + 1).padStart(2, "0")}-${time.toFixed(2).replace(".", "_")}s.png`;
    fs.writeFileSync(path.join(outputDir, fileName), image.toPNG());
    frames.push({ index: index + 1, time, fileName });
  }

  const result = { videoPath, outputDir, ...metadata, frames };
  fs.writeFileSync(path.join(outputDir, "metadata.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});

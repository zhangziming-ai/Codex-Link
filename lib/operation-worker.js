"use strict";

const { parentPort, workerData } = require("node:worker_threads");

function send(type, payload = {}) {
  parentPort.postMessage({ type, ...payload });
}

function report(event) {
  send("progress", { event });
}

try {
  const backend = require("../server");
  if (workerData.operation === "backup") {
    const result = backend.createSnapshot({ ...workerData.payload, onProgress: report });
    send("result", { result });
  } else if (workerData.operation === "restore") {
    const { executeRestoreTransaction } = require("./restore-engine");
    const plan = backend.restorePlan({ ...workerData.payload.planInput, onProgress: report });
    const result = executeRestoreTransaction({
      plan,
      cloudDir: workerData.payload.cloudDir,
      allowUnverified: Boolean(workerData.payload.allowUnverified),
      confirmHighRisk: Boolean(workerData.payload.confirmHighRisk),
      onProgress: report
    });
    send("result", { result });
  } else {
    throw new Error(`Unknown operation worker task: ${workerData.operation}`);
  }
} catch (error) {
  send("error", {
    error: error.message || String(error),
    details: error.details || null,
    stack: error.stack || ""
  });
}

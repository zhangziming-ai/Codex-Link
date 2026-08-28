"use strict";

const fs = require("fs");

function validateMacosReleaseEvidence(reportPath, expectedVersion) {
  if (!fs.existsSync(reportPath)) {
    return { pass: false, evidence: `缺少 Apple Silicon 实机报告：${reportPath}` };
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const validation = report.validation || {};
    const artifacts = report.artifacts || {};
    const failures = [];
    if (report.status !== "passed") failures.push("status 不是 passed");
    if (report.host?.os !== "macOS" || report.host?.arch !== "arm64") failures.push("主机不是 macOS arm64");
    if (report.product?.version !== expectedVersion) failures.push(`版本不是 ${expectedVersion}`);
    if (report.product?.bundleId !== "com.codexlink.desktop") failures.push("Bundle ID 不匹配");
    if (report.product?.minimumSystemVersion !== "12.0") failures.push("最低系统版本不是 12.0");
    if (validation.mainMachO !== "arm64" || validation.extractedZipMachO !== "arm64") failures.push("主程序或 ZIP 不是纯 arm64");
    if (validation.dmgVerifiedAndMounted !== true || validation.applicationsSymlink !== true) failures.push("DMG 未完成验证和挂载");
    if (validation.zipIntegrity !== true) failures.push("ZIP 完整性未通过");
    if (validation.extractedZipLaunchSeconds < 8 || validation.extractedZipStayedAlive !== true) failures.push("ZIP 解压应用未持续启动 8 秒");
    if (validation.customIcon !== true) failures.push("自定义图标未验证");
    for (const [name, artifact] of Object.entries({ dmg: artifacts.dmg, zip: artifacts.zip })) {
      if (!artifact?.path || !Number.isFinite(Number(artifact.bytes)) || Number(artifact.bytes) <= 0 || !/^[a-f0-9]{64}$/i.test(artifact.sha256 || "")) {
        failures.push(`${name} 产物指纹无效`);
      }
    }
    if (report.releaseMode === true) {
      if (validation.signatureVerified !== true) failures.push("发布签名未验证");
      if (validation.hardenedRuntimeVerified !== true) failures.push("hardened runtime 未验证");
      if (validation.notarizationTicketVerified !== true) failures.push("公证票据未验证");
    }
    return {
      pass: failures.length === 0,
      report,
      evidence: failures.length
        ? failures.join("；")
        : `Apple Silicon 实机通过：macOS ${report.host.version}，DMG/ZIP arm64，ZIP 启动 ${validation.extractedZipLaunchSeconds} 秒${report.releaseMode ? "，签名与公证通过" : "，内部测试模式"}`
    };
  } catch (error) {
    return { pass: false, evidence: `Mac 实机报告无法读取：${error.message}` };
  }
}

module.exports = { validateMacosReleaseEvidence };

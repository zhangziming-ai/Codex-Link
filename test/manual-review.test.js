"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MANUAL_MAX, validateManualReview } = require("../lib/manual-review");

const templatePath = path.join(__dirname, "..", "qa", "manual-review.example.json");

function validReview() {
  const value = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  value.reviewer = "QA-01";
  value.reviewerRole = "independent";
  value.confirmedIndependent = true;
  value.reviewedAt = new Date().toISOString();
  value.artifacts = [{ type: "recording", pathOrUrl: "evidence/session-01.mp4", description: "五位体验者的完整任务录像" }];
  for (const [key, max] of Object.entries(MANUAL_MAX)) {
    value.scores[key] = { score: max, max, evidence: `${key}：记录了实际任务结果、错误和体验者反馈。` };
  }
  return value;
}

function verify(value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-manual-review-"));
  const file = path.join(root, "review.json");
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  try {
    return validateManualReview(file, templatePath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("complete independent manual review passes structural validation", () => {
  const result = verify(validReview());
  assert.equal(result.valid, true);
  assert.deepEqual(result.pending, []);
  assert.equal(result.participants.total, 5);
  assert.equal(result.participants.targetUsers, 3);
  assert.equal(result.artifacts.length, 1);
});

test("template evidence and unconfirmed reviewer cannot pass release validation", () => {
  const value = validReview();
  value.confirmedIndependent = false;
  value.scores.productValue.evidence = JSON.parse(fs.readFileSync(templatePath, "utf8")).scores.productValue.evidence;
  const result = verify(value);
  assert.equal(result.valid, false);
  assert.match(result.evidence, /confirmedIndependent/);
  assert.match(result.evidence, /productValue.*模板说明/);
});

test("participant counts and evidence artifacts are mandatory", () => {
  const value = validReview();
  value.participants = value.participants.slice(0, 2);
  value.artifacts = [];
  const result = verify(value);
  assert.equal(result.valid, false);
  assert.match(result.evidence, /至少需要 5 位体验者/);
  assert.match(result.evidence, /至少需要 3 位目标用户/);
  assert.match(result.evidence, /artifacts 至少需要 1 项/);
});

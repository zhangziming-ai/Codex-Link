"use strict";

const fs = require("fs");

const MANUAL_MAX = Object.freeze({
  productValue: 4,
  coreReliability: 5,
  usability: 7,
  informationArchitecture: 2,
  trustAndSafety: 5,
  visualExperience: 4,
  userSatisfaction: 5
});

function normalizedText(value) {
  return String(value || "").trim();
}

function validateManualReview(reviewPath, templatePath) {
  try {
    const value = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
    const template = templatePath && fs.existsSync(templatePath)
      ? JSON.parse(fs.readFileSync(templatePath, "utf8"))
      : { scores: {} };
    const scores = {};
    const pending = [];
    const errors = [];
    const reviewer = normalizedText(value.reviewer);
    const reviewedAt = normalizedText(value.reviewedAt);

    if (reviewer.length < 2 || /^(未署名|待填写|todo)$/i.test(reviewer)) errors.push("reviewer 必须填写独立验收人姓名或编号");
    if (value.reviewerRole !== "independent") errors.push("reviewerRole 必须为 independent");
    if (value.confirmedIndependent !== true) errors.push("confirmedIndependent 必须由验收人确认并设为 true");
    const reviewedTime = Date.parse(reviewedAt);
    if (!reviewedAt || !Number.isFinite(reviewedTime)) errors.push("reviewedAt 必须是有效日期时间");
    else if (reviewedTime > Date.now() + 24 * 60 * 60 * 1000) errors.push("reviewedAt 不能是未来日期");

    const participants = Array.isArray(value.participants) ? value.participants : [];
    const participantIds = participants.map((item) => normalizedText(item?.id)).filter(Boolean);
    if (participants.length < 5) errors.push("participants 至少需要 5 位体验者");
    if (participantIds.length !== participants.length || new Set(participantIds).size !== participantIds.length) {
      errors.push("每位 participant 必须有唯一的非空 id");
    }
    if (participants.filter((item) => item?.firstTimeUser === true).length < 5) errors.push("至少需要 5 位首次使用者");
    if (participants.filter((item) => item?.targetUser === true).length < 3) errors.push("至少需要 3 位目标用户");

    const artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
    if (!artifacts.length) errors.push("artifacts 至少需要 1 项截图、录像或测试记录");
    artifacts.forEach((item, index) => {
      if (!normalizedText(item?.pathOrUrl)) errors.push(`artifacts[${index}] 缺少 pathOrUrl`);
      if (!normalizedText(item?.description)) errors.push(`artifacts[${index}] 缺少 description`);
    });

    for (const [key, max] of Object.entries(MANUAL_MAX)) {
      const item = value.scores?.[key];
      if (item?.score === null || item?.score === undefined) {
        pending.push(key);
        continue;
      }
      const score = Number(item.score);
      if (!Number.isInteger(score) || score < 0 || score > max) {
        errors.push(`${key} 必须是 0-${max} 的整数`);
        continue;
      }
      const evidence = normalizedText(item.evidence);
      const templateEvidence = normalizedText(template.scores?.[key]?.evidence);
      if (!evidence) errors.push(`${key} 缺少 evidence`);
      else if (evidence === templateEvidence || /^(待填写|请填写|todo)$/i.test(evidence)) errors.push(`${key} 仍是模板说明，必须填写实际观察证据`);
      scores[key] = { score, max, evidence };
    }

    return {
      supplied: true,
      valid: errors.length === 0,
      reviewer: reviewer || "未署名",
      reviewerRole: value.reviewerRole || "未填写",
      reviewedAt: reviewedAt || "未填写",
      confirmedIndependent: value.confirmedIndependent === true,
      participants: {
        total: participants.length,
        firstTimeUsers: participants.filter((item) => item?.firstTimeUser === true).length,
        targetUsers: participants.filter((item) => item?.targetUser === true).length
      },
      artifacts: artifacts.map((item) => ({
        type: normalizedText(item?.type) || "unspecified",
        pathOrUrl: normalizedText(item?.pathOrUrl),
        description: normalizedText(item?.description)
      })),
      scores,
      pending,
      errors,
      evidence: errors.length ? errors.join("；") : `人工验收文件：${reviewPath}`
    };
  } catch (error) {
    return {
      supplied: true,
      valid: false,
      scores: {},
      pending: Object.keys(MANUAL_MAX),
      errors: [error.message],
      evidence: `无法读取人工验收：${error.message}`
    };
  }
}

module.exports = { MANUAL_MAX, validateManualReview };

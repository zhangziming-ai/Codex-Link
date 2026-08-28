#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefixed = args.find((item) => item.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : "";
}

const templatePath = path.join(root, "qa", "manual-review.example.json");
const outputPath = path.resolve(root, option("--output") || path.join("qa", "manual-review.json"));
if (fs.existsSync(outputPath)) {
  throw new Error(`Refusing to overwrite existing manual review: ${outputPath}`);
}
const value = JSON.parse(fs.readFileSync(templatePath, "utf8"));
value.reviewer = option("--reviewer") || "";
value.reviewedAt = new Date().toISOString();
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
console.log(`人工验收文件已初始化：${outputPath}`);
console.log("请由独立体验者填写参与者、证据附件、实际观察和分数，再运行 npm run manual:validate。");

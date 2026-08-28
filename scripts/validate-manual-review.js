#!/usr/bin/env node

"use strict";

const path = require("path");
const { validateManualReview } = require("../lib/manual-review");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const reviewArg = args.find((item) => !item.startsWith("--")) || path.join("qa", "manual-review.json");
const result = validateManualReview(
  path.resolve(root, reviewArg),
  path.join(root, "qa", "manual-review.example.json")
);
console.log(JSON.stringify(result, null, 2));
if (!result.valid || result.pending.length) process.exitCode = 1;

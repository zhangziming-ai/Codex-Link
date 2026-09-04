"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Worker } = require("node:worker_threads");

const { applyBackupPolicy, createSnapshot, listSnapshots, normalizeConfig, resolveRestorePointInput, restorePlan } = require("../server");
const {
  RestoreExecutionError,
  executeRestoreTransaction,
  listRollbackPoints,
  recoverInterruptedRestores,
  undoRestoreTransaction,
  verifySnapshotIntegrity
} = require("../lib/restore-engine");

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-restore-"));
  const source = path.join(root, "source", ".codex");
  const target = path.join(root, "target", ".codex");
  const cloud = path.join(root, "backups");
  write(source, "config.toml", "model = \"restored-model\"\n");
  write(source, path.join("sessions", "new.jsonl"), "{\"source\":\"backup\"}\n");
  write(target, "config.toml", "model = \"original-model\"\n");
  write(target, path.join("sessions", "old.jsonl"), "{\"source\":\"original\"}\n");
  return { root, source, target, cloud };
}

function createVerifiedSnapshot(env) {
  return createSnapshot({
    codexHome: env.source,
    cloudDir: env.cloud,
    include: {
      config: true,
      agents: false,
      sessions: true,
      archivedSessions: false,
      stateDb: false,
      memories: false,
      skills: false,
      plugins: false,
      tools: false,
      auth: false
    },
    dryRun: false
  });
}

function buildPlan(snapshotDir, target) {
  return restorePlan({
    snapshotDir,
    targetCodexHome: target,
    targetOS: process.platform
  });
}

test("settings normalization preserves mandatory rollback and excludes high-risk backup content", () => {
  const config = normalizeConfig({
    retainSnapshots: 99,
    include: { plugins: true, tools: true, auth: true },
    restorePolicy: { autoRollback: false, crossSystemAdaptation: false, excludeHighRisk: true }
  });
  const request = applyBackupPolicy(config, { include: { plugins: true, tools: true, auth: true } });

  assert.equal(config.retainSnapshots, 30);
  assert.equal(config.restorePolicy.autoRollback, true);
  assert.equal(config.restorePolicy.crossSystemAdaptation, false);
  assert.equal(request.include.plugins, false);
  assert.equal(request.include.tools, false);
  assert.equal(request.include.auth, false);
});
test("new restore points contain and pass per-file SHA-256 integrity", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  const snapshot = createVerifiedSnapshot(env);
  const integrity = verifySnapshotIntegrity(snapshot.snapshotDir);

  assert.equal(snapshot.manifest.integrity.algorithm, "sha256");
  assert.equal(snapshot.manifest.integrity.fileCount, 3);
  assert.equal(integrity.status, "verified");
  assert.equal(integrity.issueCount, 0);
});

test("restore accepts quoted paths and backup roots on a new device", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  const snapshot = createVerifiedSnapshot(env);
  const quoted = resolveRestorePointInput(`"${snapshot.snapshotDir}"`);
  assert.equal(quoted.snapshotDir, snapshot.snapshotDir);
  assert.equal(quoted.selectedFromRoot, false);

  const fromBackupRoot = resolveRestorePointInput(env.cloud);
  assert.equal(fromBackupRoot.snapshotDir, snapshot.snapshotDir);
  assert.equal(fromBackupRoot.selectedFromRoot, true);

  const plan = restorePlan({
    snapshotDir: `"${env.cloud}"`,
    targetCodexHome: env.target,
    targetOS: process.platform
  });
  assert.equal(plan.snapshotDir, snapshot.snapshotDir);
  assert.ok(plan.warnings.some((warning) => warning.includes("自动使用最新恢复点")));
});

test("verified restore creates rollback point and validates restored files", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  const snapshot = createVerifiedSnapshot(env);
  const plan = buildPlan(snapshot.snapshotDir, env.target);
  const result = executeRestoreTransaction({ plan, cloudDir: env.cloud });

  assert.equal(result.status, "restored");
  assert.equal(result.postRestoreVerification.status, "verified");
  assert.equal(fs.readFileSync(path.join(env.target, "config.toml"), "utf8"), "model = \"restored-model\"\n");
  assert.equal(fs.readFileSync(path.join(env.target, "sessions", "new.jsonl"), "utf8"), "{\"source\":\"backup\"}\n");
  assert.equal(fs.existsSync(path.join(env.target, "sessions", "old.jsonl")), true);
  assert.equal(fs.existsSync(path.join(result.rollbackPoint.path, "manifest.json")), true);
  assert.equal(verifySnapshotIntegrity(result.rollbackPoint.path).status, "verified");
});

test("raw restore skips selected optional sections that were absent at backup time", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  const snapshot = createSnapshot({
    codexHome: env.source,
    cloudDir: env.cloud,
    include: {
      config: true,
      agents: true,
      sessions: false,
      archivedSessions: false,
      stateDb: false,
      memories: false,
      skills: false,
      plugins: false,
      tools: false,
      auth: false
    },
    dryRun: false
  });
  const plan = buildPlan(snapshot.snapshotDir, env.target);

  assert.deepEqual(plan.mappings.map((item) => item.label), ["基础配置"]);
  assert.deepEqual(plan.skippedMappings, [{ label: "全局规则", reason: "not_in_restore_point" }]);
  const result = executeRestoreTransaction({ plan, cloudDir: env.cloud });
  assert.equal(result.status, "restored");
  assert.equal(fs.readFileSync(path.join(env.target, "config.toml"), "utf8"), "model = \"restored-model\"\n");
  assert.equal(fs.existsSync(path.join(env.target, "sessions", "new.jsonl")), false);
});
test("snapshot retention keeps the newest restore points and removes older ones", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const created = [];

  for (let index = 0; index < 3; index += 1) {
    write(env.source, "config.toml", `model = "version-${index}"\n`);
    created.push(createSnapshot({
      codexHome: env.source,
      cloudDir: env.cloud,
      include: {
        config: true,
        agents: false,
        sessions: false,
        archivedSessions: false,
        stateDb: false,
        memories: false,
        skills: false,
        plugins: false,
        tools: false,
        auth: false
      },
      retainSnapshots: 2,
      dryRun: false
    }));
  }

  const snapshots = listSnapshots(env.cloud);
  assert.equal(snapshots.length, 2);
  assert.equal(fs.existsSync(created[0].snapshotDir), false);
  assert.equal(fs.existsSync(created[1].snapshotDir), true);
  assert.equal(fs.existsSync(created[2].snapshotDir), true);
  assert.deepEqual(created[2].retention.removed, [created[0].manifest.id]);
  assert.equal(verifySnapshotIntegrity(created[2].snapshotDir).status, "verified");
});
test("tampered restore point is rejected before target writes", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  const snapshot = createVerifiedSnapshot(env);
  write(snapshot.snapshotDir, path.join("payload", "config.toml"), "model = \"tampered\"\n");
  const integrity = verifySnapshotIntegrity(snapshot.snapshotDir);
  assert.equal(integrity.status, "failed");

  const plan = buildPlan(snapshot.snapshotDir, env.target);
  assert.throws(
    () => executeRestoreTransaction({ plan, cloudDir: env.cloud }),
    (error) => {
      assert.equal(error instanceof RestoreExecutionError, true);
      assert.equal(error.details.phase, "source_verification");
      return true;
    }
  );
  assert.equal(fs.readFileSync(path.join(env.target, "config.toml"), "utf8"), "model = \"original-model\"\n");
  assert.equal(fs.existsSync(path.join(env.target, "sessions", "old.jsonl")), true);
});

test("mid-restore failure automatically restores and verifies original target", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  const snapshot = createVerifiedSnapshot(env);
  const plan = buildPlan(snapshot.snapshotDir, env.target);

  assert.throws(
    () => executeRestoreTransaction({
      plan,
      cloudDir: env.cloud,
      _testFailAfterApply: 1
    }),
    (error) => {
      assert.equal(error instanceof RestoreExecutionError, true);
      assert.equal(error.details.rollback.status, "rolled_back");
      assert.equal(error.details.rollback.verified, true);
      assert.equal(fs.existsSync(error.details.rollbackPoint.path), true);
      return true;
    }
  );

  assert.equal(fs.readFileSync(path.join(env.target, "config.toml"), "utf8"), "model = \"original-model\"\n");
  assert.equal(fs.readFileSync(path.join(env.target, "sessions", "old.jsonl"), "utf8"), "{\"source\":\"original\"}\n");
  assert.equal(fs.existsSync(path.join(env.target, "sessions", "new.jsonl")), false);
});



test("persisted transaction journal recovers a simulated process interruption", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  const snapshot = createVerifiedSnapshot(env);
  const plan = buildPlan(snapshot.snapshotDir, env.target);

  assert.throws(
    () => executeRestoreTransaction({
      plan,
      cloudDir: env.cloud,
      _testCrashAfterApply: 1
    }),
    /Injected process interruption/
  );

  assert.equal(fs.readFileSync(path.join(env.target, "config.toml"), "utf8"), "model = \"original-model\"\n");
  assert.equal(fs.readFileSync(path.join(env.target, "sessions", "new.jsonl"), "utf8"), "{\"source\":\"backup\"}\n");
  const recovery = recoverInterruptedRestores(env.cloud);
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].status, "recovered_rolled_back");
  assert.equal(recovery[0].rollback.verified, true);
  assert.equal(fs.readFileSync(path.join(env.target, "config.toml"), "utf8"), "model = \"original-model\"\n");
  assert.equal(fs.readFileSync(path.join(env.target, "sessions", "old.jsonl"), "utf8"), "{\"source\":\"original\"}\n");
  assert.equal(fs.existsSync(path.join(env.target, "sessions", "new.jsonl")), false);
  assert.deepEqual(recoverInterruptedRestores(env.cloud), []);

  const journal = JSON.parse(fs.readFileSync(
    path.join(recovery[0].rollbackPoint, "restore-transaction.json"),
    "utf8"
  ));
  assert.equal(journal.status, "recovered_rolled_back");
});

test("completed restores are listed separately and can be manually undone", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = createVerifiedSnapshot(env);
  const plan = buildPlan(snapshot.snapshotDir, env.target);
  const restored = executeRestoreTransaction({ plan, cloudDir: env.cloud });

  const points = listRollbackPoints(env.cloud);
  assert.equal(points.length, 1);
  assert.equal(points[0].id, restored.rollbackPoint.id);
  assert.equal(points[0].status, "completed");
  assert.equal(points[0].canUndo, true);
  assert.ok(points[0].fileCount >= 2);

  const undone = undoRestoreTransaction({ cloudDir: env.cloud, id: points[0].id, processes: [] });
  assert.equal(undone.status, "manual_rolled_back");
  assert.equal(undone.verified, true);
  assert.equal(fs.readFileSync(path.join(env.target, "config.toml"), "utf8"), "model = \"original-model\"\n");
  assert.equal(fs.readFileSync(path.join(env.target, "sessions", "old.jsonl"), "utf8"), "{\"source\":\"original\"}\n");
  assert.equal(fs.existsSync(path.join(env.target, "sessions", "new.jsonl")), false);
  assert.equal(listRollbackPoints(env.cloud)[0].canUndo, false);
});

test("manual undo preflights hashes and preserves files changed after restore", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = createVerifiedSnapshot(env);
  const restored = executeRestoreTransaction({ plan: buildPlan(snapshot.snapshotDir, env.target), cloudDir: env.cloud });
  const changed = path.join(env.target, "sessions", "new.jsonl");
  fs.writeFileSync(changed, "{\"source\":\"user-after-restore\"}\n", "utf8");

  const result = undoRestoreTransaction({ cloudDir: env.cloud, id: restored.rollbackPoint.id, processes: [] });
  assert.equal(result.status, "rollback_conflict");
  assert.equal(result.conflictCount, 1);
  assert.equal(fs.readFileSync(changed, "utf8"), "{\"source\":\"user-after-restore\"}\n");
  assert.equal(fs.readFileSync(path.join(env.target, "config.toml"), "utf8"), "model = \"restored-model\"\n");
});

test("manual undo failure restores the state from immediately before undo and remains retryable", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = createVerifiedSnapshot(env);
  const restored = executeRestoreTransaction({ plan: buildPlan(snapshot.snapshotDir, env.target), cloudDir: env.cloud });
  const restoredConfig = fs.readFileSync(path.join(env.target, "config.toml"), "utf8");
  const restoredSession = fs.readFileSync(path.join(env.target, "sessions", "new.jsonl"), "utf8");

  const result = undoRestoreTransaction({
    cloudDir: env.cloud,
    id: restored.rollbackPoint.id,
    processes: [],
    _testFailAfterItems: 1
  });
  assert.equal(result.status, "rollback_failed_safely_recovered");
  assert.equal(result.retryAllowed, true);
  assert.equal(result.undoSafetyRecovery.verified, true);
  assert.equal(fs.readFileSync(path.join(env.target, "config.toml"), "utf8"), restoredConfig);
  assert.equal(fs.readFileSync(path.join(env.target, "sessions", "new.jsonl"), "utf8"), restoredSession);
  assert.equal(listRollbackPoints(env.cloud)[0].canUndo, true);

  const retry = undoRestoreTransaction({ cloudDir: env.cloud, id: restored.rollbackPoint.id, processes: [] });
  assert.equal(retry.status, "manual_rolled_back");
});

test("custom restore writes only the selected manifest items", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  const snapshot = createVerifiedSnapshot(env);
  const available = buildPlan(snapshot.snapshotDir, env.target);
  const conversation = available.availableItems.find((item) => item.kind === "conversation");
  assert.ok(conversation, "expected an individually selectable conversation");
  const plan = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: process.platform,
    restoreSelection: {
      mode: "custom",
      itemIds: [conversation.id]
    }
  });

  assert.equal(plan.restoreSelection.mode, "custom");
  assert.deepEqual(plan.restoreSelection.selectedItemIds, [conversation.id]);
  assert.equal(plan.mappings.length, 1);
  assert.equal(path.normalize(plan.mappings[0].target), path.join(env.target, "sessions", "new.jsonl"));
  assert.equal(plan.availableItems.find((item) => item.id === "section:config").selected, false);
  assert.equal(plan.availableItems.find((item) => item.id === conversation.id).selected, true);

  executeRestoreTransaction({ plan, cloudDir: env.cloud });
  assert.equal(fs.readFileSync(path.join(env.target, "config.toml"), "utf8"), "model = \"original-model\"\n");
  assert.equal(fs.readFileSync(path.join(env.target, "sessions", "new.jsonl"), "utf8"), "{\"source\":\"backup\"}\n");
  assert.equal(fs.readFileSync(path.join(env.target, "sessions", "old.jsonl"), "utf8"), "{\"source\":\"original\"}\n");
});

test("restore catalog preserves configured Skill names and supports per-Skill selection", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  write(env.source, path.join("skills", "director-motion", "SKILL.md"), [
    "---",
    "name: director-motion-video-generation",
    "description: Generate motion prompts.",
    "---",
    "# 导演运镜视频生成",
    ""
  ].join("\n"));

  const snapshot = createSnapshot({
    codexHome: env.source,
    cloudDir: env.cloud,
    include: {
      config: false,
      agents: false,
      sessions: false,
      archivedSessions: false,
      stateDb: false,
      memories: false,
      skills: true,
      plugins: false,
      tools: false,
      auth: false
    },
    dryRun: false
  });
  const available = buildPlan(snapshot.snapshotDir, env.target);
  const skill = available.availableItems.find((item) => item.kind === "capability");

  assert.equal(skill.label, "导演运镜视频生成");
  assert.equal(skill.manifestName, "director-motion-video-generation");
  const selected = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: process.platform,
    restoreSelection: { mode: "custom", itemIds: [skill.id] }
  });
  assert.deepEqual(selected.restoreSelection.selectedItemIds, [skill.id]);
  assert.equal(selected.mappings.length, 1);
  assert.equal(path.normalize(selected.mappings[0].target), path.join(env.target, "skills", "director-motion"));
});

test("credential files are never restorable while high-risk content requires explicit selection", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  write(env.source, "auth.json", "{\"token\":\"source-secret\"}\n");
  write(env.source, path.join("plugins", "cache.txt"), "plugin-cache\n");
  write(env.source, path.join("tools", "tool.txt"), "tool-cache\n");
  write(env.target, "auth.json", "{\"token\":\"target-secret\"}\n");

  const permissive = normalizeConfig({
    include: { plugins: true, tools: true, auth: true },
    restorePolicy: { excludeHighRisk: false }
  });
  const governed = applyBackupPolicy(permissive, {
    include: { plugins: true, tools: true, auth: true }
  });
  assert.equal(governed.include.plugins, true);
  assert.equal(governed.include.tools, true);
  assert.equal(governed.include.auth, false);

  const snapshot = createSnapshot({
    codexHome: env.source,
    cloudDir: env.cloud,
    include: { plugins: true, tools: true, auth: true },
    dryRun: false
  });
  const recommended = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: process.platform
  });
  assert.deepEqual(recommended.mappings, []);
  assert.equal(recommended.canExecute, false);
  assert.equal(recommended.availableItems.find((item) => item.id === "section:auth").restorable, false);

  const rejected = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: process.platform,
    restoreSelection: {
      mode: "custom",
      itemIds: ["section:auth", "section:unknown"]
    }
  });
  assert.deepEqual(rejected.restoreSelection.rejectedItemIds, ["section:auth", "section:unknown"]);
  assert.equal(rejected.canExecute, false);

  const all = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: process.platform,
    restoreSelection: { mode: "all" }
  });
  assert.deepEqual(all.restoreSelection.selectedItemIds, ["section:plugins", "section:tools"]);
  assert.equal(all.requiresHighRiskConfirmation, true);
  executeRestoreTransaction({ plan: all, cloudDir: env.cloud, confirmHighRisk: true });
  assert.equal(fs.readFileSync(path.join(env.target, "auth.json"), "utf8"), "{\"token\":\"target-secret\"}\n");
  assert.equal(fs.readFileSync(path.join(env.target, "plugins", "cache.txt"), "utf8"), "plugin-cache\n");
  assert.equal(fs.readFileSync(path.join(env.target, "tools", "tool.txt"), "utf8"), "tool-cache\n");
});
test("unified backup stores broad sections and item selections in one restore point", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const conversation = path.join(env.source, "sessions", "new.jsonl");
  const skill = write(env.source, path.join("skills", "sample", "SKILL.md"), "# Sample\n");

  const snapshot = createSnapshot({
    codexHome: env.source,
    cloudDir: env.cloud,
    include: {
      config: true,
      agents: false,
      sessions: false,
      archivedSessions: false,
      stateDb: false,
      memories: false,
      skills: false,
      plugins: false,
      tools: false,
      auth: false
    },
    selected: {
      conversations: [{ path: conversation, title: "Selected conversation" }],
      capabilities: [{ path: skill, name: "Sample skill", type: "skill" }]
    },
    dryRun: false
  });

  assert.equal(snapshot.manifest.snapshotKind, "raw-unified");
  assert.equal(snapshot.manifest.selectionMode, true);
  assert.equal(snapshot.manifest.copied.length, 2);
  assert.equal(snapshot.manifest.contentCounts.conversations, 1);
  assert.equal(snapshot.manifest.contentCounts.skills, 1);
  assert.equal(listSnapshots(env.cloud).length, 1);

  const plan = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: process.platform
  });
  assert.deepEqual(plan.mappings.map((item) => item.label), [
    "Selected conversation",
    "Sample skill",
    "基础配置"
  ]);
  assert.equal(plan.availableItems.filter((item) => item.selected).length, 3);

  executeRestoreTransaction({ plan, cloudDir: env.cloud });
  assert.equal(fs.readFileSync(path.join(env.target, "config.toml"), "utf8"), "model = \"restored-model\"\n");
  assert.equal(fs.readFileSync(path.join(env.target, "sessions", "new.jsonl"), "utf8"), "{\"source\":\"backup\"}\n");
  assert.equal(fs.readFileSync(path.join(env.target, "skills", "_selected_restore", "skill-Sample skill", "SKILL.md"), "utf8"), "# Sample\n");
});

test("backup progress reports real copy stages monotonically through completion", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(env.source, "sessions", "large-progress.jsonl"), Buffer.alloc(12 * 1024 * 1024, 97));
  const events = [];

  createSnapshot({
    codexHome: env.source,
    cloudDir: env.cloud,
    include: {
      config: true,
      agents: false,
      sessions: true,
      archivedSessions: false,
      stateDb: false,
      memories: false,
      skills: false,
      plugins: false,
      tools: false,
      auth: false
    },
    dryRun: false,
    onProgress: (event) => events.push(event)
  });

  assert.equal(events.at(0).stage, "scanning");
  assert.equal(events.at(-1).stage, "completed");
  assert.equal(events.at(-1).progress, 100);
  assert.ok(events.some((event) => event.stage === "copying" && event.completedUnits > 0));
  assert.ok(events.some((event) => event.stage === "verifying"));
  assert.ok(
    new Set(events.filter((event) => event.stage === "copying" && event.completedBytes > 0).map((event) => event.progress)).size >= 2,
    "large file copy should visibly advance through multiple percentages"
  );
  assert.deepEqual(
    events.map((event) => event.progress),
    [...events.map((event) => event.progress)].sort((a, b) => a - b)
  );
});

test("restore progress covers staging, rollback protection, apply and verification", (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(env.source, "sessions", "large-restore.jsonl"), Buffer.alloc(12 * 1024 * 1024, 98));
  const snapshot = createVerifiedSnapshot(env);
  const plan = buildPlan(snapshot.snapshotDir, env.target);
  const events = [];

  const result = executeRestoreTransaction({
    plan,
    cloudDir: env.cloud,
    onProgress: (event) => events.push(event)
  });

  assert.equal(result.status, "restored");
  assert.equal(events.at(0).stage, "source_verification");
  assert.equal(events.at(-1).stage, "completed");
  assert.equal(events.at(-1).progress, 100);
  for (const stage of ["staging", "rollback", "applying", "post_restore_verification"]) {
    assert.ok(events.some((event) => event.stage === stage), `missing progress stage: ${stage}`);
  }
  assert.ok(
    new Set(events.filter((event) => event.stage === "applying" && event.completedBytes > 0).map((event) => event.progress)).size >= 2,
    "large restore should visibly advance through multiple percentages"
  );
  assert.deepEqual(
    events.map((event) => event.progress),
    [...events.map((event) => event.progress)].sort((a, b) => a - b)
  );
});

test("operation worker emits intermediate progress before the backup result", async (t) => {
  const env = fixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(env.source, "sessions", "worker-progress.jsonl"), Buffer.alloc(12 * 1024 * 1024, 99));
  const messages = await new Promise((resolve, reject) => {
    const received = [];
    const worker = new Worker(path.join(__dirname, "..", "lib", "operation-worker.js"), {
      workerData: {
        operation: "backup",
        payload: {
          codexHome: env.source,
          cloudDir: env.cloud,
          include: {
            config: true,
            agents: false,
            sessions: true,
            archivedSessions: false,
            stateDb: false,
            memories: false,
            skills: false,
            plugins: false,
            tools: false,
            auth: false
          },
          dryRun: false
        }
      }
    });
    worker.on("message", (message) => {
      received.push(message);
      if (message.type === "error") reject(new Error(message.error));
      if (message.type === "result") resolve(received);
    });
    worker.on("error", reject);
  });

  const resultIndex = messages.findIndex((message) => message.type === "result");
  const progress = messages.slice(0, resultIndex).filter((message) => message.type === "progress");
  assert.ok(progress.length > 5, "worker should stream several updates before returning");
  assert.ok(progress.some((message) => message.event.progress > 1 && message.event.progress < 100));
  assert.ok(
    new Set(progress.filter((message) => message.event.completedBytes > 0).map((message) => message.event.progress)).size >= 3,
    "byte progress should reach the renderer in several distinct percentages"
  );
});

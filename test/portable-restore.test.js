"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const {
  createSnapshot,
  createTestRestoreEnvironment,
  deleteTestRestoreEnvironment,
  listSnapshots,
  restorePlan
} = require("../server");
const { executeRestoreTransaction, finalizeSnapshotManifest, undoRestoreTransaction } = require("../lib/restore-engine");
const {
  buildPortableProjectCatalog,
  loadOrRebuildProjectCatalog,
  mapPortablePath,
  normalizeProjectPath,
  rewriteJsonlPathMetadata,
  rewriteSqlitePaths,
  walkJsonl
} = require("../lib/portable-projects");
const { assertSQLiteTargetSafe, validateSQLiteDatabase } = require("../lib/sqlite-safety");

function write(root, relative, contentValue) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contentValue, "utf8");
  return target;
}

function createStateDb(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  try {
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, title TEXT)");
    const insert = db.prepare("INSERT INTO threads (id, cwd, rollout_path, title) VALUES (?, ?, ?, ?)");
    for (const row of rows) insert.run(row.id, row.cwd, row.rolloutPath, row.title || row.id);
  } finally {
    db.close();
  }
}

function createStateDbWithMetadata(filePath, rows, metadataRows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  try {
    db.exec([
      "PRAGMA foreign_keys = ON",
      "CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, title TEXT)",
      "CREATE TABLE thread_metadata (thread_id TEXT NOT NULL REFERENCES threads(id), key TEXT NOT NULL, value TEXT, PRIMARY KEY (thread_id, key))"
    ].join(";"));
    const insertThread = db.prepare("INSERT INTO threads (id, cwd, rollout_path, title) VALUES (?, ?, ?, ?)");
    for (const row of rows) insertThread.run(row.id, row.cwd, row.rolloutPath, row.title || row.id);
    const insertMetadata = db.prepare("INSERT INTO thread_metadata (thread_id, key, value) VALUES (?, ?, ?)");
    for (const row of metadataRows) insertMetadata.run(row.threadId, row.key, row.value);
  } finally {
    db.close();
  }
}

function sessionText({ id, cwd, bodyPath = cwd }) {
  return [
    JSON.stringify({ type: "session_meta", payload: { id, cwd } }),
    JSON.stringify({ type: "response_item", payload: { role: "user", content: `正文保留路径 ${bodyPath}` } }),
    JSON.stringify({ type: "turn_context", payload: { cwd } })
  ].join("\n") + "\n";
}

function portableFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-portable-"));
  const source = path.join(root, "source", ".codex");
  const target = path.join(root, "target", ".codex");
  const cloud = path.join(root, "backups");
  const sourceHome = "C:\\Users\\source\\.codex";
  const rows = [
    {
      id: "thread-alpha",
      cwd: "D:\\Work\\Alpha",
      rolloutPath: `${sourceHome}\\sessions\\2026\\08\\26\\thread-alpha.jsonl`
    },
    {
      id: "thread-beta",
      cwd: "E:\\客户\\Beta\\",
      rolloutPath: `${sourceHome}\\sessions\\2026\\08\\26\\thread-beta.jsonl`
    }
  ];
  createStateDb(path.join(source, "state_5.sqlite"), rows);
  write(source, path.join("sessions", "2026", "08", "26", "thread-alpha.jsonl"), sessionText({
    id: "thread-alpha",
    cwd: "\\\\?\\D:\\Work\\Alpha\\",
    bodyPath: "D:\\Work\\Alpha"
  }));
  write(source, path.join("sessions", "2026", "08", "26", "thread-beta.jsonl"), sessionText({
    id: "thread-beta",
    cwd: "E:/客户/Beta"
  }));
  write(target, "sentinel.txt", "target-before\n");
  return { root, source, target, cloud, sourceHome, rows };
}

function makeSnapshot(env) {
  const snapshot = createSnapshot({
    codexHome: env.source,
    cloudDir: env.cloud,
    include: {
      config: false,
      agents: false,
      sessions: true,
      archivedSessions: false,
      stateDb: true,
      memories: false,
      skills: false,
      plugins: false,
      tools: false,
      auth: false
    },
    dryRun: false
  });
  snapshot.manifest.sourceOS = "win32";
  snapshot.manifest.codexHome = env.sourceHome;
  finalizeSnapshotManifest(snapshot.snapshotDir, snapshot.manifest);
  return snapshot;
}

function mappedPlan(env, snapshot) {
  const first = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: "macos"
  });
  const projectMappings = first.projectPathMappings.map((item) => {
    const targetRoot = path.join(env.root, "mac-projects", item.displayName);
    fs.mkdirSync(targetRoot, { recursive: true });
    return { projectId: item.projectId, mode: "existing", targetRoot };
  });
  const plan = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: "macos",
    projectMappings
  });
  return { first, plan, projectMappings };
}

test("Windows extended paths normalize and deduplicate case, slash and trailing separator variants", () => {
  const extended = normalizeProjectPath("\\\\?\\D:\\Work\\Alpha\\");
  const plain = normalizeProjectPath("d:/work/alpha");
  assert.equal(extended.normalized, "D:/Work/Alpha");
  assert.equal(extended.comparisonKey, plain.comparisonKey);
});

test("project catalog rebuilds from SQLite and JSONL without duplicate Windows roots", (t) => {
  const env = portableFixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const catalog = buildPortableProjectCatalog({ codexHome: env.source, sourcePlatform: "win32" });
  assert.equal(catalog.projectCount, 2);
  assert.equal(catalog.threadCount, 2);
  assert.equal(catalog.projectFilesIncluded, false);
  assert.deepEqual(catalog.projects.map((item) => item.threadCount), [1, 1]);
});

test("backup v4 writes a threaded projects.json and SQLite geometry metadata", (t) => {
  const env = portableFixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = makeSnapshot(env);
  const projectsPath = path.join(snapshot.snapshotDir, "payload", "projects.json");
  const projects = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
  assert.equal(snapshot.manifest.formatVersion, 4);
  assert.equal(projects.projectCount, 2);
  assert.equal(projects.schemaVersion, 2);
  assert.equal(projects.projects.flatMap((project) => project.threads).length, 2);
  assert.ok(projects.projects.flatMap((project) => project.threads).every((thread) => thread.threadId && thread.relativePath));
  assert.ok(projects.projects.flatMap((project) => project.threads).every((thread) => ["active", "archived"].includes(thread.bucket)));
  assert.equal(snapshot.manifest.portableProjects.projectFilesIncluded, false);
  assert.ok(snapshot.manifest.integrity.files.some((item) => item.path === "projects.json"));
  assert.equal(snapshot.manifest.sqlite.size, fs.statSync(path.join(snapshot.snapshotDir, "payload", "state_5.sqlite")).size);
  assert.equal(snapshot.manifest.sqlite.pageCount * snapshot.manifest.sqlite.pageSize, snapshot.manifest.sqlite.size);
});

test("cross-system plan requires one-to-one project mapping and rejects duplicate targets", (t) => {
  const env = portableFixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = makeSnapshot(env);
  const first = restorePlan({ snapshotDir: snapshot.snapshotDir, targetCodexHome: env.target, targetOS: "macos" });
  assert.equal(first.requiresProjectMapping, true);
  assert.equal(first.canExecute, false);
  assert.equal(first.projectMappingStats.allUnresolvedFormal, true);
  const isolated = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: "macos",
    restoreMode: "isolated_test"
  });
  assert.equal(isolated.canExecute, true);
  assert.equal(isolated.requiresProjectMapping, false);
  assert.ok(isolated.projectPathMappings.every((item) => item.mode === "placeholder"));
  const shared = path.join(env.root, "shared-project");
  fs.mkdirSync(shared, { recursive: true });
  assert.throws(() => restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: "macos",
    projectMappings: first.projectPathMappings.map((item) => ({ projectId: item.projectId, mode: "existing", targetRoot: shared }))
  }), /不能映射到同一目标目录/);
});

test("isolated restore environments are marker-protected and safely removable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-test-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managedBase = path.join(root, "managed");
  const env = createTestRestoreEnvironment({ baseDir: managedBase });
  assert.equal(fs.existsSync(env.codexHome), true);
  assert.equal(fs.existsSync(env.projectsRoot), true);
  assert.equal(fs.existsSync(path.join(env.root, ".codex-link-test-environment.json")), true);
  assert.throws(
    () => deleteTestRestoreEnvironment({ root, baseDir: managedBase }),
    /outside the managed test root/
  );
  const deleted = deleteTestRestoreEnvironment({ root: env.root, baseDir: managedBase });
  assert.equal(deleted.deleted, true);
  assert.equal(fs.existsSync(env.root), false);
});

test("JSONL adaptation changes only path metadata and preserves identical text in conversation bodies", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-jsonl-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = write(root, "thread.jsonl", sessionText({ id: "thread", cwd: "D:\\Work\\Alpha" }));
  const beforeBody = JSON.parse(fs.readFileSync(filePath, "utf8").split(/\r?\n/)[1]).payload.content;
  const changed = rewriteJsonlPathMetadata(filePath, [{ sourceRoot: "D:\\Work\\Alpha", targetRoot: "/Users/tester/Projects/Alpha" }]);
  const records = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(changed, 2);
  assert.equal(records[0].payload.cwd, "/Users/tester/Projects/Alpha");
  assert.equal(records[2].payload.cwd, "/Users/tester/Projects/Alpha");
  assert.equal(records[1].payload.content, beforeBody);
});

test("SQLite adaptation updates threads.cwd and rollout_path transactionally", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-sqlite-map-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "state_5.sqlite");
  createStateDb(dbPath, [{
    id: "thread",
    cwd: "D:\\Work\\Alpha",
    rolloutPath: "C:\\Users\\source\\.codex\\sessions\\thread.jsonl"
  }]);
  const report = rewriteSqlitePaths(dbPath, [
    { sourceRoot: "D:\\Work\\Alpha", targetRoot: "/Users/tester/Projects/Alpha" },
    { sourceRoot: "C:\\Users\\source\\.codex", targetRoot: "/Users/tester/.codex" }
  ]);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare("SELECT cwd, rollout_path FROM threads").get();
  db.close();
  assert.deepEqual(report, { updatedCwd: 1, updatedRolloutPath: 1 });
  assert.equal(row.cwd, "/Users/tester/Projects/Alpha");
  assert.equal(row.rollout_path, "/Users/tester/.codex/sessions/thread.jsonl");
});

test("Windows to macOS simulated restore preserves project/thread counts and rollout files", (t) => {
  const env = portableFixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = makeSnapshot(env);
  const { first, plan } = mappedPlan(env, snapshot);
  const result = executeRestoreTransaction({ plan, cloudDir: env.cloud, confirmHighRisk: true });
  assert.equal(result.status, "restored");
  assert.equal(first.portableProjects.projectCount, 2);
  assert.equal(result.sqliteValidation.threadCount, 2);
  assert.equal(result.sqliteValidation.missingRolloutCount, 0);
  assert.equal(result.projectMappings.length, 2);
  assert.deepEqual(result.projectMappings.map((item) => item.threadCount).sort(), [1, 1]);
  const dbReport = validateSQLiteDatabase(path.join(env.target, "state_5.sqlite"), {
    expectedThreadCount: 2,
    rolloutResolver: (value) => value,
    requireAllRollouts: true
  });
  assert.equal(dbReport.valid, true);
  const restoredJsonl = fs.readFileSync(path.join(env.target, "sessions", "2026", "08", "26", "thread-alpha.jsonl"), "utf8");
  assert.match(restoredJsonl, /正文保留路径 D:\\\\Work\\\\Alpha/);
});

test("selecting one project conversation merges only its thread and preserves target projects", (t) => {
  const env = portableFixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = makeSnapshot(env);
  const existingRollout = write(env.target, path.join("sessions", "existing.jsonl"), sessionText({
    id: "thread-existing",
    cwd: path.join(env.root, "existing-project")
  }));
  createStateDb(path.join(env.target, "state_5.sqlite"), [{
    id: "thread-existing",
    cwd: path.join(env.root, "existing-project"),
    rolloutPath: existingRollout
  }]);
  const initial = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: "macos"
  });
  const alpha = initial.availableItems.find((item) => item.kind === "conversation" && item.threadId === "thread-alpha");
  assert.ok(alpha);
  const alphaTarget = path.join(env.root, "mac-projects", "Alpha");
  fs.mkdirSync(alphaTarget, { recursive: true });
  const plan = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: "macos",
    restoreSelection: { mode: "custom", itemIds: [alpha.id] },
    projectMappings: [{ projectId: alpha.projectId, mode: "existing", targetRoot: alphaTarget }]
  });
  assert.equal(plan.projectPathMappings.length, 1);
  assert.deepEqual(plan.selectiveRestore.selectedThreadIds, ["thread-alpha"]);
  assert.ok(plan.mappings.some((item) => item.kind === "stateDbMerge"));
  const result = executeRestoreTransaction({ plan, cloudDir: env.cloud, confirmHighRisk: true });
  assert.match(result.sqliteMerge.insertedThreadFingerprints["thread-alpha"], /^[a-f0-9]{64}$/);
  assert.deepEqual(result.sqliteMerge, {
    mode: "merge_into_existing",
    selectedThreadCount: 1,
    insertedThreadCount: 1,
    updatedThreadCount: 0,
    preservedThreadCount: 0,
    insertedThreadIds: ["thread-alpha"],
    insertedThreadFingerprints: result.sqliteMerge.insertedThreadFingerprints,
    preservedThreadIds: [],
    beforeThreadCount: 1,
    afterThreadCount: 2,
    targetExisted: true,
    pathRewrite: { updatedCwd: 1, updatedRolloutPath: 1 }
  });
  const db = new DatabaseSync(path.join(env.target, "state_5.sqlite"), { readOnly: true });
  const rows = db.prepare("SELECT id, cwd FROM threads ORDER BY id").all();
  db.close();
  assert.deepEqual(rows.map((row) => row.id), ["thread-alpha", "thread-existing"]);
  assert.equal(rows[0].cwd, alphaTarget);
  assert.equal(fs.existsSync(path.join(env.target, "sessions", "2026", "08", "26", "thread-alpha.jsonl")), true);
  assert.equal(fs.existsSync(path.join(env.target, "sessions", "2026", "08", "26", "thread-beta.jsonl")), false);
});

test("SQLite merge includes thread association tables and undo protects changed association rows", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-associations-"));
  const source = path.join(root, "source", ".codex");
  const target = path.join(root, "target", ".codex");
  const cloud = path.join(root, "backups");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const newRollout = write(source, path.join("sessions", "thread-new.jsonl"), sessionText({
    id: "thread-new",
    cwd: path.join(root, "projects", "new")
  }));
  createStateDbWithMetadata(path.join(source, "state_5.sqlite"), [{
    id: "thread-new",
    cwd: path.join(root, "projects", "new"),
    rolloutPath: newRollout
  }], [
    { threadId: "thread-new", key: "project", value: "source-note" },
    { threadId: "thread-new", key: "origin", value: "windows-backup" }
  ]);

  const localRollout = write(target, path.join("sessions", "thread-local.jsonl"), sessionText({
    id: "thread-local",
    cwd: path.join(root, "projects", "local")
  }));
  createStateDbWithMetadata(path.join(target, "state_5.sqlite"), [{
    id: "thread-local",
    cwd: path.join(root, "projects", "local"),
    rolloutPath: localRollout
  }], [
    { threadId: "thread-local", key: "project", value: "local-note" }
  ]);

  const snapshot = createSnapshot({
    codexHome: source,
    cloudDir: cloud,
    include: {
      config: false,
      agents: false,
      sessions: true,
      archivedSessions: false,
      stateDb: true,
      memories: false,
      skills: false,
      plugins: false,
      tools: false,
      auth: false
    },
    dryRun: false
  });
  const plan = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: target,
    targetOS: process.platform
  });
  const restored = executeRestoreTransaction({ plan, cloudDir: cloud, confirmHighRisk: true });
  assert.equal(restored.sqliteMerge.associatedRowsInserted, 2);
  assert.equal(restored.sqliteMerge.associatedTables[0].table, "thread_metadata");
  assert.ok(Object.keys(restored.sqliteMerge.insertedAssociationFingerprints).length > 0);

  const targetDbPath = path.join(target, "state_5.sqlite");
  const changedDb = new DatabaseSync(targetDbPath);
  assert.equal(changedDb.prepare("SELECT COUNT(*) AS count FROM thread_metadata").get().count, 3);
  changedDb.prepare("UPDATE thread_metadata SET value = ? WHERE thread_id = ? AND key = ?")
    .run("user-changed-after-restore", "thread-new", "project");
  changedDb.close();

  const conflict = undoRestoreTransaction({
    cloudDir: cloud,
    rollbackDir: restored.rollbackPoint.path,
    processes: []
  });
  assert.equal(conflict.status, "rollback_conflict");
  assert.ok(conflict.conflicts.some((item) => item.reason === "restored_thread_association_changed_after_restore"));

  const retryDb = new DatabaseSync(targetDbPath);
  retryDb.prepare("UPDATE thread_metadata SET value = ? WHERE thread_id = ? AND key = ?")
    .run("source-note", "thread-new", "project");
  retryDb.close();
  const undone = undoRestoreTransaction({
    cloudDir: cloud,
    rollbackDir: restored.rollbackPoint.path,
    processes: []
  });
  assert.equal(undone.status, "manual_rolled_back");
  const finalDb = new DatabaseSync(targetDbPath, { readOnly: true });
  const remaining = finalDb.prepare("SELECT thread_id, key, value FROM thread_metadata ORDER BY thread_id, key").all().map((row) => ({ ...row }));
  finalDb.close();
  assert.deepEqual(remaining, [{ thread_id: "thread-local", key: "project", value: "local-note" }]);
});

test("full state database defaults to merge and replace requires explicit confirmation", (t) => {
  const env = portableFixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = makeSnapshot(env);
  createStateDb(path.join(env.target, "state_5.sqlite"), [{
    id: "thread-target-only",
    cwd: path.join(env.root, "target-only"),
    rolloutPath: ""
  }]);
  const first = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: "macos"
  });
  const fullSelection = {
    mode: "custom",
    itemIds: [
      "section:stateDb",
      ...first.availableItems.filter((item) => item.kind === "conversation").map((item) => item.id)
    ]
  };
  const projectMappings = first.projectPathMappings.map((item) => {
    const targetRoot = path.join(env.root, "mapped", item.displayName);
    fs.mkdirSync(targetRoot, { recursive: true });
    return { projectId: item.projectId, mode: "existing", targetRoot };
  });
  const merged = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: "macos",
    projectMappings,
    restoreSelection: fullSelection
  });
  assert.equal(merged.databaseRestoreMode, "merge");
  assert.equal(merged.canExecute, true);
  assert.ok(merged.mappings.some((item) => item.kind === "stateDbMerge"));
  const replaceBlocked = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: "macos",
    projectMappings,
    databaseRestoreMode: "replace",
    restoreSelection: fullSelection
  });
  assert.equal(replaceBlocked.requiresDatabaseReplaceConfirmation, true);
  assert.equal(replaceBlocked.canExecute, false);
  const replaceConfirmed = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: "macos",
    projectMappings,
    databaseRestoreMode: "replace",
    confirmDatabaseReplace: true,
    restoreSelection: fullSelection
  });
  assert.equal(replaceConfirmed.requiresDatabaseReplaceConfirmation, false);
  assert.equal(replaceConfirmed.canExecute, true);
  assert.ok(replaceConfirmed.mappings.some((item) => item.kind === "stateDb"));

  const restored = executeRestoreTransaction({ plan: merged, cloudDir: env.cloud, confirmHighRisk: true });
  const mergedDb = new DatabaseSync(path.join(env.target, "state_5.sqlite"), { readOnly: true });
  const mergedIds = mergedDb.prepare("SELECT id FROM threads ORDER BY id").all().map((row) => row.id);
  mergedDb.close();
  assert.deepEqual(mergedIds, ["thread-alpha", "thread-beta", "thread-target-only"]);
  assert.equal(restored.sqliteMerge.insertedThreadCount, 2);
});

test("manual undo removes only restored SQLite rows and preserves later threads", (t) => {
  const env = portableFixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = makeSnapshot(env);
  const existingRollout = write(env.target, path.join("sessions", "existing.jsonl"), sessionText({
    id: "thread-existing",
    cwd: path.join(env.root, "existing-project")
  }));
  createStateDb(path.join(env.target, "state_5.sqlite"), [{
    id: "thread-existing",
    cwd: path.join(env.root, "existing-project"),
    rolloutPath: existingRollout
  }]);
  const initial = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: "macos"
  });
  const alpha = initial.availableItems.find((item) => item.kind === "conversation" && item.threadId === "thread-alpha");
  const alphaTarget = path.join(env.root, "mac-projects", "Alpha");
  fs.mkdirSync(alphaTarget, { recursive: true });
  const plan = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: "macos",
    restoreSelection: { mode: "custom", itemIds: [alpha.id] },
    projectMappings: [{ projectId: alpha.projectId, mode: "existing", targetRoot: alphaTarget }]
  });
  const restored = executeRestoreTransaction({ plan, cloudDir: env.cloud, confirmHighRisk: true });
  const targetDb = path.join(env.target, "state_5.sqlite");
  const db = new DatabaseSync(targetDb);
  db.prepare("INSERT INTO threads (id, cwd, rollout_path, title) VALUES (?, ?, ?, ?)")
    .run("thread-after-restore", path.join(env.root, "later-project"), "", "later");
  db.close();

  const undone = undoRestoreTransaction({
    cloudDir: env.cloud,
    rollbackDir: restored.rollbackPoint.path,
    processes: []
  });
  assert.equal(undone.status, "manual_rolled_back");
  const verify = new DatabaseSync(targetDb, { readOnly: true });
  const ids = verify.prepare("SELECT id FROM threads ORDER BY id").all().map((row) => row.id);
  verify.close();
  assert.deepEqual(ids, ["thread-after-restore", "thread-existing"]);
});

test("replanning the same restore is idempotent and produces zero writes", (t) => {
  const env = portableFixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = makeSnapshot(env);
  const { plan, projectMappings } = mappedPlan(env, snapshot);

  const first = executeRestoreTransaction({ plan, cloudDir: env.cloud, confirmHighRisk: true });
  assert.equal(first.sqliteMerge.insertedThreadCount, 2);

  const secondPlan = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: env.target,
    targetOS: "macos",
    projectMappings
  });
  assert.deepEqual(secondPlan.overlap, {
    backupThreadCount: 2,
    targetExistingCount: 2,
    newCount: 0,
    duplicateCount: 2,
    conflictCount: 0,
    targetOnlyCount: 0,
    targetThreadCount: 2,
    items: secondPlan.overlap.items
  });
  assert.equal(secondPlan.mappings.length, 0);
  assert.equal(secondPlan.canExecute, false);
  assert.equal(secondPlan.skippedMappings.filter((item) => item.reason === "duplicate_thread_content").length, 2);

  const database = new DatabaseSync(path.join(env.target, "state_5.sqlite"), { readOnly: true });
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM threads").get().count), 2);
  database.close();
});

test("229-thread restore into 50-thread target is idempotent and undo preserves a later thread", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-scale-"));
  const source = path.join(root, "source", ".codex");
  const target = path.join(root, "target", ".codex");
  const cloud = path.join(root, "backups");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const sourceRows = [];
  for (let index = 0; index < 229; index += 1) {
    const id = `backup-${String(index).padStart(3, "0")}`;
    const cwd = path.join(root, "projects", "backup", String(index));
    const rolloutPath = write(source, path.join("sessions", "bulk", `${id}.jsonl`), sessionText({ id, cwd }));
    sourceRows.push({ id, cwd, rolloutPath });
  }
  createStateDb(path.join(source, "state_5.sqlite"), sourceRows);

  const targetRows = [];
  for (let index = 0; index < 50; index += 1) {
    const id = `target-${String(index).padStart(3, "0")}`;
    const cwd = path.join(root, "projects", "target", String(index));
    const rolloutPath = write(target, path.join("sessions", "local", `${id}.jsonl`), sessionText({ id, cwd }));
    targetRows.push({ id, cwd, rolloutPath });
  }
  createStateDb(path.join(target, "state_5.sqlite"), targetRows);

  const snapshot = createSnapshot({
    codexHome: source,
    cloudDir: cloud,
    include: {
      config: false,
      agents: false,
      sessions: true,
      archivedSessions: false,
      stateDb: true,
      memories: false,
      skills: false,
      plugins: false,
      tools: false,
      auth: false
    },
    dryRun: false
  });
  const firstPlan = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: target,
    targetOS: process.platform
  });
  assert.equal(firstPlan.overlap.backupThreadCount, 229);
  assert.equal(firstPlan.overlap.newCount, 229);
  assert.equal(firstPlan.overlap.targetOnlyCount, 50);
  const restored = executeRestoreTransaction({ plan: firstPlan, cloudDir: cloud, confirmHighRisk: true });
  assert.equal(restored.sqliteValidation.threadCount, 279);
  assert.equal(walkJsonl(path.join(target, "sessions")).length, 279);

  const mergedDb = new DatabaseSync(path.join(target, "state_5.sqlite"), { readOnly: true });
  const restoredRollout = mergedDb.prepare("SELECT rollout_path FROM threads WHERE id = ?").get("backup-000").rollout_path;
  mergedDb.close();
  assert.equal(path.normalize(restoredRollout), path.join(target, "sessions", "bulk", "backup-000.jsonl"));

  const secondPlan = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: target,
    targetOS: process.platform
  });
  assert.equal(secondPlan.overlap.duplicateCount, 229);
  assert.equal(secondPlan.overlap.newCount, 0);
  assert.equal(secondPlan.overlap.targetOnlyCount, 50);
  assert.equal(secondPlan.mappings.length, 0);
  assert.equal(secondPlan.canExecute, false);

  const dbAfter = new DatabaseSync(path.join(target, "state_5.sqlite"));
  dbAfter.prepare("INSERT INTO threads (id, cwd, rollout_path, title) VALUES (?, ?, ?, ?)")
    .run("thread-after-restore", path.join(root, "projects", "later"), "", "later");
  dbAfter.close();
  const undone = undoRestoreTransaction({
    cloudDir: cloud,
    rollbackDir: restored.rollbackPoint.path,
    processes: []
  });
  assert.equal(undone.status, "manual_rolled_back");
  const finalDb = new DatabaseSync(path.join(target, "state_5.sqlite"), { readOnly: true });
  const finalIds = finalDb.prepare("SELECT id FROM threads ORDER BY id").all().map((row) => row.id);
  finalDb.close();
  assert.equal(finalIds.length, 51);
  assert.equal(finalIds.filter((id) => id.startsWith("target-")).length, 50);
  assert.equal(finalIds.includes("thread-after-restore"), true);
  assert.equal(finalIds.some((id) => id.startsWith("backup-")), false);
  assert.equal(walkJsonl(path.join(target, "sessions")).length, 50);
});

test("target WAL or SHM conflict blocks restore before target changes", (t) => {
  const env = portableFixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = makeSnapshot(env);
  const { plan } = mappedPlan(env, snapshot);
  fs.writeFileSync(path.join(env.target, "state_5.sqlite-wal"), "foreign-wal");
  assert.throws(
    () => executeRestoreTransaction({ plan, cloudDir: env.cloud, confirmHighRisk: true }),
    (error) => error.details?.phase === "sqlite_preflight" && error.details.walShmConflicts.length === 1
  );
  assert.equal(fs.readFileSync(path.join(env.target, "sentinel.txt"), "utf8"), "target-before\n");
});

test("simulated SQLite truncation fails before install and leaves target unchanged", (t) => {
  const env = portableFixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = makeSnapshot(env);
  const { plan } = mappedPlan(env, snapshot);
  assert.throws(
    () => executeRestoreTransaction({
      plan,
      cloudDir: env.cloud,
      confirmHighRisk: true,
      _testTruncateStagedSQLite: true
    }),
    (error) => error.details?.phase === "sqlite_validated" && error.details.actualSize < error.details.expectedSize
  );
  assert.equal(fs.existsSync(path.join(env.target, "state_5.sqlite")), false);
  assert.equal(fs.readFileSync(path.join(env.target, "sentinel.txt"), "utf8"), "target-before\n");
});

test("quick_check/integrity corruption cannot reach completed", (t) => {
  const env = portableFixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = makeSnapshot(env);
  const { plan } = mappedPlan(env, snapshot);
  assert.throws(
    () => executeRestoreTransaction({
      plan,
      cloudDir: env.cloud,
      confirmHighRisk: true,
      _testCorruptStagedSQLite: true
    }),
    (error) => error.details?.phase === "sqlite_validated"
  );
  assert.equal(fs.existsSync(path.join(env.target, "state_5.sqlite")), false);
});

test("legacy restore point without projects.json rebuilds candidates from SQLite and JSONL", (t) => {
  const env = portableFixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = makeSnapshot(env);
  fs.rmSync(path.join(snapshot.snapshotDir, "payload", "projects.json"));
  delete snapshot.manifest.portableProjects;
  finalizeSnapshotManifest(snapshot.snapshotDir, snapshot.manifest);
  const rebuilt = loadOrRebuildProjectCatalog(snapshot.snapshotDir, snapshot.manifest);
  const plan = restorePlan({ snapshotDir: snapshot.snapshotDir, targetCodexHome: env.target, targetOS: "macos" });
  assert.equal(rebuilt.migratedFromLegacy, true);
  assert.equal(rebuilt.projectCount, 2);
  assert.equal(plan.requiresProjectMapping, true);
  const listed = listSnapshots(env.cloud)[0];
  assert.equal(listed.projectCount, 2);
  assert.equal(listed.threadCount, 2);
  assert.equal(listed.rebuiltFromLegacy, true);
  assert.equal(listed.statsSource, "legacy_rebuilt");
  assert.equal(fs.existsSync(path.join(snapshot.snapshotDir, "codex-link-derived-metadata.json")), true);
});

test("same-system restore remains executable while Mac to Windows mapping support is reversible", (t) => {
  const env = portableFixture();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const snapshot = makeSnapshot(env);
  const plan = restorePlan({ snapshotDir: snapshot.snapshotDir, targetCodexHome: env.target, targetOS: "windows" });
  assert.equal(plan.requiresProjectMapping, false);
  assert.equal(plan.canExecute, true);
  assert.equal(
    mapPortablePath("/Users/tester/Projects/Alpha/src", [{ sourceRoot: "/Users/tester/Projects/Alpha", targetRoot: "D:\\Projects\\Alpha" }]),
    "D:\\Projects\\Alpha\\src"
  );
});

test("real-target mode blocks restore when Codex or ChatGPT process is detected", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-process-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetRoot = path.join(root, ".codex");
  assert.throws(() => assertSQLiteTargetSafe({
    targetDatabase: path.join(targetRoot, "state_5.sqlite"),
    targetRoot,
    processes: ["ChatGPT.exe", "codex.exe"],
    realUserTarget: true
  }), (error) => error.details?.phase === "sqlite_preflight" && error.details.runningProcesses.length === 2);
});

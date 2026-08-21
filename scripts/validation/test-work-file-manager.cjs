#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { listWorkDirectory, readWorkFile, writeWorkFile } = require("../server/work-file-manager.cjs");
const { runTypedWorkCommand, runWorkFileDiff } = require("../server/work-action-runner.cjs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { inspectWorkEnvironment } = require("../server/work-environment-inspector.cjs");

async function rejectsWithStatus(action, statusCode) {
  await assert.rejects(action, (error) => error?.statusCode === statusCode);
}

async function main() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "luke-work-files-"));
  const root = path.join(sandbox, "project");
  try {
    await fs.mkdir(root);
    const secondRoot = path.join(sandbox, "second-project");
    await fs.mkdir(secondRoot);
    await fs.mkdir(path.join(root, "nested"));
    await fs.writeFile(path.join(root, "nested", "inside.txt"), "inside", "utf8");
    await fs.writeFile(path.join(root, "notes.txt"), "one\ntwo\nthree\n", "utf8");
    await fs.writeFile(path.join(root, "binary.dat"), Buffer.from([65, 0, 66]));
    await fs.writeFile(path.join(sandbox, "secret.txt"), "outside", "utf8");
    await fs.symlink(path.join(sandbox, "secret.txt"), path.join(root, "escape.txt"));

    const opened = await readWorkFile({ root, filePath: "notes.txt" });
    assert.equal(opened.content, "one\ntwo\nthree\n");
    const selectedEnvironment = await inspectWorkEnvironment({ sourceFolders: [root, secondRoot], activeRoot: secondRoot });
    assert.equal(selectedEnvironment.activeRoot, secondRoot);
    const rejectedSelection = await inspectWorkEnvironment({ sourceFolders: [root, secondRoot], activeRoot: sandbox });
    assert.equal(rejectedSelection.activeRoot, root);
    const nested = await listWorkDirectory({ root, directoryPath: "nested" });
    assert.equal(nested.path, "nested");
    assert.deepEqual(nested.entries.map((entry) => entry.path), ["nested/inside.txt"]);
    await rejectsWithStatus(() => listWorkDirectory({ root, directoryPath: ".." }), 400);
    await rejectsWithStatus(() => readWorkFile({ root, filePath: "../secret.txt" }), 400);
    await rejectsWithStatus(() => readWorkFile({ root, filePath: "escape.txt" }), 403);
    await rejectsWithStatus(() => readWorkFile({ root, filePath: "binary.dat" }), 415);
    await rejectsWithStatus(() => writeWorkFile({ root, filePath: "notes.txt", content: "changed", approvalGranted: false }), 403);

    const future = new Date(Date.now() + 5000);
    await fs.utimes(path.join(root, "notes.txt"), future, future);
    await rejectsWithStatus(() => writeWorkFile({ root, filePath: "notes.txt", content: "stale", approvalGranted: true, expectedModifiedAt: opened.modifiedAt }), 409);
    assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "one\ntwo\nthree\n");

    const refreshed = await readWorkFile({ root, filePath: "notes.txt" });
    const saved = await writeWorkFile({ root, filePath: "notes.txt", content: "alpha\nbeta\ngamma", approvalGranted: true, expectedModifiedAt: refreshed.modifiedAt });
    assert.equal(saved.saved, true);
    assert.ok(saved.modifiedAt);
    assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "alpha\nbeta\ngamma");
    assert.equal((await runTypedWorkCommand({ root, command: "cat notes.txt" })).output, "alpha\nbeta\ngamma");
    assert.equal((await runTypedWorkCommand({ root, command: "head -n 2 notes.txt" })).output, "alpha\nbeta");
    assert.equal((await runTypedWorkCommand({ root, command: "tail -n 1 notes.txt" })).output, "gamma");
    await rejectsWithStatus(() => runTypedWorkCommand({ root, command: "cat ../secret.txt" }), 400);
    await rejectsWithStatus(() => runTypedWorkCommand({ root, command: "cat notes.txt | sh" }), 400);
    const run = promisify(execFile);
    await run("git", ["init"], { cwd: root });
    await run("git", ["add", "notes.txt"], { cwd: root });
    await run("git", ["-c", "user.name=LUKE Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: root });
    await fs.writeFile(path.join(root, "notes.txt"), "alpha\nbeta\nchanged", "utf8");
    const diff = await runWorkFileDiff({ root, filePath: "notes.txt" });
    assert.match(diff.output, /# Unstaged/);
    assert.match(diff.output, /-gamma/);
    assert.match(diff.output, /\+changed/);
    await rejectsWithStatus(() => runWorkFileDiff({ root, filePath: "../secret.txt" }), 400);
    console.log("PASS: Work Files confines text reads and guarded atomic writes to the project root.");
    console.log("PASS: Work Terminal cat/head/tail remain parsed, read-only and shell-free.");
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readWorkFile, writeWorkFile } = require("../server/work-file-manager.cjs");
const { runTypedWorkCommand } = require("../server/work-action-runner.cjs");

async function rejectsWithStatus(action, statusCode) {
  await assert.rejects(action, (error) => error?.statusCode === statusCode);
}

async function main() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "luke-work-files-"));
  const root = path.join(sandbox, "project");
  try {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "notes.txt"), "one\ntwo\nthree\n", "utf8");
    await fs.writeFile(path.join(root, "binary.dat"), Buffer.from([65, 0, 66]));
    await fs.writeFile(path.join(sandbox, "secret.txt"), "outside", "utf8");
    await fs.symlink(path.join(sandbox, "secret.txt"), path.join(root, "escape.txt"));

    const opened = await readWorkFile({ root, filePath: "notes.txt" });
    assert.equal(opened.content, "one\ntwo\nthree\n");
    await rejectsWithStatus(() => readWorkFile({ root, filePath: "../secret.txt" }), 400);
    await rejectsWithStatus(() => readWorkFile({ root, filePath: "escape.txt" }), 403);
    await rejectsWithStatus(() => readWorkFile({ root, filePath: "binary.dat" }), 415);
    await rejectsWithStatus(() => writeWorkFile({ root, filePath: "notes.txt", content: "changed", approvalGranted: false }), 403);

    const saved = await writeWorkFile({ root, filePath: "notes.txt", content: "alpha\nbeta\ngamma", approvalGranted: true });
    assert.equal(saved.saved, true);
    assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "alpha\nbeta\ngamma");
    assert.equal((await runTypedWorkCommand({ root, command: "cat notes.txt" })).output, "alpha\nbeta\ngamma");
    assert.equal((await runTypedWorkCommand({ root, command: "head -n 2 notes.txt" })).output, "alpha\nbeta");
    assert.equal((await runTypedWorkCommand({ root, command: "tail -n 1 notes.txt" })).output, "gamma");
    await rejectsWithStatus(() => runTypedWorkCommand({ root, command: "cat ../secret.txt" }), 400);
    await rejectsWithStatus(() => runTypedWorkCommand({ root, command: "cat notes.txt | sh" }), 400);
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

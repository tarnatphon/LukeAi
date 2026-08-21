"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_TEXT_FILE_BYTES = 1024 * 1024;

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function resolveProjectFile(rootValue, relativeValue) {
  if (!rootValue || !path.isAbsolute(String(rootValue))) {
    throw httpError("Work file root must be an absolute path.");
  }
  const root = await fs.realpath(path.resolve(String(rootValue))).catch(() => null);
  if (!root) throw httpError("Work file root is not available.");
  const relativePath = String(relativeValue || "").replace(/\\/g, "/");
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
    throw httpError("Work file path must stay inside the project root.");
  }
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw httpError("Work file path escaped the project root.", 403);
  }
  const realTarget = await fs.realpath(target).catch(() => null);
  if (!realTarget) throw httpError("Work file was not found.", 404);
  if (realTarget !== root && !realTarget.startsWith(`${root}${path.sep}`)) {
    throw httpError("Work file symlink escaped the project root.", 403);
  }
  return { root, target: realTarget, relativePath: path.relative(root, target).replace(/\\/g, "/") };
}

function assertTextBuffer(buffer) {
  if (buffer.includes(0)) throw httpError("Binary files cannot be edited in Work Files.", 415);
}

async function readWorkFile({ root, filePath }) {
  const resolved = await resolveProjectFile(root, filePath);
  const stats = await fs.stat(resolved.target).catch(() => null);
  if (!stats?.isFile()) throw httpError("Work file was not found.", 404);
  if (stats.size > MAX_TEXT_FILE_BYTES) throw httpError("Work Files can open text files up to 1 MB.", 413);
  const buffer = await fs.readFile(resolved.target);
  assertTextBuffer(buffer);
  return { path: resolved.relativePath, content: buffer.toString("utf8"), sizeBytes: stats.size, modifiedAt: stats.mtime.toISOString() };
}

async function writeWorkFile({ root, filePath, content, approvalGranted }) {
  if (approvalGranted !== true) throw httpError("Explicit approval is required before saving a Work file.", 403);
  const resolved = await resolveProjectFile(root, filePath);
  const stats = await fs.stat(resolved.target).catch(() => null);
  if (!stats?.isFile()) throw httpError("Work file was not found.", 404);
  const text = String(content ?? "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_TEXT_FILE_BYTES) throw httpError("Work Files can save text files up to 1 MB.", 413);
  const existing = await fs.readFile(resolved.target);
  assertTextBuffer(existing);
  const temporary = `${resolved.target}.luke-tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, text, { encoding: "utf8", mode: stats.mode });
    await fs.rename(temporary, resolved.target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return { path: resolved.relativePath, sizeBytes: bytes, saved: true };
}

module.exports = { MAX_TEXT_FILE_BYTES, readWorkFile, writeWorkFile };

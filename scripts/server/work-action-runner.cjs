"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const READ_ONLY_COMMANDS = {
  "git-status": { file: "git", args: ["status", "--short", "--branch"] },
  "git-diff": { file: "git", args: ["diff", "--stat"] },
  "git-log": { file: "git", args: ["log", "--oneline", "--decorate", "-20"] },
};

async function validatedRoot(value) {
  if (!value || !path.isAbsolute(String(value))) {
    const error = new Error("Work action root must be an absolute path.");
    error.statusCode = 400;
    throw error;
  }
  const root = path.resolve(String(value));
  const stats = await fs.stat(root).catch(() => null);
  if (!stats?.isDirectory()) {
    const error = new Error("Work action root is not an available directory.");
    error.statusCode = 400;
    throw error;
  }
  return root;
}

async function runReadOnlyWorkCommand({ root, commandId }) {
  const cwd = await validatedRoot(root);
  if (commandId === "list-files") {
    const entries = await fs.readdir(cwd);
    return { commandId, output: entries.slice(0, 300).join("\n"), exitCode: 0 };
  }
  const command = READ_ONLY_COMMANDS[commandId];
  if (!command) {
    const error = new Error("This Work terminal command is not allowed.");
    error.statusCode = 400;
    throw error;
  }
  try {
    const result = await execFileAsync(command.file, command.args, {
      cwd,
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
      encoding: "utf8",
    });
    return { commandId, output: String(result.stdout || result.stderr || "No output."), exitCode: 0 };
  } catch (error) {
    return {
      commandId,
      output: String(error.stdout || error.stderr || error.message || "Command failed."),
      exitCode: Number(error.code) || 1,
    };
  }
}

function launch(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function openWorkTarget({ root, target, url, approvalGranted }) {
  if (approvalGranted !== true) {
    const error = new Error("Explicit approval is required before opening an external Work target.");
    error.statusCode = 403;
    throw error;
  }
  const cwd = await validatedRoot(root);
  const supported = new Set(["files", "terminal", "vscode", "browser"]);
  if (!supported.has(target)) {
    const error = new Error("Unsupported Work open target.");
    error.statusCode = 400;
    throw error;
  }

  if (target === "browser") {
    const address = new URL(String(url || "https://www.google.com"));
    if (!["http:", "https:"].includes(address.protocol)) {
      const error = new Error("Only HTTP and HTTPS browser URLs are allowed.");
      error.statusCode = 400;
      throw error;
    }
    if (process.platform === "darwin") await launch("/usr/bin/open", [address.href]);
    else if (process.platform === "win32") await launch("rundll32.exe", ["url.dll,FileProtocolHandler", address.href]);
    else await launch("xdg-open", [address.href]);
    return { opened: target, value: address.href };
  }

  if (process.platform === "darwin") {
    if (target === "files") await launch("/usr/bin/open", [cwd]);
    if (target === "terminal") await launch("/usr/bin/open", ["-a", "Terminal", cwd]);
    if (target === "vscode") await launch("/usr/bin/open", ["-a", "Visual Studio Code", cwd]);
  } else if (process.platform === "win32") {
    if (target === "files") await launch("explorer.exe", [cwd]);
    if (target === "terminal") await launch("wt.exe", ["-d", cwd]);
    if (target === "vscode") await launch("code.cmd", [cwd]);
  } else {
    if (target === "files") await launch("xdg-open", [cwd]);
    if (target === "terminal") await launch("x-terminal-emulator", ["--working-directory", cwd]);
    if (target === "vscode") await launch("code", [cwd]);
  }
  return { opened: target, value: cwd };
}

module.exports = { openWorkTarget, runReadOnlyWorkCommand };

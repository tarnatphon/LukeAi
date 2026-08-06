"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  spawn,
} = require("node:child_process");

function readJson(filePath) {
  return JSON.parse(
    fs.readFileSync(
      filePath,
      "utf8"
    )
  );
}

function writeJsonAtomic(
  filePath,
  value
) {
  fs.mkdirSync(
    path.dirname(filePath),
    {
      recursive: true,
    }
  );

  const temporaryPath =
    `${filePath}.tmp-${process.pid}-${Date.now()}`;

  fs.writeFileSync(
    temporaryPath,
    JSON.stringify(
      value,
      null,
      2
    ) + "\n",
    "utf8"
  );

  fs.renameSync(
    temporaryPath,
    filePath
  );
}

function expandHome(value) {
  const text =
    String(value || "");

  if (text === "~") {
    return os.homedir();
  }

  if (text.startsWith("~/")) {
    return path.join(
      os.homedir(),
      text.slice(2)
    );
  }

  return text;
}

function createJobId() {
  return (
    `runtime-install-${Date.now()}-` +
    Math.random()
      .toString(16)
      .slice(2)
  );
}

function executableExists(
  executablePath
) {
  try {
    fs.accessSync(
      executablePath,
      fs.constants.X_OK
    );

    return true;
  } catch {
    return false;
  }
}

class RuntimeInstallQueue {
  constructor({
    root,
    policyPath,
    statePath,
    spawnImpl = spawn,
  }) {
    this.root = root;
    this.policyPath =
      policyPath;
    this.statePath =
      statePath;
    this.spawnImpl =
      spawnImpl;

    this.activeChild = null;
    this.processing = false;
  }

  readPolicy() {
    return readJson(
      this.policyPath
    );
  }

  readState() {
    if (
      !fs.existsSync(
        this.statePath
      )
    ) {
      return {
        schemaVersion: 1,
        updatedAt: null,
        activeJobId: null,
        jobs: [],
      };
    }

    return readJson(
      this.statePath
    );
  }

  writeState(state) {
    state.updatedAt =
      new Date().toISOString();

    writeJsonAtomic(
      this.statePath,
      state
    );

    return state;
  }

  getSnapshot() {
    const state =
      this.readState();

    return {
      ...state,
      processing:
        this.processing,
    };
  }

  resolveHomebrew() {
    const candidates = [
      "/opt/homebrew/bin/brew",
      "/usr/local/bin/brew",
    ];

    return (
      candidates.find(
        executableExists
      ) ||
      null
    );
  }

  resolvePython() {
    const candidates = [
      process.env.PYTHON3,
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/usr/bin/python3",
    ].filter(Boolean);

    return (
      candidates.find(
        executableExists
      ) ||
      null
    );
  }

  getInstallPlan(
    runtimeType
  ) {
    const policy =
      this.readPolicy();

    const definition =
      policy.supportedRuntimes
        ?.[runtimeType];

    if (!definition) {
      const error = new Error(
        "Unsupported runtime type."
      );

      error.statusCode = 400;
      throw error;
    }

    if (
      definition.appleSiliconOnly ===
        true &&
      !(
        process.platform ===
          "darwin" &&
        process.arch === "arm64"
      )
    ) {
      const error = new Error(
        `${runtimeType} requires Apple Silicon.`
      );

      error.statusCode = 409;
      throw error;
    }

    if (
      definition.installer ===
      "homebrew"
    ) {
      if (
        policy.installation
          ?.allowHomebrew !== true
      ) {
        const error = new Error(
          "Homebrew installation is disabled."
        );

        error.statusCode = 403;
        throw error;
      }

      const brew =
        this.resolveHomebrew();

      if (!brew) {
        const error = new Error(
          "Homebrew was not detected. Install Homebrew before installing this runtime."
        );

        error.statusCode = 409;
        throw error;
      }

      return {
        runtimeType,
        displayName:
          definition.displayName,
        command: brew,
        arguments: [
          "install",
          definition.package,
        ],
        workingDirectory:
          this.root,
        environment: {
          ...process.env,
          HOMEBREW_NO_AUTO_UPDATE:
            "1",
        },
        installationType:
          "homebrew",
      };
    }

    if (
      definition.installer ===
      "python-venv"
    ) {
      if (
        policy.installation
          ?.allowPythonVenv !== true
      ) {
        const error = new Error(
          "Python virtual environment installation is disabled."
        );

        error.statusCode = 403;
        throw error;
      }

      const python =
        this.resolvePython();

      if (!python) {
        const error = new Error(
          "Python 3 was not detected."
        );

        error.statusCode = 409;
        throw error;
      }

      const venvRoot =
        expandHome(
          policy.paths
            ?.pythonVenvRoot ||
          "~/Library/Application Support/LUKE AI STUDIO/runtime-venvs"
        );

      const venvPath =
        path.join(
          venvRoot,
          runtimeType
            .replace(/[^a-z0-9.-]/gi, "-")
        );

      const installerScript =
        [
          "import os, subprocess, sys, venv",
          `target=${JSON.stringify(venvPath)}`,
          "os.makedirs(os.path.dirname(target), exist_ok=True)",
          "venv.EnvBuilder(with_pip=True, clear=False).create(target)",
          "pip=os.path.join(target, 'bin', 'pip')",
          `subprocess.check_call([pip, 'install', '--upgrade', ${JSON.stringify(definition.package)}])`,
        ].join(";");

      return {
        runtimeType,
        displayName:
          definition.displayName,
        command: python,
        arguments: [
          "-c",
          installerScript,
        ],
        workingDirectory:
          this.root,
        environment: {
          ...process.env,
        },
        installationType:
          "python-venv",
        venvPath,
      };
    }

    const error = new Error(
      "Unsupported installer type."
    );

    error.statusCode = 400;
    throw error;
  }

  enqueue(runtimeType) {
    const policy =
      this.readPolicy();

    const state =
      this.readState();

    const maximumQueuedJobs =
      Number(
        policy.queue
          ?.maximumQueuedJobs
      ) || 20;

    const pendingCount =
      state.jobs.filter(
        (job) =>
          [
            "queued",
            "installing",
          ].includes(
            job.status
          )
      ).length;

    if (
      pendingCount >=
      maximumQueuedJobs
    ) {
      const error = new Error(
        "Runtime install queue is full."
      );

      error.statusCode = 409;
      throw error;
    }

    const duplicate =
      state.jobs.find(
        (job) =>
          job.runtimeType ===
            runtimeType &&
          [
            "queued",
            "installing",
          ].includes(
            job.status
          )
      );

    if (duplicate) {
      return duplicate;
    }

    const plan =
      this.getInstallPlan(
        runtimeType
      );

    const job = {
      id:
        createJobId(),
      runtimeType,
      displayName:
        plan.displayName,
      installationType:
        plan.installationType,
      status:
        "queued",
      createdAt:
        new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      log: "",
      cancelledAt: null,
    };

    state.jobs.push(job);

    this.writeState(state);

    queueMicrotask(
      () => {
        this.processNext()
          .catch(() => {});
      }
    );

    return job;
  }

  appendLog(
    jobId,
    content
  ) {
    const policy =
      this.readPolicy();

    const maximumCharacters =
      Number(
        policy.installation
          ?.maximumLogCharacters
      ) || 50000;

    const state =
      this.readState();

    const job =
      state.jobs.find(
        (item) =>
          item.id === jobId
      );

    if (!job) {
      return;
    }

    job.log =
      (
        String(job.log || "") +
        String(content || "")
      ).slice(
        -maximumCharacters
      );

    this.writeState(state);
  }

  updateJob(
    jobId,
    updater
  ) {
    const state =
      this.readState();

    const index =
      state.jobs.findIndex(
        (job) =>
          job.id === jobId
      );

    if (index < 0) {
      return null;
    }

    const current =
      state.jobs[index];

    const updated =
      updater({
        ...current,
      }) || current;

    state.jobs[index] =
      updated;

    this.writeState(state);

    return updated;
  }

  async runJob(job) {
    const policy =
      this.readPolicy();

    const plan =
      this.getInstallPlan(
        job.runtimeType
      );

    this.updateJob(
      job.id,
      (current) => ({
        ...current,
        status:
          "installing",
        startedAt:
          new Date().toISOString(),
        error: null,
      })
    );

    const state =
      this.readState();

    state.activeJobId =
      job.id;

    this.writeState(state);

    const child =
      this.spawnImpl(
        plan.command,
        plan.arguments,
        {
          cwd:
            plan.workingDirectory,
          env:
            plan.environment,
          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
          detached: false,
          shell: false,
        }
      );

    this.activeChild =
      child;

    child.stdout?.on(
      "data",
      (chunk) => {
        this.appendLog(
          job.id,
          String(chunk)
        );
      }
    );

    child.stderr?.on(
      "data",
      (chunk) => {
        this.appendLog(
          job.id,
          String(chunk)
        );
      }
    );

    const timeoutMs =
      Number(
        policy.installation
          ?.timeoutMs
      ) || 1800000;

    let timedOut = false;

    const timeout =
      setTimeout(
        () => {
          timedOut = true;

          if (
            child.exitCode ===
            null
          ) {
            child.kill(
              "SIGTERM"
            );
          }
        },
        timeoutMs
      );

    const result =
      await new Promise(
        (resolve) => {
          child.once(
            "error",
            (error) => {
              resolve({
                exitCode: null,
                signal: null,
                error:
                  error instanceof Error
                    ? error.message
                    : String(error),
              });
            }
          );

          child.once(
            "exit",
            (
              exitCode,
              signal
            ) => {
              resolve({
                exitCode,
                signal,
                error: null,
              });
            }
          );
        }
      );

    clearTimeout(timeout);

    this.activeChild =
      null;

    const latest =
      this.readState();

    const latestJob =
      latest.jobs.find(
        (item) =>
          item.id === job.id
      );

    if (
      latestJob?.status ===
      "cancelled"
    ) {
      latest.activeJobId =
        null;

      this.writeState(latest);
      return;
    }

    if (
      result.exitCode === 0 &&
      !timedOut &&
      !result.error
    ) {
      this.updateJob(
        job.id,
        (current) => ({
          ...current,
          status:
            "completed",
          completedAt:
            new Date().toISOString(),
          exitCode:
            result.exitCode,
          signal:
            result.signal,
          error: null,
        })
      );
    } else {
      this.updateJob(
        job.id,
        (current) => ({
          ...current,
          status:
            "failed",
          completedAt:
            new Date().toISOString(),
          exitCode:
            result.exitCode,
          signal:
            result.signal,
          error:
            timedOut
              ? "Installation timed out."
              : (
                  result.error ||
                  `Installer exited with code ${result.exitCode}`
                ),
        })
      );
    }

    const finalState =
      this.readState();

    finalState.activeJobId =
      null;

    this.writeState(
      finalState
    );
  }

  async processNext() {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      while (true) {
        const state =
          this.readState();

        const next =
          state.jobs.find(
            (job) =>
              job.status ===
              "queued"
          );

        if (!next) {
          break;
        }

        await this.runJob(next);

        const policy =
          this.readPolicy();

        const latest =
          this.readState();

        const completed =
          latest.jobs.find(
            (job) =>
              job.id === next.id
          );

        if (
          completed?.status ===
            "failed" &&
          policy.queue
            ?.continueAfterFailure ===
            false
        ) {
          break;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  cancel(jobId) {
    const state =
      this.readState();

    const job =
      state.jobs.find(
        (item) =>
          item.id === jobId
      );

    if (!job) {
      const error = new Error(
        "Install job was not found."
      );

      error.statusCode = 404;
      throw error;
    }

    if (
      ![
        "queued",
        "installing",
      ].includes(
        job.status
      )
    ) {
      return job;
    }

    job.status =
      "cancelled";

    job.cancelledAt =
      new Date().toISOString();

    job.completedAt =
      job.cancelledAt;

    if (
      state.activeJobId ===
      jobId
    ) {
      state.activeJobId =
        null;

      if (
        this.activeChild &&
        this.activeChild.exitCode ===
          null
      ) {
        this.activeChild.kill(
          "SIGTERM"
        );
      }
    }

    this.writeState(state);

    return job;
  }

  clearCompleted() {
    const state =
      this.readState();

    state.jobs =
      state.jobs.filter(
        (job) =>
          [
            "queued",
            "installing",
          ].includes(
            job.status
          )
      );

    this.writeState(state);

    return this.getSnapshot();
  }
}

module.exports = {
  RuntimeInstallQueue,
};

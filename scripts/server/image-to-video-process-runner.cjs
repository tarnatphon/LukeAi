"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  spawn,
} = require("node:child_process");

function clampProgress(value) {
  const number =
    Number(value);

  if (
    !Number.isFinite(
      number
    )
  ) {
    return null;
  }

  return Math.max(
    0,
    Math.min(
      99.9,
      number
    )
  );
}

function parseProgressChunk(
  chunk
) {
  const text =
    String(
      chunk || ""
    )
      .replace(/\r/g, "\n");

  let best = null;

  const ratioPattern =
    /(?:^|\s)(\d{1,4})\s*\/\s*(\d{1,4})(?:\s|$|\[)/g;

  for (
    const match of
    text.matchAll(
      ratioPattern
    )
  ) {
    const step =
      Number(
        match[1]
      );

    const total =
      Number(
        match[2]
      );

    if (
      total > 0 &&
      step >= 0
    ) {
      const percent =
        clampProgress(
          (
            step /
            total
          ) *
            100
        );

      if (
        percent !== null &&
        (
          best === null ||
          percent >
            best.percent
        )
      ) {
        best = {
          percent,
          step,
          total,
          message:
            `Inference ${step}/${total}`,
        };
      }
    }
  }

  const percentPattern =
    /(?:^|\s)(\d{1,3}(?:\.\d+)?)%\|/g;

  for (
    const match of
    text.matchAll(
      percentPattern
    )
  ) {
    const percent =
      clampProgress(
        match[1]
      );

    if (
      percent !== null &&
      (
        best === null ||
        percent >
          best.percent
      )
    ) {
      best = {
        percent,
        step:
          best?.step ??
          null,
        total:
          best?.total ??
          null,
        message:
          `Inference ${Math.round(percent)}%`,
      };
    }
  }

  return best;
}

function parseWorkerResult(
  stdout
) {
  const lines =
    String(
      stdout || ""
    )
      .split(/\r?\n/)
      .map(
        (line) =>
          line.trim()
      )
      .filter(
        Boolean
      );

  for (
    let index =
      lines.length - 1;
    index >= 0;
    index -= 1
  ) {
    const line =
      lines[index];

    if (
      !line.startsWith(
        "{"
      )
    ) {
      continue;
    }

    try {
      const parsed =
        JSON.parse(
          line
        );

      if (
        parsed &&
        typeof parsed ===
          "object"
      ) {
        return parsed;
      }
    } catch {
    }
  }

  return null;
}

class ImageToVideoProcessRunner {
  constructor({
    root,
    jobManager,
    spawnImpl = spawn,
    runtimePython = null,
    workerPath = null,
  }) {
    if (!root) {
      throw new Error(
        "root is required"
      );
    }

    if (!jobManager) {
      throw new Error(
        "jobManager is required"
      );
    }

    this.root =
      path.resolve(root);

    this.jobManager =
      jobManager;

    this.spawnImpl =
      spawnImpl;

    this.runtimePython =
      runtimePython ||
      path.join(
        this.root,
        "app",
        "runtimes",
        "image-to-video",
        "venv",
        "bin",
        "python"
      );

    this.workerPath =
      workerPath ||
      path.join(
        this.root,
        "scripts",
        "workers",
        "image_to_video_worker.py"
      );
  }

  assertRuntime() {
    if (
      !fs.existsSync(
        this.runtimePython
      )
    ) {
      throw new Error(
        "Image-to-Video runtime Python is missing."
      );
    }

    if (
      !fs.existsSync(
        this.workerPath
      )
    ) {
      throw new Error(
        "Image-to-Video worker is missing."
      );
    }
  }

  buildEnvironment() {
    return {
      ...process.env,

      HF_HUB_OFFLINE:
        "1",

      TRANSFORMERS_OFFLINE:
        "1",

      HF_HUB_DISABLE_XET:
        "1",

      TOKENIZERS_PARALLELISM:
        "false",

      PYTHONUNBUFFERED:
        "1",
    };
  }

  startPreparedJob(
    jobId,
    {
      args,
      cwd = this.root,
      output = null,
    }
  ) {
    this.assertRuntime();

    if (
      !Array.isArray(
        args
      ) ||
      args.length === 0
    ) {
      throw new Error(
        "Prepared worker arguments are required."
      );
    }

    const current =
      this.jobManager
        .getJob(
          jobId
        );

    if (!current) {
      throw new Error(
        `Image-to-Video job not found: ${jobId}`
      );
    }

    if (
      current.state !==
      "queued"
    ) {
      throw new Error(
        `Job ${jobId} must be queued before execution.`
      );
    }

    const child =
      this.spawnImpl(
        this.runtimePython,
        [
          "-u",
          this.workerPath,
          ...args,
        ],
        {
          cwd,
          env:
            this.buildEnvironment(),

          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        }
      );

    this.jobManager
      .startJob(
        jobId,
        child
      );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finishOnce =
      (callback) => {
        if (settled) {
          return;
        }

        settled = true;
        callback();
      };

    if (
      child.stdout &&
      typeof child.stdout.on ===
        "function"
    ) {
      child.stdout.on(
        "data",
        (chunk) => {
          const text =
            String(chunk);

          stdout += text;

          const progress =
            parseProgressChunk(
              text
            );

          if (progress) {
            this.jobManager
              .updateProgress(
                jobId,
                progress
              );
          }
        }
      );
    }

    if (
      child.stderr &&
      typeof child.stderr.on ===
        "function"
    ) {
      child.stderr.on(
        "data",
        (chunk) => {
          const text =
            String(chunk);

          stderr += text;

          const progress =
            parseProgressChunk(
              text
            );

          if (progress) {
            this.jobManager
              .updateProgress(
                jobId,
                progress
              );
          }
        }
      );
    }

    child.on(
      "error",
      (error) => {
        finishOnce(
          () => {
            this.jobManager
              .failJob(
                jobId,
                {
                  code:
                    "PROCESS_START_FAILED",

                  message:
                    error instanceof Error
                      ? error.message
                      : String(error),
                }
              );
          }
        );
      }
    );

    child.on(
      "close",
      (
        code,
        signal
      ) => {
        finishOnce(
          () => {
            const latest =
              this.jobManager
                .getJob(
                  jobId
                );

            if (
              latest?.state ===
              "cancelling"
            ) {
              this.jobManager
                .confirmCancelled(
                  jobId
                );

              return;
            }

            const result =
              parseWorkerResult(
                stdout
              );

            if (
              code === 0 &&
              result?.ok ===
                true
            ) {
              this.jobManager
                .completeJob(
                  jobId,
                  {
                    ...(output ||
                      {}),

                    worker:
                      result,
                  }
                );

              return;
            }

            const workerError =
              result?.error ||
              stderr
                .trim()
                .slice(
                  -4000
                ) ||
              stdout
                .trim()
                .slice(
                  -4000
                ) ||
              `Worker exited with code ${code}`;

            this.jobManager
              .failJob(
                jobId,
                {
                  code:
                    signal
                      ? "PROCESS_SIGNALLED"
                      : "GENERATION_FAILED",

                  message:
                    signal
                      ? `${workerError} (signal ${signal})`
                      : workerError,
                }
              );
          }
        );
      }
    );

    return {
      job:
        this.jobManager
          .getJob(
            jobId
          ),

      pid:
        Number.isInteger(
          child.pid
        )
          ? child.pid
          : null,
    };
  }
}

module.exports = {
  ImageToVideoProcessRunner,
  parseProgressChunk,
  parseWorkerResult,
};

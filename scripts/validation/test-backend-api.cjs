#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..", "..");
const serverFile = path.join(
  projectRoot,
  "scripts",
  "server",
  "serve.cjs"
);

const startupTimeoutMs = Number(
  process.env.LUKE_API_TEST_TIMEOUT_MS || 30000
);

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.unref();

    server.on("error", reject);

    server.listen(
      {
        host: "127.0.0.1",
        port: 0,
      },
      () => {
        const address = server.address();

        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("Unable to allocate test port."));
          return;
        }

        const port = address.port;

        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(port);
        });
      }
    );
  });
}

function discoverHealthEndpoints(source) {
  const candidates = new Set([
    "/api/health",
    "/api/status",
    "/health",
    "/status",
  ]);

  const patterns = [
    /["'`](\/api\/(?:health|status|ready|ping))["'`]/gi,
    /["'`](\/(?:health|status|ready|ping))["'`]/gi,
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(source)) !== null) {
      candidates.add(match[1]);
    }
  }

  return Array.from(candidates);
}

async function requestEndpoint(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });

    const body = await response.text();

    return {
      ok: response.status >= 200 && response.status < 500,
      status: response.status,
      body: body.slice(0, 500),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: error instanceof Error
        ? error.message
        : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  const stopped = await Promise.race([
    new Promise((resolve) => {
      child.once("exit", () => resolve(true));
    }),
    delay(3000).then(() => false),
  ]);

  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

async function main() {
  if (!fs.existsSync(serverFile)) {
    throw new Error(`Backend server not found: ${serverFile}`);
  }

  const source = fs.readFileSync(serverFile, "utf8");
  const endpoints = discoverHealthEndpoints(source);
  const port = await getFreePort();

  console.log("LUKE AI STUDIO Backend API Smoke Test");
  console.log(`Server : ${serverFile}`);
  console.log(`Port   : ${port}`);
  console.log(`Routes : ${endpoints.join(", ")}`);

  const output = [];

  const child = spawn(
    process.execPath,
    [serverFile],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: String(port),
        LUKE_AI_HOST: "127.0.0.1",
        LUKE_AI_PORT: String(port),
        LOCAL_AI_HOST: "127.0.0.1",
        LOCAL_AI_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output.push(text);
    process.stdout.write(`[backend] ${text}`);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    output.push(text);
    process.stderr.write(`[backend] ${text}`);
  });

  let passed = false;
  let selectedEndpoint = "";
  let lastResult = null;

  const startedAt = Date.now();

  try {
    while (Date.now() - startedAt < startupTimeoutMs) {
      if (child.exitCode !== null) {
        throw new Error(
          `Backend exited before becoming ready. Exit code: ${child.exitCode}`
        );
      }

      for (const endpoint of endpoints) {
        const url = `http://127.0.0.1:${port}${endpoint}`;
        const result = await requestEndpoint(url);

        lastResult = result;

        if (result.ok) {
          passed = true;
          selectedEndpoint = endpoint;

          console.log("");
          console.log(`PASS: ${endpoint}`);
          console.log(`HTTP: ${result.status}`);

          if (result.body) {
            console.log(`Body: ${result.body}`);
          }

          break;
        }
      }

      if (passed) {
        break;
      }

      await delay(500);
    }
  } finally {
    await stopProcess(child);
  }

  if (!passed) {
    console.error("");
    console.error("FAIL: Backend API did not become ready.");

    if (lastResult) {
      console.error(`Last status: ${lastResult.status}`);
      console.error(`Last result: ${lastResult.body}`);
    }

    const logs = output.join("").trim();

    if (logs) {
      console.error("");
      console.error("Backend output:");
      console.error(logs.slice(-4000));
    }

    process.exit(1);
  }

  console.log("");
  console.log(
    `PASS: Backend API smoke test completed using ${selectedEndpoint}.`
  );

  process.exit(0);
}

main().catch((error) => {
  console.error("");
  console.error(
    error instanceof Error
      ? error.stack || error.message
      : String(error)
  );

  process.exit(1);
});

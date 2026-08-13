#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(
    path.join(root, relativePath),
    "utf8"
  );
}

function assertIncludes(content, marker, message) {
  if (!content.includes(marker)) {
    throw new Error(message);
  }
}

const api = read("app/frontend/src/services/api.js");
const server = read("scripts/server/serve.cjs");

assertIncludes(
  api,
  "response_format: options.responseFormat",
  "Frontend text chat API must forward JSON output response formats."
);

assertIncludes(
  server,
  "LUKE_AI_JSON_OUTPUT_CORE_COMMANDS_V1",
  "Server JSON output core command marker is missing."
);

assertIncludes(
  server,
  "function normalizeLlmResponseFormat(value)",
  "Server must normalize JSON output response formats before runtime dispatch."
);

assertIncludes(
  server,
  "return mode ? { type: mode } : undefined;",
  "Server must support string response format modes."
);

assertIncludes(
  server,
  "typeof value !== \"object\" || Array.isArray(value)",
  "Server must ignore invalid response format payloads."
);

assertIncludes(
  server,
  "response_format: normalizeLlmResponseFormat(body.response_format || body.responseFormat)",
  "Server must forward normalized response_format to the local text runtime."
);

console.log(
  "PASS: Frontend forwards JSON output response format options."
);

console.log(
  "PASS: Server normalizes JSON output response format commands."
);

console.log(
  "PASS: Server forwards JSON output response_format to local text runtime."
);

console.log(
  "PASS: Phase JSON Output Core Commands validation completed."
);

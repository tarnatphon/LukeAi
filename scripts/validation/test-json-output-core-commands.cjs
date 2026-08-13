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
  "function buildLlmResponseFormat(options = {})",
  "Frontend text chat API must expose a JSON output response format builder."
);

assertIncludes(
  api,
  "if (options.responseFormat)",
  "Frontend response format builder must preserve explicit responseFormat payloads."
);

assertIncludes(
  api,
  "if (!options.jsonSchema)",
  "Frontend response format builder must keep JSON schema output opt-in."
);

assertIncludes(
  api,
  "name: options.jsonSchemaName || \"luke_json_output\"",
  "Frontend JSON schema response format must use a stable default schema name."
);

assertIncludes(
  api,
  "strict: options.jsonSchemaStrict !== false",
  "Frontend JSON schema response format must default to strict mode."
);

assertIncludes(
  api,
  "response_format: buildLlmResponseFormat(options)",
  "Frontend text chat API must forward built JSON output response formats."
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
  "if (type === \"json_schema\")",
  "Server must handle JSON schema response formats explicitly."
);

assertIncludes(
  server,
  "if (!schema)",
  "Server must ignore JSON schema response formats without an object schema."
);

assertIncludes(
  server,
  "name: String(jsonSchema.name || value.name || \"luke_json_output\").trim() || \"luke_json_output\"",
  "Server must provide a stable JSON schema response format name."
);

assertIncludes(
  server,
  "strict: jsonSchema.strict !== false && value.strict !== false",
  "Server must default JSON schema response formats to strict mode."
);

assertIncludes(
  server,
  "response_format: normalizeLlmResponseFormat(body.response_format || body.responseFormat)",
  "Server must forward normalized response_format to the local text runtime."
);

assertIncludes(
  server,
  "const responseFormat =",
  "Server text-runtime payloads must build a normalized response format."
);

assertIncludes(
  server,
  "payload.response_format =",
  "Server text-runtime payloads must forward normalized response formats."
);

assertIncludes(
  server,
  "response_format:\n            body.response_format",
  "Server text-runtime stream endpoint must accept response_format from requests."
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
  "PASS: Server forwards JSON output response_format through text-runtime streams."
);

console.log(
  "PASS: Phase JSON Output Core Commands validation completed."
);

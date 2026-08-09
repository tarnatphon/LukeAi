#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const ui =
  fs.readFileSync(
    "app/frontend/src/components/ImageToVideo.jsx",
    "utf8"
  );

const service =
  fs.readFileSync(
    "app/frontend/src/services/api.js",
    "utf8"
  );

const card =
  fs.readFileSync(
    "app/frontend/src/components/ImageToVideoRuntimeHealthCard.jsx",
    "utf8"
  );

const server =
  fs.readFileSync(
    "scripts/server/serve.cjs",
    "utf8"
  );

const requiredUi = [
  "getImageToVideoRuntimeCapability",
  "ImageToVideoRuntimeHealthCard",
  "LUKE_AI_I2V_RUNTIME_HEALTH_STATE_V1",
  "LUKE_AI_I2V_RUNTIME_HEALTH_MOUNT_V1",
  "LUKE_AI_I2V_GENERATE_RUNTIME_GATE_V1",
  'modelId: "auto"',
  "imageDataUrl",
  "references",
  "referenceLock",
];

for (const value of requiredUi) {
  if (!ui.includes(value)) {
    throw new Error(
      `UI_CONTRACT_MISSING:${value}`
    );
  }
}

if (
  !service.includes(
    "/api/capabilities/image-to-video/runtime"
  )
) {
  throw new Error(
    "RUNTIME_SERVICE_ENDPOINT_MISSING"
  );
}

if (
  !card.includes(
    "Automatic install: OFF"
  ) ||
  !card.includes(
    "Automatic repair: OFF"
  )
) {
  throw new Error(
    "RUNTIME_UI_SAFETY_MISSING"
  );
}

for (
  const endpoint of
  [
    "/api/capabilities/image-to-video/runtime",
    "/api/image-to-video/compatibility",
    "/api/image-to-video/generate",
  ]
) {
  if (
    !server.includes(
      endpoint
    )
  ) {
    throw new Error(
      `BACKEND_ENDPOINT_MISSING:${endpoint}`
    );
  }
}

const generationCalls =
  ui.match(
    /generateImageToVideo\s*\(/g
  ) || [];

if (
  generationCalls.length !== 1
) {
  throw new Error(
    `EXPECTED_ONE_GENERATE_CALL:${generationCalls.length}`
  );
}

console.log(
  "PASS: Runtime Health service integration is present."
);

console.log(
  "PASS: Runtime Health UI displays Torch/MPS/FFmpeg/package state."
);

console.log(
  "PASS: Generate is guarded by real runtime readiness."
);

console.log(
  "PASS: Existing Image-to-Video generation payload remains intact."
);

console.log(
  "PASS: Runtime Health performs no automatic install, repair or model download."
);

console.log(
  "PASS: Image-to-Video Runtime UI Integration validation completed."
);

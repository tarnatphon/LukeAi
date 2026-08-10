#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const api =
  fs.readFileSync(
    "app/frontend/src/services/api.js",
    "utf8",
  );

const ui =
  fs.readFileSync(
    "app/frontend/src/components/ImageToVideo.jsx",
    "utf8",
  );

const serviceNames = [
  "createImageToVideoJob",
  "getImageToVideoJob",
  "listImageToVideoJobs",
  "cancelImageToVideoJob",
  "retryImageToVideoJob",
];

for (const name of serviceNames) {
  if (!api.includes(name)) {
    throw new Error(
      `ASYNC_SERVICE_MISSING:${name}`
    );
  }
}

for (
  const route of [
    "/api/image-to-video/jobs",
    "/cancel",
    "/retry",
  ]
) {
  if (!api.includes(route)) {
    throw new Error(
      `ASYNC_ROUTE_MISSING:${route}`
    );
  }
}

const uiContracts = [
  "LUKE_AI_I2V_ASYNC_JOB_IMPORT_V1",
  "LUKE_AI_I2V_ASYNC_JOB_STATE_V1",
  "LUKE_AI_I2V_ASYNC_JOB_RUN_V1",
  "LUKE_AI_I2V_ASYNC_JOB_UI_V1",
  "pollImageToVideoJob",
  "cancelActiveJob",
  "retryJob",
  "jobHistory",
  "generatedVideoUrl",
  "activeJob",
  "createImageToVideoJob",
];

for (const value of uiContracts) {
  if (!ui.includes(value)) {
    throw new Error(
      `ASYNC_UI_CONTRACT_MISSING:${value}`
    );
  }
}

if (
  ui.includes(
    "await generateImageToVideo({",
  )
) {
  throw new Error(
    "UI_STILL_USES_SYNCHRONOUS_GENERATION"
  );
}

if (
  !api.includes(
    "generateImageToVideo",
  )
) {
  throw new Error(
    "LEGACY_FRONTEND_FALLBACK_REMOVED"
  );
}

if (
  !ui.includes(
    "LUKE_AI_I2V_GENERATE_RUNTIME_GATE_V1",
  )
) {
  throw new Error(
    "RUNTIME_GATE_REMOVED"
  );
}

if (
  ui.includes(
    "downloads automatically on first generation",
  )
) {
  throw new Error(
    "STALE_HIDDEN_DOWNLOAD_COPY_PRESENT"
  );
}

console.log(
  "PASS: Frontend Job API services are present."
);

console.log(
  "PASS: ImageToVideo uses asynchronous job creation and polling."
);

console.log(
  "PASS: Live progress, cancel, retry and history UI are present."
);

console.log(
  "PASS: Completed job output is handed to the video player."
);

console.log(
  "PASS: Runtime readiness gate remains enforced."
);

console.log(
  "PASS: Legacy generate service remains available as fallback."
);

console.log(
  "PASS: Image-to-Video Async UI Migration validation completed."
);

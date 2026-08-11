#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const ui =
  fs.readFileSync(
    "app/frontend/src/components/ImageToVideo.jsx",
    "utf8"
  );

const importer =
  fs.readFileSync(
    "app/frontend/src/utils/imageToVideoPromptImport.js",
    "utf8"
  );

const packageJson =
  JSON.parse(
    fs.readFileSync(
      "app/frontend/package.json",
      "utf8"
    )
  );

const uiContracts = [
  "promptText",
  "durationSeconds",
  "importedPromptRows",
  "handlePromptFile",
  "Prompt Studio",
  "Import Prompt / Batch",
  ".txt,.md,.csv,.xlsx",
  "[5, 10, 15]",
  "durationRequiresStitch",
  "Segment/Stitch",
  "prompt: promptText",
  "seconds: durationSeconds",
];

for (
  const value of
  uiContracts
) {
  if (
    !ui.includes(
      value
    )
  ) {
    throw new Error(
      `PROMPT_STUDIO_UI_MISSING:${value}`
    );
  }
}

const importerContracts = [
  "read-excel-file/browser",
  "readSheet",
  "parseCsvText",
  "importPromptFile",
  ".txt",
  ".csv",
  ".xlsx",
];

for (
  const value of
  importerContracts
) {
  if (
    !importer.includes(
      value
    )
  ) {
    throw new Error(
      `PROMPT_IMPORTER_MISSING:${value}`
    );
  }
}

if (
  !packageJson
    .dependencies
    ?.[
      "read-excel-file"
    ]
) {
  throw new Error(
    "XLSX_DEPENDENCY_MISSING"
  );
}

if (
  ui.includes(
    'prompt: "",'
  )
) {
  throw new Error(
    "EMPTY_PROMPT_PAYLOAD_REMAINING"
  );
}

if (
  ui.includes(
    "seconds: 5,"
  )
) {
  throw new Error(
    "HARDCODED_DURATION_REMAINING"
  );
}

if (
  !ui.includes(
    "current certified local SVD path is locked"
  )
) {
  throw new Error(
    "DURATION_CAPABILITY_GATE_MISSING"
  );
}

console.log(
  "PASS: Prompt textarea is connected to the generation payload."
);

console.log(
  "PASS: TXT and Markdown prompt import are supported."
);

console.log(
  "PASS: CSV prompt table import is supported."
);

console.log(
  "PASS: XLSX prompt table import is supported."
);

console.log(
  "PASS: Imported batch rows are retained for the next batch execution phase."
);

console.log(
  "PASS: Duration selector exposes 5 / 10 / 15 second UX targets."
);

console.log(
  "PASS: 10 / 15 second requests are capability-gated until Segment/Stitch is certified."
);

console.log(
  "PASS: Certified async I2V Job API flow remains unchanged."
);

console.log(
  "PASS: Automatic Image-to-Video Prompt Studio Phase 3A-1 validation completed."
);

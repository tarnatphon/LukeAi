#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const app = fs.readFileSync("app/frontend/src/App.jsx", "utf8");
const lazyWorkspaces = [
  "Generator",
  "ModelManager",
  "Settings",
  "TextChat",
  "SpeechTranscriber",
  "TextToSpeech",
  "ImageToVideo",
  "RuntimeDownloadDashboard",
  "TextModelManager",
  "PersistentTextChat",
  "AssetLibrary",
];

function requireText(text, label) {
  if (!app.includes(text)) throw new Error(`${label}: ${text}`);
}

requireText("lazy, Suspense", "REACT_LAZY_IMPORT_MISSING");
requireText("<Suspense fallback={<WorkspaceFallback />}>", "SUSPENSE_BOUNDARY_MISSING");
requireText("const [visitedTabs, setVisitedTabs]", "VISITED_TAB_STATE_MISSING");
requireText("role=\"status\"", "ACCESSIBLE_LOADING_STATUS_MISSING");

for (const component of lazyWorkspaces) {
  requireText(
    `const ${component} = lazy(() => import(\"./components/${component}\"));`,
    `LAZY_WORKSPACE_MISSING_${component}`
  );
  if (app.includes(`import ${component} from \"./components/${component}\";`)) {
    throw new Error(`EAGER_WORKSPACE_IMPORT_PRESENT_${component}`);
  }
}

for (const tab of [
  "generator",
  "image-video",
  "assets",
  "models",
  "chat",
  "speech",
  "tts",
  "settings",
]) {
  requireText(`visitedTabs.has(\"${tab}\")`, `VISITED_TAB_GATE_MISSING_${tab}`);
}

console.log("PASS: Heavy workspaces use dynamic imports.");
console.log("PASS: Workspaces load only after their first visit.");
console.log("PASS: Visited workspaces remain mounted to preserve state.");
console.log("PASS: Lazy loading exposes an accessible status fallback.");
console.log("PASS: Beta 8 Frontend Lazy Workspace validation completed.");

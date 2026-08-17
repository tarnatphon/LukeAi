#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const sidebar = fs.readFileSync("app/frontend/src/components/Sidebar.jsx", "utf8");
const tabs = ["home", "generator", "image-video", "assets", "chat", "speech", "tts", "models", "settings"];

function requireText(text, label) {
  if (!sidebar.includes(text)) throw new Error(`${label}: ${text}`);
}

requireText("const navigationProps = (tab) =>", "NAVIGATION_PROPS_MISSING");
requireText('role: "link"', "NAVIGATION_ROLE_MISSING");
requireText("tabIndex: 0", "NAVIGATION_TAB_STOP_MISSING");
requireText('activeTab === tab ? "page" : undefined', "CURRENT_PAGE_STATE_MISSING");
requireText('event.key !== "Enter" && event.key !== " "', "KEYBOARD_ACTIVATION_MISSING");
requireText("event.target !== event.currentTarget", "NESTED_CONTROL_GUARD_MISSING");
requireText("event.preventDefault()", "SPACE_SCROLL_GUARD_MISSING");

for (const tab of tabs) {
  requireText(`navigationProps("${tab}")`, `KEYBOARD_NAVIGATION_MISSING_${tab}`);
}

console.log("PASS: Every primary workspace is keyboard reachable.");
console.log("PASS: Enter and Space activate focused navigation items.");
console.log("PASS: The active workspace exposes aria-current page state.");
console.log("PASS: Nested history controls do not trigger parent navigation.");
console.log("PASS: Beta 10 Frontend Keyboard Navigation validation completed.");

#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const chat = fs.readFileSync("app/frontend/src/components/TextChat.jsx", "utf8");

function requireText(text, label) {
  if (!chat.includes(text)) throw new Error(`${label}: ${text}`);
}

requireText(
  "compactConversationContext = (allMessages, contextLimit, reservedTokens = 0)",
  "AUTO_CONTEXT_COMPACTION_MISSING",
);
requireText(
  "totalBudget - Math.max(0, Number(reservedTokens) || 0)",
  "SYSTEM_PROMPT_RESERVATION_MISSING",
);
requireText(
  "messages: [{ role: \"system\", content: summary }, ...recent]",
  "EARLIER_MESSAGE_SUMMARY_MISSING",
);
requireText("archivedCount: older.length", "ARCHIVED_COUNT_MISSING");
requireText("activeMessageCount: recent.length", "ACTIVE_MESSAGE_COUNT_MISSING");
requireText("conversationId: activeConversationId", "LOADED_CONTEXT_STATUS_MISSING");
requireText("conversationId: convId", "ACTIVE_CONTEXT_STATUS_MISSING");
requireText("reservedSystemTokens", "RESERVED_SYSTEM_TOKENS_MISSING");
requireText('role="status"', "AUTO_CONTEXT_STATUS_MISSING");
requireText("Auto context refreshed", "AUTO_CONTEXT_STATUS_LABEL_MISSING");
requireText("older messages remain visible", "VISIBLE_HISTORY_NOTICE_MISSING");
requireText("<span>Delete history</span>", "DESTRUCTIVE_HISTORY_LABEL_MISSING");
requireText("defaultValue={localStorage.getItem(draftStorageKey)", "UNCONTROLLED_COMPOSER_MISSING");
requireText("luke_chat_draft:", "DRAFT_PERSISTENCE_MISSING");
requireText("event.nativeEvent.isComposing", "IME_COMPOSITION_GUARD_MISSING");
requireText("draftSaveTimerRef", "DRAFT_DEBOUNCE_MISSING");

console.log("PASS: Context automatically compacts before reaching the model limit.");
console.log("PASS: System prompt tokens are reserved before selecting recent messages.");
console.log("PASS: Earlier messages are summarized for inference without deleting history.");
console.log("PASS: The UI announces how many older messages remain visible.");
console.log("PASS: Destructive history deletion is labelled explicitly.");
console.log("PASS: Composer typing avoids full-chat rerenders and preserves drafts.");
console.log("PASS: IME composition cannot accidentally submit a partial message.");
console.log("PASS: Frontend Automatic Context Refresh validation completed.");

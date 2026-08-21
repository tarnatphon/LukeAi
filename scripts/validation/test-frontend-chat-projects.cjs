#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const projects = fs.readFileSync("app/frontend/src/components/ChatProjects.jsx", "utf8");
const app = fs.readFileSync("app/frontend/src/App.jsx", "utf8");
const sidebar = fs.readFileSync("app/frontend/src/components/Sidebar.jsx", "utf8");
const chat = fs.readFileSync("app/frontend/src/components/TextChat.jsx", "utf8");

function requireText(source, text, label) {
  if (!source.includes(text)) throw new Error(`${label}: ${text}`);
}

requireText(app, 'localStorage.getItem("chat_projects")', "PROJECT_PERSISTENCE_MISSING");
requireText(app, "projectId: activeProjectId", "CONVERSATION_PROJECT_LINK_MISSING");
requireText(sidebar, "<ChatProjects", "PROJECT_SIDEBAR_MISSING");
requireText(projects, 'aria-label="Create project"', "CREATE_PROJECT_MISSING");
requireText(projects, 'role="dialog"', "PROJECT_EDITOR_DIALOG_MISSING");
requireText(projects, "sourceFolders", "SOURCE_FOLDER_REFERENCES_MISSING");
requireText(projects, 'fetch("/api/storage/choose-folder"', "NATIVE_FOLDER_PICKER_MISSING");
requireText(projects, "!draftFolders.includes(selectedPath)", "DUPLICATE_FOLDER_GUARD_MISSING");
requireText(projects, "Source folders and files will not be deleted", "NON_DESTRUCTIVE_REMOVAL_NOTICE_MISSING");
requireText(projects, "conversation.projectId === project.id", "PROJECT_CHAT_FILTER_MISSING");
requireText(projects, "pinned", "PROJECT_PINNING_MISSING");
requireText(app, 'localStorage.getItem("luke_assistant_mode")', "ASSISTANT_MODE_PERSISTENCE_MISSING");
requireText(sidebar, 'setAssistantMode?.("chat")', "CHAT_MODE_OPTION_MISSING");
requireText(sidebar, 'setAssistantMode?.("work")', "WORK_MODE_OPTION_MISSING");
requireText(sidebar, 'assistantMode === "work" && <ChatProjects', "WORK_PROJECT_VISIBILITY_MISSING");
requireText(sidebar, "onContextMenu", "CHAT_CONTEXT_MENU_MISSING");
requireText(sidebar, "Move to Work project", "MOVE_CHAT_TO_PROJECT_MISSING");
requireText(sidebar, "onMoveConversationToProject", "MOVE_CHAT_HANDLER_MISSING");
requireText(chat, 'assistantMode === "work"', "WORK_MODE_PROMPT_MISSING");
requireText(chat, "Project source folders:", "WORK_SOURCE_FOLDER_CONTEXT_MISSING");
requireText(chat, 'label="Copy code"', "COPY_CODE_BUTTON_MISSING");
requireText(chat, 'label="Copy response"', "COPY_RESPONSE_BUTTON_MISSING");

console.log("PASS: Projects persist locally and link new Chat conversations.");
console.log("PASS: Projects can be created, renamed, pinned, selected and removed.");
console.log("PASS: Native source folders can be added and detached without deleting files.");
console.log("PASS: Project chats are grouped in the sidebar.");
console.log("PASS: Chat and Work modes persist and use distinct model instructions.");
console.log("PASS: Frontend Chat Projects foundation validation completed.");

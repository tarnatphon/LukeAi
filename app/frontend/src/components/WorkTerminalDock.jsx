import React, { useState } from "react";
import { ChevronDown, ChevronUp, SquareTerminal, X } from "lucide-react";

const COMMANDS = [
  { id: "git-status", label: "git status" },
  { id: "git-diff", label: "git diff --stat" },
  { id: "git-log", label: "git log -20" },
  { id: "list-files", label: "list files" },
];

export default function WorkTerminalDock({ project, onClose }) {
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeCommand, setActiveCommand] = useState("");
  const [output, setOutput] = useState("Read-only Work Terminal ready.");
  const [commandText, setCommandText] = useState("");
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const root = project?.sourceFolders?.[0] || "";

  const runCommand = async () => {
    const command = commandText.trim();
    if (!root || busy) return;
    if (!command) return;
    if (command === "clear") {
      setOutput("");
      setCommandText("");
      return;
    }
    setBusy(true);
    setActiveCommand(command);
    setHistory((current) => [...current.filter((item) => item !== command), command].slice(-50));
    setHistoryIndex(-1);
    setOutput((current) => `${current ? `${current}\n\n` : ""}$ ${command}\nRunning…`);
    try {
      const response = await fetch("/api/work/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, command }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Work command failed.");
      setOutput((current) => current.replace(/Running…$/, data.result?.output || "No output."));
      setCommandText("");
    } catch (error) {
      setOutput((current) => current.replace(/Running…$/, error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`work-terminal-dock ${collapsed ? "collapsed" : ""}`} aria-label="Bottom Work Terminal">
      <header>
        <div><SquareTerminal size={15} /><strong>Terminal</strong>{activeCommand && <span>{activeCommand}</span>}</div>
        <button type="button" onClick={() => setCollapsed((value) => !value)} title={collapsed ? "Expand Terminal" : "Collapse Terminal"}>{collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
        <button type="button" onClick={onClose} title="Close Terminal"><X size={16} /></button>
      </header>
      {!collapsed && (
        <div className="work-terminal-dock-body">
          <div className="work-terminal-dock-commands">
            {COMMANDS.map((command) => <button type="button" key={command.id} disabled={!root || busy} onClick={() => setCommandText(command.label)}>{command.label}</button>)}
          </div>
          {!root ? <div className="work-terminal-dock-empty">Add a source folder to this Work project to enable Terminal.</div> : <div className="work-terminal-session"><pre aria-live="polite">{output}</pre><form onSubmit={(event) => { event.preventDefault(); void runCommand(); }}><span>$</span><input autoComplete="off" spellCheck="false" value={commandText} onChange={(event) => setCommandText(event.target.value)} onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault();
              const nextIndex = Math.min(history.length - 1, historyIndex + 1);
              setHistoryIndex(nextIndex);
              if (nextIndex >= 0) setCommandText(history[history.length - 1 - nextIndex]);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              const nextIndex = historyIndex - 1;
              setHistoryIndex(nextIndex);
              setCommandText(nextIndex >= 0 ? history[history.length - 1 - nextIndex] : "");
            }
          }} placeholder="Type a read-only command…" disabled={busy} aria-label="Work Terminal command" /><button type="submit" disabled={busy || !commandText.trim()}>Run</button></form></div>}
        </div>
      )}
    </section>
  );
}

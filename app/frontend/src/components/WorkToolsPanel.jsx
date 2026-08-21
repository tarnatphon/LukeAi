import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, ExternalLink, File, Folder, GitBranch, Globe2, PanelRightClose, RefreshCw, Save, Terminal, X } from "lucide-react";

const WORK_FILES_CSS = `.work-files-workspace{display:flex;flex-direction:column;gap:10px}.work-file-list>button,.work-file-breadcrumbs button{display:flex;align-items:center;gap:8px;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit}.work-file-list>button{width:100%;padding:7px 4px;border-radius:7px;font-size:.73rem;text-align:left}.work-file-list>button:hover,.work-file-list>button.active{background:var(--md-sys-color-secondary-container)}.work-file-list>button span,.work-file-editor strong,.work-file-editor small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.work-file-filter{width:100%;box-sizing:border-box;margin-bottom:7px;padding:7px 9px;border:1px solid var(--md-sys-color-outline-variant);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:.7rem}.work-file-breadcrumbs{display:flex;align-items:center;gap:2px;overflow:auto;margin:-3px 0 8px}.work-file-breadcrumbs button{flex:0 0 auto;padding:3px;color:var(--md-sys-color-outline);font-size:.67rem}.work-file-editor{display:flex;flex-direction:column;gap:9px;min-height:310px;padding:13px;border:1px solid var(--md-sys-color-outline-variant);border-radius:13px;background:var(--md-sys-color-surface-container)}.work-file-editor>header,.work-file-editor>footer{display:flex;align-items:center;justify-content:space-between;gap:8px}.work-file-editor>header>div{min-width:0;display:flex;flex-direction:column;gap:2px}.work-file-editor small,.work-file-editor>footer span{color:var(--md-sys-color-outline);font-size:.65rem}.work-file-editor textarea{flex:1;min-height:220px;resize:vertical;padding:10px;border:1px solid var(--md-sys-color-outline-variant);border-radius:9px;outline:0;background:#111;color:#d8eadf;caret-color:#67d391;font:12px/1.5 monospace;tab-size:2}.work-file-editor button{display:flex;align-items:center;gap:5px;min-height:29px;padding:0 8px;border:1px solid var(--md-sys-color-outline-variant);border-radius:8px;background:transparent;color:inherit;cursor:pointer}.work-file-editor button:disabled{opacity:.4;cursor:not-allowed}`;

export default function WorkToolsPanel({ project, approvalMode = "auto", onClose }) {
  const [tab, setTab] = useState("environment");
  const [environment, setEnvironment] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [terminalOutput, setTerminalOutput] = useState("Choose a read-only command to inspect this project.");
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("https://www.google.com");
  const [openFile, setOpenFile] = useState(null);
  const [fileDraft, setFileDraft] = useState("");
  const [fileBusy, setFileBusy] = useState(false);
  const [directory, setDirectory] = useState({ path: "", parentPath: "", entries: [] });
  const [fileFilter, setFileFilter] = useState("");
  const rootStorageKey = `luke_work_root:${project?.id || "none"}`;
  const [selectedRoot, setSelectedRoot] = useState(() => localStorage.getItem(rootStorageKey) || project?.sourceFolders?.[0] || "");
  const fileDirty = Boolean(openFile && fileDraft !== openFile.content);
  const visibleDirectoryEntries = useMemo(() => {
    const query = fileFilter.trim().toLocaleLowerCase();
    return query ? directory.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query)) : directory.entries;
  }, [directory.entries, fileFilter]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/work/environment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceFolders: project?.sourceFolders || [], activeRoot: selectedRoot }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not inspect the Work environment.");
      setEnvironment(data.environment);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoading(false);
    }
  }, [project, selectedRoot]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const roots = project?.sourceFolders || [];
    const stored = localStorage.getItem(rootStorageKey);
    setSelectedRoot(roots.includes(stored) ? stored : roots[0] || "");
  }, [project?.id, project?.sourceFolders, rootStorageKey]);
  useEffect(() => { if (selectedRoot) localStorage.setItem(rootStorageKey, selectedRoot); }, [rootStorageKey, selectedRoot]);

  const openDirectory = useCallback(async (directoryPath = "") => {
    if (!selectedRoot) return;
    setFileBusy(true);
    setError("");
    try {
      const response = await fetch("/api/work/directory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: selectedRoot, path: directoryPath }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not open the Work directory.");
      setDirectory(data.directory);
      setFileFilter("");
    } catch (directoryError) {
      setError(directoryError instanceof Error ? directoryError.message : String(directoryError));
    } finally {
      setFileBusy(false);
    }
  }, [selectedRoot]);

  useEffect(() => { if (tab === "files" && selectedRoot) void openDirectory(""); }, [tab, selectedRoot, openDirectory]);

  const runCommand = async (commandId) => {
    if (!selectedRoot) return;
    setTerminalBusy(true);
    setTerminalOutput(`Running ${commandId}…`);
    try {
      const response = await fetch("/api/work/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: selectedRoot, commandId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Work command failed.");
      setTerminalOutput(data.result?.output || "No output.");
      await refresh();
    } catch (commandError) {
      setTerminalOutput(commandError instanceof Error ? commandError.message : String(commandError));
    } finally {
      setTerminalBusy(false);
    }
  };

  const openTarget = async (target) => {
    if (!selectedRoot) return;
    const needsConfirmation = approvalMode !== "full";
    if (needsConfirmation && !window.confirm(`Allow LUKE AI to open ${target} for this Work project?`)) return;
    try {
      const response = await fetch("/api/work/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: selectedRoot, target, url: target === "browser" ? browserUrl : undefined, approvalGranted: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Could not open ${target}.`);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  };

  const readFile = async (filePath, force = false) => {
    if (!selectedRoot || fileBusy) return;
    if (!force && fileDirty && !window.confirm("Discard the unsaved Work file changes?")) return;
    setFileBusy(true);
    setError("");
    try {
      const response = await fetch("/api/work/file/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: selectedRoot, path: filePath }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not open the Work file.");
      setOpenFile(data.file);
      setFileDraft(data.file.content);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : String(readError));
    } finally {
      setFileBusy(false);
    }
  };

  const saveFile = async () => {
    if (!selectedRoot || !openFile || !fileDirty || fileBusy) return;
    if (approvalMode !== "full" && !window.confirm(`Allow LUKE AI to save ${openFile.path}?`)) return;
    setFileBusy(true);
    setError("");
    try {
      const response = await fetch("/api/work/file/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: selectedRoot, path: openFile.path, content: fileDraft, approvalGranted: true, expectedModifiedAt: openFile.modifiedAt }),
      });
      const data = await response.json();
      if (response.status === 409) {
        window.alert("This file changed on disk. Your draft is still here. Reload the file before saving again.");
        return;
      }
      if (!response.ok) throw new Error(data.error || "Could not save the Work file.");
      setOpenFile((current) => ({ ...current, content: fileDraft, sizeBytes: data.result?.sizeBytes ?? current.sizeBytes, modifiedAt: data.result?.modifiedAt ?? current.modifiedAt }));
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setFileBusy(false);
    }
  };

  const repository = environment?.repository;
  return (
    <aside className="work-tools-panel" aria-label="Work tools">
      <style>{WORK_FILES_CSS}</style>
      <header>
        <div><strong>{project?.name || "Work tools"}</strong><small>Project tools · guarded writes</small></div>
        <button type="button" onClick={refresh} disabled={loading} title="Refresh"><RefreshCw size={16} className={loading ? "progress-spinner" : ""} /></button>
        <button type="button" onClick={onClose} title="Close side panel"><PanelRightClose size={17} /></button>
      </header>
      <nav aria-label="Work tool sections">
        {["environment", "review", "files", "terminal", "browser"].map((item) => (
          <button type="button" className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>{item}</button>
        ))}
      </nav>
      {environment?.sourceFolders?.length > 1 && <label className="work-root-selector"><span>Source</span><select value={selectedRoot} onChange={(event) => { const nextRoot = event.target.value; if (fileDirty && !window.confirm("Discard the unsaved Work file changes before switching source folders?")) return; setSelectedRoot(nextRoot); setOpenFile(null); setFileDraft(""); }} aria-label="Active Work source folder">{environment.sourceFolders.map((folder) => <option value={folder} key={folder}>{folder}</option>)}</select></label>}
      <div className="work-tools-content">
        {error && <div className="work-tools-error">{error}</div>}
        {!error && !project && <div className="work-tools-empty">Select a Work project to inspect its environment.</div>}
        {!error && project && !project.sourceFolders?.length && <div className="work-tools-empty">Add a source folder in Edit project to enable Files and Review.</div>}
        {!error && environment && tab === "environment" && (
          <div className="work-tools-sections">
            <section><h3>Environment</h3><dl><dt>Platform</dt><dd>{navigator.platform || "Local"}</dd><dt>Project</dt><dd>{project?.name}</dd><dt>Source folders</dt><dd>{environment.sourceFolders.length}</dd></dl><div className="work-open-actions"><button type="button" onClick={() => openTarget("files")}><Folder size={14} /> Files</button><button type="button" onClick={() => openTarget("terminal")}><Terminal size={14} /> Terminal</button><button type="button" onClick={() => openTarget("vscode")}><ExternalLink size={14} /> VS Code</button></div></section>
            <section><h3>Repository</h3>{repository ? <dl><dt>Branch</dt><dd><GitBranch size={13} /> {repository.branch}</dd><dt>HEAD</dt><dd>{repository.head || "No commits"}</dd><dt>Sync</dt><dd>↑ {repository.ahead} · ↓ {repository.behind}</dd><dt>Changes</dt><dd>{repository.changeCount}</dd></dl> : <p>No Git repository detected.</p>}</section>
            <section><h3>Sources</h3>{environment.sourceFolders.map((folder) => <div className="work-tool-path" key={folder}><Folder size={14} /><span title={folder}>{folder}</span></div>)}</section>
          </div>
        )}
        {!error && environment && tab === "review" && (
          <div className="work-review-list">
            <h3>Changed files <span>{repository?.changeCount || 0}</span></h3>
            {!repository && <p>No Git repository detected.</p>}
            {repository && repository.changedFiles.length === 0 && <p>Working tree is clean.</p>}
            {repository?.changedFiles.map((entry) => <div key={`${entry.status}-${entry.path}`}><code>{entry.status}</code><span title={entry.path}>{entry.path}</span></div>)}
          </div>
        )}
        {!error && environment && tab === "files" && (
          <div className="work-files-workspace">
            <div className="work-file-list">
              <h3>Files <span>{visibleDirectoryEntries.length}/{directory.entries.length}</span></h3>
              <div className="work-file-breadcrumbs"><button type="button" onClick={() => void openDirectory("")}>Project</button>{directory.path.split("/").filter(Boolean).map((part, index, parts) => { const target = parts.slice(0, index + 1).join("/"); return <React.Fragment key={target}><ChevronRight size={12} /><button type="button" onClick={() => void openDirectory(target)}>{part}</button></React.Fragment>; })}</div>
              <input className="work-file-filter" value={fileFilter} onChange={(event) => setFileFilter(event.target.value)} placeholder="Filter this folder…" aria-label="Filter Work files" />
              {directory.path && <button type="button" disabled={fileBusy} onClick={() => void openDirectory(directory.parentPath)}><Folder size={15} /><span>..</span></button>}
              {visibleDirectoryEntries.map((entry) => <button type="button" className={openFile?.path === entry.path ? "active" : ""} disabled={fileBusy} key={entry.path} onClick={() => void (entry.type === "folder" ? openDirectory(entry.path) : readFile(entry.path))}>{entry.type === "folder" ? <Folder size={15} /> : <File size={15} />}<span title={entry.path}>{entry.name}</span></button>)}
            </div>
            {openFile && <section className="work-file-editor" aria-label={`Editing ${openFile.path}`}>
              <header><div><strong>{openFile.path}</strong><small>{openFile.sizeBytes} bytes{fileDirty ? " · Unsaved" : " · Saved"}</small></div><button type="button" onClick={() => { if (!fileDirty || window.confirm("Discard the unsaved Work file changes?")) { setOpenFile(null); setFileDraft(""); } }} title="Close file"><X size={15} /></button></header>
              <textarea value={fileDraft} onChange={(event) => setFileDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveFile(); } }} spellCheck="false" disabled={fileBusy} aria-label="Work file contents" />
              <footer><span>UTF-8 text · 1 MB maximum</span><div style={{ display: "flex", gap: 6 }}><button type="button" onClick={() => void readFile(openFile.path, true)} disabled={fileBusy}>Reload</button><button type="button" onClick={() => void saveFile()} disabled={!fileDirty || fileBusy}><Save size={14} /> {fileBusy ? "Saving…" : "Save"}</button></div></footer>
            </section>}
          </div>
        )}
        {!error && environment && tab === "terminal" && (
          <div className="work-terminal">
            <div className="work-command-palette">
              {[{ id: "git-status", label: "git status" }, { id: "git-diff", label: "git diff --stat" }, { id: "git-log", label: "git log -20" }, { id: "list-files", label: "list files" }].map((command) => <button type="button" disabled={terminalBusy} key={command.id} onClick={() => runCommand(command.id)}>{command.label}</button>)}
            </div>
            <pre aria-live="polite">{terminalOutput}</pre>
            <small>Read-only command palette · shell disabled</small>
          </div>
        )}
        {!error && environment && tab === "browser" && (
          <div className="work-browser">
            <label><span>Open website</span><input value={browserUrl} onChange={(event) => setBrowserUrl(event.target.value)} placeholder="https://example.com" /></label>
            <button type="button" onClick={() => openTarget("browser")}><Globe2 size={15} /> Open in browser</button>
            <p>HTTP and HTTPS links only. Opening an external app follows the selected approval policy.</p>
          </div>
        )}
      </div>
    </aside>
  );
}

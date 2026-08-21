import React, { useCallback, useEffect, useState } from "react";
import { File, Folder, GitBranch, PanelRightClose, RefreshCw } from "lucide-react";

export default function WorkToolsPanel({ project, onClose }) {
  const [tab, setTab] = useState("environment");
  const [environment, setEnvironment] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/work/environment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceFolders: project?.sourceFolders || [] }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not inspect the Work environment.");
      setEnvironment(data.environment);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => { void refresh(); }, [refresh]);

  const repository = environment?.repository;
  return (
    <aside className="work-tools-panel" aria-label="Work tools">
      <header>
        <div><strong>{project?.name || "Work tools"}</strong><small>Read-only project view</small></div>
        <button type="button" onClick={refresh} disabled={loading} title="Refresh"><RefreshCw size={16} className={loading ? "progress-spinner" : ""} /></button>
        <button type="button" onClick={onClose} title="Close side panel"><PanelRightClose size={17} /></button>
      </header>
      <nav aria-label="Work tool sections">
        {["environment", "review", "files"].map((item) => (
          <button type="button" className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>{item}</button>
        ))}
      </nav>
      <div className="work-tools-content">
        {error && <div className="work-tools-error">{error}</div>}
        {!error && !project && <div className="work-tools-empty">Select a Work project to inspect its environment.</div>}
        {!error && project && !project.sourceFolders?.length && <div className="work-tools-empty">Add a source folder in Edit project to enable Files and Review.</div>}
        {!error && environment && tab === "environment" && (
          <div className="work-tools-sections">
            <section><h3>Environment</h3><dl><dt>Platform</dt><dd>{navigator.platform || "Local"}</dd><dt>Project</dt><dd>{project?.name}</dd><dt>Source folders</dt><dd>{environment.sourceFolders.length}</dd></dl></section>
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
          <div className="work-file-list">
            <h3>Files <span>{environment.files.length}</span></h3>
            {environment.files.map((entry) => <div key={entry.name}>{entry.type === "folder" ? <Folder size={15} /> : <File size={15} />}<span title={entry.name}>{entry.name}</span></div>)}
          </div>
        )}
      </div>
    </aside>
  );
}

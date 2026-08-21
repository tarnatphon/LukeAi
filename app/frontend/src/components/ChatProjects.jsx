import React, { useMemo, useState } from "react";
import { Folder, FolderPlus, MoreHorizontal, Pencil, Pin, Plus, Trash2, X } from "lucide-react";

const createProjectId = () => `project-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export default function ChatProjects({
  projects = [],
  setProjects,
  conversations = [],
  activeProjectId,
  setActiveProjectId,
  setActiveConversationId,
  setActiveTab,
}) {
  const [editingProject, setEditingProject] = useState(null);
  const [draftName, setDraftName] = useState("");
  const [draftFolders, setDraftFolders] = useState([]);
  const [pickerBusy, setPickerBusy] = useState(false);

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0)),
    [projects],
  );

  const openEditor = (project = null) => {
    setEditingProject(project || { id: "", name: "", sourceFolders: [], pinned: false });
    setDraftName(project?.name || "");
    setDraftFolders(project?.sourceFolders || []);
  };

  const closeEditor = () => {
    setEditingProject(null);
    setDraftName("");
    setDraftFolders([]);
  };

  const chooseFolder = async () => {
    setPickerBusy(true);
    try {
      const response = await fetch("/api/storage/choose-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Choose a source folder for this LUKE AI project" }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.cancelled) return;
        throw new Error(data.error || "Could not choose folder.");
      }
      const selectedPath = String(data.selectedPath || "").trim();
      if (selectedPath && !draftFolders.includes(selectedPath)) {
        setDraftFolders((current) => [...current, selectedPath]);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setPickerBusy(false);
    }
  };

  const saveProject = () => {
    const name = draftName.trim();
    if (!name) return;
    const now = Date.now();
    let savedId = editingProject.id;
    setProjects((current) => {
      if (editingProject.id) {
        return current.map((project) => project.id === editingProject.id
          ? { ...project, name, sourceFolders: draftFolders, updatedAt: now }
          : project);
      }
      savedId = createProjectId();
      return [{ id: savedId, name, sourceFolders: draftFolders, pinned: false, createdAt: now, updatedAt: now }, ...current];
    });
    setActiveProjectId(savedId);
    setActiveTab("chat");
    closeEditor();
  };

  const removeProject = () => {
    if (!editingProject?.id) return;
    const confirmed = window.confirm("Remove this project from LUKE AI? Source folders and files will not be deleted.");
    if (!confirmed) return;
    setProjects((current) => current.filter((project) => project.id !== editingProject.id));
    if (activeProjectId === editingProject.id) setActiveProjectId(null);
    closeEditor();
  };

  const togglePinned = (project) => {
    const nextPinned = !project.pinned;
    setProjects((current) => current.map((candidate) => candidate.id === project.id
      ? { ...candidate, pinned: nextPinned, updatedAt: Date.now() }
      : candidate));
    setEditingProject((current) => current?.id === project.id ? { ...current, pinned: nextPinned } : current);
  };

  return (
    <section className="chat-projects" aria-label="Chat projects">
      <div className="chat-projects-heading">
        <span>Projects</span>
        <button type="button" onClick={() => openEditor()} aria-label="Create project" title="Create project">
          <Plus size={15} />
        </button>
      </div>

      <div className="chat-project-list">
        {sortedProjects.length === 0 && <span className="chat-project-empty">No projects yet</span>}
        {sortedProjects.map((project) => {
          const projectChats = conversations.filter((conversation) => conversation.projectId === project.id);
          const active = activeProjectId === project.id;
          return (
            <div className={`chat-project ${active ? "active" : ""}`} key={project.id}>
              <div className="chat-project-row">
                <button
                  type="button"
                  className="chat-project-select"
                  aria-current={active ? "true" : undefined}
                  onClick={() => {
                    setActiveProjectId(project.id);
                    setActiveTab("chat");
                    setActiveConversationId(projectChats[0]?.id || null);
                  }}
                >
                  <Folder size={16} />
                  <span>{project.name}</span>
                  {project.pinned && <Pin size={12} />}
                </button>
                <button type="button" className="chat-project-more" onClick={() => openEditor(project)} aria-label={`Edit ${project.name}`}>
                  <MoreHorizontal size={16} />
                </button>
              </div>
              {active && (
                <div className="chat-project-chats">
                  {projectChats.length === 0 && <span>No chats</span>}
                  {projectChats.slice(0, 8).map((conversation) => (
                    <button type="button" key={conversation.id} onClick={() => setActiveConversationId(conversation.id)}>
                      {conversation.title || "Chat Session"}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {editingProject && (
        <div className="chat-project-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeEditor()}>
          <div className="chat-project-modal" role="dialog" aria-modal="true" aria-labelledby="chat-project-dialog-title">
            <div className="chat-project-modal-heading">
              <h2 id="chat-project-dialog-title">{editingProject.id ? "Edit project" : "New project"}</h2>
              <button type="button" onClick={closeEditor} aria-label="Close project editor"><X size={18} /></button>
            </div>
            <label className="chat-project-name">
              <span>Project name</span>
              <div><Folder size={17} /><input autoFocus value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="My project" /></div>
            </label>
            <div className="chat-project-folders">
              <strong>Source folders</strong>
              {draftFolders.map((folderPath) => (
                <div className="chat-project-folder" key={folderPath}>
                  <Folder size={17} />
                  <span title={folderPath}>{folderPath}</span>
                  <button type="button" onClick={() => setDraftFolders((current) => current.filter((path) => path !== folderPath))} aria-label={`Remove ${folderPath}`}><X size={16} /></button>
                </div>
              ))}
              <button type="button" className="chat-project-add-folder" onClick={chooseFolder} disabled={pickerBusy}>
                <FolderPlus size={17} /> {pickerBusy ? "Choosing folder…" : "Add folder"}
              </button>
            </div>
            <div className="chat-project-modal-actions">
              <div>
                {editingProject.id && <button type="button" className="danger" onClick={removeProject}><Trash2 size={15} /> Remove local project</button>}
                {editingProject.id && <button type="button" onClick={() => togglePinned(editingProject)}><Pin size={15} /> {editingProject.pinned ? "Unpin" : "Pin"}</button>}
              </div>
              <div>
                <button type="button" onClick={closeEditor}>Cancel</button>
                <button type="button" className="primary" onClick={saveProject} disabled={!draftName.trim()}><Pencil size={15} /> Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

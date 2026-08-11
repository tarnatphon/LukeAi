// LUKE_AI_I2V_PROMPT_IMPORT_V1
import {
  importPromptFile,
} from "../utils/imageToVideoPromptImport";

// LUKE_AI_I2V_ASYNC_JOB_IMPORT_V1
import {
  createImageToVideoJob,
  getImageToVideoJob,
  listImageToVideoJobs,
  cancelImageToVideoJob,
  retryImageToVideoJob,
  // LUKE_AI_I2V_RECOVERY_IMPORT_V1
  getImageToVideoRecoveryStatus,
} from "../services/api";

import { getImageToVideoRuntimeCapability } from "../services/api";
import ImageToVideoRuntimeHealthCard from "./ImageToVideoRuntimeHealthCard.jsx";
import React, { useEffect, useMemo, useState } from "react";
import { Film, Upload, Play, CheckCircle2, AlertTriangle, Cpu, HardDrive, Plus, Trash2, Sparkles, ShieldCheck, Download, Wrench } from "lucide-react";
import { getImageToVideoCompatibility, generateImageToVideo, getImageToVideoCapabilityStatus, installImageToVideoCapability } from "../services/api";

function readImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) return reject(new Error("Please select a valid image."));
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, dataUrl: reader.result });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

export default function ImageToVideo({

 specs, showAlert }) {

  // LUKE_AI_I2V_RUNTIME_HEALTH_STATE_V1
    const [
      runtimeCapability,
      setRuntimeCapability,
    ] = useState(null);

    const [
      runtimeCapabilityLoading,
      setRuntimeCapabilityLoading,
    ] = useState(true);

    const [
      runtimeCapabilityError,
      setRuntimeCapabilityError,
    ] = useState("");

    const refreshRuntimeCapability =
      useCallback(
        async () => {
          setRuntimeCapabilityLoading(
            true,
          );

          try {
            const runtime =
              await getImageToVideoRuntimeCapability();

            setRuntimeCapability(
              runtime,
            );

            setRuntimeCapabilityError(
              "",
            );

            return runtime;
          } catch (error) {
            setRuntimeCapability(
              null,
            );

            setRuntimeCapabilityError(
              error instanceof Error
                ? error.message
                : String(error),
            );

            return null;
          } finally {
            setRuntimeCapabilityLoading(
              false,
            );
          }
        },
        [],
      );

    useEffect(() => {
      refreshRuntimeCapability();
    }, [refreshRuntimeCapability]);

  const [catalog, setCatalog] = useState([]);
  const [source, setSource] = useState(null);
  const [references, setReferences] = useState([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [capability, setCapability] = useState({ state: "checking", installed: false });
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    getImageToVideoCompatibility()
      .then((data) => setCatalog(data.models || []))
      .catch((e) => showAlert?.({ title: "Compatibility Check Failed", message: e.message, danger: true }));
  }, [showAlert]);

  const refreshCapability = async () => {
    try {
      const data = await getImageToVideoCapabilityStatus();
      setCapability(data);
      setInstalling(data.state === "installing");
      return data;
    } catch (error) {
      setCapability({ state: "error", installed: false, message: error.message });
      return null;
    }
  };

  useEffect(() => {
    let timer;
    refreshCapability().then((data) => {
      if (data?.state === "installing") timer = setInterval(refreshCapability, 1500);
    });
    return () => timer && clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!installing) return undefined;
    const timer = setInterval(async () => {
      const data = await refreshCapability();
      if (data && data.state !== "installing") {
        clearInterval(timer);
        if (data.state === "ready") showAlert?.({ title: "Image-to-Video Ready", message: "Runtime installed successfully." });
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [installing, showAlert]);

  const installCapability = async (repair = false) => {
    setInstalling(true);
    setCapability((prev) => ({ ...prev, state: "installing", message: repair ? "Repairing Image-to-Video…" : "Installing Image-to-Video…" }));
    try {
      await installImageToVideoCapability(repair);
    } catch (error) {
      setInstalling(false);
      setCapability({ state: "error", installed: false, message: error.message });
      showAlert?.({ title: "Installation Failed", message: error.message, danger: true });
    }
  };

  const automaticModel = useMemo(
    () => catalog.find((m) => m.workerReady && m.compatibility.status === "recommended")
      || catalog.find((m) => m.workerReady && m.compatibility.status === "limited")
      || catalog.find((m) => m.workerReady)
      || null,
    [catalog]
  );

  const addReferences = async (files) => {
    try {
      const available = Math.max(0, 8 - references.length);
      const accepted = Array.from(files || []).filter((file) => file.type.startsWith("image/")).slice(0, available);
      const items = await Promise.all(accepted.map(readImage));
      setReferences((prev) => [...prev, ...items].slice(0, 8));
    } catch (error) {
      showAlert?.({ title: "Reference Image", message: error.message, danger: true });
    }
  };

  const chooseSource = async (file) => {
    try { setSource(await readImage(file)); }
    catch (error) { showAlert?.({ title: "Source Image", message: error.message, danger: true }); }
  };

  // LUKE_AI_I2V_ASYNC_JOB_STATE_V1
  const [
    activeJob,
    setActiveJob,
  ] = useState(null);

  const [
    jobHistory,
    setJobHistory,
  ] = useState([]);

  const [
    generatedVideoUrl,
    setGeneratedVideoUrl,
  ] = useState("");

  const refreshJobHistory =
    useCallback(
      async () => {
        try {
          const result =
            await listImageToVideoJobs(
              12,
            );

          setJobHistory(
            Array.isArray(
              result?.jobs,
            )
              ? result.jobs
              : [],
          );
        } catch {
        }
      },
      [],
    );

  // LUKE_AI_I2V_UI_RESTART_RECOVERY_V1
  useEffect(() => {
    let cancelled = false;

    const restoreImageToVideoState =
      async () => {
        try {
          const [
            historyResult,
            recoveryResult,
          ] =
            await Promise.all([
              listImageToVideoJobs(
                12,
              ),
              getImageToVideoRecoveryStatus(),
            ]);

          if (cancelled) {
            return;
          }

          const jobs =
            Array.isArray(
              historyResult?.jobs,
            )
              ? historyResult.jobs
              : [];

          setJobHistory(
            jobs,
          );

          const active =
            Array.isArray(
              recoveryResult
                ?.activeJobs,
            )
              ? recoveryResult
                  .activeJobs[0]
              : null;

          if (active?.id) {
            setActiveJob(
              active,
            );

            setStatus(
              "Restoring active Image-to-Video job…",
            );

            pollImageToVideoJob(
              active.id,
            ).catch(
              (error) => {
                if (!cancelled) {
                  setStatus(
                    error.message,
                  );
                }
              },
            );

            return;
          }

          const recovered =
            Array.isArray(
              recoveryResult
                ?.recoveredJobs,
            )
              ? recoveryResult
                  .recoveredJobs[0]
              : null;

          if (recovered) {
            setActiveJob(
              recovered,
            );

            setStatus(
              "A previous Image-to-Video job was interrupted when the application closed. Retry the job to generate it again.",
            );

            return;
          }

          const latest =
            jobs[0] || null;

          if (
            latest?.state ===
              "completed"
          ) {
            const output =
              normalizeVideoUrl(
                latest?.output
                  ?.videoUrl ||
                latest?.output
                  ?.output ||
                latest?.output
                  ?.worker
                  ?.output,
              );

            if (output) {
              setGeneratedVideoUrl(
                output,
              );
            }
          }

        } catch {
          await refreshJobHistory();
        }
      };

    restoreImageToVideoState();

    return () => {
      cancelled = true;
    };
  }, []);



  const normalizeVideoUrl =
    (value) => {
      const url =
        String(
          value || "",
        );

      if (
        url.startsWith(
          "app/outputs/",
        )
      ) {
        return (
          "/" +
          url.slice(
            "app/".length,
          )
        );
      }

      return url;
    };

  const pollImageToVideoJob =
    async (jobId) => {
      for (;;) {
        const job =
          await getImageToVideoJob(
            jobId,
          );

        setActiveJob(
          job,
        );

        const percent =
          Math.round(
            Number(
              job?.progress
                ?.percent || 0,
            ),
          );

        if (
          job.state ===
          "queued"
        ) {
          setStatus(
            "Image-to-Video job queued…",
          );
        } else if (
          job.state ===
          "running" ||
          job.state ===
          "cancelling"
        ) {
          setStatus(
            job?.progress
              ?.message ||
              `Creating video… ${percent}%`,
          );
        }

        if (
          job.state ===
          "completed"
        ) {
          const output =
            normalizeVideoUrl(
              job?.output
                ?.videoUrl ||
              job?.output
                ?.output ||
              job?.output
                ?.worker
                ?.output,
            );

          setGeneratedVideoUrl(
            output,
          );

          setStatus(
            "Automatic Image-to-Video completed.",
          );

          await refreshJobHistory();

          return job;
        }

        if (
          job.state ===
          "cancelled"
        ) {
          setStatus(
            "Image-to-Video generation cancelled.",
          );

          await refreshJobHistory();

          return job;
        }

        if (
          job.state ===
          "failed"
        ) {
          await refreshJobHistory();

          throw new Error(
            job?.error
              ?.message ||
              "Image-to-Video generation failed.",
          );
        }

        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              1000,
            ),
        );
      }
    };

  const cancelActiveJob =
    async () => {
      if (!activeJob?.id) {
        return;
      }

      try {
        const job =
          await cancelImageToVideoJob(
            activeJob.id,
          );

        setActiveJob(
          job,
        );

        setStatus(
          "Cancelling Image-to-Video generation…",
        );
      } catch (error) {
        showAlert?.({
          title:
            "Cancel Image-to-Video",
          message:
            error.message,
          danger: true,
        });
      }
    };

  const retryJob =
    async (jobId) => {
      setBusy(true);
      setGeneratedVideoUrl("");

      try {
        const job =
          await retryImageToVideoJob(
            jobId,
          );

        setActiveJob(
          job,
        );

        setStatus(
          "Retry queued…",
        );

        await pollImageToVideoJob(
          job.id,
        );
      } catch (error) {
        setStatus(
          error.message,
        );

        showAlert?.({
          title:
            "Retry Image-to-Video",
          message:
            error.message,
          danger: true,
        });
      } finally {
        setBusy(false);
      }
    };

  // LUKE_AI_I2V_ASYNC_JOB_RUN_V1
  // LUKE_AI_I2V_PROMPT_STUDIO_STATE_V1
  const [
    promptText,
    setPromptText,
  ] = useState("");

  const [
    durationSeconds,
    setDurationSeconds,
  ] = useState(5);

  const [
    importedPromptRows,
    setImportedPromptRows,
  ] = useState([]);

  const [
    promptImportStatus,
    setPromptImportStatus,
  ] = useState("");

  // LUKE_AI_I2V_DURATION_STRATEGY_UI_V1
  const durationUsesStitch =
    durationSeconds > 5;

  const handlePromptFile =
    async (file) => {
      if (!file) {
        return;
      }

      try {
        const imported =
          await importPromptFile(
            file,
          );

        setImportedPromptRows(
          imported.rows || [],
        );

        if (
          imported.prompt
        ) {
          setPromptText(
            imported.prompt,
          );
        }

        const importedDuration =
          imported.rows
            ?.find(
              (item) =>
                item.duration,
            )
            ?.duration;

        if (
          [5, 10, 15]
            .includes(
              importedDuration,
            )
        ) {
          setDurationSeconds(
            importedDuration,
          );
        }

        setPromptImportStatus(
          `${file.name}: ${imported.rows?.length || 0} prompt row(s) imported`,
        );

      } catch (error) {
        setPromptImportStatus(
          error.message,
        );

        showAlert?.({
          title:
            "Prompt Import",
          message:
            error.message,
          danger: true,
        });
      }
    };

  const run = async () => {
    if (
      !source ||
      !automaticModel ||
      automaticModel
        .compatibility
        .status === "blocked"
    ) {
      return;
    }

    setBusy(true);
    setGeneratedVideoUrl("");

    setStatus(
      "Automatic Match is analysing the computer and locking the reference appearance…",
    );

    try {
      // LUKE_AI_I2V_GENERATE_RUNTIME_GATE_V1
      if (
        runtimeCapability?.ready !== true
      ) {
        const currentRuntime =
          await refreshRuntimeCapability();

        if (
          currentRuntime?.ready !== true
        ) {
          throw new Error(
            "Image-to-Video runtime is not ready. Check Torch, MPS/CUDA, required packages and FFmpeg before generating.",
          );
        }
      }

      const job =
        await createImageToVideoJob({
          modelId: "auto",
          imageDataUrl:
            source.dataUrl,
          references:
            references.map(
              (item) => ({
                ...item,
                type: "auto",
                weight: 1,
              }),
            ),
          referenceLock: true,
          automaticMatch: true,
          prompt: promptText,
          seconds: durationSeconds,
        });

      setActiveJob(
        job,
      );

      setStatus(
        job?.state === "running"
          ? "Image-to-Video generation started…"
          : "Image-to-Video job queued…",
      );

      await pollImageToVideoJob(
        job.id,
      );
    } catch (error) {
      setStatus(
        error.message,
      );

      showAlert?.({
        title:
          "Automatic Image-to-Video",
        message:
          error.message,
        danger: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const runtimeReady = capability.installed === true || capability.state === "ready";
  const blocked = !runtimeReady || !automaticModel || automaticModel.compatibility.status === "blocked";

  return <div style={{ padding: 24, overflow: "auto", height: "100%" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>

      {/* LUKE_AI_I2V_RUNTIME_HEALTH_MOUNT_V1 */}
      <ImageToVideoRuntimeHealthCard
        runtime={runtimeCapability}
        loading={runtimeCapabilityLoading}
        error={runtimeCapabilityError}
        onRefresh={refreshRuntimeCapability}
      />

      <Film size={28}/><div><h2 style={{ margin: 0 }}>Automatic Image to Video</h2><div style={{ opacity: .72 }}>Upload images only. LUKE AI selects and applies every setting automatically.</div></div>
    </div>

    <div className="settings-card" style={{ padding: 18, marginBottom: 18, border: "1px solid var(--border-color)" }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, fontWeight:700 }}><Sparkles size={20}/> Automatic Reference Match</div>
      <p style={{ marginBottom:0, opacity:.78 }}>The system automatically locks identity, hairstyle, clothing, object shape, colors, materials, artwork, logos and background appearance. No model, strength, prompt or motion adjustment is required.</p>
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 1.25fr) minmax(300px, .8fr)", gap: 18 }}>
      <section className="settings-card" style={{ padding: 18 }}>
        <h3>1. Upload the image to animate</h3>
        <label style={{ minHeight: 280, border: "2px dashed var(--border-color)", borderRadius: 14, display: "grid", placeItems: "center", cursor: "pointer", overflow: "hidden" }}>
          {source ? <img src={source.dataUrl} alt="source" style={{ width: "100%", height: 310, objectFit: "contain" }}/> : <div style={{ textAlign: "center" }}><Upload size={34}/><div style={{marginTop:8}}>Choose the main image</div></div>}
          <input type="file" accept="image/*" hidden onChange={(e)=>chooseSource(e.target.files?.[0])}/>
        </label>

        <h3 style={{ marginTop: 20 }}>2. Add Reference images <span style={{ opacity:.6, fontWeight:400 }}>({references.length}/8)</span></h3>
        <p style={{ opacity:.72, marginTop:-6 }}>Upload the clearest photos available. Front, side and detail views are accepted; the system decides how each image should be used.</p>
        <label style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:12, border:"1px dashed var(--border-color)", borderRadius:12, cursor:"pointer" }}><Plus size={18}/> Add Reference images<input type="file" accept="image/*" multiple hidden onChange={(e)=>addReferences(e.target.files)}/></label>

        {/* LUKE_AI_I2V_PROMPT_STUDIO_UI_V1 */}
        <div
          style={{
            marginTop: 16,
            padding: 14,
            border:
              "1px solid var(--border-color)",
            borderRadius: 12,
          }}
        >
          <h3
            style={{
              marginTop: 0,
            }}
          >
            Prompt Studio
          </h3>

          <textarea
            value={
              promptText
            }
            onChange={(event) =>
              setPromptText(
                event.target.value,
              )
            }
            placeholder="Describe the motion, camera movement, lighting and scene..."
            rows={6}
            style={{
              width: "100%",
              resize:
                "vertical",
            }}
          />

          <label
            style={{
              display:
                "flex",
              alignItems:
                "center",
              justifyContent:
                "center",
              padding: 10,
              marginTop: 10,
              border:
                "1px dashed var(--border-color)",
              borderRadius: 10,
              cursor:
                "pointer",
            }}
          >
            Import Prompt / Batch

            <input
              type="file"
              accept=".txt,.md,.csv,.xlsx,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              hidden
              onChange={(event) => {
                const file =
                  event.target
                    .files?.[0];

                handlePromptFile(
                  file,
                );

                event.target.value =
                  "";
              }}
            />
          </label>

          {promptImportStatus && (
            <div
              style={{
                marginTop: 8,
                fontSize: 13,
                opacity: 0.75,
              }}
            >
              {promptImportStatus}
            </div>
          )}

          {importedPromptRows
            .length > 1 && (
            <div
              style={{
                marginTop: 10,
                fontSize: 13,
              }}
            >
              Batch preview:
              {" "}
              {importedPromptRows.length}
              {" "}
              rows loaded.
              Phase 3A batch execution
              will consume these rows
              after the duration strategy
              is certified.
            </div>
          )}

          <div
            style={{
              marginTop: 16,
            }}
          >
            <strong>
              Video Duration
            </strong>

            <div
              style={{
                display:
                  "grid",
                gridTemplateColumns:
                  "repeat(3, 1fr)",
                gap: 8,
                marginTop: 8,
              }}
            >
              {[5, 10, 15]
                .map(
                  (seconds) => (
                    <button
                      key={
                        seconds
                      }
                      type="button"
                      onClick={() =>
                        setDurationSeconds(
                          seconds,
                        )
                      }
                      style={{
                        padding: 10,
                        fontWeight:
                          durationSeconds ===
                          seconds
                            ? 700
                            : 400,
                      }}
                    >
                      {seconds} sec
                    </button>
                  ),
                )}
            </div>

            {durationUsesStitch && (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 13,
                }}
              >
                {durationSeconds} sec
                uses LUKE AI STUDIO Segment/Stitch mode with last-frame continuity and final duration verification.
              </div>
            )}
          </div>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))", gap:10, marginTop:12 }}>
          {references.map((item,index)=><div key={`${item.name}-${index}`} style={{ border:"1px solid var(--border-color)", borderRadius:12, padding:8 }}>
            <img src={item.dataUrl} alt={`reference ${index + 1}`} style={{ width:"100%", height:120, objectFit:"contain", borderRadius:8 }}/>
            <div style={{fontSize:12, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", margin:"7px 0"}}>{item.name}</div>
            <button type="button" onClick={()=>setReferences((prev)=>prev.filter((_,i)=>i!==index))} style={{ width:"100%", display:"flex", justifyContent:"center", gap:6 }}><Trash2 size={15}/> Remove</button>
          </div>)}
        </div>
      </section>

      <section className="settings-card" style={{ padding: 18 }}>
        <h3>Automatic computer check</h3>
        <div style={{ display:"flex", gap:10, marginBottom:12 }}><Cpu size={18}/>{specs?.gpu_name || "GPU detecting…"}</div>
        <div style={{ display:"flex", gap:10, marginBottom:16 }}><HardDrive size={18}/>{specs?.ram_total_gb || 0} GB RAM</div>
        {automaticModel ? <div style={{ padding:14, borderRadius:12, background:"var(--md-sys-color-surface-container)" }}>
          <div style={{ display:"flex", gap:8, alignItems:"center", fontWeight:700 }}>{blocked ? <AlertTriangle size={18}/> : <CheckCircle2 size={18}/>} {automaticModel.compatibility.label}</div>
          <p>{automaticModel.compatibility.reason}</p>
          <div><strong>Selected automatically:</strong> {automaticModel.name}</div>
          <div style={{marginTop:8, display:"flex", gap:7, alignItems:"center"}}><ShieldCheck size={17}/> Maximum Reference Lock enabled</div>
          <p style={{marginBottom:0, opacity:.72}}>Duration, frame count, memory offload and conservative camera motion are selected automatically for this computer.</p>
        </div> : <p>Checking compatible local video models…</p>}
        {!runtimeReady && <div style={{ marginTop:16, padding:14, border:"1px solid var(--border-color)", borderRadius:12 }}>
          <div style={{display:"flex", alignItems:"center", gap:8, fontWeight:700}}><Download size={18}/> Image-to-Video is not installed</div>
          <p style={{opacity:.76}}>{capability.message || "Install the isolated runtime and required AI components. Video models are installed explicitly and generation never downloads model weights silently."}</p>
          <button type="button" onClick={()=>installCapability(capability.state === "error")} disabled={installing} style={{width:"100%", padding:12, display:"flex", justifyContent:"center", gap:8}}>
            {capability.state === "error" ? <Wrench size={18}/> : <Download size={18}/>}
            {installing ? (capability.message || "Installing…") : capability.state === "error" ? "Repair Image-to-Video" : "Install Image-to-Video"}
          </button>
          {installing && <p style={{fontSize:12, opacity:.7}}>Keep LUKE AI open. Installation progress is checked automatically.</p>}
        </div>}
        {runtimeReady && <div style={{marginTop:16, display:"flex", gap:8, alignItems:"center"}}><CheckCircle2 size={18}/> Image-to-Video runtime ready</div>}
        <button onClick={run} disabled={busy || !source || blocked} style={{ width:"100%", marginTop:18, padding:13, display:"flex", justifyContent:"center", gap:8 }}><Play size={18}/>{busy ? "Creating automatically…" : "Create Video Automatically"}</button>
        {!source && <p style={{opacity:.66}}>Upload the main image to enable automatic generation.</p>}
        {status && <p style={{ marginTop:12 }}>{status}</p>}

        {/* LUKE_AI_I2V_ASYNC_JOB_UI_V1 */}
        {activeJob && (
          <div
            style={{
              marginTop: 14,
              padding: 14,
              border:
                "1px solid var(--border-color)",
              borderRadius: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent:
                  "space-between",
                gap: 10,
                alignItems:
                  "center",
              }}
            >
              <strong>
                Generation Job
              </strong>

              <span>
                {activeJob.state}
              </span>
            </div>

            <div
              style={{
                height: 8,
                marginTop: 10,
                borderRadius: 999,
                overflow:
                  "hidden",
                background:
                  "var(--md-sys-color-surface-container)",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width:
                    `${Math.max(
                      0,
                      Math.min(
                        100,
                        Number(
                          activeJob
                            ?.progress
                            ?.percent ||
                            0,
                        ),
                      ),
                    )}%`,
                  background:
                    "var(--md-sys-color-primary)",
                  transition:
                    "width .25s ease",
                }}
              />
            </div>

            <div
              style={{
                marginTop: 7,
                fontSize: 13,
                opacity: 0.76,
              }}
            >
              {Math.round(
                Number(
                  activeJob
                    ?.progress
                    ?.percent ||
                    0,
                ),
              )}
              %
              {" · "}
              {activeJob
                ?.progress
                ?.message ||
                activeJob.state}
            </div>

            {[
              "queued",
              "running",
            ].includes(
              activeJob.state,
            ) && (
              <button
                type="button"
                onClick={
                  cancelActiveJob
                }
                style={{
                  width: "100%",
                  marginTop: 10,
                  padding: 10,
                }}
              >
                Cancel Generation
              </button>
            )}
          </div>
        )}

        {generatedVideoUrl && (
          <div
            style={{
              marginTop: 16,
            }}
          >
            <h3>
              Generated Video
            </h3>

            <video
              src={
                generatedVideoUrl
              }
              controls
              playsInline
              style={{
                width: "100%",
                borderRadius: 12,
                background: "#000",
              }}
            />
          </div>
        )}

        {jobHistory.length > 0 && (
          <div
            style={{
              marginTop: 18,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent:
                  "space-between",
                alignItems:
                  "center",
                gap: 8,
              }}
            >
              <h3
                style={{
                  margin: 0,
                }}
              >
                Generation History
              </h3>

              <button
                type="button"
                onClick={
                  refreshJobHistory
                }
              >
                Refresh
              </button>
            </div>

            <div
              style={{
                display: "grid",
                gap: 8,
                marginTop: 10,
              }}
            >
              {jobHistory
                .slice(0, 6)
                .map(
                  (job) => (
                    <div
                      key={job.id}
                      style={{
                        padding: 10,
                        border:
                          "1px solid var(--border-color)",
                        borderRadius: 10,
                      }}
                    >
                      <div
                        style={{
                          display:
                            "flex",
                          justifyContent:
                            "space-between",
                          gap: 8,
                        }}
                      >
                        <strong>
                          {job.state}
                        </strong>

                        <span
                          style={{
                            fontSize: 12,
                            opacity: 0.7,
                          }}
                        >
                          {Math.round(
                            Number(
                              job
                                ?.progress
                                ?.percent ||
                                0,
                            ),
                          )}
                          %
                        </span>
                      </div>

                      {job.state ===
                        "completed" &&
                        (
                          job?.output
                            ?.videoUrl ||
                          job?.output
                            ?.output
                        ) && (
                          <button
                            type="button"
                            onClick={() =>
                              setGeneratedVideoUrl(
                                normalizeVideoUrl(
                                  job
                                    ?.output
                                    ?.videoUrl ||
                                  job
                                    ?.output
                                    ?.output,
                                ),
                              )
                            }
                            style={{
                              marginTop: 8,
                            }}
                          >
                            View Video
                          </button>
                        )}

                      {[
                        "completed",
                        "failed",
                        "cancelled",
                      ].includes(
                        job.state,
                      ) && (
                        <button
                          type="button"
                          onClick={() =>
                            retryJob(
                              job.id,
                            )
                          }
                          disabled={busy}
                          style={{
                            marginTop: 8,
                            marginLeft: 8,
                          }}
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  ),
                )}
            </div>
          </div>
        )}

      </section>
    </div>
  </div>;
}

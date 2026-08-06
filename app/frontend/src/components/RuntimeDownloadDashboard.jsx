import {
  AlertTriangle,
  CheckCircle2,
  CircleX,
  Download,
  HardDrive,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  Square,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const ACTIVE_STATES = new Set([
  "queued",
  "preparing",
  "downloading",
  "verifying",
  "installing",
  "rolling-back",
]);

const TERMINAL_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "rolled-back",
]);

const STATE_LABELS = {
  queued: "รอเริ่มติดตั้ง",
  preparing: "กำลังเตรียมระบบ",
  downloading: "กำลังดาวน์โหลด",
  verifying: "กำลังตรวจสอบ SHA256",
  installing: "กำลังติดตั้ง",
  "rolling-back": "กำลังกู้คืนระบบเดิม",
  completed: "ติดตั้งสำเร็จ",
  failed: "ติดตั้งไม่สำเร็จ",
  cancelled: "ยกเลิกแล้ว",
  "rolled-back": "กู้คืนระบบเดิมแล้ว",
  ready: "พร้อมใช้งาน",
  missing: "ยังไม่ได้ติดตั้ง",
};

function formatBytes(value) {
  const bytes = Number(value);

  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );

  const amount = bytes / (1024 ** index);

  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function getJobForDependency(jobs, dependencyId) {
  return jobs.find(
    (job) =>
      job.dependencyId === dependencyId &&
      (
        ACTIVE_STATES.has(job.state) ||
        TERMINAL_STATES.has(job.state)
      ),
  );
}

function getStatusClass(state) {
  if (state === "completed" || state === "ready") {
    return "runtime-status-ready";
  }

  if (
    state === "failed" ||
    state === "rolled-back"
  ) {
    return "runtime-status-error";
  }

  if (state === "cancelled") {
    return "runtime-status-muted";
  }

  if (ACTIVE_STATES.has(state)) {
    return "runtime-status-active";
  }

  return "runtime-status-missing";
}

function RuntimeProgress({ job }) {
  if (!job) {
    return null;
  }

  const percent = Math.max(
    0,
    Math.min(100, Number(job.progress?.percent) || 0),
  );

  return (
    <div className="runtime-progress-section">
      <div className="runtime-progress-header">
        <span>{STATE_LABELS[job.state] || job.state}</span>
        <strong>{percent}%</strong>
      </div>

      <div
        className="progress-bar-container runtime-progress-track"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent}
      >
        <div
          className="progress-bar-fill runtime-progress-fill"
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="runtime-progress-meta">
        <span>
          {formatBytes(job.progress?.downloadedBytes)}
          {job.progress?.totalBytes
            ? ` / ${formatBytes(job.progress.totalBytes)}`
            : ""}
        </span>

        <span>
          {formatBytes(job.progress?.speedBytesPerSecond)}/s
        </span>
      </div>
    </div>
  );
}

function RuntimeDependencyCard({
  dependency,
  job,
  busyDependencyId,
  onInstall,
  onCancel,
}) {
  const active = Boolean(job && ACTIVE_STATES.has(job.state));
  const completed = job?.state === "completed";
  const state = active || job
    ? job.state
    : dependency.installed
      ? "ready"
      : "missing";

  const isBusy = busyDependencyId === dependency.id;

  return (
    <article className="m3-card runtime-dependency-card">
      <div className="runtime-card-header">
        <div className="runtime-card-icon">
          {dependency.installed || completed
            ? <CheckCircle2 size={22} />
            : active
              ? <LoaderCircle className="progress-spinner" size={22} />
              : <Download size={22} />}
        </div>

        <div className="runtime-card-title-group">
          <h3 className="m3-card-title">
            {dependency.name?.th || dependency.name?.en || dependency.id}
          </h3>

          <div className="runtime-card-subtitle">
            {dependency.name?.en || dependency.id}
          </div>
        </div>

        <span className={`status-chip ${getStatusClass(state)}`}>
          {STATE_LABELS[state] || state}
        </span>
      </div>

      <div className="runtime-card-details">
        <span>
          {dependency.required ? "จำเป็นต่อระบบ" : "ติดตั้งเพิ่มเติมได้"}
        </span>

        <span>
          {dependency.category === "core-runtime"
            ? "Core Runtime"
            : "AI Runtime"}
        </span>
      </div>

      <RuntimeProgress job={job} />

      {job?.checksum?.expected && (
        <div className="runtime-checksum">
          <ShieldCheck size={15} />
          <span>
            SHA256:
            {" "}
            {job.checksum.verified
              ? "ตรวจสอบผ่าน"
              : job.state === "verifying"
                ? "กำลังตรวจสอบ"
                : "รอตรวจสอบ"}
          </span>
        </div>
      )}

      {job?.error?.message && (
        <div className="runtime-error-message">
          <CircleX size={16} />
          <span>{job.error.message}</span>
        </div>
      )}

      <div className="runtime-card-actions">
        {!dependency.installed && !active && (
          <button
            type="button"
            className="m3-btn m3-btn-filled"
            disabled={isBusy}
            onClick={() => onInstall(dependency)}
          >
            {isBusy
              ? <LoaderCircle className="progress-spinner" size={15} />
              : <Download size={15} />}
            ติดตั้ง
          </button>
        )}

        {active && (
          <button
            type="button"
            className="m3-btn m3-btn-error"
            disabled={isBusy}
            onClick={() => onCancel(job)}
          >
            <Square size={14} />
            ยกเลิก
          </button>
        )}

        {(dependency.installed || completed) && (
          <span className="runtime-installed-label">
            <PackageCheck size={16} />
            พร้อมใช้งาน
          </span>
        )}
      </div>
    </article>
  );
}

export default function RuntimeDownloadDashboard() {
  const [dependencies, setDependencies] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [summary, setSummary] = useState(null);
  const [downloadDirectory, setDownloadDirectory] = useState("");
  const [fallbackDirectory, setFallbackDirectory] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyDependencyId, setBusyDependencyId] = useState("");
  const [error, setError] = useState("");
  const mountedRef = useRef(true);

  const hasActiveJobs = useMemo(
    () => jobs.some((job) => ACTIVE_STATES.has(job.state)),
    [jobs],
  );

  const requestJson = useCallback(async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });

    const text = await response.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error("Backend returned an invalid response.");
    }

    if (!response.ok) {
      throw new Error(
        data?.error ||
        `Request failed with HTTP ${response.status}`,
      );
    }

    return data;
  }, []);

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setRefreshing(true);
    }

    try {
      const [dependencyData, jobData] = await Promise.all([
        requestJson("/api/runtime/dependencies"),
        requestJson("/api/runtime/install/jobs"),
      ]);

      if (!mountedRef.current) {
        return;
      }

      setDependencies(dependencyData.dependencies || []);
      setSummary(dependencyData.summary || null);
      setDownloadDirectory(
        dependencyData.defaultDownloadDirectory || "",
      );
      setFallbackDirectory(
        dependencyData.fallbackDownloadDirectory || "",
      );
      setJobs(jobData.jobs || []);
      setError("");
    } catch (requestError) {
      if (mountedRef.current) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : String(requestError),
        );
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [requestJson]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();

    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    const interval = window.setInterval(
      () => refresh({ silent: true }),
      hasActiveJobs ? 750 : 10000,
    );

    return () => {
      window.clearInterval(interval);
    };
  }, [hasActiveJobs, refresh]);

  const installDependency = useCallback(
    async (dependency) => {
      setBusyDependencyId(dependency.id);
      setError("");

      try {
        const createResult = await requestJson(
          "/api/runtime/install/jobs",
          {
            method: "POST",
            body: JSON.stringify({
              dependencyId: dependency.id,
            }),
          },
        );

        const jobId = createResult.job?.id;

        if (!jobId) {
          throw new Error("Backend did not create an install job.");
        }

        await requestJson(
          `/api/runtime/install/jobs/${encodeURIComponent(jobId)}/start`,
          {
            method: "POST",
            body: JSON.stringify({}),
          },
        );

        await refresh({ silent: true });
      } catch (installError) {
        setError(
          installError instanceof Error
            ? installError.message
            : String(installError),
        );
      } finally {
        setBusyDependencyId("");
      }
    },
    [refresh, requestJson],
  );

  const cancelJob = useCallback(
    async (job) => {
      setBusyDependencyId(job.dependencyId);
      setError("");

      try {
        await requestJson(
          `/api/runtime/install/jobs/${encodeURIComponent(job.id)}/cancel`,
          {
            method: "POST",
            body: JSON.stringify({}),
          },
        );

        await refresh({ silent: true });
      } catch (cancelError) {
        setError(
          cancelError instanceof Error
            ? cancelError.message
            : String(cancelError),
        );
      } finally {
        setBusyDependencyId("");
      }
    },
    [refresh, requestJson],
  );

  return (
    <section className="runtime-dashboard">
      <div className="runtime-dashboard-header">
        <div>
          <div className="runtime-dashboard-eyebrow">
            System Health
          </div>

          <h2>Runtime & Download Manager</h2>

          <p>
            ตรวจสอบ ติดตั้ง และติดตามความคืบหน้าของระบบ AI
            โดยไฟล์ดาวน์โหลดจะถูกตรวจ SHA256 ก่อนติดตั้งทุกครั้ง
          </p>
        </div>

        <button
          type="button"
          className="m3-btn m3-btn-outlined"
          disabled={refreshing}
          onClick={() => refresh()}
        >
          <RefreshCw
            size={15}
            className={refreshing ? "progress-spinner" : ""}
          />
          รีเฟรช
        </button>
      </div>

      <div className="runtime-summary-grid">
        <div className="m3-card runtime-summary-card">
          <span>Runtime ทั้งหมด</span>
          <strong>{summary?.total ?? dependencies.length}</strong>
        </div>

        <div className="m3-card runtime-summary-card runtime-summary-ready">
          <span>พร้อมใช้งาน</span>
          <strong>{summary?.ready ?? 0}</strong>
        </div>

        <div className="m3-card runtime-summary-card runtime-summary-missing">
          <span>ยังไม่ได้ติดตั้ง</span>
          <strong>{summary?.missing ?? 0}</strong>
        </div>

        <div className="m3-card runtime-summary-card runtime-summary-required">
          <span>Runtime จำเป็นที่ขาด</span>
          <strong>{summary?.requiredMissing ?? 0}</strong>
        </div>
      </div>

      <div className="m3-card runtime-storage-panel">
        <div className="runtime-storage-icon">
          <HardDrive size={22} />
        </div>

        <div>
          <strong>ตำแหน่งดาวน์โหลดหลัก</strong>
          <div className="runtime-storage-path">
            {downloadDirectory || "กำลังตรวจสอบ..."}
          </div>

          {fallbackDirectory && (
            <div className="runtime-storage-fallback">
              สำรองเมื่อ External Drive ไม่พร้อม: {fallbackDirectory}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="runtime-dashboard-error">
          <AlertTriangle size={18} />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="m3-card runtime-dashboard-loading">
          <LoaderCircle className="progress-spinner" size={24} />
          กำลังตรวจสอบ Runtime...
        </div>
      ) : (
        <div className="runtime-dependency-grid">
          {dependencies.map((dependency) => (
            <RuntimeDependencyCard
              key={dependency.id}
              dependency={dependency}
              job={getJobForDependency(jobs, dependency.id)}
              busyDependencyId={busyDependencyId}
              onInstall={installDependency}
              onCancel={cancelJob}
            />
          ))}
        </div>
      )}
    </section>
  );
}

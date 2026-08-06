// serve.cjs — portable static file server + backend process manager
// Serves app/dist/, manages sd-vulkan.exe lifecycle with correct CLI flags
// serve.cjs — portable static file server + backend process manager
// Serves app/dist/, manages sd-vulkan.exe lifecycle with correct CLI flags

const http     = require("http");
const https    = require("https");
const fs       = require("fs");
const net      = require("net");
const os       = require("os");
const path     = require("path");
const { spawn, spawnSync, execSync, exec, execFile } = require("child_process");
const { comprehensiveWebSearch } = require("../search/core");

// HTTP keep-alive agent for llama-server (eliminates TCP handshake per request)
const llmHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 1,
  keepAliveMsecs: 30000,
});

const HF_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const hfModelCache = new Map();
const hfProjectorCache = new Map();

function readPort(value, fallback) {
  const port = parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

const PORT_FRONTEND = readPort(process.env.PORT || process.env.FRONTEND_PORT, 1420);
const PREFERRED_BACKEND_PORT = readPort(process.env.BACKEND_PORT || process.env.SD_BACKEND_PORT, 8080);
const PREFERRED_LLM_PORT = readPort(process.env.LLM_PORT, 10086);
const PREFERRED_SPEECH_PORT = readPort(process.env.SPEECH_PORT, 10088);
const PREFERRED_TTS_PORT = readPort(process.env.TTS_PORT, 10089);
let PORT_BACKEND = PREFERRED_BACKEND_PORT;
let PORT_LLM = PREFERRED_LLM_PORT;
let PORT_SPEECH = PREFERRED_SPEECH_PORT;
let PORT_TTS = PREFERRED_TTS_PORT;
const MAX_JSON_BODY_BYTES = 64 * 1024 * 1024;
const SERVER_BUILD = "text-image-v1";
const ROOT    = path.join(__dirname, "..", "..");
const DIST    = path.join(ROOT, "app", "dist");
const TOOLS   = path.join(ROOT, "app", "tools");
const osPlatform = process.platform;
const BACKEND_PATHS = {
  cuda: path.join(ROOT, "app", "backend", "win", "cuda", "sd-cuda.exe"),
  vulkan: path.join(ROOT, "app", "backend", "win", "vulkan", "sd-vulkan.exe"),
  cpu: path.join(ROOT, "app", "backend", "win", "cpu", "sd-cpu.exe"),
  mac: path.join(ROOT, "app", "backend", "mac", "sd"),
  linuxCpu: path.join(ROOT, "app", "backend", "linux", "cpu", "sd-server-cpu"),
  linuxVulkan: path.join(ROOT, "app", "backend", "linux", "vulkan", "sd-server-vulkan"),
  linuxRocm: path.join(ROOT, "app", "backend", "linux", "rocm", "sd-server-rocm"),
  linuxCuda: path.join(ROOT, "app", "backend", "linux", "cuda", "sd-server-cuda"),
};
let BACKEND_PATH = "";
const backendSupportsFlags = {};
if (osPlatform === "win32") {
  let hasNvidia = false;
  try {
    execSync("nvidia-smi", { stdio: "ignore" });
    hasNvidia = true;
  } catch (_) {
    const commonPath = "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe";
    if (fs.existsSync(commonPath)) {
      hasNvidia = true;
    }
  }

  if (hasNvidia && fs.existsSync(BACKEND_PATHS.cuda)) {
    BACKEND_PATH = BACKEND_PATHS.cuda;
  } else if (fs.existsSync(BACKEND_PATHS.cpu)) {
    BACKEND_PATH = BACKEND_PATHS.cpu;
  } else {
    BACKEND_PATH = BACKEND_PATHS.vulkan;
  }
} else if (osPlatform === "darwin") {
  BACKEND_PATH = BACKEND_PATHS.mac;
} else {
  // Linux: default to Vulkan if available, otherwise CPU
  if (fs.existsSync(BACKEND_PATHS.linuxVulkan)) {
    BACKEND_PATH = BACKEND_PATHS.linuxVulkan;
  } else if (fs.existsSync(BACKEND_PATHS.linuxCpu)) {
    BACKEND_PATH = BACKEND_PATHS.linuxCpu;
  } else {
    BACKEND_PATH = BACKEND_PATHS.linuxVulkan;
  }
}
const MODELS  = path.join(ROOT, "app", "models");
if (!fs.existsSync(MODELS)) {
  fs.mkdirSync(MODELS, { recursive: true });
}
const LLM_MODELS = path.join(ROOT, "app", "llm-models");
if (!fs.existsSync(LLM_MODELS)) {
  fs.mkdirSync(LLM_MODELS, { recursive: true });
}
const CHAT_HISTORY = path.join(ROOT, "app", "chat-history");
if (!fs.existsSync(CHAT_HISTORY)) {
  fs.mkdirSync(CHAT_HISTORY, { recursive: true });
}
const LLM_BACKEND_PATHS = {
  winCuda: path.join(ROOT, "app", "llm-backend", "win", "cuda", "llama-server.exe"),
  winVulkan: path.join(ROOT, "app", "llm-backend", "win", "vulkan", "llama-server.exe"),
  winSycl: path.join(ROOT, "app", "llm-backend", "win", "sycl", "llama-server.exe"),
  winHip: path.join(ROOT, "app", "llm-backend", "win", "hip", "llama-server.exe"),
  winCpu: path.join(ROOT, "app", "llm-backend", "win", "cpu", "llama-server.exe"),
  linuxCuda: path.join(ROOT, "app", "llm-backend", "linux", "cuda", "llama-server"),
  linuxRocm: path.join(ROOT, "app", "llm-backend", "linux", "rocm", "llama-server"),
  linuxVulkan: path.join(ROOT, "app", "llm-backend", "linux", "vulkan", "llama-server"),
  linuxSycl: path.join(ROOT, "app", "llm-backend", "linux", "sycl", "llama-server"),
  linuxCpu: path.join(ROOT, "app", "llm-backend", "linux", "cpu", "llama-server"),
  macArm64: path.join(ROOT, "app", "llm-backend", "mac", "arm64", "llama-server"),
  macX64: path.join(ROOT, "app", "llm-backend", "mac", "x64", "llama-server"),
};
const LLM_CONFIG_DIR = path.join(ROOT, "app", "config");
const LLM_MODEL_SETTINGS_PATH = path.join(LLM_CONFIG_DIR, "llm-model-settings.json");
const LLM_BENCHMARK_PATH = path.join(LLM_CONFIG_DIR, "llm-benchmarks.json");
if (!fs.existsSync(LLM_CONFIG_DIR)) {
  fs.mkdirSync(LLM_CONFIG_DIR, { recursive: true });
}
const SPEECH_MODELS = path.join(ROOT, "app", "speech-models");
if (!fs.existsSync(SPEECH_MODELS)) {
  fs.mkdirSync(SPEECH_MODELS, { recursive: true });
}
const TRANSCRIPTIONS = path.join(ROOT, "app", "transcriptions");
if (!fs.existsSync(TRANSCRIPTIONS)) {
  fs.mkdirSync(TRANSCRIPTIONS, { recursive: true });
}
const TTS_MODELS = path.join(ROOT, "app", "tts-models");
if (!fs.existsSync(TTS_MODELS)) {
  fs.mkdirSync(TTS_MODELS, { recursive: true });
}
const TTS_OUTPUTS = path.join(ROOT, "app", "tts-outputs");
if (!fs.existsSync(TTS_OUTPUTS)) {
  fs.mkdirSync(TTS_OUTPUTS, { recursive: true });
}
const TTS_CACHE = path.join(ROOT, "app", "tts-cache");
if (!fs.existsSync(TTS_CACHE)) {
  fs.mkdirSync(TTS_CACHE, { recursive: true });
}
const WEB_SEARCH_CACHE = path.join(ROOT, "app", "cache", "search");
if (!fs.existsSync(WEB_SEARCH_CACHE)) {
  fs.mkdirSync(WEB_SEARCH_CACHE, { recursive: true });
}
const TTS_RUNTIME = path.join(ROOT, "app", "tts-runtime");
const TTS_WORKER = path.join(ROOT, "scripts", "workers", "tts-kokoro-worker.mjs");
const SPEECH_BACKEND_ROOT = path.join(ROOT, "app", "speech-backend");
const SPEECH_BACKEND_PATHS = {
  winVulkanCli: path.join(SPEECH_BACKEND_ROOT, "win", "vulkan", "whisper-cli.exe"),
  winVulkanServer: path.join(SPEECH_BACKEND_ROOT, "win", "vulkan", "whisper-server.exe"),
  winCpuCli: path.join(SPEECH_BACKEND_ROOT, "win", "cpu", "whisper-cli.exe"),
  winCpuServer: path.join(SPEECH_BACKEND_ROOT, "win", "cpu", "whisper-server.exe"),
  winCli: path.join(ROOT, "app", "speech-backend", "win", "whisper-cli.exe"),
  winServer: path.join(ROOT, "app", "speech-backend", "win", "whisper-server.exe"),
  linuxVulkanCli: path.join(SPEECH_BACKEND_ROOT, "linux", "vulkan", "whisper-cli"),
  linuxVulkanServer: path.join(SPEECH_BACKEND_ROOT, "linux", "vulkan", "whisper-server"),
  linuxCpuCli: path.join(SPEECH_BACKEND_ROOT, "linux", "cpu", "whisper-cli"),
  linuxCpuServer: path.join(SPEECH_BACKEND_ROOT, "linux", "cpu", "whisper-server"),
  linuxCli: path.join(ROOT, "app", "speech-backend", "linux", "whisper-cli"),
  linuxServer: path.join(ROOT, "app", "speech-backend", "linux", "whisper-server"),
  macMetalCli: path.join(SPEECH_BACKEND_ROOT, "mac", "metal", "whisper-cli"),
  macMetalServer: path.join(SPEECH_BACKEND_ROOT, "mac", "metal", "whisper-server"),
  macCpuCli: path.join(SPEECH_BACKEND_ROOT, "mac", "cpu", "whisper-cli"),
  macCpuCpp: path.join(SPEECH_BACKEND_ROOT, "mac", "cpu", "whisper-cpp"),
  macCpuMain: path.join(SPEECH_BACKEND_ROOT, "mac", "cpu", "main"),
  macCpuServer: path.join(SPEECH_BACKEND_ROOT, "mac", "cpu", "whisper-server"),
  macCli: path.join(ROOT, "app", "speech-backend", "mac", "whisper-cli"),
  macServer: path.join(ROOT, "app", "speech-backend", "mac", "whisper-server"),
};
const SPEECH_MODEL_CATALOG = [
  { id: "tiny.en", name: "Whisper Tiny English", filename: "ggml-tiny.en.bin", size: "75 MB", language: "English", recommended: false },
  { id: "tiny.en-q5_1", name: "Whisper Tiny English Q5", filename: "ggml-tiny.en-q5_1.bin", size: "31 MB", language: "English", recommended: false },
  { id: "base.en", name: "Whisper Base English", filename: "ggml-base.en.bin", size: "142 MB", language: "English", recommended: true },
  { id: "base.en-q5_1", name: "Whisper Base English Q5", filename: "ggml-base.en-q5_1.bin", size: "57 MB", language: "English", recommended: true },
  { id: "small.en", name: "Whisper Small English", filename: "ggml-small.en.bin", size: "466 MB", language: "English", recommended: false },
  { id: "small.en-q5_1", name: "Whisper Small English Q5", filename: "ggml-small.en-q5_1.bin", size: "181 MB", language: "English", recommended: false },
  { id: "tiny", name: "Whisper Tiny Multilingual", filename: "ggml-tiny.bin", size: "75 MB", language: "Multilingual", recommended: false },
  { id: "base", name: "Whisper Base Multilingual", filename: "ggml-base.bin", size: "142 MB", language: "Multilingual", recommended: false },
  { id: "base-q5_1", name: "Whisper Base Multilingual Q5", filename: "ggml-base-q5_1.bin", size: "57 MB", language: "Multilingual", recommended: false },
  { id: "small", name: "Whisper Small Multilingual", filename: "ggml-small.bin", size: "466 MB", language: "Multilingual", recommended: false },
  { id: "thai-base", name: "Whisper Base Thai / ภาษาไทย", filename: "ggml-base.bin", size: "142 MB", language: "Thai", languageCode: "th", recommended: true, notes: "Recommended starter model for Thai speech-to-text. Uses the multilingual Whisper Base weights and sets Thai as the intended language." },
  { id: "thai-small", name: "Whisper Small Thai / ภาษาไทย", filename: "ggml-small.bin", size: "466 MB", language: "Thai", languageCode: "th", recommended: true, notes: "Better Thai accuracy than Base on most recordings. Recommended for Thai meetings, voice notes, and customer audio." },
  { id: "thai-medium", name: "Whisper Medium Thai / ภาษาไทย", filename: "ggml-medium.bin", size: "1.5 GB", language: "Thai", languageCode: "th", recommended: false, notes: "Higher accuracy Thai transcription for long or noisy audio. Requires more RAM and CPU/GPU time." },
  { id: "thai-medium-q5_0", name: "Whisper Medium Thai Q5 / ภาษาไทย", filename: "ggml-medium-q5_0.bin", size: "539 MB", language: "Thai", languageCode: "th", recommended: false, notes: "Quantized Thai-capable medium model. Smaller download with good accuracy/speed balance." },
];
const TTS_MODEL_CATALOG = [
  {
    id: "kokoro-onnx-q8",
    name: "Kokoro 82M ONNX Q8",
    filename: "kokoro-onnx-q8.json",
    modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    dtype: "q8",
    size: "Model cache managed by kokoro-js",
    format: "Kokoro ONNX",
    recommended: true,
  },
  {
    id: "kokoro-onnx-fp32",
    name: "Kokoro 82M ONNX FP32",
    filename: "kokoro-onnx-fp32.json",
    modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    dtype: "fp32",
    size: "Model cache managed by kokoro-js",
    format: "Kokoro ONNX",
    recommended: false,
  },
];
const TTS_VOICES = [
  { id: "af_heart", name: "Heart", language: "en-us", gender: "Female", recommended: true },
  { id: "af_bella", name: "Bella", language: "en-us", gender: "Female", recommended: false },
  { id: "af_nicole", name: "Nicole", language: "en-us", gender: "Female", recommended: false },
  { id: "af_sarah", name: "Sarah", language: "en-us", gender: "Female", recommended: false },
  { id: "am_michael", name: "Michael", language: "en-us", gender: "Male", recommended: false },
  { id: "am_fenrir", name: "Fenrir", language: "en-us", gender: "Male", recommended: false },
  { id: "bf_emma", name: "Emma", language: "en-gb", gender: "Female", recommended: false },
  { id: "bm_george", name: "George", language: "en-gb", gender: "Male", recommended: false },
];
const OPENVINO_MODELS = path.join(ROOT, "app", "openvino-models");
if (!fs.existsSync(OPENVINO_MODELS)) {
  fs.mkdirSync(OPENVINO_MODELS, { recursive: true });
}
const OUTPUTS = path.join(ROOT, "app", "outputs");
if (!fs.existsSync(OUTPUTS)) {
  fs.mkdirSync(OUTPUTS, { recursive: true });
}

const OPENVINO_NPU_MODELS = [
  {
    id: "lcm-dreamshaper-v7-fp16",
    name: "LCM DreamShaper v7 FP16",
    repo: "OpenVINO/LCM_Dreamshaper_v7-fp16-ov",
    folder: "LCM_Dreamshaper_v7-fp16-ov",
    approxSize: "2.0 GB",
    resolution: "512x512",
    notes: "OpenVINO LCM image model. Uses CPU text encoder, NPU UNet, and GPU or CPU VAE decoder.",
  },
];

// ── Backend process state ─────────────────────────────────────────────────────
let backendProc  = null;
let backendProcSeq = 0;
let backendReady = false;
let backendError = null;
let openvinoProc = null;
let openvinoReady = false;
let openvinoError = null;
let openvinoPort = null;
let openvinoModel = null;
let openvinoWidth = null;
let openvinoHeight = null;
let llmProc = null;
let llmProcSeq = 0;
let llmReady = false;
let llmError = null;
let llmOperationQueue = Promise.resolve();
let speechReady = false;
let speechError = null;
let speechOperationQueue = Promise.resolve();
let speechSettings = {
  model: null,
  language: "auto",
  threads: Math.max(1, Math.min(8, os.cpus().length || 4)),
  backendPreference: "auto",
  backendBinary: "",
  backendMode: "",
};
let speechTranscriptionState = {
  active: false,
  phase: "",
  progress: 0,
  model: "",
  filename: "",
};
let ttsReady = false;
let ttsError = null;
let ttsOperationQueue = Promise.resolve();
let ttsSettings = {
  model: null,
  voice: "af_heart",
  speed: 1,
  dtype: "q8",
  backendMode: "Kokoro ONNX",
};
let ttsGenerationState = {
  active: false,
  phase: "",
  progress: 0,
  model: "",
  voice: "",
  output: "",
};

function modelName(value) {
  return path.basename(String(value || ""));
}

function getActiveHeavyRuntime() {
  if ((backendReady || backendProc || openvinoReady || openvinoProc) && currentSettings.model) {
    return { type: "image", label: "Image", model: modelName(currentSettings.model) };
  }
  if ((llmReady || llmProc) && llmSettings.model) {
    return { type: "text", label: "Text", model: modelName(llmSettings.model) };
  }
  return null;
}

function assertNoOtherActiveRuntime(targetType, targetModel) {
  if (targetType !== "image" && targetType !== "text") return;

  const runtime = getActiveHeavyRuntime();
  const targetName = modelName(targetModel);
  if (!runtime || (runtime.type === targetType && runtime.model === targetName)) return;

  const err = new Error(`"${runtime.model}" is already loaded as a ${runtime.label} model. Unload it before loading "${targetName}".`);
  err.statusCode = 409;
  err.code = "MODEL_ALREADY_ACTIVE";
  err.activeRuntime = runtime;
  err.targetRuntime = { type: targetType, model: targetName };
  throw err;
}

function jsonErrorStatus(err) {
  return Number(err?.statusCode) || (err?.code === "MODEL_ALREADY_ACTIVE" ? 409 : 500);
}
let llmSettings = {
  model: null,
  threads: Math.max(1, Math.min(16, os.cpus().length || 4)),
  contextSize: 4096,
  gpuLayers: -1,
  backendMode: "",
  backendBinary: "",
  supportsVision: false,
  visionMode: "none",
  visionStatus: "Projector not loaded",
  flashAttn: true,
  cacheTypeK: "q8_0",
  cacheTypeV: "q8_0",
  mlock: false,
  mmap: true,
  cachePrompt: true,
  defragThold: 0.1,
  batchSize: 512,
  ubatchSize: 512,
  performanceProfile: "balanced",
};

function runExclusiveLlmOperation(operation) {
  const run = llmOperationQueue.catch(() => {}).then(operation);
  llmOperationQueue = run.catch(() => {});
  return run;
}
let backendLoadState = {
  active: false,
  phase: "",
  progress: 0,
  current: 0,
  total: 0,
  speed: "",
  model: "",
  backendMode: "",
  backendBinary: "",
  device: "",
};
let backendUnloadState = {
  active: false,
  phase: "",
  progress: 0,
};
let currentSettings = {
  model:    null,
  steps:    20,
  cfgScale: 7.0,
  sampler:  "euler_a",
  threads:  8,
  useGpu:   true,
  backendType: "auto",
  vaeTiling: true,
  vaeOnCpu:  false,
  flashAttn: true,
  width: 512,
  height: 512,
};

const BACKEND_RESTART_SETTING_KEYS = [
  "model",
  "steps",
  "cfgScale",
  "sampler",
  "threads",
  "useGpu",
  "backendType",
  "vaeTiling",
  "vaeOnCpu",
  "flashAttn",
  "width",
  "height",
];

function normalizeBackendSettingValue(key, value) {
  if (value === undefined || value === null) return value;
  if (key === "model") return path.resolve(String(value));
  if (["steps", "threads", "width", "height"].includes(key)) return parseInt(value);
  if (key === "cfgScale") return Math.round(parseFloat(value) * 1000) / 1000;
  if (["useGpu", "vaeTiling", "vaeOnCpu", "flashAttn"].includes(key)) return Boolean(value);
  return String(value);
}

function backendSettingsMatch(current, requested) {
  return BACKEND_RESTART_SETTING_KEYS.every((key) => (
    normalizeBackendSettingValue(key, current[key]) === normalizeBackendSettingValue(key, requested[key])
  ));
}

function appleNpuRuntimeMatches(current, requested) {
  return normalizeBackendSettingValue("model", current.model) === normalizeBackendSettingValue("model", requested.model) &&
    current.backendType === "apple-npu" &&
    requested.backendType === "apple-npu" &&
    normalizeBackendSettingValue("useGpu", current.useGpu) === normalizeBackendSettingValue("useGpu", requested.useGpu) &&
    normalizeBackendSettingValue("width", current.width || 512) === normalizeBackendSettingValue("width", requested.width || 512) &&
    normalizeBackendSettingValue("height", current.height || 512) === normalizeBackendSettingValue("height", requested.height || 512);
}

function setBackendLoadStage(phase, progress, extra = {}) {
  if (backendReady) return;
  backendLoadState = {
    ...backendLoadState,
    active: true,
    phase,
    progress: Math.max(backendLoadState.progress || 0, Math.min(99, progress)),
    ...extra,
  };
}

function updateCoreMLLoadProgress(output) {
  if (currentSettings.backendType !== "apple-npu" || backendReady) return;
  const cleanOutput = stripAnsi(output);

  if (cleanOutput.includes("Loading PyTorch reference configuration")) {
    setBackendLoadStage("Loading PyTorch reference configuration...", 8);
  }

  const pipelineMatch = cleanOutput.match(/Loading pipeline components.*?(\d+)%/);
  if (pipelineMatch) {
    const componentProgress = Math.max(0, Math.min(100, Number(pipelineMatch[1]) || 0));
    setBackendLoadStage("Loading pipeline components...", 10 + Math.round(componentProgress * 0.25));
  }

  if (cleanOutput.includes("Loading Core ML models from")) {
    setBackendLoadStage("Loading Core ML model bundle...", 40);
  }
  if (cleanOutput.includes("Loading text_encoder")) {
    setBackendLoadStage("Loading text encoder...", 48);
  }
  if (cleanOutput.includes("Loading unet")) {
    setBackendLoadStage("Loading UNet neural engine model...", 62);
  }
  if (cleanOutput.includes("Loading vae_decoder")) {
    setBackendLoadStage("Loading VAE decoder...", 78);
  }
  if (cleanOutput.includes("Loading safety_checker")) {
    setBackendLoadStage("Loading safety checker...", 88);
  }
  if (cleanOutput.includes("Initializing Core ML pipe")) {
    setBackendLoadStage("Initializing Core ML pipeline...", 94);
  }
  if (cleanOutput.includes("Stable Diffusion configured")) {
    setBackendLoadStage("Configuring image resolution...", 97);
  }
  if (cleanOutput.includes("Core ML models loaded successfully")) {
    setBackendLoadStage("Core ML models loaded successfully.", 99);
  }
}

let lastCpuSample = null;
let cachedGpuInfo = null;
let cachedBackendOptions = null;
let cachedVramInfo = null;

function roundGb(bytes) {
  return Math.round((bytes / (1024 ** 3)) * 100) / 100;
}

// Detect physical CPU cores (not logical/hyperthreaded cores)
// llama.cpp docs: "Do NOT set threads too high — major cause of oversaturation"
function getPhysicalCores() {
  const cpus = os.cpus();
  const logicalCores = cpus.length;
  
  if (logicalCores <= 1) return 1;
  
  // Check if hyperthreading is likely: compare unique core IDs vs total
  // On Windows/Linux, os.cpus() lists each logical core separately
  // Physical cores typically have the same model but different speeds can indicate HT
  const uniqueModels = new Set(cpus.map(c => c.model)).size;
  
  // If we have very few unique models relative to core count, likely HT
  // Also check: if logical cores is exactly 2x a common physical core count
  const commonPhysicalCounts = [2, 4, 6, 8, 10, 12, 16, 20, 24, 32];
  const isLikelyHT = commonPhysicalCounts.some(physical => logicalCores === physical * 2);
  
  if (isLikelyHT || uniqueModels < logicalCores / 2) {
    return Math.max(1, Math.floor(logicalCores / 2));
  }
  
  return logicalCores;
}

// Get optimal thread count for llama.cpp
// GPU mode: fewer threads to avoid CPU-GPU contention (physical/2)
// CPU mode: use physical cores directly
function getOptimalThreads(isGpuMode) {
  const physicalCores = getPhysicalCores();
  if (isGpuMode) {
    // llama.cpp benchmark: 4 threads on 7-core CPU + GPU = 9.1 t/s (optimal)
    // vs 7 threads = 8.7 t/s (oversaturated)
    return Math.max(1, Math.floor(physicalCores / 2));
  }
  return Math.max(1, physicalCores);
}

function getCpuSample() {
  return os.cpus().reduce((acc, cpu) => {
    const times = cpu.times;
    acc.idle += times.idle;
    acc.total += times.user + times.nice + times.sys + times.idle + times.irq;
    return acc;
  }, { idle: 0, total: 0 });
}

function getCpuUsagePercent() {
  const current = getCpuSample();
  if (!lastCpuSample) {
    lastCpuSample = current;
    return 0;
  }

  const idleDelta = current.idle - lastCpuSample.idle;
  const totalDelta = current.total - lastCpuSample.total;
  lastCpuSample = current;

  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10));
}

function hasVulkanRuntime() {
  if (osPlatform !== "win32") return true;
  try {
    const sysPaths = [
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "vulkan-1.dll"),
      path.join(process.env.SystemRoot || "C:\\Windows", "SysWOW64", "vulkan-1.dll"),
    ];
    for (const dllPath of sysPaths) {
      if (fs.existsSync(dllPath)) return true;
    }
    try {
      execSync("where vulkan-1.dll", { stdio: "ignore" });
      return true;
    } catch (_) {}
  } catch (_) {}
  return false;
}

function detectLinuxGpuFromSysfs() {
  try {
    const pciDir = "/sys/bus/pci/devices";
    if (!fs.existsSync(pciDir)) return null;
    const entries = fs.readdirSync(pciDir);
    for (const entry of entries) {
      const vendorFile = path.join(pciDir, entry, "vendor");
      const deviceFile = path.join(pciDir, entry, "device");
      if (!fs.existsSync(vendorFile)) continue;
      const vendor = fs.readFileSync(vendorFile, "utf8").trim();
      let device = "";
      try { device = fs.readFileSync(deviceFile, "utf8").trim(); } catch (_) {}
      if (vendor === "0x10de") {
        return { name: `NVIDIA GPU (${device || entry})` };
      }
      if (vendor === "0x1002") {
        return { name: `AMD GPU (${device || entry})` };
      }
      if (vendor === "0x8086") {
        return { name: `Intel GPU (${device || entry})` };
      }
    }
  } catch (_) {}
  return null;
}

function isVirtualOrSoftwareGpu(name) {
  const lowercase = String(name || "").toLowerCase();
  return lowercase.includes("virtual desktop") ||
         lowercase.includes("remote display") ||
         lowercase.includes("microsoft basic render") ||
         lowercase.includes("citrix") ||
         lowercase.includes("software rasterizer") ||
         lowercase.includes("virtualbox") ||
         lowercase.includes("vmware");
}

let cachedPreferredVulkanBackend = null;
let cachedPreferredVulkanBackendChecked = false;
function getPreferredVulkanBackendName() {
  const explicit = String(process.env.SD_VULKAN_DEVICE || process.env.UAIS_VULKAN_DEVICE || "").trim();
  if (/^vulkan\d+$/i.test(explicit)) return explicit.toLowerCase();
  if (/^\d+$/.test(explicit)) return `vulkan${explicit}`;

  if (cachedPreferredVulkanBackendChecked) return cachedPreferredVulkanBackend || "vulkan0";
  cachedPreferredVulkanBackendChecked = true;
  cachedPreferredVulkanBackend = "vulkan0";

  if (osPlatform !== "linux") return cachedPreferredVulkanBackend;
  try {
    const result = spawnSync("vulkaninfo", ["--summary"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const devices = [];
    let current = null;
    for (const line of output.split(/\r?\n/)) {
      const gpuMatch = line.match(/^\s*GPU(\d+)\s*:/i);
      if (gpuMatch) {
        current = { index: Number(gpuMatch[1]), name: "", type: "" };
        devices.push(current);
        continue;
      }
      if (!current) continue;
      const nameMatch = line.match(/deviceName\s*=\s*(.+)$/i);
      if (nameMatch) current.name = nameMatch[1].trim();
      const typeMatch = line.match(/deviceType\s*=\s*(.+)$/i);
      if (typeMatch) current.type = typeMatch[1].trim();
    }
    const usable = devices.filter((device) => Number.isInteger(device.index) && !isVirtualOrSoftwareGpu(device.name));
    const discrete = usable.find((device) => /discrete/i.test(device.type));
    const amd = usable.find((device) => /amd|radeon/i.test(device.name));
    const selected = discrete || amd || usable[0];
    if (selected) cachedPreferredVulkanBackend = `vulkan${selected.index}`;
  } catch (_) {}

  return cachedPreferredVulkanBackend;
}

let cachedLlamaCudaGpu = null;
let cachedLlamaCudaGpuChecked = false;
function detectLlamaCudaGpu() {
  if (cachedLlamaCudaGpuChecked) return cachedLlamaCudaGpu;
  cachedLlamaCudaGpuChecked = true;

  const backendPath = osPlatform === "win32"
    ? LLM_BACKEND_PATHS.winCuda
    : osPlatform === "linux"
      ? LLM_BACKEND_PATHS.linuxCuda
      : "";
  if (!backendPath || !fs.existsSync(backendPath)) return null;

  try {
    const result = spawnSync(backendPath, ["--list-devices"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const devices = [];
    const devicePattern = /CUDA\d+\s*:\s*(.+?)\s+\(([\d.]+)\s+MiB(?:,\s*([\d.]+)\s+MiB free)?\)/gi;
    let match;
    while ((match = devicePattern.exec(output)) !== null) {
      devices.push({
        name: match[1].trim(),
        vram_gb: Math.round((Number(match[2]) / 1024) * 100) / 100,
        free_vram_gb: match[3] ? Math.round((Number(match[3]) / 1024) * 100) / 100 : null,
      });
    }
    let activeDevices = devices.filter(d => !isVirtualOrSoftwareGpu(d.name));
    if (activeDevices.length === 0) {
      activeDevices = devices;
    }
    cachedLlamaCudaGpu = activeDevices.sort((a, b) => b.vram_gb - a.vram_gb)[0] || null;
  } catch (_) {
    cachedLlamaCudaGpu = null;
  }
  return cachedLlamaCudaGpu;
}

let cachedLlamaVulkanGpu = null;
let cachedLlamaVulkanGpuChecked = false;
function detectLlamaVulkanGpu() {
  if (cachedLlamaVulkanGpuChecked) return cachedLlamaVulkanGpu;
  cachedLlamaVulkanGpuChecked = true;

  const backendPath = osPlatform === "win32"
    ? LLM_BACKEND_PATHS.winVulkan
    : osPlatform === "linux"
      ? LLM_BACKEND_PATHS.linuxVulkan
      : "";
  if (!backendPath || !fs.existsSync(backendPath)) return null;

  try {
    const result = spawnSync(backendPath, ["--list-devices"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const devices = [];
    const devicePattern = /Vulkan\d+\s*:\s*(.+?)\s+\(([\d.]+)\s+MiB(?:,\s*([\d.]+)\s+MiB free)?\)/gi;
    let match;
    while ((match = devicePattern.exec(output)) !== null) {
      devices.push({
        name: match[1].trim(),
        vram_gb: Math.round((Number(match[2]) / 1024) * 100) / 100,
        free_vram_gb: match[3] ? Math.round((Number(match[3]) / 1024) * 100) / 100 : null,
      });
    }
    let activeDevices = devices.filter(d => !isVirtualOrSoftwareGpu(d.name));
    if (activeDevices.length === 0) {
      activeDevices = devices;
    }
    cachedLlamaVulkanGpu = activeDevices.sort((a, b) => b.vram_gb - a.vram_gb)[0] || null;
  } catch (_) {
    cachedLlamaVulkanGpu = null;
  }
  return cachedLlamaVulkanGpu;
}

let cachedLlamaSyclGpu = null;
let cachedLlamaSyclGpuChecked = false;
function detectLlamaSyclGpu() {
  if (cachedLlamaSyclGpuChecked) return cachedLlamaSyclGpu;
  cachedLlamaSyclGpuChecked = true;

  const backendPath = osPlatform === "win32"
    ? LLM_BACKEND_PATHS.winSycl
    : osPlatform === "linux"
      ? LLM_BACKEND_PATHS.linuxSycl
      : "";
  if (!backendPath || !fs.existsSync(backendPath)) return null;

  try {
    const result = spawnSync(backendPath, ["--list-devices"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const devices = [];
    const devicePattern = /SYCL\d+\s*:\s*(.+?)\s+\(([\d.]+)\s+MiB(?:,\s*([\d.]+)\s+MiB free)?\)/gi;
    let match;
    while ((match = devicePattern.exec(output)) !== null) {
      devices.push({
        name: match[1].trim(),
        vram_gb: Math.round((Number(match[2]) / 1024) * 100) / 100,
        free_vram_gb: match[3] ? Math.round((Number(match[3]) / 1024) * 100) / 100 : null,
      });
    }
    cachedLlamaSyclGpu = devices.sort((a, b) => b.vram_gb - a.vram_gb)[0] || null;
  } catch (_) {
    cachedLlamaSyclGpu = null;
  }
  return cachedLlamaSyclGpu;
}

function getGpuInfo() {
  if (cachedGpuInfo) return cachedGpuInfo;

  if (osPlatform === "win32" || osPlatform === "linux") {
    const llamaCudaGpu = detectLlamaCudaGpu();
    if (llamaCudaGpu) {
      cachedGpuInfo = llamaCudaGpu;
      return cachedGpuInfo;
    }

    const llamaVulkanGpu = detectLlamaVulkanGpu();
    if (llamaVulkanGpu) {
      cachedGpuInfo = llamaVulkanGpu;
      return cachedGpuInfo;
    }

    try {
      const stdout = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | ForEach-Object { [PSCustomObject]@{ Name = $_.Name; VRAM = [math]::Round($_.AdapterRAM / 1GB, 2) } } | ConvertTo-Json"',
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      if (stdout) {
        let gpus = [];
        try {
          const parsed = JSON.parse(stdout);
          if (Array.isArray(parsed)) {
            gpus = parsed;
          } else if (parsed && typeof parsed === "object") {
            gpus = [parsed];
          }
        } catch (_) {}

        if (gpus.length > 0) {
          const discreteKeywords = ["nvidia", "amd", "arc", "geforce", "radeon", "rtx", "gtx"];
          let activeGpus = gpus.filter(gpu => !isVirtualOrSoftwareGpu(gpu.Name));
          if (activeGpus.length === 0) {
            activeGpus = gpus;
          }
          let selectedGpu = activeGpus.find(gpu => {
            const name = String(gpu.Name || "").toLowerCase();
            return discreteKeywords.some(kw => name.includes(kw));
          });
          if (!selectedGpu) {
            selectedGpu = activeGpus[0];
          }
          cachedGpuInfo = {
            name: selectedGpu.Name || "Unknown GPU",
            vram_gb: typeof selectedGpu.VRAM === "number" ? selectedGpu.VRAM : 0
          };
          return cachedGpuInfo;
        }
      }
    } catch (_) {}
    // Fallback if Powershell fails or returns empty
    try {
      const output = execSync(
        "powershell -NoProfile -Command \"Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name\"",
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (output) {
        cachedGpuInfo = { name: output, vram_gb: 0 };
        return cachedGpuInfo;
      }
    } catch (_) {}
  }

  if (osPlatform === "darwin") {
    try {
      const output = execSync("system_profiler SPDisplaysDataType", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const lines = output.split("\n");
      let currentGpu = null;
      const gpus = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("Chipset Model:")) {
          if (currentGpu) {
            gpus.push(currentGpu);
          }
          currentGpu = {
            name: trimmed.substring("Chipset Model:".length).trim(),
            vram_gb: 0,
          };
        } else if (currentGpu && (trimmed.startsWith("VRAM (Total):") || trimmed.startsWith("VRAM (Dynamic, Max):"))) {
          const valStr = trimmed.split(":")[1].trim(); // e.g. "2 GB" or "1536 MB"
          let bytesVal = 0;
          const numMatch = valStr.match(/^([\d\.]+)\s*(GB|MB)/i);
          if (numMatch) {
            const val = parseFloat(numMatch[1]);
            const unit = numMatch[2].toUpperCase();
            if (unit === "GB") {
              bytesVal = val;
            } else if (unit === "MB") {
              bytesVal = val / 1024;
            }
          }
          currentGpu.vram_gb = Math.round(bytesVal * 100) / 100;
        }
      }
      if (currentGpu) {
        gpus.push(currentGpu);
      }

      if (gpus.length > 0) {
        const isAppleSilicon = gpus.some(g => {
          const name = g.name.toLowerCase();
          return name.includes("apple") || name.includes("m1") || name.includes("m2") || name.includes("m3") || name.includes("m4");
        }) || (os.arch() === "arm64");

        if (isAppleSilicon) {
          const totalRamGb = Math.round((os.totalmem() / (1024 ** 3)) * 100) / 100;
          let selected = gpus.find(g => g.name.toLowerCase().includes("apple")) || gpus[0];
          cachedGpuInfo = {
            name: selected.name,
            vram_gb: totalRamGb
          };
          return cachedGpuInfo;
        } else {
          const discreteKeywords = ["nvidia", "amd", "radeon", "geforce"];
          let selected = gpus.find(gpu => {
            const name = gpu.name.toLowerCase();
            return discreteKeywords.some(kw => name.includes(kw));
          });
          if (!selected) {
            selected = gpus[0];
          }
          cachedGpuInfo = {
            name: selected.name,
            vram_gb: selected.vram_gb
          };
          return cachedGpuInfo;
        }
      }
    } catch (_) {}
    // Fallback if system_profiler command fails
    const totalRamGb = Math.round((os.totalmem() / (1024 ** 3)) * 100) / 100;
    cachedGpuInfo = { name: "Apple Metal GPU", vram_gb: totalRamGb };
    return cachedGpuInfo;
  }

  if (osPlatform === "linux") {
    // AMD cards: Scan /sys/class/drm/card*/device/vendor and mem_info_vram_total
    try {
      if (fs.existsSync("/sys/class/drm")) {
        const cards = fs.readdirSync("/sys/class/drm").filter(name => name.startsWith("card"));
        for (const card of cards) {
          const vendorPath = `/sys/class/drm/${card}/device/vendor`;
          const vramPath = `/sys/class/drm/${card}/device/mem_info_vram_total`;
          if (fs.existsSync(vendorPath) && fs.existsSync(vramPath)) {
            const vendor = fs.readFileSync(vendorPath, "utf8").trim();
            if (vendor === "0x1002") {
              const vramBytesStr = fs.readFileSync(vramPath, "utf8").trim();
              const vramBytes = parseFloat(vramBytesStr);
              if (!isNaN(vramBytes)) {
                cachedGpuInfo = {
                  name: "AMD Radeon GPU",
                  vram_gb: Math.round((vramBytes / (1024 ** 3)) * 100) / 100
                };
                return cachedGpuInfo;
              }
            }
          }
        }
      }
    } catch (_) {}

    // NVIDIA cards: read /proc/driver/nvidia/gpus/*/information or run nvidia-smi
    try {
      if (fs.existsSync("/proc/driver/nvidia/gpus")) {
        const gpuDirs = fs.readdirSync("/proc/driver/nvidia/gpus");
        for (const gpuDir of gpuDirs) {
          const infoPath = `/proc/driver/nvidia/gpus/${gpuDir}/information`;
          if (fs.existsSync(infoPath)) {
            const info = fs.readFileSync(infoPath, "utf8");
            const modelMatch = info.match(/Model:\s+(.*)/);
            if (modelMatch) {
              const modelName = modelMatch[1].trim();
              let vram_gb = 0;
              try {
                const smiOut = execSync("nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits", {
                  encoding: "utf8",
                  stdio: ["ignore", "pipe", "ignore"]
                }).trim();
                const parsedVal = parseFloat(smiOut);
                if (!isNaN(parsedVal)) {
                  vram_gb = Math.round((parsedVal / 1024) * 100) / 100;
                }
              } catch (_) {}
              cachedGpuInfo = {
                name: modelName,
                vram_gb: vram_gb || 8.0
              };
              return cachedGpuInfo;
            }
          }
        }
      }
    } catch (_) {}

    try {
      const smiOut = execSync("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      if (smiOut) {
        const lines = smiOut.split("\n");
        if (lines[0]) {
          const [name, totalMb] = lines[0].split(",").map(p => p.trim());
          const parsedVal = parseFloat(totalMb);
          cachedGpuInfo = {
            name: name || "NVIDIA GPU",
            vram_gb: !isNaN(parsedVal) ? Math.round((parsedVal / 1024) * 100) / 100 : 8.0
          };
          return cachedGpuInfo;
        }
      }
    } catch (_) {}

    const linuxGpu = detectLinuxGpuFromSysfs();
    if (linuxGpu) {
      cachedGpuInfo = {
        name: linuxGpu.name,
        vram_gb: 0
      };
      return cachedGpuInfo;
    }
  }

  cachedGpuInfo = { name: "Unavailable", vram_gb: 0 };
  return cachedGpuInfo;
}

// ── NPU Detection ─────────────────────────────────────────────────────────────
let cachedNpuInfo = null;
let cachedHasNpuHardware = null;

function hasNpuHardware() {
  if (cachedHasNpuHardware !== null) return cachedHasNpuHardware;

  if (osPlatform !== "win32" && osPlatform !== "linux") {
    cachedHasNpuHardware = false;
    return cachedHasNpuHardware;
  }

  try {
    if (osPlatform === "win32") {
      const deviceResult = spawnSync("wmic", [
        "path", "win32_pnpentity", "where", "Name like '%NPU%' or Name like '%Intel%AI%' or Name like '%VPU%'", "get", "Name", "/value"
      ], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
      if (deviceResult.status === 0 && deviceResult.stdout && /NPU|AI Boost|VPU/i.test(deviceResult.stdout)) {
        cachedHasNpuHardware = true;
        return cachedHasNpuHardware;
      }

      const cpuResult = spawnSync("wmic", ["cpu", "get", "Name", "/value"], {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (cpuResult.status === 0 && cpuResult.stdout) {
        const cpuName = cpuResult.stdout.toLowerCase();
        if (cpuName.includes("ultra") && (cpuName.match(/ultra\s*\d/) || cpuName.includes("core(tm) ultra"))) {
          cachedHasNpuHardware = true;
          return cachedHasNpuHardware;
        }
      }
    } else if (osPlatform === "linux") {
      const lspciResult = spawnSync("lspci", [], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
      if (lspciResult.status === 0 && lspciResult.stdout && lspciResult.stdout.toLowerCase().includes("npu")) {
        cachedHasNpuHardware = true;
        return cachedHasNpuHardware;
      }

      try {
        const sysPci = fs.readdirSync("/sys/bus/pci/devices");
        for (const dev of sysPci) {
          const vendorPath = `/sys/bus/pci/devices/${dev}/vendor`;
          const classPath = `/sys/bus/pci/devices/${dev}/class`;
          if (!fs.existsSync(vendorPath) || !fs.existsSync(classPath)) continue;
          const vendor = fs.readFileSync(vendorPath, "utf8").trim();
          const devClass = fs.readFileSync(classPath, "utf8").trim();
          if (vendor === "0x8086" && (devClass.includes("1180") || devClass.includes("acce"))) {
            cachedHasNpuHardware = true;
            return cachedHasNpuHardware;
          }
        }
      } catch (_) {}

      try {
        const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8").toLowerCase();
        if (cpuInfo.includes("ultra") && cpuInfo.includes("intel")) {
          cachedHasNpuHardware = true;
          return cachedHasNpuHardware;
        }
      } catch (_) {}
    }
  } catch (_) {}

  cachedHasNpuHardware = false;
  return cachedHasNpuHardware;
}

function detectNpu() {
  if (cachedNpuInfo !== null) return cachedNpuInfo;
  cachedNpuInfo = { detected: false, vendor: null, name: null };
  
  if (osPlatform === "win32") {
    try {
      const output = execSync(
        'powershell -NoProfile -Command "Get-PnpDevice | Where-Object { $_.FriendlyName -match \'Intel.*NPU\' -or $_.FriendlyName -match \'Neural\' } | Select-Object -First 1 FriendlyName"',
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }
      ).trim();
      if (output && output.includes("NPU")) {
        cachedNpuInfo = { detected: true, vendor: "intel", name: output.trim() };
      }
    } catch (_) {}
  } else if (osPlatform === "linux") {
    try {
      const output = execSync("lspci | grep -i 'neural\|npu' || true", {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000
      }).trim();
      if (output) {
        const isIntel = output.toLowerCase().includes("intel");
        cachedNpuInfo = { 
          detected: true, 
          vendor: isIntel ? "intel" : "unknown", 
          name: output.split("\n")[0].trim() 
        };
      }
    } catch (_) {}
  }
  // macOS: Apple Silicon Neural Engine is part of the SoC, not a separate NPU device
  return cachedNpuInfo;
}

// ── GPU Layer Auto-Tuning ─────────────────────────────────────────────────────
// Calculate optimal GPU layer count from free VRAM to prevent OOM
function chooseAutoLayers(modelFilename, freeVramBytes, cacheTypeK = "q8_0", cacheTypeV = "q8_0") {
  let modelSizeGb = 4;
  let layerCount = 32;
  
  try {
    const modelPath = path.join(LLM_MODELS, modelFilename);
    if (fs.existsSync(modelPath)) {
      const stats = fs.statSync(modelPath);
      modelSizeGb = stats.size / (1024 * 1024 * 1024);
    }
  } catch (_) {}
  
  // Estimate layer count from model size (rough heuristic based on common architectures)
  if (modelSizeGb < 2) layerCount = 24;      // Small models (1-2B)
  else if (modelSizeGb < 4) layerCount = 32;   // Medium (3-4B)
  else if (modelSizeGb < 8) layerCount = 40;   // Large (7-8B)
  else if (modelSizeGb < 20) layerCount = 80;    // Very large (13-20B)
  else if (modelSizeGb < 40) layerCount = 100;   // Huge (30-40B)
  else layerCount = 120;                        // Massive (70B+)
  
  // Calculate approximate layer size
  const layerSizeGb = modelSizeGb / layerCount;
  
  // Account for KV cache memory with quantization
  // q8_0 = 0.5x, q4_0 = 0.25x of f16
  const kvCacheMultiplier = (cacheTypeK === "q4_0" || cacheTypeV === "q4_0") ? 0.25 :
                            (cacheTypeK === "q8_0" || cacheTypeV === "q8_0") ? 0.5 : 1.0;
  
  // Leave 15% VRAM headroom for KV cache + overhead + OS
  const usableVram = freeVramBytes * 0.85;
  const maxLayers = Math.floor(usableVram / (layerSizeGb * 1024 * 1024 * 1024));
  
  // Cap at total layers, return -1 if fits fully
  if (maxLayers >= layerCount) return -1;  // All layers fit
  return Math.max(0, maxLayers);
}

function getGgufModelSizeGb(modelFilename) {
  try {
    const modelPath = path.join(LLM_MODELS, modelFilename);
    if (fs.existsSync(modelPath)) {
      return fs.statSync(modelPath).size / (1024 * 1024 * 1024);
    }
  } catch (_) {}
  return 4;
}

function getStableSyclGpuLayers(modelFilename, requestedLayers) {
  if (process.env.LOCALAI_LLM_ALLOW_FULL_SYCL === "1") return requestedLayers;
  if (requestedLayers !== -1) return requestedLayers;

  const syclGpu = detectLlamaSyclGpu();
  const vramGb = syclGpu?.free_vram_gb || syclGpu?.vram_gb || 0;
  const modelSizeGb = getGgufModelSizeGb(modelFilename);
  if (vramGb > 0 && vramGb <= 8.5 && modelSizeGb >= 2.5) {
    return 0;
  }
  if (vramGb > 0 && vramGb <= 12 && modelSizeGb >= 5) {
    return 0;
  }
  return requestedLayers;
}

let nvidiaSmiCmd = "nvidia-smi";
let hasNvidiaSmi = null;

if (osPlatform === "win32") {
  const commonPath = "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe";
  if (fs.existsSync(commonPath)) {
    nvidiaSmiCmd = `"${commonPath}"`;
  }
}

let isPollingVram = false;
let lastVramPollTime = 0;

function pollNvidiaVram(force = false) {
  if (isPollingVram) return;
  if (hasNvidiaSmi === false) return;

  const now = Date.now();
  // If not forced, skip if backend is running (driver queries conflict & cause display lag),
  // or if it has been polled too recently
  if (!force) {
    if (backendProc !== null) {
      return;
    }
    if (now - lastVramPollTime < 4500) {
      return;
    }
  }

  isPollingVram = true;
  lastVramPollTime = now;
  const cmd = `${nvidiaSmiCmd} --query-gpu=name,memory.used,memory.total --format=csv,noheader,nounits`;
  exec(
    cmd,
    { stdio: ["ignore", "pipe", "ignore"] },
    (error, stdout) => {
      isPollingVram = false;
      if (error) {
        // Only permanently disable if we are not currently running a backend workload
        if (backendProc === null) {
          hasNvidiaSmi = false;
        }
        cachedVramInfo = null;
        return;
      }
      hasNvidiaSmi = true;
      const output = (stdout || "").trim();
      const firstLine = output.split(/\r?\n/)[0];
      if (!firstLine) {
        cachedVramInfo = null;
        return;
      }

      const [name, usedMb, totalMb] = firstLine.split(",").map(part => part.trim());
      cachedVramInfo = {
        gpu_name: name || getGpuInfo().name,
        vram_used_gb: Math.round((parseFloat(usedMb) / 1024) * 100) / 100,
        vram_total_gb: Math.round((parseFloat(totalMb) / 1024) * 100) / 100,
      };
    }
  );
}

// Start background VRAM polling (runs every 5 seconds, only active when backend is idle)
setInterval(() => pollNvidiaVram(false), 5000);
pollNvidiaVram(true);

function getNvidiaVram() {
  return cachedVramInfo;
}

let cachedLlamaVramInfo = null;
let isPollingLlamaVram = false;
let lastLlamaVramPollTime = 0;

function parseLlamaDeviceMemory(output) {
  const devices = [];
  const devicePattern = /(CUDA|Vulkan|SYCL)\d+\s*:\s*(.+?)\s+\(([\d.]+)\s+MiB(?:,\s*([\d.]+)\s+MiB free)?\)/gi;
  let match;
  while ((match = devicePattern.exec(output || "")) !== null) {
    const totalMiB = Number(match[3]);
    const freeMiB = match[4] ? Number(match[4]) : NaN;
    if (!Number.isFinite(totalMiB) || totalMiB <= 0) continue;

    const usedMiB = Number.isFinite(freeMiB) ? Math.max(0, totalMiB - freeMiB) : 0;
    devices.push({
      gpu_name: match[2].trim(),
      vram_used_gb: Math.round((usedMiB / 1024) * 100) / 100,
      vram_total_gb: Math.round((totalMiB / 1024) * 100) / 100,
    });
  }
  return devices.sort((a, b) => b.vram_total_gb - a.vram_total_gb)[0] || null;
}

function getLlamaTelemetryBackendPath() {
  if (osPlatform === "win32") {
    if (fs.existsSync(LLM_BACKEND_PATHS.winVulkan)) return LLM_BACKEND_PATHS.winVulkan;
    if (fs.existsSync(LLM_BACKEND_PATHS.winSycl)) return LLM_BACKEND_PATHS.winSycl;
    if (fs.existsSync(LLM_BACKEND_PATHS.winHip)) return LLM_BACKEND_PATHS.winHip;
    if (fs.existsSync(LLM_BACKEND_PATHS.winCuda)) return LLM_BACKEND_PATHS.winCuda;
  } else if (osPlatform === "linux") {
    if (fs.existsSync(LLM_BACKEND_PATHS.linuxVulkan)) return LLM_BACKEND_PATHS.linuxVulkan;
    if (fs.existsSync(LLM_BACKEND_PATHS.linuxSycl)) return LLM_BACKEND_PATHS.linuxSycl;
    if (fs.existsSync(LLM_BACKEND_PATHS.linuxRocm)) return LLM_BACKEND_PATHS.linuxRocm;
    if (fs.existsSync(LLM_BACKEND_PATHS.linuxCuda)) return LLM_BACKEND_PATHS.linuxCuda;
  }
  return null;
}

function pollLlamaVram(force = false) {
  if (isPollingLlamaVram) return;

  const now = Date.now();
  if (!force && now - lastLlamaVramPollTime < 4500) {
    return;
  }

  const backendPath = getLlamaTelemetryBackendPath();
  if (!backendPath) return;

  isPollingLlamaVram = true;
  lastLlamaVramPollTime = now;
  execFile(
    backendPath,
    ["--list-devices"],
    { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => {
      isPollingLlamaVram = false;
      if (error) {
        cachedLlamaVramInfo = null;
        return;
      }
      cachedLlamaVramInfo = parseLlamaDeviceMemory(`${stdout || ""}\n${stderr || ""}`);
    }
  );
}

setInterval(() => pollLlamaVram(false), 5000);
pollLlamaVram(true);

function getLlamaVram() {
  return cachedLlamaVramInfo;
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function getPersistedLlmModelSettings() {
  return readJsonFile(LLM_MODEL_SETTINGS_PATH, { models: {} });
}

function savePersistedLlmModelSettings(settings) {
  writeJsonFile(LLM_MODEL_SETTINGS_PATH, settings && typeof settings === "object" ? settings : { models: {} });
}

function getLlmModelSettings(filename) {
  const safeFilename = path.basename(String(filename || ""));
  if (!safeFilename) return {};
  const settings = getPersistedLlmModelSettings();
  return settings.models?.[safeFilename] || {};
}

function updateLlmModelSettings(filename, patch) {
  const safeFilename = path.basename(String(filename || ""));
  if (!safeFilename) return {};
  const allSettings = getPersistedLlmModelSettings();
  if (!allSettings.models || typeof allSettings.models !== "object") allSettings.models = {};
  const previous = allSettings.models[safeFilename] || {};
  const next = {
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  allSettings.models[safeFilename] = next;
  savePersistedLlmModelSettings(allSettings);
  return next;
}

function getPersistedLlmBenchmarks() {
  return readJsonFile(LLM_BENCHMARK_PATH, { results: [] });
}

function savePersistedLlmBenchmarks(benchmarks) {
  writeJsonFile(LLM_BENCHMARK_PATH, benchmarks && typeof benchmarks === "object" ? benchmarks : { results: [] });
}

function recordLlmBenchmark(result) {
  const benchmarks = getPersistedLlmBenchmarks();
  const results = Array.isArray(benchmarks.results) ? benchmarks.results : [];
  results.unshift({
    ...result,
    createdAt: new Date().toISOString(),
  });
  benchmarks.results = results.slice(0, 100);
  savePersistedLlmBenchmarks(benchmarks);
  return benchmarks.results[0];
}

function parseLlamaDeviceList(output) {
  const devices = [];
  const devicePattern = /(CUDA|Vulkan|SYCL|HIP|ROCm)\d*\s*:\s*(.+?)\s+\(([\d.]+)\s+MiB(?:,\s*([\d.]+)\s+MiB free)?\)/gi;
  let match;
  while ((match = devicePattern.exec(output || "")) !== null) {
    const totalMiB = Number(match[3]);
    const freeMiB = match[4] ? Number(match[4]) : NaN;
    if (!Number.isFinite(totalMiB) || totalMiB <= 0) continue;
    devices.push({
      type: match[1],
      name: match[2].trim(),
      vram_gb: Math.round((totalMiB / 1024) * 100) / 100,
      free_vram_gb: Number.isFinite(freeMiB) ? Math.round((freeMiB / 1024) * 100) / 100 : null,
    });
  }
  return devices.sort((a, b) => b.vram_gb - a.vram_gb);
}

let cachedMacRamUsedGb = null;
function pollMacRam() {
  if (osPlatform !== "darwin") return;
  exec("vm_stat", (err, stdout) => {
    if (err) return;
    try {
      const vmStat = stdout.toString();
      const pageSizeMatch = vmStat.match(/page size of (\d+) bytes/);
      const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;

      const getVal = (key) => {
        const match = vmStat.match(new RegExp(key + ":\\s+(\\d+)\\."));
        return match ? parseInt(match[1], 10) : 0;
      };

      const freePages = getVal("Pages free");
      const inactivePages = getVal("Pages inactive");
      const speculativePages = getVal("Pages speculative");
      
      const totalFreeBytes = (freePages + inactivePages + speculativePages) * pageSize;
      cachedMacRamUsedGb = roundGb(os.totalmem() - totalFreeBytes);
    } catch (e) {
      // Ignore parsing errors
    }
  });
}

if (osPlatform === "darwin") {
  pollMacRam();
  setInterval(pollMacRam, 5000);
}

function getHardwareSpecs() {
  const cpus = os.cpus();
  const gpu = getGpuInfo();
  const ramTotalGb = roundGb(os.totalmem());
  const gpuVramGb = gpu.vram_gb || 0;
  const physicalCores = getPhysicalCores();
  const logicalCores = cpus.length;
  const npuInfo = detectNpu();

  // Tiering logic
  let tier = "low";
  let tierReason = "";

  const isAppleSilicon = osPlatform === "darwin" && (os.arch() === "arm64" || String(cpus[0]?.model || "").toLowerCase().includes("apple"));

  if (isAppleSilicon) {
    if (ramTotalGb >= 16) {
      tier = "high";
      tierReason = `Apple Silicon Mac with ${ramTotalGb} GB unified memory.`;
    } else if (ramTotalGb >= 8) {
      tier = "mid";
      tierReason = `Apple Silicon Mac with ${ramTotalGb} GB unified memory.`;
    } else {
      tier = "low";
      tierReason = `Apple Silicon Mac with ${ramTotalGb} GB unified memory.`;
    }
  } else {
    if (gpuVramGb >= 12) {
      tier = "high";
      tierReason = `Discrete GPU with ${gpuVramGb} GB VRAM.`;
    } else if (gpuVramGb >= 6) {
      tier = "mid";
      tierReason = `GPU with ${gpuVramGb} GB VRAM.`;
    } else {
      tier = "low";
      tierReason = `GPU with ${gpuVramGb} GB VRAM and ${ramTotalGb} GB RAM.`;
    }
  }

  // Recommended text settings per tier
  const recommendedTextSettings = {
    low: {
      contextSize: 2048,
      threads: Math.max(1, physicalCores),
      gpuLayers: 0,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      flashAttn: true,
      mlock: true,
      mmap: true,
      cachePrompt: true,
      batchSize: 256,
      ubatchSize: 256,
      performanceProfile: "potato",
    },
    mid: {
      contextSize: 4096,
      threads: Math.max(1, Math.floor(physicalCores / 2)),
      gpuLayers: -1,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      flashAttn: true,
      mlock: false,
      mmap: true,
      cachePrompt: true,
      batchSize: 512,
      ubatchSize: 512,
      performanceProfile: "balanced",
    },
    high: {
      contextSize: 8192,
      threads: Math.max(1, Math.floor(physicalCores / 2)),
      gpuLayers: -1,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      flashAttn: true,
      mlock: false,
      mmap: true,
      cachePrompt: true,
      batchSize: 1024,
      ubatchSize: 1024,
      performanceProfile: "high",
    },
  };

  // Recommended models catalog matching contract exactly
  let recommended_models = [];
  if (tier === "high") {
    recommended_models = [
      {
        name: "Llama 3 8B Instruct (Q8_0)",
        filename: "Meta-Llama-3-8B-Instruct-Q8_0.gguf",
        approxSize: "8.5 GB",
        url: "https://huggingface.co/QuantFactory/Meta-Llama-3-8B-Instruct-GGUF/resolve/main/Meta-Llama-3-8B-Instruct-Q8_0.gguf",
        notes: "Near-lossless precision for high quality responses.",
        reason: tierReason
      },
      {
        name: "Mistral 7B Instruct v0.3 (Q8_0)",
        filename: "Mistral-7B-Instruct-v0.3.Q8_0.gguf",
        approxSize: "7.7 GB",
        url: "https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3.Q8_0.gguf",
        notes: "Superb instruction-following and context window size.",
        reason: tierReason
      }
    ];
  } else if (tier === "mid") {
    recommended_models = [
      {
        name: "Llama 3 8B Instruct (Q4_K_M)",
        filename: "Meta-Llama-3-8B-Instruct-Q4_K_M.gguf",
        approxSize: "4.8 GB",
        url: "https://huggingface.co/QuantFactory/Meta-Llama-3-8B-Instruct-GGUF/resolve/main/Meta-Llama-3-8B-Instruct-Q4_K_M.gguf",
        notes: "Great balance of speed and performance.",
        reason: tierReason
      },
      {
        name: "Phi-3 Mini Instruct (Q4_K_M)",
        filename: "Phi-3-mini-4k-instruct-q4.gguf",
        approxSize: "2.2 GB",
        url: "https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf",
        notes: "Lightweight and fast, optimized by Microsoft.",
        reason: tierReason
      }
    ];
  } else {
    recommended_models = [
      {
        name: "Qwen 2.5 Coder 0.5B Instruct (Q4_K_M)",
        filename: "qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
        approxSize: "491 MB",
        url: "https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
        notes: "Extremely fast, lightweight assistant, perfect for low RAM/VRAM machines.",
        reason: tierReason
      },
      {
        name: "SmolLM2 1.7B Instruct (Q4_K_M)",
        filename: "smollm2-1.7b-instruct-q4_k_m.gguf",
        approxSize: "1.1 GB",
        url: "https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/resolve/main/smollm2-1.7b-instruct-q4_k_m.gguf",
        notes: "Excellent lightweight assistant with strong logic, reasoning, and prompt expansion capabilities.",
        reason: tierReason
      }
    ];
  }

  return {
    os_name: `${os.type()} ${os.release()}`,
    cpu_name: cpus[0]?.model || "Unavailable",
    cpu_cores_physical: physicalCores,
    cpu_cores_logical: logicalCores,
    ram_total_gb: ramTotalGb,
    gpu_name: gpu.name,
    gpu_vram_gb: gpuVramGb,
    npu: npuInfo,
    tier,
    recommended_models,
    recommended_text_settings: recommendedTextSettings[tier] || recommendedTextSettings.mid,
  };
}

function getTelemetry() {
  const vram = getNvidiaVram();
  const llamaVram = vram || getLlamaVram();
  let ram_used_gb = roundGb(os.totalmem() - os.freemem());
  if (osPlatform === "darwin" && cachedMacRamUsedGb !== null) {
    ram_used_gb = cachedMacRamUsedGb;
  }
  const gpu = getGpuInfo();
  return {
    cpu_usage: getCpuUsagePercent(),
    ram_used_gb,
    ram_total_gb: roundGb(os.totalmem()),
    gpu_name: llamaVram?.gpu_name || gpu.name,
    vram_used_gb: Number.isFinite(Number(llamaVram?.vram_used_gb)) ? llamaVram.vram_used_gb : 0,
    vram_total_gb: llamaVram?.vram_total_gb || gpu.vram_gb || 0,
  };
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** idx)).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function getPathInfo(label, targetPath, type = "file") {
  const exists = fs.existsSync(targetPath);
  return {
    label,
    path: targetPath,
    type,
    exists,
    ok: exists,
  };
}

function isDirWritable(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const testFile = path.join(dirPath, `.luke-ai-studio-write-test-${Date.now()}.tmp`);
    fs.writeFileSync(testFile, "ok", "utf8");
    fs.unlinkSync(testFile);
    return true;
  } catch (_) {
    return false;
  }
}

function getDirInfo(label, targetPath) {
  const exists = fs.existsSync(targetPath);
  const writable = exists ? isDirWritable(targetPath) : false;
  return {
    label,
    path: targetPath,
    type: "directory",
    exists,
    writable,
    ok: exists && writable,
  };
}

function getPathSize(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) return 0;
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    return fs.readdirSync(targetPath).reduce((sum, name) => sum + getPathSize(path.join(targetPath, name)), 0);
  } catch (_) {
    return 0;
  }
}

function getOpenVinoPythonCandidates() {
  const candidates = [];
  if (process.env.OPENVINO_PYTHON) candidates.push(process.env.OPENVINO_PYTHON);
  if (osPlatform === "win32") {
    candidates.push(path.join(ROOT, "app", "tools", "python-win", "python.exe"));
  } else {
    candidates.push(path.join(ROOT, "app", "tools", "openvino-venv-linux", "bin", "python"));
    candidates.push(path.join(ROOT, "app", "tools", "openvino-venv", "bin", "python")); // legacy fallback
  }
  return [...new Set(candidates)];
}

function getOpenVinoPython() {
  for (const candidate of getOpenVinoPythonCandidates()) {
    try {
      const result = spawnSync(candidate, [
        "-c",
        "import openvino, openvino_genai, PIL; print(openvino.__version__)",
      ], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
      if (result.status === 0) return candidate;
    } catch (_) {}
  }
  return null;
}

let cachedOpenVinoNpuInfo = null;

function getOpenVinoNpuInfo() {
  if (cachedOpenVinoNpuInfo) return cachedOpenVinoNpuInfo;

  if (osPlatform !== "win32" && osPlatform !== "linux") {
    cachedOpenVinoNpuInfo = { supported: false, reason: "OpenVINO NPU backend is supported on Windows and Linux Intel Core Ultra systems." };
    return cachedOpenVinoNpuInfo;
  }
  const python = getOpenVinoPython();
  if (!python) {
    const setupScript = osPlatform === "win32"
      ? "scripts/setup/setup-openvino-npu.ps1"
      : "bash scripts/setup/setup-openvino-npu.sh";
    cachedOpenVinoNpuInfo = {
      supported: false,
      reason: `OpenVINO GenAI runtime is not installed. Run ${setupScript} first.`,
    };
    return cachedOpenVinoNpuInfo;
  }
  try {
    const script = [
      "import json, openvino as ov",
      "core=ov.Core()",
      "devices=core.available_devices",
      "info={'devices':devices,'npu':None}",
      "if 'NPU' in devices:",
      "    info['npu']={'name':core.get_property('NPU','FULL_DEVICE_NAME'),'capabilities':core.get_property('NPU','OPTIMIZATION_CAPABILITIES')}",
      "print(json.dumps(info))",
    ].join("\n");
    const result = spawnSync(python, ["-c", script], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) {
      cachedOpenVinoNpuInfo = { supported: false, python, reason: result.stderr.trim() || "OpenVINO NPU probe failed." };
      return cachedOpenVinoNpuInfo;
    }
    const info = JSON.parse(result.stdout.trim());
    if (!info.devices.includes("NPU")) {
      cachedOpenVinoNpuInfo = { supported: false, python, reason: `OpenVINO is installed, but NPU is not available. Devices: ${info.devices.join(", ")}` };
      return cachedOpenVinoNpuInfo;
    }
    cachedOpenVinoNpuInfo = { supported: true, platform: osPlatform, python, devices: info.devices, npu: info.npu };
    return cachedOpenVinoNpuInfo;
  } catch (err) {
    cachedOpenVinoNpuInfo = { supported: false, python, reason: err.message || String(err) };
    return cachedOpenVinoNpuInfo;
  }
}

function getOpenVinoModelInfo() {
  return OPENVINO_NPU_MODELS.map((model) => {
    const modelPath = path.join(OPENVINO_MODELS, model.folder);
    const requiredFiles = [
      path.join(modelPath, "model_index.json"),
      path.join(modelPath, "text_encoder", "openvino_model.xml"),
      path.join(modelPath, "unet", "openvino_model.xml"),
      path.join(modelPath, "vae_decoder", "openvino_model.xml"),
    ];
    const installed = requiredFiles.every((file) => fs.existsSync(file));
    return {
      ...model,
      filename: model.id,
      path: modelPath,
      installed,
      sizeBytes: getPathSize(modelPath),
      size: formatBytes(getPathSize(modelPath)),
      format: "OpenVINO",
    };
  });
}

function findOpenVinoModel(modelId) {
  return getOpenVinoModelInfo().find((model) => model.id === modelId || model.folder === modelId || model.name === modelId);
}

function pathInside(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function checkPort(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once("error", () => resolve({ port, available: false, inUse: true }))
      .once("listening", () => {
        tester.close(() => resolve({ port, available: true, inUse: false }));
      })
      .listen(port, "127.0.0.1");
  });
}

async function waitForPortAvailable(port, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await checkPort(port);
    if (status.available) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function findAvailableBackendPort() {
  const preferred = await checkPort(PREFERRED_BACKEND_PORT);
  if (preferred.available) return PREFERRED_BACKEND_PORT;

  for (let port = 28088; port <= 28120; port += 1) {
    const candidate = await checkPort(port);
    if (candidate.available) {
      console.log(`  [backend] Preferred port ${PREFERRED_BACKEND_PORT} is busy; using ${port} instead.`);
      return port;
    }
  }

  throw new Error(`No free backend port found. Tried ${PREFERRED_BACKEND_PORT} and 28088-28120.`);
}

async function findAvailableLlmPort() {
  const preferred = await checkPort(PREFERRED_LLM_PORT);
  if (preferred.available) return PREFERRED_LLM_PORT;

  for (let port = 28121; port <= 28160; port += 1) {
    const candidate = await checkPort(port);
    if (candidate.available) {
      console.log(`  [llm] Preferred port ${PREFERRED_LLM_PORT} is busy; using ${port} instead.`);
      return port;
    }
  }

  throw new Error(`No free LLM port found. Tried ${PREFERRED_LLM_PORT} and 28121-28160.`);
}

async function findAvailableSpeechPort() {
  const preferred = await checkPort(PREFERRED_SPEECH_PORT);
  if (preferred.available) return PREFERRED_SPEECH_PORT;

  for (let port = 28161; port <= 28190; port += 1) {
    const candidate = await checkPort(port);
    if (candidate.available) {
      console.log(`  [speech] Preferred port ${PREFERRED_SPEECH_PORT} is busy; using ${port} instead.`);
      return port;
    }
  }

  throw new Error(`No free speech port found. Tried ${PREFERRED_SPEECH_PORT} and 28161-28190.`);
}

function getLlmBackend() {
  return getLlmBackendCandidates()[0] || null;
}

let cachedLlmBackendProbe = null;
let cachedLlmBackendProbeAt = 0;

function resolveSystemLlamaServer() {
  const configured = process.env.LOCALAI_LLM_SYSTEM_SERVER || process.env.LLAMA_SERVER_PATH || "";
  if (configured && fs.existsSync(configured)) return configured;
  return "";
}

function probeLlmBackend(backend) {
  if (!backend?.path || !fs.existsSync(backend.path)) {
    return {
      ...backend,
      installed: false,
      detected: false,
      devices: [],
      error: "Backend binary not installed.",
    };
  }

  try {
    const result = spawnSync(backend.path, ["--list-devices"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const devices = parseLlamaDeviceList(output);
    const detected = backend.key === "cpu" || backend.key === "metal" || backend.key === "system" || devices.length > 0;
    return {
      ...backend,
      installed: true,
      detected,
      devices,
      device: devices[0] || null,
      error: result.status && !detected ? output.trim().slice(-600) : "",
    };
  } catch (err) {
    return {
      ...backend,
      installed: true,
      detected: backend.key === "cpu",
      devices: [],
      device: null,
      error: err.message || String(err),
    };
  }
}

function getAllLlmBackendCandidates() {
  const systemPath = resolveSystemLlamaServer();
  const candidates = [];
  const add = (key, backendPath, mode, portable = true) => {
    if (!backendPath) return;
    if (candidates.some((item) => item.path === backendPath)) return;
    candidates.push({ key, path: backendPath, mode, portable });
  };

  if (systemPath) add("system", systemPath, "System llama.cpp", false);
  if (osPlatform === "win32") {
    add("cuda", LLM_BACKEND_PATHS.winCuda, "Auto (CUDA/CPU)");
    add("hip", LLM_BACKEND_PATHS.winHip, "Auto (HIP/CPU)");
    add("vulkan", LLM_BACKEND_PATHS.winVulkan, "Auto (Vulkan/CPU)");
    add("sycl", LLM_BACKEND_PATHS.winSycl, "Auto (SYCL/CPU)");
    add("cpu", LLM_BACKEND_PATHS.winCpu, "CPU");
  } else if (osPlatform === "darwin") {
    add("metal", process.arch === "arm64" ? LLM_BACKEND_PATHS.macArm64 : LLM_BACKEND_PATHS.macX64, process.arch === "arm64" ? "Metal GPU" : "CPU");
  } else {
    add("cuda", LLM_BACKEND_PATHS.linuxCuda, "Auto (CUDA/CPU)");
    add("rocm", LLM_BACKEND_PATHS.linuxRocm, "Auto (ROCm/CPU)");
    add("sycl", LLM_BACKEND_PATHS.linuxSycl, "Auto (SYCL/CPU)");
    add("vulkan", LLM_BACKEND_PATHS.linuxVulkan, "Auto (Vulkan/CPU)");
    add("cpu", LLM_BACKEND_PATHS.linuxCpu, "CPU");
  }
  return candidates;
}

function getLlmBackendProbe(force = false) {
  const now = Date.now();
  if (!force && cachedLlmBackendProbe && now - cachedLlmBackendProbeAt < 60000) return cachedLlmBackendProbe;

  const probed = getAllLlmBackendCandidates().map(probeLlmBackend);
  const priority = osPlatform === "win32"
    ? { system: -1, cuda: 0, hip: 1, vulkan: 2, sycl: 3, metal: 4, cpu: 9 }
    : osPlatform === "darwin"
      ? { system: -1, metal: 0, cpu: 9 }
      : { system: -1, cuda: 0, rocm: 1, sycl: 2, cpu: 3, vulkan: 4 };

  const available = probed
    .filter((item) => item.installed && item.detected)
    .sort((a, b) => {
      if (osPlatform !== "linux") {
        if (a.key === "cpu" && b.key !== "cpu") return 1;
        if (b.key === "cpu" && a.key !== "cpu") return -1;
      }
      return (priority[a.key] ?? 8) - (priority[b.key] ?? 8);
    });

  cachedLlmBackendProbe = {
    generatedAt: new Date().toISOString(),
    candidates: probed,
    available,
    selected: available[0] || null,
  };
  cachedLlmBackendProbeAt = now;
  return cachedLlmBackendProbe;
}

function getLlmBackendCandidates() {
  const includeUndetectedGpu = process.env.LOCALAI_LLM_TRY_UNDETECTED_GPU === "1";
  const probe = getLlmBackendProbe();
  if (includeUndetectedGpu) {
    return probe.candidates.filter((item) => item.installed);
  }
  return probe.available;
}

function getLlmModels() {
  try {
    return fs.readdirSync(LLM_MODELS)
      .filter((filename) => filename.toLowerCase().endsWith(".gguf"))
      .map((filename) => {
        const stats = fs.statSync(path.join(LLM_MODELS, filename));
        const lower = filename.toLowerCase();
        return {
          filename,
          name: filename,
          sizeBytes: stats.size,
          size: formatBytes(stats.size),
          format: "GGUF",
          isProjector: lower.includes("mmproj"),
        };
      });
  } catch (_) {
    return [];
  }
}

function findExistingFile(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

function getSpeechBackendCandidates() {
  if (osPlatform === "win32") {
    return [
      {
        key: "vulkan",
        label: "Vulkan GPU",
        mode: "whisper.cpp Vulkan GPU",
        cli: findExistingFile([SPEECH_BACKEND_PATHS.winVulkanCli, path.join(SPEECH_BACKEND_ROOT, "win", "vulkan", "main.exe")]),
        server: findExistingFile([SPEECH_BACKEND_PATHS.winVulkanServer, path.join(SPEECH_BACKEND_ROOT, "win", "vulkan", "server.exe")]),
        pathHint: path.join(SPEECH_BACKEND_ROOT, "win", "vulkan"),
      },
      {
        key: "cpu",
        label: "CPU",
        mode: "whisper.cpp CPU",
        cli: findExistingFile([SPEECH_BACKEND_PATHS.winCpuCli, SPEECH_BACKEND_PATHS.winCli, path.join(SPEECH_BACKEND_ROOT, "win", "cpu", "main.exe"), path.join(SPEECH_BACKEND_ROOT, "win", "main.exe")]),
        server: findExistingFile([SPEECH_BACKEND_PATHS.winCpuServer, SPEECH_BACKEND_PATHS.winServer, path.join(SPEECH_BACKEND_ROOT, "win", "cpu", "server.exe"), path.join(SPEECH_BACKEND_ROOT, "win", "server.exe")]),
        pathHint: path.join(SPEECH_BACKEND_ROOT, "win", "cpu"),
      },
    ];
  }
  if (osPlatform === "darwin") {
    return [
      {
        key: "metal",
        label: "Metal GPU",
        mode: "whisper.cpp Metal GPU",
        cli: findExistingFile([SPEECH_BACKEND_PATHS.macMetalCli, path.join(SPEECH_BACKEND_ROOT, "mac", "metal", "main")]),
        server: findExistingFile([SPEECH_BACKEND_PATHS.macMetalServer, path.join(SPEECH_BACKEND_ROOT, "mac", "metal", "server")]),
        pathHint: path.join(SPEECH_BACKEND_ROOT, "mac", "metal"),
      },
      {
        key: "cpu",
        label: "CPU",
        mode: "whisper.cpp CPU",
        cli: findExistingFile([SPEECH_BACKEND_PATHS.macCpuCli, SPEECH_BACKEND_PATHS.macCpuCpp, SPEECH_BACKEND_PATHS.macCpuMain, SPEECH_BACKEND_PATHS.macCli, path.join(SPEECH_BACKEND_ROOT, "mac", "whisper-cpp"), path.join(SPEECH_BACKEND_ROOT, "mac", "main")]),
        server: findExistingFile([SPEECH_BACKEND_PATHS.macCpuServer, SPEECH_BACKEND_PATHS.macServer, path.join(SPEECH_BACKEND_ROOT, "mac", "cpu", "server"), path.join(SPEECH_BACKEND_ROOT, "mac", "server")]),
        pathHint: path.join(SPEECH_BACKEND_ROOT, "mac", "cpu"),
      },
    ];
  }
  return [
    {
      key: "vulkan",
      label: "Vulkan GPU",
      mode: "whisper.cpp Vulkan GPU",
      cli: findExistingFile([SPEECH_BACKEND_PATHS.linuxVulkanCli, path.join(SPEECH_BACKEND_ROOT, "linux", "vulkan", "main")]),
      server: findExistingFile([SPEECH_BACKEND_PATHS.linuxVulkanServer, path.join(SPEECH_BACKEND_ROOT, "linux", "vulkan", "server")]),
      pathHint: path.join(SPEECH_BACKEND_ROOT, "linux", "vulkan"),
    },
    {
      key: "cpu",
      label: "CPU",
      mode: "whisper.cpp CPU",
      cli: findExistingFile([SPEECH_BACKEND_PATHS.linuxCpuCli, SPEECH_BACKEND_PATHS.linuxCli, path.join(SPEECH_BACKEND_ROOT, "linux", "cpu", "main"), path.join(SPEECH_BACKEND_ROOT, "linux", "main")]),
      server: findExistingFile([SPEECH_BACKEND_PATHS.linuxCpuServer, SPEECH_BACKEND_PATHS.linuxServer, path.join(SPEECH_BACKEND_ROOT, "linux", "cpu", "server"), path.join(SPEECH_BACKEND_ROOT, "linux", "server")]),
      pathHint: path.join(SPEECH_BACKEND_ROOT, "linux", "cpu"),
    },
  ];
}

function normalizeSpeechBackendPreference(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (["auto", "cpu", "vulkan", "metal"].includes(raw)) return raw;
  return "auto";
}

function getSpeechBackend(preference = speechSettings.backendPreference) {
  const candidates = getSpeechBackendCandidates().map((candidate) => ({
    ...candidate,
    installed: Boolean(candidate.cli),
  }));
  const preferred = normalizeSpeechBackendPreference(preference);
  const selected = preferred === "auto"
    ? candidates.find((candidate) => candidate.installed) || candidates[candidates.length - 1]
    : candidates.find((candidate) => candidate.key === preferred) || candidates.find((candidate) => candidate.installed) || candidates[candidates.length - 1];
  return {
    ...(selected || { key: "cpu", label: "CPU", mode: "whisper.cpp CPU", cli: "", server: "" }),
    preference: preferred,
    candidates,
  };
}

function getSpeechModels() {
  const catalog = SPEECH_MODEL_CATALOG.map((model) => {
    const modelPath = path.join(SPEECH_MODELS, model.filename);
    const installed = fs.existsSync(modelPath);
    return {
      ...model,
      installed,
      sizeBytes: installed ? getPathSize(modelPath) : 0,
      localSize: installed ? formatBytes(getPathSize(modelPath)) : "",
      url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model.filename}`,
    };
  });

  const known = new Set(catalog.map((model) => model.filename.toLowerCase()));
  let custom = [];
  try {
    custom = fs.readdirSync(SPEECH_MODELS)
      .filter((filename) => filename.toLowerCase().endsWith(".bin") && !known.has(filename.toLowerCase()))
      .map((filename) => {
        const sizeBytes = getPathSize(path.join(SPEECH_MODELS, filename));
        return {
          id: filename,
          name: filename,
          filename,
          size: formatBytes(sizeBytes),
          localSize: formatBytes(sizeBytes),
          sizeBytes,
          language: "Custom",
          installed: true,
          recommended: false,
          custom: true,
        };
      });
  } catch (_) {}
  return [...catalog, ...custom];
}

function resolveSpeechModel(value) {
  const raw = String(value || "").trim();
  const model = getSpeechModels().find((item) => item.id === raw || item.filename === raw) ||
    getSpeechModels().find((item) => item.installed);
  if (!model) throw new Error("Download or import a Whisper model first.");
  const modelPath = path.join(SPEECH_MODELS, path.basename(model.filename));
  if (!pathInside(modelPath, SPEECH_MODELS) || !fs.existsSync(modelPath)) {
    throw new Error(`Speech model is not installed: ${model.filename}`);
  }
  return { ...model, path: modelPath };
}

function getTtsManifestPath(filename) {
  const manifestPath = path.join(TTS_MODELS, path.basename(String(filename || "")));
  return pathInside(manifestPath, TTS_MODELS) ? manifestPath : "";
}

function readTtsManifest(filename) {
  const manifestPath = getTtsManifestPath(filename);
  if (!manifestPath || !fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (_) {
    return null;
  }
}

function installTtsCatalogModel(modelIdOrFilename) {
  const raw = String(modelIdOrFilename || "").trim();
  const catalogModel = TTS_MODEL_CATALOG.find((model) => model.id === raw || model.filename === raw) || TTS_MODEL_CATALOG[0];
  if (!catalogModel) throw new Error("Unknown TTS model.");
  const manifestPath = getTtsManifestPath(catalogModel.filename);
  const manifest = {
    ...catalogModel,
    installed: true,
    createdAt: new Date().toISOString(),
    notes: "Kokoro model files are cached under app/tts-cache by kokoro-js on first generation.",
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

function getTtsModels() {
  const catalog = TTS_MODEL_CATALOG.map((model) => {
    const manifest = readTtsManifest(model.filename);
    const installed = Boolean(manifest);
    const manifestPath = getTtsManifestPath(model.filename);
    const sizeBytes = installed ? getPathSize(manifestPath) : 0;
    return {
      ...model,
      ...(manifest || {}),
      installed,
      sizeBytes,
      localSize: installed ? formatBytes(sizeBytes) : "",
      url: `kokoro://install/${model.id}`,
    };
  });

  const known = new Set(catalog.map((model) => model.filename.toLowerCase()));
  let custom = [];
  try {
    custom = fs.readdirSync(TTS_MODELS)
      .filter((filename) => filename.toLowerCase().endsWith(".json") && !known.has(filename.toLowerCase()))
      .map((filename) => {
        const manifest = readTtsManifest(filename) || {};
        const sizeBytes = getPathSize(path.join(TTS_MODELS, filename));
        return {
          id: manifest.id || filename,
          name: manifest.name || filename,
          filename,
          modelId: manifest.modelId || "onnx-community/Kokoro-82M-v1.0-ONNX",
          dtype: manifest.dtype || "q8",
          format: manifest.format || "Kokoro ONNX",
          size: formatBytes(sizeBytes),
          localSize: formatBytes(sizeBytes),
          sizeBytes,
          installed: true,
          recommended: false,
          custom: true,
        };
      });
  } catch (_) {}
  return [...catalog, ...custom];
}

function resolveTtsModel(value) {
  const raw = String(value || "").trim();
  const model = getTtsModels().find((item) => item.id === raw || item.filename === raw) ||
    getTtsModels().find((item) => item.installed);
  if (!model) throw new Error("Download or import a Kokoro TTS model from Model Manager first.");
  const manifestPath = getTtsManifestPath(model.filename);
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new Error(`TTS model is not installed: ${model.filename}`);
  }
  return { ...model, path: manifestPath };
}

function getTtsRuntimeStatus() {
  const nodeModules = path.join(TTS_RUNTIME, "node_modules");
  const installed = fs.existsSync(path.join(nodeModules, "kokoro-js"));
  return {
    installed: installed && fs.existsSync(TTS_WORKER),
    worker: TTS_WORKER,
    runtime: TTS_RUNTIME,
    cache: TTS_CACHE,
    backendMode: "Kokoro ONNX",
  };
}

function runExclusiveTtsOperation(operation) {
  const run = ttsOperationQueue.catch(() => {}).then(operation);
  ttsOperationQueue = run.catch(() => {});
  return run;
}

async function startTts(settings = {}) {
  const runtime = getTtsRuntimeStatus();
  if (!runtime.installed) {
    throw new Error("Kokoro TTS runtime is not installed. Run scripts/setup/setup-tts for this platform.");
  }
  const model = resolveTtsModel(settings.model || ttsSettings.model);
  PORT_TTS = PREFERRED_TTS_PORT;
  ttsError = null;
  ttsReady = true;
  ttsSettings = {
    ...ttsSettings,
    model: model.filename,
    voice: settings.voice || ttsSettings.voice || "af_heart",
    speed: Math.max(0.5, Math.min(2, Number(settings.speed) || ttsSettings.speed || 1)),
    dtype: model.dtype || settings.dtype || ttsSettings.dtype || "q8",
    backendMode: runtime.backendMode,
  };
}

async function stopTts() {
  ttsReady = false;
  ttsError = null;
  ttsGenerationState = { active: false, phase: "", progress: 0, model: "", voice: "", output: "" };
}

function saveTtsOutput(result) {
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-");
  const base = `tts-${stamp}-${safeOutputName(result.voice || "voice")}`;
  const wavFilename = `${base}.wav`;
  const jsonFilename = `${base}.json`;
  const wavPath = path.join(TTS_OUTPUTS, wavFilename);
  fs.copyFileSync(result.wavPath, wavPath);
  const metadata = {
    text: result.text || "",
    model: result.model,
    modelName: result.modelName,
    voice: result.voice,
    voiceName: result.voiceName,
    speed: result.speed,
    durationMs: result.durationMs,
    sampleRate: result.sampleRate || 24000,
    createdAt,
    audioFile: wavFilename,
    metadata: jsonFilename,
    displayName: result.displayName || `${result.voiceName || result.voice} - ${createdAt}`,
  };
  fs.writeFileSync(path.join(TTS_OUTPUTS, jsonFilename), JSON.stringify(metadata, null, 2), "utf8");
  return {
    ...metadata,
    filename: jsonFilename,
    url: `/tts-outputs/${encodeURIComponent(wavFilename)}`,
  };
}

function listTtsOutputs() {
  try {
    return fs.readdirSync(TTS_OUTPUTS)
      .filter((file) => file.toLowerCase().endsWith(".json"))
      .map((file) => {
        const filePath = path.join(TTS_OUTPUTS, file);
        try {
          const metadata = JSON.parse(fs.readFileSync(filePath, "utf8"));
          const stat = fs.statSync(filePath);
          return {
            ...metadata,
            filename: file,
            displayName: metadata.displayName || metadata.text?.slice(0, 48) || metadata.audioFile || file,
            sizeBytes: stat.size,
            size: formatBytes(stat.size),
            modifiedAt: stat.mtime.toISOString(),
            createdAt: metadata.createdAt || stat.mtime.toISOString(),
            url: metadata.audioFile ? `/tts-outputs/${encodeURIComponent(metadata.audioFile)}` : "",
          };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  } catch (_) {
    return [];
  }
}

function synthesizeTts(text, options = {}) {
  return new Promise((resolve, reject) => {
    const cleanedText = String(text || "").trim();
    if (!cleanedText) {
      reject(new Error("Enter text to synthesize."));
      return;
    }
    if (cleanedText.length > 5000) {
      reject(new Error("TTS text is too long. Limit is 5000 characters for V1."));
      return;
    }
    const runtime = getTtsRuntimeStatus();
    if (!runtime.installed) {
      reject(new Error("Kokoro TTS runtime is not installed."));
      return;
    }
    const model = resolveTtsModel(options.model || ttsSettings.model);
    const voice = String(options.voice || ttsSettings.voice || "af_heart");
    const voiceInfo = TTS_VOICES.find((item) => item.id === voice) || { id: voice, name: voice };
    const speed = Math.max(0.5, Math.min(2, Number(options.speed) || ttsSettings.speed || 1));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tempWav = path.join(TTS_OUTPUTS, `.tts-${stamp}.wav`);
    const payload = {
      text: cleanedText,
      modelId: model.modelId || "onnx-community/Kokoro-82M-v1.0-ONNX",
      dtype: model.dtype || "q8",
      voice,
      speed,
      output: tempWav,
      cacheDir: TTS_CACHE,
    };

    ttsGenerationState = {
      active: true,
      phase: "Generating speech...",
      progress: -1,
      model: model.filename,
      voice,
      output: "",
    };

    const startedAt = Date.now();
    const proc = spawn(process.execPath, [TTS_WORKER], {
      cwd: ROOT,
      stdio: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        NODE_PATH: path.join(TTS_RUNTIME, "node_modules"),
        TTS_RUNTIME,
      },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      process.stderr.write("  [tts] " + data.toString());
    });
    proc.on("error", (err) => {
      ttsGenerationState = { active: false, phase: "Failed", progress: 0, model: model.filename, voice, output: "" };
      reject(err);
    });
    proc.on("exit", (code) => {
      ttsGenerationState = { active: false, phase: code === 0 ? "Complete" : "Failed", progress: code === 0 ? 100 : 0, model: model.filename, voice, output: "" };
      if (code !== 0) {
        try { fs.unlinkSync(tempWav); } catch (_) {}
        const message = (stderr || stdout || `Kokoro TTS exited with code ${code}`).trim().slice(-1400);
        ttsError = message;
        reject(new Error(message));
        return;
      }
      try {
        const workerResult = JSON.parse(stdout.trim() || "{}");
        if (!workerResult.ok || !fs.existsSync(tempWav)) {
          throw new Error(workerResult.error || "Kokoro TTS did not produce a WAV file.");
        }
        const saved = saveTtsOutput({
          text: cleanedText,
          model: model.filename,
          modelName: model.name,
          voice,
          voiceName: voiceInfo.name,
          speed,
          durationMs: Date.now() - startedAt,
          sampleRate: workerResult.sampleRate || 24000,
          wavPath: tempWav,
          displayName: `${voiceInfo.name || voice} - ${cleanedText.slice(0, 40)}`,
        });
        try { fs.unlinkSync(tempWav); } catch (_) {}
        ttsError = null;
        resolve(saved);
      } catch (err) {
        try { fs.unlinkSync(tempWav); } catch (_) {}
        ttsError = err.message || String(err);
        reject(err);
      }
    });
    proc.stdin.end(JSON.stringify(payload));
  });
}

function runExclusiveSpeechOperation(operation) {
  const run = speechOperationQueue.catch(() => {}).then(operation);
  speechOperationQueue = run.catch(() => {});
  return run;
}

function tryAutoInstallSpeechBackend() {
  if (process.env.AUTO_SETUP_SPEECH === "0") return { ok: false, skipped: true, message: "AUTO_SETUP_SPEECH=0" };
  if (osPlatform !== "darwin" && osPlatform !== "linux") return { ok: false, skipped: true, message: "Unsupported platform" };
  const setupScript = path.join(ROOT, "scripts", "setup", "setup-whisper.sh");
  if (!fs.existsSync(setupScript)) return { ok: false, skipped: true, message: `Missing ${setupScript}` };
  try {
    const result = spawnSync("bash", [setupScript], { cwd: ROOT, encoding: "utf8", timeout: 15 * 60 * 1000, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: result.status === 0, status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function ensureSpeechBackendInstalled(preference = speechSettings.backendPreference) {
  let backend = getSpeechBackend(preference);
  if (backend.cli) return backend;
  const attempted = tryAutoInstallSpeechBackend();
  backend = getSpeechBackend(preference);
  if (backend.cli) return backend;
  const details = attempted?.stderr || attempted?.stdout || attempted?.message || attempted?.error || "";
  const extra = details ? ` Setup output: ${String(details).trim().slice(-900)}` : "";
  throw new Error(`${backend.label || "Selected"} whisper.cpp backend is not installed. The app tried to repair it automatically but no compatible binary was found at ${backend.pathHint || "app/speech-backend"}.${extra} On macOS, run scripts/setup/setup-whisper.sh or install Homebrew whisper-cpp, then relaunch.`);
}

async function startSpeech(settings = {}) {
  const backendPreference = normalizeSpeechBackendPreference(settings.backendPreference || speechSettings.backendPreference);
  const backend = ensureSpeechBackendInstalled(backendPreference);
  const model = resolveSpeechModel(settings.model);
  PORT_SPEECH = await findAvailableSpeechPort();
  speechError = null;
  speechReady = true;
  speechSettings = {
    ...speechSettings,
    model: model.filename,
    language: settings.language || speechSettings.language || "auto",
    threads: Math.max(1, Math.min(32, Number(settings.threads) || speechSettings.threads || 4)),
    backendPreference,
    backendBinary: path.basename(backend.cli),
    backendMode: backend.mode,
  };
}

async function stopSpeech() {
  speechReady = false;
  speechError = null;
  speechTranscriptionState = { active: false, phase: "", progress: 0, model: "", filename: "" };
}

function readBinaryBody(req, limitBytes = 250 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limitBytes) {
        reject(new Error(`Audio file is too large. Limit is ${Math.round(limitBytes / (1024 * 1024))} MB.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isWaveBuffer(buffer) {
  return buffer?.length > 44 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE";
}

function saveTranscript(result) {
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-");
  const base = `transcript-${stamp}-${safeOutputName(result.sourceFilename || "audio")}`;
  const textFilename = `${base}.txt`;
  const jsonFilename = `${base}.json`;
  fs.writeFileSync(path.join(TRANSCRIPTIONS, textFilename), result.text || "", "utf8");
  const metadata = {
    ...result,
    createdAt,
    textFile: textFilename,
    metadata: jsonFilename,
  };
  fs.writeFileSync(path.join(TRANSCRIPTIONS, jsonFilename), JSON.stringify(metadata, null, 2), "utf8");
  return metadata;
}

function listTranscriptions() {
  try {
    return fs.readdirSync(TRANSCRIPTIONS)
      .filter((file) => file.toLowerCase().endsWith(".json"))
      .map((file) => {
        const filePath = path.join(TRANSCRIPTIONS, file);
        try {
          const metadata = JSON.parse(fs.readFileSync(filePath, "utf8"));
          const stat = fs.statSync(filePath);
          return {
            ...metadata,
            filename: file,
            displayName: metadata.sourceFilename || metadata.textFile || file,
            sizeBytes: stat.size,
            size: formatBytes(stat.size),
            modifiedAt: stat.mtime.toISOString(),
            createdAt: metadata.createdAt || stat.mtime.toISOString(),
            url: `/transcriptions/${encodeURIComponent(file)}`,
            textUrl: metadata.textFile ? `/transcriptions/${encodeURIComponent(metadata.textFile)}` : "",
          };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  } catch (_) {
    return [];
  }
}

function transcribeWavBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    if (!isWaveBuffer(buffer)) {
      reject(new Error("Speech transcription currently accepts WAV audio only."));
      return;
    }
    const backendPreference = normalizeSpeechBackendPreference(options.backendPreference || speechSettings.backendPreference);
    let backend;
    try {
      backend = ensureSpeechBackendInstalled(backendPreference);
    } catch (err) {
      reject(err);
      return;
    }
    const model = resolveSpeechModel(options.model || speechSettings.model);
    const language = String(options.language || speechSettings.language || "auto");
    const sourceFilename = safeOutputName(options.filename || "recording.wav") || "recording.wav";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tempBase = path.join(TRANSCRIPTIONS, `.speech-${stamp}-${sourceFilename.replace(/\.[^.]+$/, "")}`);
    const wavPath = `${tempBase}.wav`;
    const outBase = `${tempBase}-out`;
    fs.writeFileSync(wavPath, buffer);

    speechTranscriptionState = {
      active: true,
      phase: "Transcribing audio...",
      progress: -1,
      model: model.filename,
      filename: sourceFilename,
    };

    const args = [
      "-m", model.path,
      "-f", wavPath,
      "-otxt",
      "-oj",
      "-of", outBase,
      "-t", String(Math.max(1, Math.min(32, Number(options.threads) || speechSettings.threads || 4))),
    ];
    if (language && language !== "auto") {
      args.push("-l", language);
    } else {
      args.push("-l", "auto");
    }
    if (options.translate) {
      args.push("-tr");
    }

    const startedAt = Date.now();
    console.log("  [speech] Starting:", backend.cli, args.join(" "));
    const proc = spawn(backend.cli, args, {
      stdio: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        ...(osPlatform === "win32" ? { PATH: path.dirname(backend.cli) + (process.env.PATH ? `;${process.env.PATH}` : "") } : {}),
        ...(osPlatform === "linux" ? { LD_LIBRARY_PATH: path.dirname(backend.cli) + (process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : "") } : {}),
        ...(osPlatform === "darwin" ? { DYLD_LIBRARY_PATH: path.dirname(backend.cli) + (process.env.DYLD_LIBRARY_PATH ? `:${process.env.DYLD_LIBRARY_PATH}` : "") } : {}),
      },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
      process.stdout.write("  [speech] " + data.toString());
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      process.stderr.write("  [speech-err] " + data.toString());
    });
    proc.on("exit", (code) => {
      try { fs.unlinkSync(wavPath); } catch (_) {}
      speechTranscriptionState = { active: false, phase: code === 0 ? "Complete" : "Failed", progress: code === 0 ? 100 : 0, model: model.filename, filename: sourceFilename };
      if (code !== 0) {
        const message = (stderr || stdout || `whisper.cpp exited with code ${code}`).trim().slice(-1200);
        speechError = message;
        reject(new Error(message));
        return;
      }
      const txtPath = `${outBase}.txt`;
      const jsonPath = `${outBase}.json`;
      const text = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, "utf8").trim() : stdout.trim();
      let raw = null;
      try {
        raw = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, "utf8")) : null;
      } catch (_) {}
      try { fs.unlinkSync(txtPath); } catch (_) {}
      try { fs.unlinkSync(jsonPath); } catch (_) {}
      const saved = saveTranscript({
        text,
        model: model.filename,
        modelName: model.name,
        language,
        backend: backend.key,
        backendMode: backend.mode,
        sourceFilename,
        durationMs: Date.now() - startedAt,
        raw,
      });
      speechError = null;
      resolve(saved);
    });
  });
}

function pingLlmReady(expectedModel = "") {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT_LLM}/v1/models`, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 500) {
          resolve(false);
          return;
        }
        if (!expectedModel) {
          resolve(true);
          return;
        }
        try {
          const parsed = JSON.parse(body || "{}");
          const servedIds = Array.isArray(parsed.data)
            ? parsed.data.map((item) => String(item.id || item.model || ""))
            : [];
          const expectedBase = path.basename(expectedModel).toLowerCase();
          resolve(servedIds.some((id) => {
            const lower = id.toLowerCase();
            return lower === expectedBase || lower.includes(expectedBase);
          }));
        } catch (_) {
          resolve(false);
        }
      });
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function waitForLlmReady(maxAttempts = 240, expectedProc = llmProc, expectedModel = "") {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!expectedProc || llmProc !== expectedProc) throw new Error(llmError || "llama.cpp exited during startup.");
    if (await pingLlmReady(expectedModel)) {
      llmReady = true;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`llama.cpp did not become ready within ${Math.round(maxAttempts / 120)} minutes.`);
}

function waitForChildExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      resolve(true);
      return;
    }
    let done = false;
    const finish = (exited) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      proc.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    proc.once("exit", onExit);
  });
}

async function killLlm() {
  llmReady = false;
  llmSettings.supportsVision = false;
  llmSettings.visionMode = "none";
  llmSettings.visionStatus = "Projector not loaded";
  llmSettings.mmproj = null;
  if (!llmProc) {
    await waitForPortAvailable(PORT_LLM, 1500);
    return;
  }

  const proc = llmProc;
  const procPort = PORT_LLM;
  llmProc = null;

  try { proc.kill("SIGTERM"); } catch (_) {}
  const exitedAfterTerm = await waitForChildExit(proc, 2500);
  if (!exitedAfterTerm) {
    try { proc.kill("SIGKILL"); } catch (_) {}
    await waitForChildExit(proc, 2500);
  }

  const released = await waitForPortAvailable(procPort, 5000);
  if (!released) {
    console.warn(`  [llm] Port ${procPort} is still busy after stopping llama.cpp.`);
  }
}

function getSetupPaths() {
  const appDir = path.join(ROOT, "app");
  if (osPlatform === "win32") {
    return {
      node: path.join(appDir, "tools", "node-win", "node.exe"),
      npm: path.join(appDir, "tools", "node-win", "npm.cmd"),
      distIndex: path.join(DIST, "index.html"),
      cudaBackend: BACKEND_PATHS.cuda,
      vulkanBackend: BACKEND_PATHS.vulkan,
      cpuBackend: BACKEND_PATHS.cpu,
      models: MODELS,
      outputs: OUTPUTS,
      chatHistory: CHAT_HISTORY,
      transcriptions: TRANSCRIPTIONS,
      ttsOutputs: TTS_OUTPUTS,
    };
  } else if (osPlatform === "darwin") {
    return {
      node: path.join(appDir, "tools", "node-mac", "bin", "node"),
      npm: path.join(appDir, "tools", "node-mac", "bin", "npm"),
      distIndex: path.join(DIST, "index.html"),
      macBackend: BACKEND_PATHS.mac,
      models: MODELS,
      outputs: OUTPUTS,
      chatHistory: CHAT_HISTORY,
      transcriptions: TRANSCRIPTIONS,
      ttsOutputs: TTS_OUTPUTS,
    };
  } else {
    // Linux / WSL
    return {
      node: path.join(appDir, "tools", "node-linux", "bin", "node"),
      npm: path.join(appDir, "tools", "node-linux", "bin", "npm"),
      distIndex: path.join(DIST, "index.html"),
      linuxCpuBackend: BACKEND_PATHS.linuxCpu,
      linuxVulkanBackend: BACKEND_PATHS.linuxVulkan,
      linuxRocmBackend: BACKEND_PATHS.linuxRocm,
      models: MODELS,
      outputs: OUTPUTS,
      chatHistory: CHAT_HISTORY,
      transcriptions: TRANSCRIPTIONS,
      ttsOutputs: TTS_OUTPUTS,
    };
  }
}

async function getHealth() {
  const paths = getSetupPaths();
  const checks = [
    getPathInfo("Portable Node.js", paths.node),
    getPathInfo("Portable npm", paths.npm),
    getPathInfo("Frontend build", paths.distIndex),
    getDirInfo("Models folder", paths.models),
    getDirInfo("Outputs folder", paths.outputs),
    getDirInfo("Chat history folder", paths.chatHistory),
    getDirInfo("Transcriptions folder", paths.transcriptions),
    getDirInfo("TTS outputs folder", paths.ttsOutputs),
  ];

  if (osPlatform === "win32") {
    checks.push(getPathInfo("CUDA backend", paths.cudaBackend));
    checks.push(getPathInfo("Vulkan backend", paths.vulkanBackend));
    checks.push(getPathInfo("CPU backend", paths.cpuBackend));
  } else if (osPlatform === "darwin") {
    checks.push(getPathInfo("Mac backend", paths.macBackend));
  } else {
    checks.push(getPathInfo("Linux CPU backend", paths.linuxCpuBackend));
    checks.push(getPathInfo("Linux Vulkan backend", paths.linuxVulkanBackend));
    checks.push(getPathInfo("Linux ROCm backend", paths.linuxRocmBackend));
  }

  let backendInstalled = false;
  if (osPlatform === "win32") {
    backendInstalled = checks.find((check) => check.label === "CUDA backend")?.exists ||
      checks.find((check) => check.label === "Vulkan backend")?.exists ||
      checks.find((check) => check.label === "CPU backend")?.exists;
  } else if (osPlatform === "darwin") {
    backendInstalled = checks.find((check) => check.label === "Mac backend")?.exists;
  } else {
    backendInstalled =
      checks.find((check) => check.label === "Linux CPU backend")?.exists ||
      checks.find((check) => check.label === "Linux CPU backend")?.exists ||
      checks.find((check) => check.label === "Linux Vulkan backend")?.exists ||
      checks.find((check) => check.label === "Linux ROCm backend")?.exists;
  }

  const criticalOk = checks
    .filter((check) => !["CUDA backend", "Vulkan backend", "CPU backend", "Linux CPU backend", "Linux Vulkan backend", "Linux ROCm backend", "Mac backend"].includes(check.label))
    .every((check) => check.ok) && backendInstalled;

  const ports = {
    frontend: { ...(await checkPort(PORT_FRONTEND)), expectedInUse: true },
    backend: { ...(await checkPort(PORT_BACKEND)), expectedInUse: backendProc !== null || openvinoProc !== null },
  };
  ports.frontend.ok = !ports.frontend.available;
  ports.backend.preferred = PREFERRED_BACKEND_PORT;
  ports.backend.selected = PORT_BACKEND;
  ports.backend.ok = true;

  const issues = checks
    .filter((check) => !check.ok && !["CUDA backend", "Vulkan backend", "CPU backend", "Linux CPU backend", "Linux Vulkan backend", "Linux ROCm backend", "Mac backend"].includes(check.label))
    .map((check) => `${check.label} is missing or not writable.`);
  if (!backendInstalled) {
    issues.push(`No ${osPlatform === "win32" ? "Windows" : osPlatform === "darwin" ? "macOS" : "Linux"} backend binary is installed.`);
  }
  return {
    ok: criticalOk && ports.backend.ok,
    build: SERVER_BUILD,
    root: ROOT,
    platform: osPlatform,
    checks,
    ports,
    backend: {
      ready: backendReady || openvinoReady,
      running: backendProc !== null || openvinoProc !== null,
      error: backendError,
      settings: currentSettings,
      options: getBackendOptions(),
    },
    models: {
      count: fs.existsSync(MODELS) ? fs.readdirSync(MODELS).filter(isModelFile).length : 0,
      totalBytes: getPathSize(MODELS),
      totalSize: formatBytes(getPathSize(MODELS)),
    },
    outputs: {
      count: fs.existsSync(OUTPUTS) ? fs.readdirSync(OUTPUTS).filter((file) => file.toLowerCase().endsWith(".json")).length : 0,
      totalBytes: getPathSize(OUTPUTS),
      totalSize: formatBytes(getPathSize(OUTPUTS)),
    },
    chat: {
      count: fs.existsSync(CHAT_HISTORY) ? fs.readdirSync(CHAT_HISTORY).filter((file) => file.toLowerCase().endsWith(".json")).length : 0,
      totalBytes: getPathSize(CHAT_HISTORY),
      totalSize: formatBytes(getPathSize(CHAT_HISTORY)),
    },
    speech: {
      transcriptions: fs.existsSync(TRANSCRIPTIONS) ? fs.readdirSync(TRANSCRIPTIONS).filter((file) => file.toLowerCase().endsWith(".json")).length : 0,
      totalBytes: getPathSize(TRANSCRIPTIONS),
      totalSize: formatBytes(getPathSize(TRANSCRIPTIONS)),
    },
    tts: {
      models: fs.existsSync(TTS_MODELS) ? fs.readdirSync(TTS_MODELS).filter((file) => file.toLowerCase().endsWith(".json")).length : 0,
      outputs: fs.existsSync(TTS_OUTPUTS) ? fs.readdirSync(TTS_OUTPUTS).filter((file) => file.toLowerCase().endsWith(".json")).length : 0,
      runtimeInstalled: getTtsRuntimeStatus().installed,
      totalBytes: getPathSize(TTS_MODELS) + getPathSize(TTS_OUTPUTS) + getPathSize(TTS_CACHE),
      totalSize: formatBytes(getPathSize(TTS_MODELS) + getPathSize(TTS_OUTPUTS) + getPathSize(TTS_CACHE)),
    },
    issues,
  };
}

function addCleanupCandidate(candidates, id, targetPath, reason, options = {}) {
  if (!fs.existsSync(targetPath)) return;
  if (!options.allowUserData && (
    pathInside(targetPath, MODELS) ||
    pathInside(targetPath, OUTPUTS) ||
    pathInside(targetPath, CHAT_HISTORY) ||
    pathInside(targetPath, TRANSCRIPTIONS) ||
    pathInside(targetPath, TTS_MODELS) ||
    pathInside(targetPath, TTS_OUTPUTS)
  )) return;
  const sizeBytes = getPathSize(targetPath);
  candidates.push({
    id,
    path: targetPath,
    name: path.basename(targetPath),
    reason,
    sizeBytes,
    size: formatBytes(sizeBytes),
  });
}

function getCleanupCandidates() {
  const candidates = [];
  const toolsDir = path.join(ROOT, "app", "tools");
  const frontendDir = path.join(ROOT, "app", "frontend");
  addCleanupCandidate(candidates, "scratch-invalid", path.join(ROOT, "scratch_invalid.txt"), "Scratch/debug file.");
  addCleanupCandidate(candidates, "vite-cache", path.join(frontendDir, "node_modules", ".vite"), "Vite dependency cache; it can be regenerated.");

  if (fs.existsSync(toolsDir)) {
    for (const item of fs.readdirSync(toolsDir)) {
      const itemPath = path.join(toolsDir, item);
      if (item.toLowerCase().endsWith(".zip")) {
        addCleanupCandidate(candidates, `setup-zip-${item}`, itemPath, "Setup download archive.");
      } else if (/^sd-.+-temp$/i.test(item)) {
        addCleanupCandidate(candidates, `setup-temp-${item}`, itemPath, "Temporary backend extraction folder.");
      }
    }
  }

  if (fs.existsSync(MODELS)) {
    for (const item of fs.readdirSync(MODELS)) {
      if (item.toLowerCase().endsWith(".part") || item.toLowerCase().endsWith(".tmp")) {
        addCleanupCandidate(candidates, `partial-model-${item}`, path.join(MODELS, item), "Incomplete model download/import file.", { allowUserData: true });
      }
    }
  }

  return candidates.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function cleanupSelected(ids = []) {
  const allowed = new Map(getCleanupCandidates().map((candidate) => [candidate.id, candidate]));
  const deleted = [];
  for (const id of ids) {
    const candidate = allowed.get(id);
    if (!candidate) continue;
    if (!fs.existsSync(candidate.path)) continue;
    const stat = fs.statSync(candidate.path);
    if (stat.isDirectory()) {
      fs.rmSync(candidate.path, { recursive: true, force: true });
    } else {
      fs.unlinkSync(candidate.path);
    }
    deleted.push(candidate);
  }
  return deleted;
}

function hasNvidiaGpu() {
  const info = getGpuInfo().name.toLowerCase();
  if (info.includes("nvidia")) return true;
  try {
    execSync("nvidia-smi", { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

function hasAmdGpu() {
  const info = getGpuInfo().name.toLowerCase();
  return info.includes("amd") || info.includes("advanced micro devices") || info.includes("radeon");
}

// Detect whether we are running inside WSL2 (Windows Subsystem for Linux).
// WSL2's GPU paravirtualization (GPU-PV) only exposes a D3D12/DirectX interface
// to Linux. Vulkan hardware passthrough is only supported for NVIDIA (via CUDA).
// Intel Arc and AMD GPUs in WSL2 fall back to llvmpipe (CPU software rendering).
function isRunningInWSL() {
  if (osPlatform !== "linux") return false;
  try {
    const procVersion = fs.readFileSync("/proc/version", "utf8").toLowerCase();
    return procVersion.includes("microsoft") || procVersion.includes("wsl");
  } catch (_) {
    return false;
  }
}

function getVulkanUnavailableReason() {
  if (osPlatform === "win32" && !hasVulkanRuntime()) {
    return "The Vulkan runtime (vulkan-1.dll) is missing. Install or update your GPU vendor driver with Vulkan support, then run setup again so the Vulkan backend folder is repaired.";
  }
  if (osPlatform === "linux" && isRunningInWSL()) {
    const gpuName = getGpuInfo().name;
    const lowerGpu = gpuName.toLowerCase();
    if (lowerGpu.includes("intel") || lowerGpu.includes("arc")) {
      return `Vulkan GPU is not available in WSL2 for Intel ${gpuName}. WSL2's GPU paravirtualization only exposes a DirectX interface — Intel Arc Vulkan requires running natively on Windows.`;
    }
    return "Vulkan GPU is not available in WSL2. WSL2's GPU paravirtualization does not support hardware Vulkan for this GPU. Run natively on Windows or Linux for GPU acceleration.";
  }
  return "Installed, but this binary did not register a Vulkan backend on this machine.";
}

let cachedCoreMLPythonPath = null;
let cachedCoreMLAvailable = null;

function getCoreMLPythonPath() {
  if (cachedCoreMLAvailable !== null) {
    return cachedCoreMLPythonPath;
  }

  if (osPlatform !== "darwin") {
    cachedCoreMLAvailable = false;
    cachedCoreMLPythonPath = null;
    return null;
  }

  // 1. Check environment variable COREML_PYTHON
  if (process.env.COREML_PYTHON && fs.existsSync(process.env.COREML_PYTHON)) {
    cachedCoreMLPythonPath = process.env.COREML_PYTHON;
    cachedCoreMLAvailable = true;
    return cachedCoreMLPythonPath;
  }

  // 2. Check local/in-project venvs
  const localPaths = [
    path.join(ROOT, "app", "backend", "mac", "coreml_venv", "bin", "python"),
    path.join(ROOT, "app", "backend", "mac", "venv", "bin", "python"),
    path.join(ROOT, "venv", "bin", "python"),
  ];

  for (const p of localPaths) {
    if (fs.existsSync(p)) {
      cachedCoreMLPythonPath = p;
      cachedCoreMLAvailable = true;
      return p;
    }
  }

  // 3. Check dynamically in home directory (as fallback to user's setup)
  const homeDir = os.homedir();
  const homePaths = [
    path.join(homeDir, "workspace", "coreml_conversion", "venv", "bin", "python"),
    path.join(homeDir, "ml-stable-diffusion", "venv", "bin", "python"),
  ];

  for (const p of homePaths) {
    if (fs.existsSync(p)) {
      cachedCoreMLPythonPath = p;
      cachedCoreMLAvailable = true;
      return p;
    }
  }

  // 4. Fallback: Probe system python3 if it has required imports
  try {
    const probeResult = spawnSync("python3", [
      "-c",
      "import python_coreml_stable_diffusion, diffusers, transformers"
    ], { timeout: 2000 });
    
    if (probeResult.status === 0) {
      // Find absolute path of python3
      const whichResult = spawnSync("which", ["python3"], { encoding: "utf8" });
      const python3Path = whichResult.stdout ? whichResult.stdout.trim() : "python3";
      cachedCoreMLPythonPath = python3Path;
      cachedCoreMLAvailable = true;
      return python3Path;
    }
  } catch (err) {
    // python3 not in path or crashed
  }

  cachedCoreMLAvailable = false;
  cachedCoreMLPythonPath = null;
  return null;
}

function getCoreMLNpuInfo() {
  const isAppleSilicon = osPlatform === "darwin" && os.arch() === "arm64";
  if (!isAppleSilicon) {
    return { supported: false, reason: "Apple Silicon ANE (NPU) is only available on Apple Silicon macOS devices." };
  }

  const pythonPath = getCoreMLPythonPath();
  if (!pythonPath) {
    return {
      supported: true,
      ready: false,
      reason: "CoreML Python environment is not set up. Run scripts/setup/setup-coreml-npu.sh first.",
    };
  }

  return {
    supported: true,
    ready: true,
    python: pythonPath,
  };
}

function getBackendOptions() {
  if (cachedBackendOptions) return cachedBackendOptions;

  const cudaInstalled = (osPlatform === "win32" && fs.existsSync(BACKEND_PATHS.cuda)) ||
                        (osPlatform === "linux" && fs.existsSync(BACKEND_PATHS.linuxCuda));
  const cudaAvailable = cudaInstalled && hasNvidiaGpu() && backendAccepts(
    osPlatform === "win32" ? BACKEND_PATHS.cuda : BACKEND_PATHS.linuxCuda,
    "cuda"
  );
  const vulkanInstalled = (osPlatform === "win32" && fs.existsSync(BACKEND_PATHS.vulkan)) ||
                          (osPlatform === "linux" && fs.existsSync(BACKEND_PATHS.linuxVulkan));
  const vulkanRuntimeAvailable = osPlatform !== "win32" || hasVulkanRuntime();
  const vulkanAvailable = vulkanInstalled && vulkanRuntimeAvailable && backendAccepts(
    osPlatform === "win32" ? BACKEND_PATHS.vulkan : BACKEND_PATHS.linuxVulkan,
    "vulkan"
  );
  const rocmInstalled = osPlatform === "linux" && fs.existsSync(BACKEND_PATHS.linuxRocm);
  const rocmAvailable = rocmInstalled && hasAmdGpu() && backendAccepts(BACKEND_PATHS.linuxRocm, "rocm");
  const cpuInstalled = (osPlatform === "linux" && fs.existsSync(BACKEND_PATHS.linuxCpu)) ||
                        (osPlatform === "win32" && fs.existsSync(BACKEND_PATHS.cpu));
  const metalInstalled = osPlatform === "darwin" && fs.existsSync(BACKEND_PATHS.mac);
  const metalAvailable = metalInstalled;
  const coremlNpu = getCoreMLNpuInfo();
  const openvinoNpu = getOpenVinoNpuInfo();
  const openvinoModels = getOpenVinoModelInfo();
  const openvinoNpuAvailable = openvinoNpu.supported && openvinoModels.some((model) => model.installed);

  const options = [];
  if (cpuInstalled) options.push({ id: "cpu", label: "CPU", available: true });
  if (metalAvailable) options.push({ id: "metal", label: "Metal GPU", available: true });
  if (coremlNpu.supported && coremlNpu.ready) options.push({ id: "apple-npu", label: "Apple Neural Engine (NPU)", available: true });
  if (vulkanAvailable) options.push({ id: "vulkan", label: "Vulkan GPU", available: true });
  if (rocmAvailable) options.push({ id: "rocm", label: "ROCm GPU (AMD)", available: true });
  if (cudaAvailable) options.push({ id: "cuda", label: "CUDA GPU", available: true });
  if (openvinoNpuAvailable) options.push({ id: "openvino-npu", label: "NPU (OpenVINO)", available: true });

  const unavailable = [];
  if (vulkanInstalled && !vulkanAvailable) {
    unavailable.push({ id: "vulkan", label: "Vulkan GPU", reason: getVulkanUnavailableReason() });
  }
  if (cudaInstalled && !cudaAvailable) {
    unavailable.push({ id: "cuda", label: "CUDA GPU", reason: "Installed, but CUDA backend validation failed." });
  }
  if (rocmInstalled && !rocmAvailable) {
    unavailable.push({ id: "rocm", label: "ROCm GPU (AMD)", reason: "Installed, but ROCm backend validation failed." });
  }
  if (metalInstalled && !metalAvailable) {
    unavailable.push({ id: "metal", label: "Metal GPU", reason: "Installed, but Metal backend validation failed." });
  }
  if (coremlNpu.supported && !coremlNpu.ready) {
    unavailable.push({ id: "apple-npu", label: "Apple Neural Engine (NPU)", reason: coremlNpu.reason });
  }
  if (!cpuInstalled && (osPlatform === "win32" || osPlatform === "linux")) {
    unavailable.push({
      id: "cpu",
      label: "CPU",
      reason: osPlatform === "win32"
        ? "Windows CPU backend is not installed. Run scripts/setup/setup.ps1 to install app/backend/win/cpu."
        : "Linux CPU backend is not installed. Run setup again to install app/backend/linux/cpu.",
    });
  }
  if (openvinoNpu.supported && !openvinoNpuAvailable) {
    unavailable.push({ id: "openvino-npu", label: "NPU (OpenVINO)", reason: "Runtime is ready, but no OpenVINO NPU model is downloaded." });
  } else if (!openvinoNpu.supported && hasNpuHardware() && (osPlatform === "win32" || osPlatform === "linux")) {
    unavailable.push({ id: "openvino-npu", label: "NPU (OpenVINO)", reason: openvinoNpu.reason });
  }

  let defaultBackend = "cpu";
  if (coremlNpu.supported && coremlNpu.ready) {
    defaultBackend = "apple-npu";
  } else if (metalAvailable) {
    defaultBackend = "metal";
  } else if (cudaAvailable) {
    const gpuName = String(getGpuInfo().name).toLowerCase();
    const isGtxCard = gpuName.includes("gtx");
    if (isGtxCard && vulkanAvailable) {
      defaultBackend = "vulkan"; // Default to Vulkan for GTX cards because of lack of Tensor Cores
    } else {
      defaultBackend = "cuda";
    }
  } else if (rocmAvailable) {
    defaultBackend = "rocm";
  } else if (vulkanAvailable) {
    defaultBackend = "vulkan";
  }

  cachedBackendOptions = {
    options,
    unavailable,
    cudaAvailable,
    vulkanAvailable,
    rocmAvailable,
    metalAvailable,
    openvinoNpuAvailable,
    openvinoNpu,
    openvinoModels,
    coremlNpu,
    defaultBackendType: defaultBackend,
  };
  return cachedBackendOptions;
}

function backendAccepts(binaryPath, backendName) {
  if (!binaryPath || !fs.existsSync(binaryPath)) return false;
  try {
    const cliBackendName = backendName;
    let probeArgs = [
      "--backend", cliBackendName,
      "--params-backend", cliBackendName,
      "--model", path.join(MODELS, "__backend_probe_missing__.safetensors"),
      "--listen-port", "18082",
    ];
    if (cliBackendName === "metal") {
      probeArgs = [
        "--model", path.join(MODELS, "__backend_probe_missing__.safetensors"),
        "--listen-port", "18082",
      ];
    }
    const spawnEnv = { ...process.env };
    if (osPlatform === "linux") {
      const dir = path.dirname(binaryPath);
      const existing = spawnEnv.LD_LIBRARY_PATH || "";
      spawnEnv.LD_LIBRARY_PATH = dir + (existing ? ":" + existing : "");
    } else if (osPlatform === "darwin") {
      const dir = path.dirname(binaryPath);
      const existing = spawnEnv.DYLD_LIBRARY_PATH || "";
      spawnEnv.DYLD_LIBRARY_PATH = dir + (existing ? ":" + existing : "");
    }
    let result = spawnSync(binaryPath, probeArgs, { env: spawnEnv, encoding: "utf8", timeout: 5000 });
    let output = `${result.stdout || ""}\n${result.stderr || ""}`;

    let supportsFlags = true;
    // Some binaries do not support --backend. If we see "unknown argument",
    // retry without backend flags so we can still verify the binary launches.
    if (output.includes("unknown argument") && output.includes("--backend")) {
      supportsFlags = false;
      const fallbackArgs = [
        "--model", path.join(MODELS, "__backend_probe_missing__.safetensors"),
        "--listen-port", "18082",
      ];
      result = spawnSync(binaryPath, fallbackArgs, { env: spawnEnv, encoding: "utf8", timeout: 5000 });
      output = `${result.stdout || ""}\n${result.stderr || ""}`;
    }

    const lower = output.toLowerCase();
    if (lower.includes("backend config failed") || output.includes(`backend '${backendName}' was not found`) || output.includes(`backend '${cliBackendName}' was not found`)) {
      return false;
    }
    // Reject binaries that fail at the dynamic linker / glibc level.
    if (lower.includes("glibc") || lower.includes("libc.so") || lower.includes("libstdc++") || lower.includes("cannot open shared object")) {
      return false;
    }
    // A healthy binary prints project-specific log lines when it tries to load the model.
    const isOk = lower.includes("stable-diffusion.cpp") || lower.includes("loading model");
    if (isOk) {
      backendSupportsFlags[binaryPath] = supportsFlags;
    }
    return isOk;
  } catch (_) {
    return false;
  }
}

function selectBackendPath(useGpu, backendType = "auto", modelPath = "") {
  const resolvedType = resolveBackendType(useGpu, backendType, modelPath);
  if (osPlatform === "win32") {
    if (resolvedType === "cuda" && fs.existsSync(BACKEND_PATHS.cuda)) return BACKEND_PATHS.cuda;
    if (resolvedType === "cpu" && fs.existsSync(BACKEND_PATHS.cpu)) return BACKEND_PATHS.cpu;
    if (resolvedType === "vulkan" && fs.existsSync(BACKEND_PATHS.vulkan)) return BACKEND_PATHS.vulkan;
    if (fs.existsSync(BACKEND_PATHS.cuda)) return BACKEND_PATHS.cuda;
    if (fs.existsSync(BACKEND_PATHS.cpu)) return BACKEND_PATHS.cpu;
    if (fs.existsSync(BACKEND_PATHS.vulkan)) return BACKEND_PATHS.vulkan;
    return BACKEND_PATH;
  }
  if (osPlatform === "linux") {
    let finalType = resolvedType;
    if (finalType === "cuda") {
      if (fs.existsSync(BACKEND_PATHS.linuxCuda)) {
        return BACKEND_PATHS.linuxCuda;
      }
      finalType = "vulkan";
    }
    if (finalType === "rocm" && fs.existsSync(BACKEND_PATHS.linuxRocm)) return BACKEND_PATHS.linuxRocm;
    if (resolvedType === "vulkan" && fs.existsSync(BACKEND_PATHS.linuxVulkan)) return BACKEND_PATHS.linuxVulkan;
    if (resolvedType === "cpu" && fs.existsSync(BACKEND_PATHS.linuxCpu)) return BACKEND_PATHS.linuxCpu;
    if (fs.existsSync(BACKEND_PATHS.linuxVulkan)) return BACKEND_PATHS.linuxVulkan;
    if (fs.existsSync(BACKEND_PATHS.linuxCpu)) return BACKEND_PATHS.linuxCpu;
    return BACKEND_PATH;
  }
  if (osPlatform === "darwin") {
    if (resolvedType === "apple-npu") return getCoreMLPythonPath();
    if (fs.existsSync(BACKEND_PATHS.mac)) return BACKEND_PATHS.mac;
    return BACKEND_PATH;
  }
  // generic fallback
  if (fs.existsSync(BACKEND_PATHS.mac)) return BACKEND_PATHS.mac;
  return BACKEND_PATH;
}

function resolveBackendType(useGpu, backendType = "auto", modelPath = "") {
  const options = getBackendOptions();
  let requestedType = useGpu === false ? "cpu" : backendType === "auto" ? options.defaultBackendType : backendType;

  if (modelPath && osPlatform === "darwin") {
    const lower = modelPath.toLowerCase();
    const isDir = fs.existsSync(modelPath) && fs.statSync(modelPath).isDirectory();
    if (lower.endsWith(".safetensors") || lower.endsWith(".gguf")) {
      if (requestedType === "apple-npu") requestedType = "metal";
    } else if (lower.endsWith(".coreml") || lower.endsWith(".mlpackage") || lower.endsWith(".mlmodelc") || isDir) {
      if (requestedType === "metal") requestedType = "apple-npu";
    }
  }

  const available = new Set(options.options.map(option => option.id));
  return available.has(requestedType) ? requestedType : options.defaultBackendType;
}

function getBackendMode(backendPath, useGpu, backendType = "auto") {
  if (useGpu === false || backendType === "cpu") return "CPU";
  const name = path.basename(backendPath || "").toLowerCase();
  if (name.includes("cuda")) return "CUDA GPU";
  if (name.includes("rocm")) return "ROCm GPU";
  if (name.includes("vulkan")) return "Vulkan GPU";
  if (backendType === "apple-npu") return "Apple NPU";
  if (osPlatform === "darwin" || backendType === "metal") return "Metal GPU";
  return "GPU";
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\[[A-Z]/g, "");
}

function markBackendReady() {
  if (backendReady) return;
  backendReady = true;
  backendLoadState = {
    ...backendLoadState,
    active: false,
    phase: "Model ready",
    progress: 100,
  };
  console.log("  [backend] READY on port", PORT_BACKEND);

  // Force a single VRAM poll after the model settles in memory
  setTimeout(() => pollNvidiaVram(true), 1500);
}

function pingBackendReady() {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${PORT_BACKEND}/v1/models`, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function requestJson(url, payload = null, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = payload ? Buffer.from(JSON.stringify(payload), "utf8") : null;
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: data ? "POST" : "GET",
      headers: data ? {
        "Content-Type": "application/json",
        "Content-Length": data.length,
      } : {},
      timeout: timeoutMs,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const jsonBody = JSON.parse(body || "{}");
          if (res.statusCode < 200 || res.statusCode >= 300 || jsonBody.ok === false) {
            reject(new Error(jsonBody.error || `HTTP ${res.statusCode}`));
            return;
          }
          resolve(jsonBody);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    if (data) req.write(data);
    req.end();
  });
}

function proxyImageBackendRequest(req, res) {
  const headers = { ...req.headers };
  delete headers.host;
  headers.host = `127.0.0.1:${PORT_BACKEND}`;

  const proxyReq = http.request({
    hostname: "127.0.0.1",
    port: PORT_BACKEND,
    path: req.url,
    method: req.method,
    headers,
    timeout: 300000,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, {
      ...proxyRes.headers,
      "Access-Control-Allow-Origin": "*",
    });
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    json(res, 502, { ok: false, error: `Image backend is not reachable: ${err.message}` });
  });
  proxyReq.on("timeout", () => {
    proxyReq.destroy(new Error("Image backend request timed out"));
  });

  req.pipe(proxyReq);
}

function requestHttpsJson(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Uncensored-AI-Studio/1.0",
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body || "null");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(parsed?.error || `Hugging Face returned HTTP ${res.statusCode}`));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Hugging Face returned invalid JSON: ${err.message}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Hugging Face request timed out")));
  });
}

function getModelParameterBillions(value) {
  const text = String(value || "");
  const matches = [...text.matchAll(/(?:^|[-_/ ])(\d+(?:\.\d+)?)\s*b(?:[-_/ ]|$)/gi)];
  if (matches.length === 0) return null;
  return Math.min(...matches.map((match) => Number(match[1])).filter(Number.isFinite));
}

function selectGgufFile(siblings = [], tier = "low") {
  const files = siblings
    .map((item) => typeof item === "string" ? item : item?.rfilename)
    .filter((name) => name && /\.gguf$/i.test(name))
    .filter((name) => !/(?:^|\/)(?:mmproj|mtp)(?:[-_/]|$)|-\d{5}-of-\d{5}\.gguf$/i.test(name));
  const preferences = tier === "high"
    ? [/q6_k\.gguf$/i, /q5_k_m\.gguf$/i, /q4_k_m\.gguf$/i, /q8_0\.gguf$/i]
    : [/q4_k_m\.gguf$/i, /q4_k_s\.gguf$/i, /q4_0\.gguf$/i, /q3_k_m\.gguf$/i, /iq4_xs\.gguf$/i];
  for (const pattern of preferences) {
    const match = files.find((name) => pattern.test(name));
    if (match) return match;
  }
  return files[0] || "";
}

function selectMmprojFile(siblings = [], modelFilename = "") {
  const files = siblings
    .map((item) => typeof item === "string" ? item : item?.rfilename)
    .filter((name) => name && /\.gguf$/i.test(name))
    .filter((name) => /(?:^|[-_/])mmproj(?:[-_.\/]|$)|mmproj/i.test(name));
  if (files.length === 0) return "";

  const modelBase = path.basename(modelFilename).toLowerCase();
  const modelStem = modelBase.replace(/\.gguf$/i, "").replace(/\.(q\d(?:_k_[ms])?|iq\d_[a-z0-9]+|bf16|f16|f32)$/i, "");
  const scored = files.map((name) => {
    const lower = name.toLowerCase();
    let score = 0;
    if (/bf16/i.test(lower)) score += 6;
    if (/f16/i.test(lower)) score += 5;
    if (/mmproj-model-f16/i.test(lower)) score += 4;
    if (modelStem && lower.includes(modelStem)) score += 10;
    return { name, score };
  });
  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return scored[0]?.name || "";
}

function parseHuggingFaceResolveUrl(fileUrl) {
  try {
    const parsed = new URL(fileUrl);
    if (!/^(?:www\.)?huggingface\.co$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    const resolveIndex = parts.findIndex((part) => part === "resolve" || part === "blob");
    if (resolveIndex < 2 || resolveIndex + 2 >= parts.length) return null;
    const repoId = `${decodeURIComponent(parts[0])}/${decodeURIComponent(parts[1])}`;
    const revision = decodeURIComponent(parts[resolveIndex + 1] || "main");
    const repositoryFilename = parts.slice(resolveIndex + 2).map(decodeURIComponent).join("/");
    return { repoId, revision, repositoryFilename };
  } catch (_) {
    return null;
  }
}

async function resolveHuggingFaceProjector(fileUrl, localModelFilename = "") {
  const parsed = parseHuggingFaceResolveUrl(fileUrl);
  if (!parsed) return null;

  const cacheKey = `${parsed.repoId}|${parsed.revision}|${parsed.repositoryFilename}`;
  const cached = hfProjectorCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < HF_MODEL_CACHE_TTL_MS) return cached.projector;

  try {
    const treeUrl = `https://huggingface.co/api/models/${parsed.repoId}/tree/${encodeURIComponent(parsed.revision)}?recursive=true`;
    const tree = await requestHttpsJson(treeUrl);
    const projectorRepositoryFilename = selectMmprojFile(tree, parsed.repositoryFilename || localModelFilename);
    const projector = projectorRepositoryFilename
      ? {
          url: `https://huggingface.co/${parsed.repoId}/resolve/${encodeURIComponent(parsed.revision)}/${projectorRepositoryFilename.split("/").map(encodeURIComponent).join("/")}`,
          filename: `${parsed.repoId.replace(/\//g, "--")}--${path.basename(projectorRepositoryFilename)}`,
          repositoryFilename: projectorRepositoryFilename,
        }
      : null;
    hfProjectorCache.set(cacheKey, { createdAt: Date.now(), projector });
    return projector;
  } catch (err) {
    console.warn(`  [download] Could not resolve vision projector for ${parsed.repoId}: ${err.message || err}`);
    hfProjectorCache.set(cacheKey, { createdAt: Date.now(), projector: null });
    return null;
  }
}

function classifyHuggingFaceModel(model, filename) {
  const searchable = `${model.id || ""} ${filename || ""} ${(model.tags || []).join(" ")}`.toLowerCase();
  const parameters = getModelParameterBillions(searchable);
  return {
    potato: parameters !== null && parameters <= 3,
    vision: /(?:vision|llava|multimodal|(?:^|[-_/ ])vl(?:[-_/ ]|$)|moondream)/i.test(searchable),
    uncensored: /uncensored|abliterated|heretic/i.test(searchable),
    parameters,
  };
}

function getTextModelFit(sizeBytes, specs = getHardwareSpecs()) {
  if (!sizeBytes) {
    return { recommended: false, mode: "unknown", label: "", reason: "File size is unavailable, so compatibility cannot be estimated." };
  }

  const ramBytes = Math.max(0, Number(specs.ram_total_gb) || 0) * (1024 ** 3);
  const vramBytes = Math.max(0, Number(specs.gpu_vram_gb) || 0) * (1024 ** 3);
  const isAppleSilicon = osPlatform === "darwin" && /apple/i.test(String(specs.cpu_name || ""));
  const systemReserve = Math.max(4 * (1024 ** 3), ramBytes * 0.3);
  const usableRam = Math.max(0, ramBytes - systemReserve);
  const runtimeNeed = (sizeBytes * 1.25) + (1.5 * (1024 ** 3));
  const fastGpuFit = vramBytes >= runtimeNeed;
  const cpuOrOffloadFit = usableRam >= runtimeNeed;
  const unifiedMemoryFit = isAppleSilicon && usableRam >= runtimeNeed;
  const hybridFit = !fastGpuFit && vramBytes > 0 && cpuOrOffloadFit;
  const recommended = fastGpuFit || cpuOrOffloadFit || unifiedMemoryFit;

  if (recommended) {
    const mode = fastGpuFit
      ? "GPU memory"
      : isAppleSilicon
        ? "unified memory"
        : hybridFit
          ? "combined GPU and system memory"
          : "system RAM";
    return {
      recommended: true,
      mode: fastGpuFit ? "gpu" : isAppleSilicon ? "unified" : hybridFit ? "hybrid" : "ram",
      label: fastGpuFit ? "GPU Fit" : isAppleSilicon ? "Fits Unified Memory" : hybridFit ? "GPU + RAM Fit" : "Fits in RAM",
      reason: `${formatBytes(sizeBytes)} weights fit the estimated ${mode} budget with runtime headroom.`,
    };
  }

  return {
    recommended: false,
    mode: "too-large",
    label: "",
    reason: `${formatBytes(sizeBytes)} weights need about ${formatBytes(runtimeNeed)} including runtime headroom; this computer has about ${formatBytes(usableRam)} usable RAM and ${formatBytes(vramBytes)} VRAM.`,
  };
}

async function addHuggingFaceFileSize(model) {
  try {
    const detail = await requestHttpsJson(`https://huggingface.co/api/models/${model.id}?blobs=true`);
    const file = (detail.siblings || []).find((item) => item?.rfilename === model.repositoryFilename);
    const sizeBytes = Number(file?.size || file?.lfs?.size || 0);
    const fit = getTextModelFit(sizeBytes);
    return {
      ...model,
      sizeBytes,
      size: sizeBytes > 0 ? formatBytes(sizeBytes) : "Unknown",
      approxSize: sizeBytes > 0 ? formatBytes(sizeBytes) : model.approxSize,
      recommendedFit: fit.recommended,
      fitMode: fit.mode,
      fitLabel: fit.label,
      fitReason: fit.reason,
    };
  } catch (_) {
    return {
      ...model,
      sizeBytes: 0,
      size: "Unknown",
      recommendedFit: false,
      fitMode: "unknown",
      fitLabel: "",
      fitReason: "File size is unavailable, so compatibility cannot be estimated.",
    };
  }
}

async function searchHuggingFaceModels(query, filters) {
  const specs = getHardwareSpecs();
  const tier = specs.gpu_vram_gb >= 10 || specs.ram_total_gb >= 32
    ? "high"
    : specs.gpu_vram_gb >= 5 || specs.ram_total_gb >= 16 ? "mid" : "low";
  const defaultSearch = tier === "low" ? "1B instruct" : tier === "mid" ? "7B instruct" : "8B instruct";
  let searchTerms = "";
  if (query.trim()) {
    searchTerms = [
      query.trim(),
      filters.includes("vision") ? "vision" : "",
      filters.includes("uncensored") ? "uncensored" : "",
    ].filter(Boolean).join(" ");
  } else {
    if (filters.includes("vision") && filters.includes("uncensored")) {
      searchTerms = "vision uncensored gguf";
    } else if (filters.includes("vision")) {
      searchTerms = "vision gguf";
    } else if (filters.includes("uncensored")) {
      searchTerms = "uncensored gguf";
    } else {
      searchTerms = defaultSearch;
    }
  }
  const cacheKey = `${tier}|${searchTerms}|${filters.sort().join(",")}`;
  const cached = hfModelCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < HF_MODEL_CACHE_TTL_MS) return cached.models;

  const params = new URLSearchParams({
    filter: "gguf",
    search: searchTerms,
    sort: "downloads",
    direction: "-1",
    limit: "50",
    full: "true",
  });
  const results = await requestHttpsJson(`https://huggingface.co/api/models?${params.toString()}`);
  const models = [];

  for (const model of Array.isArray(results) ? results : []) {
    if (model.private || model.gated || model.disabled) continue;
    const filename = selectGgufFile(model.siblings, tier);
    if (!filename) continue;
    const projectorFilename = selectMmprojFile(model.siblings, filename);
    const traits = classifyHuggingFaceModel(model, filename);
    if (filters.includes("vision") && !traits.vision) continue;
    if (filters.includes("uncensored") && !traits.uncensored) continue;

    const isLikelyChatModel = /instruct|chat|assistant|coder|uncensored|abliterated|vision|llava|\bvl\b/i.test(`${model.id} ${filename}`);
    if (!query.trim() && !isLikelyChatModel) continue;
    const normalizedQuery = query.trim().toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ");
    const normalizedModelName = `${model.id} ${filename}`.toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ");
    const queryWords = normalizedQuery.split(" ").filter(Boolean);
    const exactPhraseMatch = normalizedQuery && normalizedModelName.includes(normalizedQuery);
    const matchedQueryWords = queryWords.filter((word) => normalizedModelName.includes(word)).length;
    const score = Number(model.downloads || 0)
      + (traits.parameters && traits.parameters <= 3 && tier === "low" ? 10000000 : 0)
      + (traits.parameters && tier === "mid" && traits.parameters >= 4 && traits.parameters <= 9 ? 10000000 : 0)
      + (traits.parameters && tier === "high" && traits.parameters >= 7 && traits.parameters <= 14 ? 10000000 : 0)
      + (exactPhraseMatch ? 100000000 : 0)
      + (matchedQueryWords * 5000000);
    models.push({
      id: model.id,
      name: String(model.id || "").split("/").pop().replace(/[-_]+/g, " "),
      filename: `${model.id.replace(/\//g, "--")}--${path.basename(filename)}`,
      repositoryFilename: filename,
      format: "GGUF",
      approxSize: traits.parameters ? `~${traits.parameters}B parameters` : "Size shown before download",
      resolution: "N/A",
      notes: `Community GGUF from ${String(model.id || "").split("/")[0]}. ${Number(model.downloads || 0).toLocaleString()} Hugging Face downloads.`,
      url: `https://huggingface.co/${model.id}/resolve/main/${filename.split("/").map(encodeURIComponent).join("/")}`,
      projectorUrl: projectorFilename ? `https://huggingface.co/${model.id}/resolve/main/${projectorFilename.split("/").map(encodeURIComponent).join("/")}` : "",
      projectorFilename: projectorFilename ? `${model.id.replace(/\//g, "--")}--${path.basename(projectorFilename)}` : "",
      pageUrl: `https://huggingface.co/${model.id}`,
      downloads: Number(model.downloads || 0),
      likes: Number(model.likes || 0),
      tags: Object.entries(traits).filter(([key, value]) => key !== "parameters" && value).map(([key]) => key),
      score,
    });
  }

  const ranked = models.sort((a, b) => b.score - a.score);
  hfModelCache.set(cacheKey, { createdAt: Date.now(), models: ranked });
  return ranked;
}

async function killOpenVinoWorker() {
  if (!openvinoProc) {
    openvinoReady = false;
    return;
  }
  console.log("  [openvino-npu] Stopping worker...");
  try { openvinoProc.kill("SIGTERM"); } catch (_) {}
  await new Promise((resolve) => setTimeout(resolve, 800));
  try { openvinoProc.kill("SIGKILL"); } catch (_) {}
  openvinoProc = null;
  openvinoReady = false;
}

function getOpenVinoResolution(settings = {}) {
  const width = Number(settings.width) || 512;
  const height = Number(settings.height) || 512;
  const supported = (width === 512 && height === 512) || (width === 1024 && height === 1024);
  if (!supported) {
    throw new Error("OpenVINO NPU supports 512x512 generation or 1024x1024 HD upscale.");
  }
  return { width, height };
}

async function startOpenVinoWorker(settings = {}) {
  const npuInfo = getOpenVinoNpuInfo();
  if (!npuInfo.supported) throw new Error(npuInfo.reason || "OpenVINO NPU is not available.");
  const requestedModel = settings.model ? findOpenVinoModel(settings.model) : null;
  if (settings.model && !requestedModel) {
    throw new Error("OpenVINO NPU requires a downloaded OpenVINO model. Standard .safetensors/.ckpt weights must use Vulkan, CUDA, or CPU.");
  }
  const model = requestedModel || getOpenVinoModelInfo().find((item) => item.installed);
  if (!model || !model.installed) {
    throw new Error("OpenVINO NPU model is not downloaded. Download an OpenVINO NPU model from Model Manager first.");
  }
  const { width, height } = getOpenVinoResolution(settings);
  if (openvinoProc &&
      openvinoReady &&
      openvinoModel === model.id) {
    currentSettings = { ...currentSettings, ...settings, model: model.id, width, height };
    return;
  }

  await killBackend();
  await killOpenVinoWorker();
  openvinoError = null;
  openvinoReady = false;
  openvinoModel = model.id;
  openvinoWidth = 512;
  openvinoHeight = 512;
  openvinoPort = await findAvailableBackendPort();
  PORT_BACKEND = openvinoPort;

  currentSettings = { ...currentSettings, ...settings };
  currentSettings.backendType = "openvino-npu";
  currentSettings.useGpu = true;
  currentSettings.backendMode = "NPU (OpenVINO)";
  currentSettings.backendBinary = "openvino_npu_worker.py";
  currentSettings.backendDevice = npuInfo.npu?.name || "Intel AI Boost";
  currentSettings.model = model.id;
  currentSettings.width = width;
  currentSettings.height = height;

  backendError = null;
  backendLoadState = {
    active: true,
    phase: "Compiling OpenVINO NPU pipeline (512x512)...",
    progress: 5,
    current: 0,
    total: 0,
    speed: "",
    model: model.name,
    backendMode: "NPU (OpenVINO)",
    backendBinary: "openvino_npu_worker.py",
    device: currentSettings.backendDevice,
  };

  const workerPath = path.join(ROOT, "scripts", "workers", "openvino_npu_worker.py");
  const cacheDir = path.join(ROOT, "app", "tools", "openvino-cache", "512x512");
  console.log(`  [openvino-npu] Starting 512x512 worker on port ${openvinoPort}`);
  openvinoProc = spawn(npuInfo.python, [
    workerPath,
    "--model-dir", model.path,
    "--port", String(openvinoPort),
    "--width", "512",
    "--height", "512",
    "--cache-dir", cacheDir,
  ], { stdio: "pipe" });

  let openvinoStdoutBuffer = "";
  openvinoProc.stdout.on("data", (data) => {
    const text = data.toString();
    process.stdout.write("  " + text);
    openvinoStdoutBuffer += text;
    const lines = openvinoStdoutBuffer.split(/\r?\n/);
    openvinoStdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (line.includes("READY")) {
        openvinoReady = true;
        backendReady = true;
        backendLoadState = { ...backendLoadState, active: false, phase: "OpenVINO NPU model ready", progress: 100 };
      }
      const progressMatch = line.match(/PROGRESS\s+(\d+)\/(\d+)\s+(.+)$/);
      if (progressMatch) {
        generationState.active = true;
        generationState.step = Number(progressMatch[1]);
        generationState.steps = Number(progressMatch[2]);
        generationState.speed = progressMatch[3].trim();
        generationState.decoding = false;
      } else if (line.includes("DECODING") && generationState.active) {
        generationState.step = generationState.steps;
        generationState.decoding = true;
        generationState.speed = "";
      }
    }
  });
  openvinoProc.stderr.on("data", (data) => {
    const text = data.toString();
    process.stderr.write("  " + text);
    const cleanText = stripAnsi(text).trim();
    if (cleanText && (cleanText.includes("ERROR") || cleanText.includes("Traceback") || cleanText.includes("Exception"))) {
      openvinoError = cleanText;
      backendError = openvinoError;
    }
  });
  openvinoProc.on("exit", (code) => {
    console.log("  [openvino-npu] worker exited with code", code);
    openvinoProc = null;
    openvinoReady = false;
    backendReady = false;
    if (code !== 0 && code !== null && !backendError) backendError = `OpenVINO NPU worker exited with code ${code}`;
    backendLoadState.active = false;
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 360000) {
    if (openvinoReady) return;
    if (backendError) throw new Error(backendError);
    if (!openvinoProc) throw new Error("OpenVINO NPU worker exited during startup.");
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    backendLoadState.progress = Math.min(95, 5 + Math.round(elapsed / 2));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await killOpenVinoWorker();
  throw new Error("OpenVINO NPU 512x512 compile timed out after 6 minutes.");
}

async function generateWithOpenVino(body) {
  if (!openvinoReady || !openvinoPort) throw new Error("OpenVINO NPU worker is not ready. Load an OpenVINO NPU model first.");
  const steps = Math.max(1, Math.min(8, Number(body.steps) || 4));
  generationState = { active: true, step: 0, steps, speed: "", decoding: false };
  try {
    const result = await requestJson(`http://127.0.0.1:${openvinoPort}/generate`, {
      prompt: body.prompt,
      negative_prompt: body.negative_prompt || "",
      width: Number(body.width) || currentSettings.width || 512,
      height: Number(body.height) || currentSettings.height || 512,
      steps,
      cfg_scale: Number(body.cfg_scale) || 1.0,
      seed: body.seed,
    }, 300000);
    resetGenerationState();
    return result;
  } catch (err) {
    resetGenerationState();
    throw err;
  }
}

function startBackendReadyPoll() {
  let attempts = 0;
  const isNpu = currentSettings.backendType === "apple-npu" || currentSettings.backendType === "openvino-npu";
  const maxAttempts = isNpu ? 1200 : 240;
  const interval = setInterval(async () => {
    attempts += 1;
    if (!backendProc || backendReady || attempts > maxAttempts) {
      clearInterval(interval);
      return;
    }
    if (await pingBackendReady()) {
      markBackendReady();
      clearInterval(interval);
    }
  }, 500);
}

function startCoreMLLoadHeartbeat(proc) {
  if (currentSettings.backendType !== "apple-npu") return null;
  const startedAt = Date.now();
  const interval = setInterval(() => {
    if (backendProc !== proc || backendReady || !backendLoadState.active) {
      clearInterval(interval);
      return;
    }
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const targetProgress = Math.min(96, Math.round(8 + 88 * (1 - Math.exp(-elapsedSec / 55))));
    if (targetProgress > (backendLoadState.progress || 0)) {
      backendLoadState = {
        ...backendLoadState,
        active: true,
        phase: backendLoadState.phase || "Loading Core ML model...",
        progress: targetProgress,
      };
    }
  }, 1000);
  return interval;
}

function getDefaultModel() {
  try {
    const files = fs.readdirSync(MODELS).filter(isModelFile);
    return files.length ? path.join(MODELS, files[0]) : null;
  } catch (_) { return null; }
}

function killBackend() {
  return new Promise(resolve => {
    resetGenerationState();
    const proc = backendProc;
    if (!proc) {
      backendUnloadState = { active: false, phase: "", progress: 0 };
      resolve();
      return;
    }
    backendUnloadState = { active: true, phase: "Stopping backend process...", progress: 10 };
    backendReady = false;
    try { proc.kill("SIGTERM"); } catch (_) {}
    backendUnloadState = { active: true, phase: "Waiting for process exit...", progress: 50 };
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch (_) {}
      if (backendProc === proc) backendProc = null;
      backendUnloadState = { active: false, phase: "Backend unloaded", progress: 100 };
      resolve();
    }, 2000);
  });
}

function chooseAutoContext(modelFilename, isGpu) {
  let modelSizeGb = 4;
  try {
    const modelPath = path.join(LLM_MODELS, modelFilename);
    if (fs.existsSync(modelPath)) {
      const stats = fs.statSync(modelPath);
      modelSizeGb = stats.size / (1024 * 1024 * 1024);
    }
  } catch (_) {}

  const lowerFilename = String(modelFilename || "").toLowerCase();
  const isVisionModel = isVisionModelFilename(lowerFilename);
  let projectorSizeGb = 0;
  if (isVisionModel) {
    try {
      const files = fs.readdirSync(LLM_MODELS);
      const projector = files.find((file) => {
        const lower = file.toLowerCase();
        return lower.endsWith(".gguf") && lower.includes("mmproj");
      });
      if (projector) {
        projectorSizeGb = fs.statSync(path.join(LLM_MODELS, projector)).size / (1024 * 1024 * 1024);
      }
    } catch (_) {}
  }

  const systemRamGb = os.totalmem() / (1024 * 1024 * 1024);
  let vramGb = 0;
  try {
    const gpu = getGpuInfo();
    if (gpu && gpu.vram_gb) {
      vramGb = gpu.vram_gb;
    }
  } catch (_) {}

  let availableGb = 0;
  let bufferGb = 2.0;

  if (isGpu && vramGb > 0) {
    availableGb = vramGb;
    bufferGb = 1.5;
  } else {
    availableGb = systemRamGb;
    bufferGb = 2.5;
  }

  if (isGpu && vramGb > 0) {
    const gpuBudgetGb = Math.max(0.5, vramGb - modelSizeGb - projectorSizeGb - bufferGb);
    const maxFastContext = vramGb < 10 ? 8192 : vramGb < 16 ? 16384 : 20000;
    if (isVisionModel) {
      return Math.min(maxFastContext, gpuBudgetGb >= 2.5 ? 8192 : 4096);
    }
    if (gpuBudgetGb < 1.5) return 4096;
    if (gpuBudgetGb < 3.0) return Math.min(maxFastContext, 8192);
    return Math.min(maxFastContext, 16384);
  }

  const usableGb = Math.max(0.5, availableGb - modelSizeGb - projectorSizeGb - bufferGb);

  let kvPer4096Gb = 0.55;
  if (modelSizeGb >= 5.5) {
    kvPer4096Gb = 1.05;
  } else if (modelSizeGb >= 4.0) {
    kvPer4096Gb = 0.85;
  }

  const estimatedMaxCtx = (usableGb / kvPer4096Gb) * 4096;
  const contextLadder = [20000, 16384, 12288, 8192, 4096, 2048];
  
  for (const limit of contextLadder) {
    if (limit <= estimatedMaxCtx) {
      return limit;
    }
  }
  return 2048;
}

function isVisionModelFilename(filename = "") {
  const lower = String(filename || "").toLowerCase();
  return lower.includes("llava") ||
    lower.includes("vision") ||
    lower.includes("qwen2vl") ||
    lower.includes("qwen2-vl") ||
    lower.includes("qwen3.5-4b-vision") ||
    lower.includes("gemma-4") ||
    lower.includes("gemma4") ||
    lower.includes("-e2b-") ||
    lower.includes("e2b-it") ||
    lower.includes("paligemma") ||
    lower.includes("minicpm-v") ||
    lower.includes("internvl") ||
    lower.includes("phi-3-vision") ||
    lower.includes("phi3-vision") ||
    lower.includes("smolvlm") ||
    lower.includes("moondream") ||
    lower === "ggml-model-q4_k.gguf";
}

function buildLlmLoadProfiles(settings = {}, backend = {}) {
  const requestedContext = Number(settings.contextSize);
  const safeContext = requestedContext && requestedContext > 0
    ? Math.max(512, Math.min(20000, requestedContext))
    : 4096;
  const isCpu = backend.key === "cpu" || backend.mode === "CPU";
  const profiles = [
    { name: "requested", gpuLayers: isCpu ? 0 : undefined },
    {
      name: "safe",
      contextSize: safeContext,
      gpuLayers: isCpu ? 0 : 0,
      flashAttn: false,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      batchSize: 256,
      ubatchSize: 256,
      enableThinking: false,
    },
  ];
  return profiles;
}

async function startLlm(settings = {}) {
  const filename = path.basename(String(settings.model || ""));
  const modelPath = path.join(LLM_MODELS, filename);
  if (!filename || !pathInside(modelPath, LLM_MODELS) || !fs.existsSync(modelPath)) {
    throw new Error("Select a downloaded GGUF text model first.");
  }
  if (!filename.toLowerCase().endsWith(".gguf")) {
    throw new Error("Text generation requires a .gguf model.");
  }

  const candidates = getLlmBackendCandidates();
  if (candidates.length === 0) {
    throw new Error("llama.cpp is not installed. Run the platform setup script to install the text backend.");
  }
  const persistedSettings = getLlmModelSettings(filename);
  const preferredBackend = String(settings.preferredBackend || persistedSettings.preferredBackend || "").toLowerCase();
  const sortedCandidates = preferredBackend
    ? [...candidates].sort((a, b) => {
        if (a.key === preferredBackend && b.key !== preferredBackend) return -1;
        if (b.key === preferredBackend && a.key !== preferredBackend) return 1;
        return 0;
      })
    : candidates;

  const failures = [];
  for (const backend of sortedCandidates) {
    for (const profile of buildLlmLoadProfiles(settings, backend)) {
      try {
        await startLlmWithBackend({ ...settings, __loadProfile: profile }, backend);
        llmSettings.backendFallbacks = failures;
        updateLlmModelSettings(filename, {
          preferredBackend: backend.key,
          lastBackendMode: llmSettings.backendMode,
          lastBackendBinary: llmSettings.backendBinary,
          lastSettings: {
            threads: llmSettings.threads,
            contextSize: llmSettings.contextSize,
            gpuLayers: llmSettings.gpuLayers,
            cacheTypeK: llmSettings.cacheTypeK,
            cacheTypeV: llmSettings.cacheTypeV,
            batchSize: llmSettings.batchSize,
            ubatchSize: llmSettings.ubatchSize,
            flashAttn: llmSettings.flashAttn,
          },
        });
        return;
      } catch (err) {
        const message = err.message || String(err);
        failures.push({
          backend: backend.mode,
          binary: path.basename(backend.path),
          profile: profile.name,
          error: message.slice(-500),
        });
        console.warn(`  [llm] Load failed on ${backend.mode} (${profile.name}): ${message}`);
        await killLlm();
      }
    }
  }

  const last = failures[failures.length - 1];
  llmSettings.backendFallbacks = failures;
  throw new Error(`Text model failed on all available llama.cpp backends. Last failure: ${last?.error || "unknown error"}`);
}

async function startLlmWithBackend(settings = {}, backend) {
  const filename = path.basename(String(settings.model || ""));
  const modelPath = path.join(LLM_MODELS, filename);
  if (!filename || !pathInside(modelPath, LLM_MODELS) || !fs.existsSync(modelPath)) {
    throw new Error("Select a downloaded GGUF text model first.");
  }
  if (!filename.toLowerCase().endsWith(".gguf")) {
    throw new Error("Text generation requires a .gguf model.");
  }

  if (!backend) {
    throw new Error("llama.cpp is not installed. Run the platform setup script to install the text backend.");
  }

  assertNoOtherActiveRuntime("text", filename);
  await killBackend();
  await killOpenVinoWorker();
  await killLlm();
  PORT_LLM = await findAvailableLlmPort();
  llmError = null;

  const loadProfile = settings.__loadProfile || {};
  let contextSize = Number(loadProfile.contextSize ?? settings.contextSize);
  if (!contextSize || contextSize <= 0) {
    const isGpu = backend.mode.includes("GPU") || backend.mode.includes("CUDA") || backend.mode.includes("Vulkan") || backend.mode.includes("Metal") || backend.mode.startsWith("Auto");
    contextSize = chooseAutoContext(filename, isGpu);
    console.log(`  [llm] Auto-selected context size: ${contextSize} tokens based on memory limits.`);
  } else {
    contextSize = Math.max(512, Math.min(20000, contextSize));
  }

  const isSyclBackend = backend.mode.includes("SYCL") || path.basename(path.dirname(backend.path)).toLowerCase() === "sycl";
  const requestedGpuLayers = Number.isFinite(Number(loadProfile.gpuLayers ?? settings.gpuLayers)) ? Number(loadProfile.gpuLayers ?? settings.gpuLayers) : -1;
  const effectiveGpuLayers = isSyclBackend ? getStableSyclGpuLayers(filename, requestedGpuLayers) : requestedGpuLayers;
  const effectiveFlashAttn = isSyclBackend ? false : (loadProfile.flashAttn ?? (settings.flashAttn !== false));
  const effectiveCacheTypeK = isSyclBackend ? "q4_0" : loadProfile.cacheTypeK || settings.cacheTypeK || llmSettings.cacheTypeK || "q8_0";
  const effectiveCacheTypeV = isSyclBackend ? "q4_0" : loadProfile.cacheTypeV || settings.cacheTypeV || llmSettings.cacheTypeV || "q8_0";
  const effectiveBatchSize = isSyclBackend ? Math.min(256, Number(loadProfile.batchSize ?? settings.batchSize) || llmSettings.batchSize || 512) : Number(loadProfile.batchSize ?? settings.batchSize) || llmSettings.batchSize || 512;
  const effectiveUbatchSize = isSyclBackend ? Math.min(256, Number(loadProfile.ubatchSize ?? settings.ubatchSize) || llmSettings.ubatchSize || 512) : Number(loadProfile.ubatchSize ?? settings.ubatchSize) || llmSettings.ubatchSize || 512;
  const effectiveEnableThinking = isSyclBackend && effectiveGpuLayers === 0 ? false : (loadProfile.enableThinking ?? (settings.enableThinking === true));

  llmSettings = {
    ...llmSettings,
    model: filename,
    threads: Math.max(1, Math.min(64, Number(settings.threads) || llmSettings.threads)),
    contextSize: contextSize,
    gpuLayers: effectiveGpuLayers,
    requestedGpuLayers,
    backendMode: backend.mode,
    backendBinary: path.basename(backend.path),
    loadProfile: loadProfile.name || "requested",
    enableThinking: effectiveEnableThinking,
    supportsThinking: /deepseek|qwen3|gemma-4|gemma4|think|r1|e2b|reasoning/i.test(filename),
    // New performance settings
    flashAttn: effectiveFlashAttn,
    cacheTypeK: effectiveCacheTypeK,
    cacheTypeV: effectiveCacheTypeV,
    mlock: settings.mlock || llmSettings.mlock || false,
    mmap: settings.mmap !== false && llmSettings.mmap !== false,
    cachePrompt: settings.cachePrompt !== false && llmSettings.cachePrompt !== false,
    defragThold: Number(settings.defragThold) || llmSettings.defragThold || 0.1,
    batchSize: Math.max(128, Math.min(2048, effectiveBatchSize)),
    ubatchSize: Math.max(128, Math.min(2048, effectiveUbatchSize)),
    performanceProfile: settings.performanceProfile || llmSettings.performanceProfile || "balanced",
  };

  let mmprojPath = null;
  const lowerFilename = filename.toLowerCase();
  const isMultimodal = isVisionModelFilename(lowerFilename);

  if (isMultimodal) {
    if (settings.mmproj) {
      const customProjPath = path.join(LLM_MODELS, path.basename(settings.mmproj));
      if (fs.existsSync(customProjPath)) {
        mmprojPath = customProjPath;
      }
    }
    if (!mmprojPath) {
      try {
        const files = fs.readdirSync(LLM_MODELS);
        let bestMatch = null;
        
        // 1. Match by Hugging Face repository prefix (e.g., "unsloth--gemma-4-E2B-it-qat-GGUF--")
        if (filename.includes("--")) {
          const lastIndex = filename.lastIndexOf("--");
          const repoPrefix = filename.substring(0, lastIndex + 2);
          bestMatch = files.find(file => {
            const lower = file.toLowerCase();
            return file.startsWith(repoPrefix) && lower.includes("mmproj") && lower.endsWith(".gguf");
          });
        }
        
        // 2. Match by model family keyword (e.g. matching model containing "gemma-4" with projector containing "gemma-4")
        if (!bestMatch) {
          const keywords = ["gemma-4", "gemma4", "llava", "qwen2vl", "qwen2-vl", "paligemma", "minicpm", "internvl", "phi-3", "phi3", "smolvlm", "moondream"];
          const matchedKeyword = keywords.find(kw => lowerFilename.includes(kw));
          if (matchedKeyword) {
            bestMatch = files.find(file => {
              const lower = file.toLowerCase();
              return lower.endsWith(".gguf") && lower.includes("mmproj") && lower.includes(matchedKeyword);
            });
          }
        }
        
        // 3. General fallback
        if (!bestMatch) {
          bestMatch = files.find(file => {
            const lower = file.toLowerCase();
            return lower.endsWith(".gguf") && (lower === "mmproj-model-f16.gguf" || lower.includes("mmproj"));
          });
        }
        
        if (bestMatch) {
          mmprojPath = path.join(LLM_MODELS, bestMatch);
        }
      } catch (_) {}
    }
  }

  const args = [
    "--model", modelPath,
    "--host", "127.0.0.1",
    "--port", String(PORT_LLM),
    "-lv", "1",
    "--ctx-size", String(llmSettings.contextSize),
    "--threads", String(llmSettings.threads),
    "--n-gpu-layers", String(llmSettings.gpuLayers),
    "--parallel", "1",
    "--cache-type-k", String(llmSettings.cacheTypeK),   // ✅ KV cache quantization K
    "--cache-type-v", String(llmSettings.cacheTypeV),   // ✅ KV cache quantization V
    "--cache-prompt",                        // ✅ Prompt caching for multi-turn (major UX win)
    "--ctx-checkpoints", "8",                // ✅ Context shifting recovery
    "--poll", "30",                          // ✅ More aggressive polling
    "--metrics",                             // ✅ Metrics endpoint for tuning
    "--batch-size", String(llmSettings.batchSize),       // ✅ Prompt processing batch
    "--ubatch-size", String(llmSettings.ubatchSize),     // ✅ Micro-batch size
  ];
  if (llmSettings.flashAttn) {
    args.push("--flash-attn", "on");
  }
  if (isSyclBackend) {
    args.push("--no-warmup");
  }
  
  // CPU mode: lock memory to prevent OS paging (critical for consistent speed)
  const isGpuMode = backend.mode.includes("GPU") || backend.mode.includes("CUDA") ||
                    backend.mode.includes("HIP") || backend.mode.includes("ROCm") ||
                    backend.mode.includes("Vulkan") || backend.mode.includes("Metal") ||
                    backend.mode.includes("SYCL");
  if (!isGpuMode && llmSettings.mlock) {
    args.push("--mlock");                    // ✅ Prevent OS swapping on CPU
  }
  
  // All modes: memory-mapped loading for faster startup
  if (llmSettings.mmap) {
    args.push("--mmap");                     // ✅ Faster model loading
  }
  
  if (llmSettings.enableThinking === false) {
    args.push("--reasoning", "off");           // ✅ Disable reasoning/thinking completely
  } else if (llmSettings.supportsThinking) {
    args.push("--reasoning", "on");            // ✅ Enable reasoning for supported models
  }
  if (llmSettings.enableThinking === true && llmSettings.supportsThinking) {
    args.push("--reasoning-format", "deepseek"); // ✅ Extract thoughts into reasoning_content
  }
  if (mmprojPath) {
    args.push("--mmproj", mmprojPath);
  }
  llmSettings.supportsVision = Boolean(mmprojPath);
  llmSettings.mmproj = mmprojPath ? path.basename(mmprojPath) : null;
  llmSettings.visionMode = mmprojPath ? "mmproj" : "none";
  llmSettings.visionStatus = mmprojPath
    ? `Using projector ${path.basename(mmprojPath)}`
    : (isMultimodal ? "Matching mmproj projector not found" : "Model is text-only");
  const spawnEnv = { ...process.env };
  const backendDir = path.dirname(backend.path);
  
  // Platform library paths
  if (osPlatform === "linux") {
    spawnEnv.LD_LIBRARY_PATH = backendDir + (spawnEnv.LD_LIBRARY_PATH ? `:${spawnEnv.LD_LIBRARY_PATH}` : "");
  } else if (osPlatform === "darwin") {
    spawnEnv.DYLD_LIBRARY_PATH = backendDir + (spawnEnv.DYLD_LIBRARY_PATH ? `:${spawnEnv.DYLD_LIBRARY_PATH}` : "");
  }
  
  // CUDA-specific optimizations
  if (backend.mode.includes("CUDA")) {
    // Multi-GPU: increase command buffer size (reduces CPU stalls)
    spawnEnv.CUDA_SCALE_LAUNCH_QUEUES = spawnEnv.CUDA_SCALE_LAUNCH_QUEUES || "4x";
    
    // Linux: allow swapping to system RAM when VRAM exhausted
    if (osPlatform === "linux") {
      spawnEnv.GGML_CUDA_ENABLE_UNIFIED_MEMORY = spawnEnv.GGML_CUDA_ENABLE_UNIFIED_MEMORY || "1";
    }
  }
  
  // SYCL-specific optimizations (Intel Arc/Graphics)
  if (backend.mode.includes("SYCL")) {
    spawnEnv.ZES_ENABLE_SYSMAN = "1";
  }

  console.log("  [llm] Starting:", backend.path, args.join(" "));
  const proc = spawn(backend.path, args, { stdio: "pipe", env: spawnEnv });
  const procSeq = ++llmProcSeq;
  llmProc = proc;
  proc.stdout.on("data", (data) => {
    if (llmProc !== proc) return;
    process.stdout.write("  [llm] " + data.toString());
  });
  proc.stderr.on("data", (data) => {
    if (llmProc !== proc) return;
    const output = data.toString();
    process.stderr.write("  [llm-err] " + output);
    if (/Vulkan\d+\s*:/i.test(output)) llmSettings.backendMode = "Vulkan GPU";
    else if (/CUDA\d+\s*:/i.test(output)) llmSettings.backendMode = "CUDA GPU";
    else if (/(HIP|ROCm)\d*\s*:/i.test(output)) llmSettings.backendMode = "ROCm GPU";
    else if (/SYCL\d+\s*:/i.test(output)) llmSettings.backendMode = "SYCL GPU";
    else if (/Metal/i.test(output) && /GPU|device/i.test(output)) llmSettings.backendMode = "Metal GPU";
    else if (/\-\s+CPU\s+:/i.test(output) && llmSettings.backendMode.startsWith("Auto")) llmSettings.backendMode = "CPU";
    if (/error|failed/i.test(output) && !/no error/i.test(output)) {
      llmError = output.trim().slice(-1200);
    }
  });
  proc.on("exit", (code) => {
    if (llmProc !== proc) {
      console.log("  [llm] stale process exited with code", code);
      return;
    }
    llmReady = false;
    llmProc = null;
    if (code !== 0 && code !== null && !llmError) llmError = `llama.cpp exited with code ${code}`;
    console.log("  [llm] exited with code", code, `(process ${procSeq})`);
  });

  await waitForLlmReady(backend.key === "cpu" ? 720 : 360, proc, filename);
}

async function startBackend(settings = {}) {
  const requestedSettings = { ...currentSettings, ...settings };
  if (!requestedSettings.model) requestedSettings.model = getDefaultModel();
  assertNoOtherActiveRuntime("image", requestedSettings.model);

  await killLlm();
  if (settings.backendType === "openvino-npu") {
    await startOpenVinoWorker(settings);
    return;
  }
  await killOpenVinoWorker();
  backendError = null;
  currentSettings = requestedSettings;
  if (!currentSettings.model) {
    console.log("  [backend] No model found in app/models/ — backend not started");
    return;
  }

  const modelLoadIssue = getModelLoadIssue(currentSettings.model);
  if (modelLoadIssue) {
    backendError = modelLoadIssue;
    backendLoadState = {
      active: false,
      phase: "Model load blocked",
      progress: 0,
      current: 0,
      total: 0,
      speed: "",
      model: path.basename(currentSettings.model),
      backendMode: "",
      backendBinary: "",
      device: "",
    };
    throw new Error(modelLoadIssue);
  }

  PORT_BACKEND = Number(settings.backendPort) > 0 ? Number(settings.backendPort) : await findAvailableBackendPort();

  const resolvedBackendType = resolveBackendType(currentSettings.useGpu, currentSettings.backendType, currentSettings.model);
  currentSettings.backendType = resolvedBackendType;
  currentSettings.useGpu = resolvedBackendType !== "cpu";
  const backendPath = selectBackendPath(currentSettings.useGpu, currentSettings.backendType, currentSettings.model);
  if (!backendPath) {
    const setupHint = resolvedBackendType === "apple-npu"
      ? "CoreML Python environment is not set up. Run scripts/setup/setup-coreml-npu.sh first."
      : resolvedBackendType === "cpu" && osPlatform === "win32"
        ? "Windows CPU backend is not installed. Run scripts/setup.ps1 again so app/backend/win/cpu is created."
        : "No compatible backend executable was found.";
    throw new Error(setupHint);
  }
  const backendMode = getBackendMode(backendPath, currentSettings.useGpu, currentSettings.backendType);
  currentSettings.backendMode = backendMode;
  currentSettings.backendBinary = path.basename(backendPath);

  backendLoadState = {
    active: true,
    phase: "Starting backend...",
    progress: 0,
    current: 0,
    total: 0,
    speed: "",
    model: path.basename(currentSettings.model),
    backendMode,
    backendBinary: path.basename(backendPath),
    device: "",
  };

  let runThreads = parseInt(currentSettings.threads) || 4;
  if (currentSettings.useGpu) {
    runThreads = Math.min(4, runThreads);
  }

  let args = [];
  const requestedBackend = resolveBackendType(currentSettings.useGpu, currentSettings.backendType, currentSettings.model);
  const selectedVulkanBackend = requestedBackend === "vulkan" ? getPreferredVulkanBackendName() : "";

  const supportsFlags = backendSupportsFlags[backendPath] !== false;

  if (requestedBackend === "apple-npu") {
    args = [
      path.join(ROOT, "scripts", "workers", "coreml_server.py"),
      "--listen-port", String(PORT_BACKEND),
      "--model",       currentSettings.model,
      "--steps",       String(currentSettings.steps),
      "--cfg-scale",   String(currentSettings.cfgScale),
    ];
  } else {
    args = [
      "--listen-port", String(PORT_BACKEND),
      "--model",       currentSettings.model,
      "--steps",       String(currentSettings.steps),
      "--cfg-scale",   String(currentSettings.cfgScale),
      "--sampling-method", currentSettings.sampler,
      "--threads",     String(runThreads),
    ];

    if (requestedBackend === "cpu") {
      if (supportsFlags) {
        args.push("--backend", "cpu", "--params-backend", "cpu");
      }
      args.push("--rng", "cpu", "--sampler-rng", "cpu");
  } else if (requestedBackend === "vulkan") {
    if (supportsFlags) {
      args.push("--backend", selectedVulkanBackend, "--params-backend", selectedVulkanBackend);
    }
    args.push("--rng", "cpu", "--sampler-rng", "cpu");
  } else if (requestedBackend === "cuda") {
    if (supportsFlags) {
      args.push("--backend", "cuda0", "--params-backend", "cuda0");
    }
    args.push("--rng", "cuda", "--sampler-rng", "cuda");
  } else if (requestedBackend === "rocm") {
    if (supportsFlags) {
      args.push("--backend", "rocm0", "--params-backend", "rocm0");
    }
    args.push("--rng", "cpu", "--sampler-rng", "cpu");
  } else if (requestedBackend === "metal") {
    args.push("--rng", "cpu", "--sampler-rng", "cpu");
  }

  }

  if (requestedBackend === "vulkan" && selectedVulkanBackend) {
    currentSettings.backendDevice = selectedVulkanBackend;
    backendLoadState.device = selectedVulkanBackend;
  }

  if (requestedBackend !== "apple-npu") {
    if (currentSettings.vaeTiling) {
      args.push("--vae-tiling");
    }
    if (currentSettings.vaeOnCpu) {
      args.push("--vae-on-cpu");
    }
    if (currentSettings.flashAttn) {
      if (requestedBackend === "cuda") {
        args.push("--diffusion-fa");
      } else {
        args.push("--fa");
      }
    }
  }

  // Build environment for Linux backends so bundled .so libraries are found.
  // Official Linux releases ship libstable-diffusion.so next to the executable.
  const spawnEnv = { ...process.env };
  if (osPlatform === "linux") {
    const extraLibs = [];
    if (requestedBackend === "rocm") {
      extraLibs.push(path.dirname(BACKEND_PATHS.linuxRocm));
    } else if (requestedBackend === "vulkan") {
      extraLibs.push(path.dirname(BACKEND_PATHS.linuxVulkan));
    } else if (requestedBackend === "cpu") {
      extraLibs.push(path.dirname(BACKEND_PATHS.linuxCpu));
    } else if (requestedBackend === "cuda") {
      extraLibs.push(path.dirname(BACKEND_PATHS.linuxCuda));
    }
    if (extraLibs.length > 0) {
      const existing = spawnEnv.LD_LIBRARY_PATH || "";
      spawnEnv.LD_LIBRARY_PATH = extraLibs.join(":") + (existing ? ":" + existing : "");
    }
  } else if (osPlatform === "darwin" && requestedBackend !== "apple-npu") {
    const existing = spawnEnv.DYLD_LIBRARY_PATH || "";
    const backendDir = path.dirname(BACKEND_PATHS.mac);
    spawnEnv.DYLD_LIBRARY_PATH = backendDir + (existing ? ":" + existing : "");
  }

  console.log("  [backend] Starting:", path.basename(backendPath), args.join(" "));
  backendReady = false;

  const procSeq = ++backendProcSeq;
  const proc = spawn(backendPath, args, { stdio: "pipe", env: spawnEnv });
  backendProc = proc;
  startBackendReadyPoll();
  const coremlLoadHeartbeat = startCoreMLLoadHeartbeat(proc);

  proc.stdout.on("data", d => {
    const output = d.toString();
    process.stdout.write("  [sd] " + output);
    updateCoreMLLoadProgress(output);
    const cleanOutput = stripAnsi(output);
    if (cleanOutput.includes("listening on")) {
      markBackendReady();
    }
    
    const lines = output.split(/[\r\n]+/);
    for (const line of lines) {
      const cleanLine = stripAnsi(line);
      if (!cleanLine.trim()) continue;
      
      if (cleanLine.includes("listening on")) {
        markBackendReady();
      }

      if (cleanLine.includes("loading model from")) {
        backendLoadState.active = true;
        backendLoadState.phase = "Loading model weights...";
        backendLoadState.progress = Math.max(backendLoadState.progress, 1);
      }

      if (cleanLine.includes("model files processing completed")) {
        backendLoadState.active = true;
        backendLoadState.phase = "Initializing model...";
        backendLoadState.progress = Math.max(backendLoadState.progress, 95);
      }

      const loadMatch = cleanLine.match(/\|\s*(\d+)\/(\d+)\s*-\s*([^|]+)$/);
      if (loadMatch && !cleanLine.includes("it/s") && !cleanLine.includes("s/it")) {
        const current = parseInt(loadMatch[1], 10);
        const total = parseInt(loadMatch[2], 10);
        const progress = total > 0 ? Math.round((current / total) * 100) : 0;
        const isCoreML = currentSettings.backendType === "apple-npu" || total <= 10;
        const phaseDesc = isCoreML ? stripAnsi(loadMatch[3]).trim() : "Loading model weights...";
        const speedDesc = isCoreML ? "" : stripAnsi(loadMatch[3]).trim();
        backendLoadState = {
          ...backendLoadState,
          active: !backendReady,
          phase: phaseDesc,
          progress: Math.max(backendLoadState.progress, Math.min(99, progress)),
          current,
          total,
          speed: speedDesc,
        };
      }
      
      if (cleanLine.includes("generate_image") || cleanLine.includes("generating image")) {
        generationState.active = true;
        generationState.step = 0;
        generationState.steps = 0;
        generationState.speed = "";
        generationState.decoding = false;
      }
      
      if (cleanLine.includes("decoding") && generationState.active) {
        generationState.decoding = true;
      }
      
      const match = cleanLine.match(/\|\s*[^|]*\s*\|\s*(\d+)\/(\d+)\s*-\s*([\d.]+\s*(?:it\/s|s\/it))/);
      if (match) {
        generationState.active = true;
        if (!generationState.decoding) {
          generationState.step = parseInt(match[1], 10);
          generationState.steps = parseInt(match[2], 10);
          generationState.speed = match[3].trim();
        }
      }
      
      if (cleanLine.includes("generate_image completed")) {
        generationState.active = false;
        generationState.step = 0;
        generationState.steps = 0;
        generationState.speed = "";
        generationState.decoding = false;
      }
    }
  });

  proc.stderr.on("data", d => {
    const output = d.toString();
    process.stderr.write("  [sd-err] " + output);
    updateCoreMLLoadProgress(output);
    const cleanOutput = stripAnsi(output);
    const runtimeLinkerError = describeLinuxRuntimeLinkerError(cleanOutput);
    if (runtimeLinkerError) {
      backendError = runtimeLinkerError;
      backendLoadState.phase = "Linux runtime is too old for this backend";
    }
    const deviceMatch = cleanOutput.match(/Device\s+\d+:\s*([^,\r\n]+)/);
    if (deviceMatch) {
      backendLoadState.device = deviceMatch[1].trim();
      currentSettings.backendDevice = backendLoadState.device;
    }
    const metalDeviceMatch = cleanOutput.match(/GPU name:\s*([^\r\n]+)/);
    if (metalDeviceMatch) {
      backendLoadState.device = metalDeviceMatch[1].trim();
      currentSettings.backendDevice = backendLoadState.device;
    }
    if (cleanOutput.includes("ggml_cuda_init")) {
      backendLoadState.backendMode = "CUDA GPU";
      currentSettings.backendMode = "CUDA GPU";
    }
    if (cleanOutput.includes("ggml_vulkan")) {
      backendLoadState.backendMode = "Vulkan GPU";
      currentSettings.backendMode = "Vulkan GPU";
    }
    if (cleanOutput.includes("ggml_hip") || cleanOutput.includes("ggml_rocm")) {
      backendLoadState.backendMode = "ROCm GPU";
      currentSettings.backendMode = "ROCm GPU";
    }
    if (cleanOutput.includes("ggml_metal")) {
      backendLoadState.backendMode = "Metal GPU";
      currentSettings.backendMode = "Metal GPU";
    }
    if (cleanOutput.includes("[ERROR]")) {
      const nextError = describeBackendError(cleanOutput.trim(), currentSettings.model);
      const hasSpecificFileError = String(backendError || "").includes("incomplete or corrupted");
      const isGenericContextError = cleanOutput.includes("new_sd_ctx_t failed");
      if (!(hasSpecificFileError && isGenericContextError)) {
        backendError = nextError;
      }
    }
  });
  proc.on("exit", (code, signal) => {
    if (coremlLoadHeartbeat) clearInterval(coremlLoadHeartbeat);
    if (backendProc !== proc) {
      console.log("  [backend] stale process exited with code", code, signal ? `(signal ${signal})` : "", `(process ${procSeq})`);
      return;
    }
    backendReady = false;
    backendProc  = null;
    console.log("  [backend] exited with code", code, signal ? `(signal ${signal})` : "", `(process ${procSeq})`);
    if (code !== null && code !== 0) {
      if (!backendError) {
        backendError = describeBackendExitCode(code, currentSettings.backendBinary || BACKEND_PATH);
      }
    }
    backendLoadState.active = false;
    generationState.active = false;
    generationState.step = 0;
    generationState.steps = 0;
    generationState.speed = "";
    generationState.decoding = false;

    // Force a VRAM poll to update free memory space
    setTimeout(() => pollNvidiaVram(true), 1000);
  });
}

// ── Model Downloader ─────────────────────────────────────────────────────────
let downloadState = {
  active: false,
  filename: "",
  progress: 0,
  speed: "0 MB/s",
  eta: 0,
  totalBytes: 0,
  downloadedBytes: 0,
  error: null
};
let activeDownload = null;
const activeModelDownloads = new Map();
const MAX_PARALLEL_MODEL_DOWNLOADS = 4;

function makeModelDownloadId(kind, filename) {
  return `${kind || "model"}:${filename || Date.now()}`;
}

function summarizeModelDownloads() {
  const downloads = Array.from(activeModelDownloads.values()).map((job) => ({
    id: job.id,
    active: job.active,
    filename: job.filename,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    totalBytes: job.totalBytes,
    downloadedBytes: job.downloadedBytes,
    error: job.error,
    kind: job.kind,
  }));
  const active = downloads.filter((job) => job.active);
  if (active.length === 0) {
    const last = downloads[downloads.length - 1];
    return {
      active: false,
      filename: last?.filename || downloadState.filename || "",
      progress: last?.progress || downloadState.progress || 0,
      speed: last?.speed || downloadState.speed || "0 MB/s",
      eta: last?.eta || downloadState.eta || 0,
      totalBytes: last?.totalBytes || downloadState.totalBytes || 0,
      downloadedBytes: last?.downloadedBytes || downloadState.downloadedBytes || 0,
      error: last?.error || downloadState.error || null,
      kind: last?.kind || downloadState.kind || "model",
      downloads,
    };
  }
  const totalBytes = active.reduce((sum, job) => sum + (Number(job.totalBytes) || 0), 0);
  const downloadedBytes = active.reduce((sum, job) => sum + (Number(job.downloadedBytes) || 0), 0);
  return {
    active: true,
    filename: active.map((job) => job.filename).join(", "),
    progress: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : -1,
    speed: `${active.length} active`,
    eta: 0,
    totalBytes,
    downloadedBytes,
    error: null,
    kind: "multi",
    downloads,
  };
}

function startOpenVinoModelDownload(modelId) {
  if (downloadState.active) return;
  const npuInfo = getOpenVinoNpuInfo();
  if (!npuInfo.supported) throw new Error(npuInfo.reason || "OpenVINO NPU runtime is not available.");
  const model = OPENVINO_NPU_MODELS.find((item) => item.id === modelId);
  if (!model) throw new Error("Unknown OpenVINO model.");

  const destDir = path.join(OPENVINO_MODELS, model.folder);
  fs.mkdirSync(destDir, { recursive: true });
  downloadState = {
    active: true,
    filename: model.name,
    progress: -1,
    speed: "Downloading snapshot",
    eta: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    error: null,
  };

  const script = [
    "from huggingface_hub import snapshot_download",
    `snapshot_download(repo_id=${JSON.stringify(model.repo)}, local_dir=${JSON.stringify(destDir)}, ignore_patterns=['safety_checker/*','feature_extractor/*','*.safetensors'])`,
    "print('DONE')",
  ].join("\n");
  console.log(`  [openvino-download] Downloading ${model.repo} -> ${destDir}`);
  const proc = spawn(npuInfo.python, ["-c", script], { stdio: "pipe" });
  activeDownload = { process: proc, destPath: destDir, openvino: true };
  proc.stdout.on("data", (data) => process.stdout.write("  [openvino-download] " + data.toString()));
  proc.stderr.on("data", (data) => process.stderr.write("  [openvino-download] " + data.toString()));
  proc.on("exit", (code) => {
    activeDownload = null;
    if (String(downloadState.error || "").toLowerCase().includes("cancelled")) {
      return;
    }
    downloadState.active = false;
    if (code === 0) {
      downloadState.progress = 100;
      downloadState.downloadedBytes = getPathSize(destDir);
      downloadState.totalBytes = downloadState.downloadedBytes;
      downloadState.speed = "Complete";
      cachedBackendOptions = null;
    } else {
      downloadState.error = `OpenVINO model download failed with code ${code}`;
    }
  });
}

const IMAGE_BACKEND_DOWNLOADS = {
  "cpu": {
    id: "cpu",
    label: "CPU",
    url: "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-721-8caa3f9/sd-master-8caa3f9-bin-win-avx2-x64.zip",
    destDir: path.join(ROOT, "app", "backend", "win", "cpu"),
    exeName: "sd-cpu.exe",
    requiredDll: "stable-diffusion.dll",
  },
  "vulkan": {
    id: "vulkan",
    label: "Vulkan GPU",
    url: "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-669-2d40a8b/sd-master-2d40a8b-bin-win-vulkan-x64.zip",
    destDir: path.join(ROOT, "app", "backend", "win", "vulkan"),
    exeName: "sd-vulkan.exe",
    requiredDll: "stable-diffusion.dll",
  },
  "cuda": {
    id: "cuda",
    label: "CUDA GPU",
    url: "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-721-8caa3f9/sd-master-8caa3f9-bin-win-cuda12-x64.zip",
    destDir: path.join(ROOT, "app", "backend", "win", "cuda"),
    exeName: "sd-cuda.exe",
    requiredDll: "stable-diffusion.dll",
  },
};

function listFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function installImageBackendArchive(zipPath, backend) {
  const tempDir = path.join(TOOLS, `image-backend-${backend.id}-extract-${Date.now()}`);
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(backend.destDir, { recursive: true });

    const tar = spawnSync("tar.exe", ["-xf", zipPath, "-C", tempDir], { encoding: "utf8" });
    if (tar.status !== 0) {
      throw new Error((tar.stderr || tar.stdout || "Could not extract backend archive.").trim());
    }

    const files = listFilesRecursive(tempDir);
    const exeSource = files.find((file) => ["sd-server.exe", "sd.exe"].includes(path.basename(file).toLowerCase()));
    const dllSource = files.find((file) => path.basename(file).toLowerCase() === backend.requiredDll.toLowerCase());
    if (!exeSource || !dllSource) {
      throw new Error("Backend archive did not contain the expected stable-diffusion executable and DLL.");
    }

    fs.copyFileSync(exeSource, path.join(backend.destDir, backend.exeName));
    fs.copyFileSync(dllSource, path.join(backend.destDir, backend.requiredDll));
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (ext !== ".dll" && ext !== ".exe") continue;
      if (file === exeSource) continue;
      fs.copyFileSync(file, path.join(backend.destDir, path.basename(file)));
    }

    if (!fs.existsSync(path.join(backend.destDir, backend.exeName)) || !fs.existsSync(path.join(backend.destDir, backend.requiredDll))) {
      throw new Error(`Backend install did not create ${backend.exeName} and ${backend.requiredDll}.`);
    }
    cachedBackendOptions = null;
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function startImageBackendDownload(backendId, redirectCount = 0, redirectUrl = "") {
  if (downloadState.active && redirectCount === 0) {
    throw new Error("Another download is already active.");
  }
  if (osPlatform !== "win32") {
    throw new Error("In-app backend downloads are currently available for Windows image backends.");
  }
  const backend = IMAGE_BACKEND_DOWNLOADS[String(backendId || "").toLowerCase()];
  if (!backend) {
    throw new Error("This backend cannot be installed from the app yet. Use the platform setup script.");
  }

  fs.mkdirSync(TOOLS, { recursive: true });
  const url = redirectUrl || backend.url;
  const filename = `${backend.id}-backend.zip`;
  const destPath = path.join(TOOLS, filename);
  const tempPath = `${destPath}.part`;
  if (redirectCount === 0) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    downloadState = {
      active: true,
      filename: backend.label,
      progress: 0,
      speed: "0 MB/s",
      eta: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      error: null,
      kind: "backend",
      backendId: backend.id,
    };
  }

  console.log(`  [backend-download] Downloading ${backend.label} backend from ${url}`);
  let downloadFinalized = false;
  const fileStream = fs.createWriteStream(tempPath);
  const failDownload = (message, err = null) => {
    if (downloadFinalized) return;
    downloadFinalized = true;
    downloadState.active = false;
    downloadState.error = message;
    if (err) console.error("  [backend-download]", message, err);
    else console.error("  [backend-download] Failed:", message);
    try { fileStream.close(); } catch (_) {}
    try { fs.unlinkSync(tempPath); } catch (_) {}
    activeDownload = null;
  };

  fileStream.on("error", (err) => failDownload(`Could not write ${filename}: ${err.message}`, err));
  const client = url.startsWith("https") ? https : http;
  const request = client.get(url, {
    headers: {
      "User-Agent": "Uncensored-AI-Studio/1.0 (+https://github.com/techjarves/Uncensored-AI-Studio)",
      "Accept": "application/zip, application/octet-stream, */*",
    },
  }, (response) => {
    activeDownload = { request, fileStream, destPath, tempPath };
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const nextUrl = response.headers.location ? new URL(response.headers.location, url).toString() : "";
      if (!nextUrl) return failDownload("Redirect response did not include a Location header.");
      if (redirectCount > 10) return failDownload("Too many redirects.");
      downloadState.speed = "Following redirect";
      request.removeAllListeners("error");
      request.destroy();
      response.resume();
      fileStream.close();
      try { fs.unlinkSync(tempPath); } catch (_) {}
      activeDownload = null;
      startImageBackendDownload(backend.id, redirectCount + 1, nextUrl);
      return;
    }
    if (response.statusCode !== 200) {
      return failDownload(describeDownloadHttpError(response.statusCode, url, response.headers));
    }

    const totalBytes = parseInt(response.headers["content-length"], 10) || 0;
    downloadState.totalBytes = totalBytes;
    let downloadedBytes = 0;
    let lastTime = Date.now();
    let lastDownloaded = 0;

    response.on("data", (chunk) => {
      downloadedBytes += chunk.length;
      downloadState.downloadedBytes = downloadedBytes;
      fileStream.write(chunk);
      const now = Date.now();
      const elapsed = (now - lastTime) / 1000;
      if (elapsed >= 0.5) {
        const chunkSpeed = (downloadedBytes - lastDownloaded) / elapsed;
        lastDownloaded = downloadedBytes;
        lastTime = now;
        downloadState.speed = `${(chunkSpeed / (1024 * 1024)).toFixed(1)} MB/s`;
        if (totalBytes > 0) {
          downloadState.progress = Math.round((downloadedBytes / totalBytes) * 100);
          downloadState.eta = Math.round((totalBytes - downloadedBytes) / Math.max(1, chunkSpeed));
        } else {
          downloadState.progress = -1;
          downloadState.eta = -1;
        }
      }
    });

    response.on("aborted", () => failDownload(`Download interrupted before ${backend.label} backend finished.`));
    response.on("error", (err) => failDownload(`Download stream failed before ${backend.label} backend finished.`, err));
    response.on("end", () => {
      if (downloadFinalized) return;
      if (totalBytes > 0 && downloadedBytes !== totalBytes) {
        failDownload(`Download incomplete for ${backend.label}: received ${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}.`);
        return;
      }
      fileStream.end(() => {
        try {
          try { fs.unlinkSync(destPath); } catch (_) {}
          fs.renameSync(tempPath, destPath);
          downloadState.speed = "Installing";
          downloadState.progress = 95;
          installImageBackendArchive(destPath, backend);
          try { fs.unlinkSync(destPath); } catch (_) {}
          downloadFinalized = true;
          downloadState.active = false;
          downloadState.progress = 100;
          downloadState.downloadedBytes = downloadedBytes;
          downloadState.error = null;
          downloadState.speed = "Complete";
          activeDownload = null;
          console.log(`  [backend-download] Installed ${backend.label} backend`);
        } catch (err) {
          failDownload(`Could not install ${backend.label} backend: ${err.message}`, err);
        }
      });
    });
  });

  request.on("error", (err) => failDownload(err.message, err));
  activeDownload = { request, fileStream, destPath, tempPath };
}

// ── Generation State (Real-time progress parser) ─────────────────────────────
let generationState = {
  active: false,
  step: 0,
  steps: 0,
  speed: "",
  decoding: false,
  backendMode: "",
  backendDevice: "",
};

function resetGenerationState() {
  generationState = {
    active: false,
    step: 0,
    steps: 0,
    speed: "",
    decoding: false,
    backendMode: "",
    backendDevice: "",
  };
}

function describeDownloadHttpError(statusCode, url, headers = {}) {
  const host = (() => {
    try { return new URL(url).hostname; } catch (_) { return ""; }
  })();
  const isHuggingFace = host.includes("huggingface.co") || host.includes("hf.co");
  const hfErrorCode = headers["x-error-code"];
  const hfErrorMessage = headers["x-error-message"];

  if (isHuggingFace && hfErrorCode === "GatedRepo") {
    return `HTTP ${statusCode}: Hugging Face says this model is gated. Open the model page in your browser, accept access/login, then use a Hugging Face token or download the file manually.`;
  }
  if (isHuggingFace && hfErrorMessage) {
    return `HTTP ${statusCode}: Hugging Face rejected the download request: ${hfErrorMessage}`;
  }

  if (statusCode === 401 || statusCode === 403) {
    return isHuggingFace
      ? `HTTP ${statusCode}: Hugging Face rejected the download request. If this model is public, retry after restarting the app; otherwise open the model page in your browser and accept any license/login requirement.`
      : `HTTP ${statusCode}: This download URL requires authorization or permission. Use a public direct download URL.`;
  }
  if (statusCode === 404) {
    return `HTTP 404: Model file not found. Check that the URL points directly to a .safetensors, .gguf, or .ckpt file.`;
  }
  return `HTTP ${statusCode}`;
}

function startModelDownload(url, overrideFilename = null, targetDir = MODELS, kind = "image", redirectCount = 0, existingJobId = null) {
  // Convert HuggingFace viewer URL (/blob/) to direct download URL (/resolve/)
  if (url.includes("huggingface.co") && url.includes("/blob/")) {
    url = url.replace("/blob/", "/resolve/");
  }

  let filename = overrideFilename;
  if (!filename) {
    filename = "model.gguf";
    try {
      const parsed = new URL(url);
      filename = path.basename(parsed.pathname);
    } catch (e) {
      console.error("Failed to parse URL filename:", e);
    }
  }

  const id = existingJobId || makeModelDownloadId(kind, filename);
  const activeCount = Array.from(activeModelDownloads.values()).filter((job) => job.active).length;
  const existingActive = activeModelDownloads.get(id);
  if (!existingJobId && existingActive?.active) {
    throw new Error(`"${filename}" is already downloading.`);
  }
  if (!existingJobId && activeCount >= MAX_PARALLEL_MODEL_DOWNLOADS) {
    throw new Error(`Maximum ${MAX_PARALLEL_MODEL_DOWNLOADS} parallel downloads are already active. Wait for one to finish or cancel one.`);
  }

  const destPath = path.join(targetDir, filename);
  const tempPath = `${destPath}.part`;
  if (redirectCount === 0) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
  }

  const job = activeModelDownloads.get(id) || {
    id,
    active: true,
    filename,
    progress: 0,
    speed: "0 MB/s",
    eta: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    error: null,
    kind,
  };
  Object.assign(job, {
    active: true,
    filename,
    progress: redirectCount > 0 ? job.progress : 0,
    speed: redirectCount > 0 ? "Following redirect" : "0 MB/s",
    eta: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    error: null,
    kind,
  });
  activeModelDownloads.set(id, job);
  downloadState = summarizeModelDownloads();

  if (redirectCount > 0) {
    console.log(`  [download] Continuing redirected download of ${filename}`);
  } else {
    console.log(`  [download] Starting download of ${filename} from ${url}`);
  }

  let downloadFinalized = false;
  const fileStream = fs.createWriteStream(tempPath);

  const failDownload = (message, err = null) => {
    if (downloadFinalized) return;
    downloadFinalized = true;
    job.active = false;
    job.error = message;
    job.speed = "Failed";
    if (err) {
      console.error("  [download]", message, err);
    } else {
      console.error("  [download] Failed:", message);
    }
    try { fileStream.close(); } catch (_) {}
    try { fs.unlinkSync(tempPath); } catch (_) {}
    activeModelDownloads.delete(id);
    activeModelDownloads.set(id, job);
    downloadState = summarizeModelDownloads();
  };

  fileStream.on("error", (err) => {
    failDownload(`Could not write ${filename}: ${err.message}`, err);
  });
  
  const client = url.startsWith("https") ? https : http;
  const request = client.get(url, {
    headers: {
      "User-Agent": "Uncensored-AI-Studio/1.0 (+https://github.com/techjarves/Uncensored-AI-Studio)",
      "Accept": "application/octet-stream, application/x-safetensors, */*",
      "Referer": "https://huggingface.co/",
    },
  }, (response) => {
    activeModelDownloads.set(id, { ...job, request, fileStream, destPath, tempPath });
    // Handle redirects (HuggingFace resolve URLs redirect to Cloudfront/S3)
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const redirectUrl = response.headers.location ? new URL(response.headers.location, url).toString() : "";
      if (!redirectUrl) {
        failDownload("Redirect response did not include a Location header");
        return;
      }
      if (redirectCount > 10) {
        failDownload("Too many redirects");
        return;
      }
      console.log(`  [download] Following redirect for ${filename}`);
      job.speed = "Following redirect";
      downloadState = summarizeModelDownloads();
      request.removeAllListeners("error");
      request.destroy();
      response.resume();
      fileStream.close();
      try { fs.unlinkSync(tempPath); } catch (_) {}
      startModelDownload(redirectUrl, filename, targetDir, kind, redirectCount + 1, id);
      return;
    }

    if (response.statusCode !== 200) {
      failDownload(describeDownloadHttpError(response.statusCode, url, response.headers));
      return;
    }

    const totalBytes = parseInt(response.headers["content-length"], 10) || 0;
    job.totalBytes = totalBytes;
    let downloadedBytes = 0;
    let startTime = Date.now();
    let lastTime = startTime;
    let lastDownloaded = 0;

    response.on("data", (chunk) => {
      downloadedBytes += chunk.length;
      job.downloadedBytes = downloadedBytes;
      fileStream.write(chunk);

      const now = Date.now();
      const elapsed = (now - lastTime) / 1000;
      if (elapsed >= 0.5) {
        const chunkSpeed = (downloadedBytes - lastDownloaded) / elapsed; // bytes/sec
        lastDownloaded = downloadedBytes;
        lastTime = now;

        const speedMb = (chunkSpeed / (1024 * 1024)).toFixed(1);
        job.speed = `${speedMb} MB/s`;

        if (totalBytes > 0) {
          job.progress = Math.round((downloadedBytes / totalBytes) * 100);
          const remainingBytes = totalBytes - downloadedBytes;
          job.eta = Math.round(remainingBytes / Math.max(1, chunkSpeed));
        } else {
          job.progress = -1;
          job.eta = -1;
        }
        downloadState = summarizeModelDownloads();
      }
    });

    response.on("aborted", () => {
      failDownload(`Download interrupted before ${filename} finished. Delete and retry the model download.`);
    });

    response.on("error", (err) => {
      failDownload(`Download stream failed before ${filename} finished. Delete and retry the model download.`, err);
    });

    response.on("end", () => {
      if (downloadFinalized) return;
      if (totalBytes > 0 && downloadedBytes !== totalBytes) {
        failDownload(`Download incomplete for ${filename}: received ${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}. Delete and retry the model download.`);
        return;
      }

      fileStream.end(() => {
        try {
          if (totalBytes > 0) {
            const writtenBytes = fs.statSync(tempPath).size;
            if (writtenBytes !== totalBytes) {
              failDownload(`Download incomplete for ${filename}: wrote ${formatBytes(writtenBytes)} of ${formatBytes(totalBytes)}. Delete and retry the model download.`);
              return;
            }
          }
          try { fs.unlinkSync(destPath); } catch (_) {}
          fs.renameSync(tempPath, destPath);

          if (destPath.toLowerCase().endsWith(".zip")) {
            try {
              const { execSync } = require("child_process");
              execSync(`unzip -o "${destPath}" -d "${path.dirname(destPath)}"`, { stdio: "ignore" });
              fs.unlinkSync(destPath);
            } catch(err) {
              console.error("Failed to unzip", err);
            }
          }

          downloadFinalized = true;
          job.active = false;
          job.progress = 100;
          job.downloadedBytes = downloadedBytes;
          job.error = null;
          job.speed = "Complete";
          activeModelDownloads.set(id, job);
          downloadState = summarizeModelDownloads();
          console.log(`  [download] Completed download of ${filename}`);
        } catch (err) {
          failDownload(`Could not finalize ${filename}: ${err.message}`);
        }
      });
    });
  });

  request.on("error", (err) => {
    failDownload(err.message, err);
  });
  activeModelDownloads.set(id, { ...job, request, fileStream, destPath, tempPath });
  downloadState = summarizeModelDownloads();
  return { id, filename };
}

function cancelModelDownload(filenameOrId = "") {
  const key = String(filenameOrId || "");
  let entries = Array.from(activeModelDownloads.entries()).filter(([, job]) => job.active);
  if (key) {
    entries = entries.filter(([id, job]) => id === key || job.filename === key);
  }

  if (entries.length === 0) {
    if (!downloadState.active || key) return false;
    entries = [];
  }

  if (entries.length > 0) {
    for (const [id, job] of entries) {
      if (job.request) {
        try { job.request.destroy(new Error("Download cancelled by user")); } catch (_) {}
      }
      if (job.fileStream) {
        try { job.fileStream.destroy(); } catch (_) {}
      }
      try { fs.unlinkSync(job.tempPath || `${path.join(job.kind === "text" ? LLM_MODELS : job.kind === "speech" ? SPEECH_MODELS : job.kind === "tts" ? TTS_MODELS : MODELS, job.filename)}.part`); } catch (_) {}
      job.active = false;
      job.progress = 0;
      job.speed = "Cancelled";
      job.error = "Download cancelled";
      activeModelDownloads.set(id, job);
      console.log(`  [download] Cancelled download of ${job.filename}`);
    }
    downloadState = summarizeModelDownloads();
    return true;
  }

  const filename = downloadState.filename;
  if (activeDownload) {
    if (activeDownload.process) {
      try { activeDownload.process.kill("SIGTERM"); } catch (_) {}
      setTimeout(() => { try { activeDownload?.process?.kill("SIGKILL"); } catch (_) {} }, 1000);
    } else {
      try { activeDownload.request.destroy(new Error("Download cancelled by user")); } catch (_) {}
      try { activeDownload.fileStream.destroy(); } catch (_) {}
      try { fs.unlinkSync(activeDownload.tempPath || activeDownload.destPath); } catch (_) {}
    }
  }
  activeDownload = null;
  downloadState = {
    active: false,
    filename,
    progress: 0,
    speed: "0 MB/s",
    eta: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    error: "Download cancelled",
    kind: downloadState.kind || "image",
    downloads: summarizeModelDownloads().downloads || [],
  };
  console.log(`  [download] Cancelled download of ${filename}`);
  return true;
}

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html", ".js": "application/javascript",
  ".css":  "text/css",  ".png": "image/png",
  ".jpg":  "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico":  "image/x-icon", ".json": "application/json", ".wav": "audio/wav", ".txt": "text/plain",
  ".woff2":"font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
};

function isModelFile(filename) {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".safetensors") || lower.endsWith(".gguf") || lower.endsWith(".ckpt") || lower.endsWith(".coreml") || lower.endsWith(".coreml.zip")) {
    return true;
  }
  const fullPath = path.join(MODELS, filename);
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(fullPath).map(f => f.toLowerCase());
      const hasTextEncoder = files.includes("text_encoder.mlpackage") || 
                             files.includes("text_encoder.mlmodelc") ||
                             files.includes("textencoder.mlpackage") || 
                             files.includes("textencoder.mlmodelc");
      
      const hasUnet = files.includes("unet.mlpackage") || 
                      files.includes("unet.mlmodelc");
                      
      if (hasTextEncoder && hasUnet) return true;
      
      const checkSubdirs = ["split_einsum/packages", "split_einsum/compiled", "original/packages", "original/compiled", "split_einsum", "original"];
      for (const subdir of checkSubdirs) {
        const subPath = path.join(fullPath, subdir);
        if (fs.existsSync(subPath)) {
          const subFiles = fs.readdirSync(subPath).map(f => f.toLowerCase());
          const subTextEncoder = subFiles.includes("text_encoder.mlpackage") || 
                                 subFiles.includes("text_encoder.mlmodelc") ||
                                 subFiles.includes("textencoder.mlpackage") || 
                                 subFiles.includes("textencoder.mlmodelc");
          const subUnet = subFiles.includes("unet.mlpackage") || 
                          subFiles.includes("unet.mlmodelc");
          if (subTextEncoder && subUnet) return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** idx)).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function getModelLoadIssue(modelPath) {
  const filename = path.basename(modelPath || "");
  const lower = filename.toLowerCase();
  const ext = path.extname(lower);
  if (!modelPath || !fs.existsSync(modelPath)) {
    return `Model file not found: ${filename || "unknown model"}`;
  }

  const size = getPathSize(modelPath);
  if (size < 128 * 1024 * 1024) {
    return `${filename} is too small to be a complete image model (${formatBytes(size)}). Delete it and download/import it again.`;
  }

  if (ext === ".gguf") {
    const knownDiffusionOnlyGguf =
      lower === "stable-diffusion-xl-base-1.0-q4_0.gguf" ||
      lower.includes("stable-diffusion-xl-base-1.0");
    const requiresSeparateComponents =
      knownDiffusionOnlyGguf ||
      lower.includes("z_image") ||
      lower.includes("z-image") ||
      lower.includes("zimage") ||
      lower.includes("qwen") ||
      lower.includes("hidream") ||
      lower.includes("hunyuan") ||
      lower.includes("wan") ||
      lower.includes("flux");

    if (requiresSeparateComponents) {
      if (knownDiffusionOnlyGguf) {
        return `${filename} is not supported as a one-click model in this app. This SDXL GGUF is a diffusion-only component and needs matching VAE/text encoder files instead of being loaded with --model. Use one of the recommended Safetensors SDXL/SD 1.5 checkpoints, or import a complete single-file GGUF checkpoint.`;
      }
      return `${filename} looks like a multi-file diffusion GGUF. This app currently loads single-file SD 1.5/SDXL checkpoints directly. Models like Z-Image, Qwen, Flux, HiDream, Hunyuan, and Wan usually need extra files such as VAE/text encoders and must be launched with --diffusion-model instead of --model.`;
    }
  }

  return null;
}

function describeBackendError(rawError, modelPath) {
  const raw = String(rawError || "").trim();
  const filename = path.basename(modelPath || "");
  const lower = filename.toLowerCase();

  if (raw.includes("read tensor data failed") || raw.includes("load tensors from file failed")) {
    return `${raw}\n\n${filename || "The selected model"} is present but appears incomplete or corrupted. Delete it from Local Models and download/import it again.`;
  }

  if (!raw.includes("new_sd_ctx_t failed")) return raw;

  if (lower.endsWith(".gguf")) {
    if (lower === "stable-diffusion-xl-base-1.0-q4_0.gguf" || lower.includes("stable-diffusion-xl-base-1.0")) {
      return `${raw}\n\n${filename} is not supported as a one-click model in this app. This SDXL GGUF is a diffusion-only component and needs matching VAE/text encoder files instead of being loaded with --model. Use one of the recommended Safetensors SDXL/SD 1.5 checkpoints, or import a complete single-file GGUF checkpoint.`;
    }
    return `${raw}\n\n${filename} could not be loaded as a single checkpoint. Some GGUF files are only the diffusion part of a larger workflow and need separate VAE/text encoder files. Try a recommended SD 1.5/SDXL model, or re-download/import the file if this is meant to be a single-file SD/SDXL GGUF.`;
  }

  return `${raw}\n\nThe backend could not create the model context. Common causes are a corrupt/incomplete model file, unsupported checkpoint type, or not enough free RAM/VRAM. Delete and re-download the model, then try CPU or Vulkan mode at 512x512.`;
}

function describeLinuxRuntimeLinkerError(rawError) {
  const raw = String(rawError || "").trim();
  const lower = raw.toLowerCase();
  if (osPlatform !== "linux") return null;
  if (!lower.includes("glibc") && !lower.includes("libstdc++") && !lower.includes("libc.so.6")) return null;

  const needsGlibc = raw.match(/GLIBC_([0-9.]+)/)?.[1];
  const needsGlibcxx = raw.match(/GLIBCXX_([0-9.]+)/)?.[1];
  const requirements = [];
  if (needsGlibc) requirements.push(`glibc ${needsGlibc}+`);
  if (needsGlibcxx) requirements.push(`GLIBCXX_${needsGlibcxx}+`);
  const requirementText = requirements.length ? requirements.join(" and ") : "newer glibc/libstdc++ runtime libraries";

  return `${raw}\n\nThe selected model is not the problem. The Linux backend binary cannot start because this OS is missing ${requirementText}. The bundled Linux backends are built for Ubuntu 24.04-era systems. Use Ubuntu 24.04+, Fedora 40+, another glibc 2.38+ distro, or build stable-diffusion.cpp from source on this machine.`;
}

function describeBackendExitCode(code, backendPath) {
  const numericCode = Number(code);
  if (osPlatform === "win32" && numericCode === 3221225781) {
    const backendName = path.basename(backendPath || BACKEND_PATH || "backend");
    const lowerBackend = backendName.toLowerCase();
    const isVulkan = lowerBackend.includes("vulkan");
    const isCuda = lowerBackend.includes("cuda");
    const likelyMissing = isVulkan
      ? "the Vulkan runtime/driver DLL, such as vulkan-1.dll"
      : isCuda
        ? "a CUDA runtime DLL or NVIDIA driver component"
        : "a required backend DLL";
    const driverHint = isVulkan
      ? "Install or update the GPU vendor driver with Vulkan support, then run setup again so the Vulkan backend folder is repaired."
      : isCuda
        ? "Install or update the NVIDIA driver, then run setup again so the CUDA backend folder is repaired."
        : "Update the GPU driver, then run setup again so the backend folder is repaired.";

    return `exited with code ${code} (0xC0000135: required DLL not found).\n\nWindows could not start ${backendName} because ${likelyMissing} is missing or not loadable. ${driverHint}\n\nIf you are using an AMD/Intel GPU, update the AMD/Intel graphics driver first. If the GPU is too old for the current Vulkan backend, switch the backend to CPU.`;
  }

  return `exited with code ${code}`;
}

function getModelInfo(filename) {
  const safeFilename = path.basename(filename || "");
  const fullPath = path.join(MODELS, safeFilename);
  const stats = fs.statSync(fullPath);
  
  if (stats.isDirectory()) {
    const dirSize = getPathSize(fullPath);
    return {
      filename: safeFilename,
      sizeBytes: dirSize,
      size: formatBytes(dirSize),
      format: "CoreML",
    };
  }

  return {
    filename: safeFilename,
    sizeBytes: stats.size,
    size: formatBytes(stats.size),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BODY_BYTES) {
        reject(new Error(`Request body is too large. Limit is ${Math.round(MAX_JSON_BODY_BYTES / (1024 * 1024))} MB.`));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end",  () => { try { resolve(JSON.parse(data || "{}")); } catch(e) { reject(new Error("Invalid JSON request body")); } });
    req.on("error", reject);
  });
}

async function readJsonBody(req, res) {
  try {
    return await readBody(req);
  } catch (err) {
    json(res, err.message.includes("too large") ? 413 : 400, { ok: false, error: err.message });
    return null;
  }
}

function safeOutputName(value) {
  return String(value || "")
    .replace(/[^a-z0-9._-]/gi, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
}

function sanitizeChatMessageForStorage(message) {
  if (!message || typeof message !== "object") return null;
  const role = String(message.role || "").trim();
  if (!["system", "user", "assistant"].includes(role)) return null;
  let content = message.content;
  if (Array.isArray(content)) {
    content = content.map((item) => {
      if (!item || typeof item !== "object") return item;
      if (item.type === "image_url") {
        return { type: "text", text: "[Attached image omitted from saved chat history]" };
      }
      return item;
    });
  } else if (typeof content !== "string") {
    content = content === undefined || content === null ? "" : String(content);
  }
  return {
    ...message,
    role,
    content,
  };
}

function sanitizeChatConversationForStorage(conversation = {}) {
  const now = Date.now();
  const id = safeOutputName(conversation.id || `chat_${now}`) || `chat_${now}`;
  const messages = Array.isArray(conversation.messages)
    ? conversation.messages.map(sanitizeChatMessageForStorage).filter(Boolean)
    : [];
  const timestamp = Number(conversation.timestamp) || now;
  return {
    id,
    title: String(conversation.title || "Chat Session").slice(0, 160),
    model: String(conversation.model || ""),
    messages,
    timestamp,
    createdAt: conversation.createdAt || new Date(timestamp).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function getChatConversationPath(id) {
  const safeId = safeOutputName(id);
  if (!safeId) throw new Error("A chat id is required.");
  const filePath = path.join(CHAT_HISTORY, `${safeId}.json`);
  if (!pathInside(filePath, CHAT_HISTORY)) {
    throw new Error("Invalid chat id.");
  }
  return filePath;
}

function saveChatConversation(conversation = {}) {
  const saved = sanitizeChatConversationForStorage(conversation);
  const filePath = getChatConversationPath(saved.id);
  fs.writeFileSync(filePath, JSON.stringify(saved, null, 2), "utf8");
  return saved;
}

function listChatConversations() {
  try {
    return fs.readdirSync(CHAT_HISTORY)
      .filter((file) => file.toLowerCase().endsWith(".json"))
      .map((file) => {
        try {
          const filePath = path.join(CHAT_HISTORY, file);
          if (!pathInside(filePath, CHAT_HISTORY)) return null;
          const conversation = JSON.parse(fs.readFileSync(filePath, "utf8"));
          const stat = fs.statSync(filePath);
          return {
            ...conversation,
            filename: file,
            modifiedAt: stat.mtime.toISOString(),
            sizeBytes: stat.size,
            size: formatBytes(stat.size),
          };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  } catch (_) {
    return [];
  }
}

function deleteChatConversation(id) {
  const filePath = getChatConversationPath(id);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

function saveGeneratedOutput(imageDataUrl, metadata = {}) {
  const match = String(imageDataUrl || "").match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
  if (!match) {
    throw new Error("Expected a real base64 PNG, JPEG, or WebP image data URL");
  }

  const mime = match[1];
  const extByMime = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
  };
  const ext = extByMime[mime] || ".png";
  const imageBuffer = Buffer.from(match[2], "base64");
  const isPng = imageBuffer.length > 8 &&
    imageBuffer[0] === 0x89 &&
    imageBuffer[1] === 0x50 &&
    imageBuffer[2] === 0x4e &&
    imageBuffer[3] === 0x47;
  const isJpeg = imageBuffer.length > 3 &&
    imageBuffer[0] === 0xff &&
    imageBuffer[1] === 0xd8 &&
    imageBuffer[2] === 0xff;
  const isWebp = imageBuffer.length > 12 &&
    imageBuffer.toString("ascii", 0, 4) === "RIFF" &&
    imageBuffer.toString("ascii", 8, 12) === "WEBP";
  if ((mime === "image/png" && !isPng) ||
      ((mime === "image/jpeg" || mime === "image/jpg") && !isJpeg) ||
      (mime === "image/webp" && !isWebp)) {
    throw new Error("Generated image payload did not match its declared image format.");
  }
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-");
  const seed = metadata.seed !== undefined && metadata.seed !== null ? `-${safeOutputName(metadata.seed)}` : "";
  const baseName = `output-${stamp}${seed}`;
  const imageFilename = `${baseName}${ext}`;
  const metadataFilename = `${baseName}.json`;
  const imagePath = path.join(OUTPUTS, imageFilename);
  const metadataPath = path.join(OUTPUTS, metadataFilename);

  fs.writeFileSync(imagePath, imageBuffer);
  const savedMetadata = {
    ...metadata,
    createdAt,
    image: imageFilename,
    metadata: metadataFilename,
  };
  fs.writeFileSync(metadataPath, JSON.stringify(savedMetadata, null, 2), "utf8");
  console.log(`  [api] Saved generated output: ${imageFilename}`);
  return savedMetadata;
}

function listGeneratedOutputs() {
  try {
    return fs.readdirSync(OUTPUTS)
      .filter(file => file.toLowerCase().endsWith(".json"))
      .map(file => {
        try {
          const metadata = JSON.parse(fs.readFileSync(path.join(OUTPUTS, file), "utf8"));
          return {
            ...metadata,
            url: `/api/output-file?filename=${encodeURIComponent(metadata.image)}`,
          };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  } catch (_) {
    return [];
  }
}

function deleteGeneratedOutputs(outputs = []) {
  const deleted = [];
  for (const output of outputs) {
    const imageFilename = path.basename(output?.image || output?.filename || "");
    const metadataFilename = path.basename(output?.metadata || "");
    if (!imageFilename && !metadataFilename) continue;

    const targets = new Set();
    if (imageFilename) targets.add(imageFilename);
    if (metadataFilename) targets.add(metadataFilename);

    if (!metadataFilename && imageFilename) {
      const stem = imageFilename.replace(/\.[^.]+$/, "");
      targets.add(`${stem}.json`);
    }

    for (const filename of targets) {
      const filePath = path.join(OUTPUTS, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted.push(filename);
      }
    }
  }
  return deleted;
}

function streamModelUpload(req, filename, targetDir = MODELS, mode = "image") {
  return new Promise((resolve, reject) => {
    const safeFilename = path.basename(filename || "");
    const lowerName = safeFilename.toLowerCase();
    const valid = mode === "text"
      ? lowerName.endsWith(".gguf")
      : mode === "speech"
        ? lowerName.endsWith(".bin")
        : mode === "tts"
          ? lowerName.endsWith(".json")
        : isModelFile(lowerName);
    if (!safeFilename || !valid) {
      reject(new Error(mode === "text"
        ? "Filename must end with .gguf"
        : mode === "speech"
          ? "Filename must end with .bin"
          : mode === "tts"
            ? "Filename must end with .json"
            : "Filename must end with .gguf, .safetensors, or .ckpt"));
      return;
    }

    const destPath = path.join(targetDir, safeFilename);
    const tempPath = `${destPath}.part`;
    const out = fs.createWriteStream(tempPath);
    let finished = false;

    const cleanupPartial = () => {
      if (finished) return;
      out.destroy();
      try { fs.unlinkSync(tempPath); } catch (_) {}
    };

    req.pipe(out);
    req.on("error", err => {
      cleanupPartial();
      reject(err);
    });
    req.on("aborted", () => {
      cleanupPartial();
      reject(new Error("Import cancelled by user"));
    });
    req.on("close", () => {
      if (!finished && req.aborted) {
        cleanupPartial();
      }
    });
    out.on("error", err => {
      cleanupPartial();
      reject(err);
    });
    out.on("finish", () => {
      try {
        finished = true;
        fs.renameSync(tempPath, destPath);
        console.log(`  [api] Imported model file: ${safeFilename}`);
        if (mode === "text" || mode === "speech") {
          const stats = fs.statSync(destPath);
          resolve({ filename: safeFilename, name: safeFilename, sizeBytes: stats.size, size: formatBytes(stats.size), format: mode === "speech" ? "Whisper GGML" : "GGUF" });
        } else {
          resolve(getModelInfo(safeFilename));
        }
      } catch (err) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
        reject(err);
      }
    });
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

// LUKE_AI_RUNTIME_DEPENDENCY_API_V2
const runtimeDependencyCatalogPath = path.join(
  ROOT,
  "app",
  "config",
  "runtime-dependencies.json"
);

function readRuntimeDependencyCatalog() {
  const raw = fs.readFileSync(
    runtimeDependencyCatalogPath,
    "utf8"
  );

  const catalog = JSON.parse(raw);

  if (
    !catalog ||
    !Array.isArray(catalog.dependencies)
  ) {
    throw new Error(
      "Runtime dependency catalog is invalid."
    );
  }

  return catalog;
}

function resolveRuntimeDependencyPath(relativePath) {
  return path.resolve(ROOT, relativePath);
}

function inspectRuntimeDependencyCheck(check) {
  if (!check || typeof check !== "object") {
    return {
      ok: false,
      error: "Invalid runtime dependency check",
    };
  }

  if (
    check.type === "file" ||
    check.type === "executable"
  ) {
    const absolutePath =
      resolveRuntimeDependencyPath(check.path);

    const exists = fs.existsSync(absolutePath);
    let executable = false;

    if (exists && check.type === "executable") {
      try {
        fs.accessSync(
          absolutePath,
          fs.constants.X_OK
        );

        executable = true;
      } catch {}
    }

    return {
      type: check.type,
      path: absolutePath,
      exists,
      executable:
        check.type === "executable"
          ? executable
          : undefined,
      ok:
        check.type === "executable"
          ? exists && executable
          : exists,
    };
  }

  if (check.type === "directory") {
    const absolutePath =
      resolveRuntimeDependencyPath(check.path);

    const exists = fs.existsSync(absolutePath);
    let directory = false;
    let writable = false;

    if (exists) {
      try {
        directory =
          fs.statSync(absolutePath).isDirectory();

        fs.accessSync(
          absolutePath,
          fs.constants.W_OK
        );

        writable = true;
      } catch {}
    }

    return {
      type: check.type,
      path: absolutePath,
      exists,
      directory,
      writable,
      ok: exists && directory && writable,
    };
  }

  if (check.type === "python-module") {
    return {
      type: check.type,
      module: check.module,
      status: "not-probed",
      ok: false,
    };
  }

  return {
    type: check.type,
    ok: false,
    error: "Unsupported runtime dependency check",
  };
}

function buildRuntimeDependencyStatus() {
  const catalog = readRuntimeDependencyCatalog();

  const dependencies = catalog.dependencies.map(
    (dependency) => {
      const checks = Array.isArray(dependency.checks)
        ? dependency.checks.map(
            inspectRuntimeDependencyCheck
          )
        : [];

      const installed =
        checks.length > 0 &&
        checks.every(
          (check) => check.ok === true
        );

      return {
        id: dependency.id,
        name: dependency.name,
        category: dependency.category,
        required: dependency.required === true,
        platforms: dependency.platforms || [],
        installed,
        state: installed ? "ready" : "missing",
        checks,
        install: dependency.install || {},
      };
    }
  );

  const required = dependencies.filter(
    (dependency) => dependency.required
  );

  const optional = dependencies.filter(
    (dependency) => !dependency.required
  );

  return {
    ok: required.every(
      (dependency) => dependency.installed
    ),
    platform: `${process.platform}-${process.arch}`,
    catalogVersion: catalog.catalogVersion,
    defaultDownloadDirectory:
      catalog.defaultDownloadDirectory,
    fallbackDownloadDirectory:
      catalog.fallbackDownloadDirectory,
    summary: {
      total: dependencies.length,
      ready: dependencies.filter(
        (dependency) => dependency.installed
      ).length,
      missing: dependencies.filter(
        (dependency) => !dependency.installed
      ).length,
      requiredMissing: required.filter(
        (dependency) => !dependency.installed
      ).length,
      optionalMissing: optional.filter(
        (dependency) => !dependency.installed
      ).length,
    },
    dependencies,
  };
}


// LUKE_AI_RUNTIME_INSTALL_STATE_MACHINE_V1
const runtimeInstallStatePath = path.join(
  ROOT,
  "app",
  "runtime-state",
  "install-jobs.json"
);

const runtimeInstallTransitions = {
  queued: ["preparing", "cancelled"],
  preparing: ["downloading", "failed", "cancelled"],
  downloading: ["verifying", "failed", "cancelled"],
  verifying: ["installing", "failed", "cancelled"],
  installing: ["completed", "rolling-back", "failed"],
  "rolling-back": ["rolled-back", "failed"],
  completed: [],
  failed: ["rolling-back"],
  cancelled: [],
  "rolled-back": [],
};

function ensureRuntimeInstallStateFile() {
  fs.mkdirSync(
    path.dirname(runtimeInstallStatePath),
    {
      recursive: true,
    }
  );

  if (!fs.existsSync(runtimeInstallStatePath)) {
    fs.writeFileSync(
      runtimeInstallStatePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          updatedAt: null,
          jobs: [],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }
}

function readRuntimeInstallState() {
  ensureRuntimeInstallStateFile();

  const raw = fs.readFileSync(
    runtimeInstallStatePath,
    "utf8"
  );

  const state = JSON.parse(raw);

  if (!state || !Array.isArray(state.jobs)) {
    throw new Error(
      "Runtime install state is invalid."
    );
  }

  return state;
}

function writeRuntimeInstallState(state) {
  state.updatedAt = new Date().toISOString();

  const temporaryPath =
    `${runtimeInstallStatePath}.tmp`;

  fs.writeFileSync(
    temporaryPath,
    JSON.stringify(state, null, 2) + "\n",
    "utf8"
  );

  fs.renameSync(
    temporaryPath,
    runtimeInstallStatePath
  );
}

function createRuntimeInstallJob(
  dependencyId,
  downloadDirectory
) {
  const catalog = readRuntimeDependencyCatalog();

  const dependency = catalog.dependencies.find(
    (item) => item.id === dependencyId
  );

  if (!dependency) {
    const error = new Error(
      `Unknown runtime dependency: ${dependencyId}`
    );

    error.statusCode = 404;
    throw error;
  }

  const state = readRuntimeInstallState();

  const activeJob = state.jobs.find(
    (job) =>
      job.dependencyId === dependencyId &&
      ![
        "completed",
        "failed",
        "cancelled",
        "rolled-back",
      ].includes(job.state)
  );

  if (activeJob) {
    const error = new Error(
      `An install job is already active for ${dependencyId}`
    );

    error.statusCode = 409;
    throw error;
  }

  const now = new Date().toISOString();

  const job = {
    id:
      `runtime-${Date.now()}-` +
      Math.random().toString(16).slice(2, 10),
    dependencyId,
    state: "queued",
    progress: {
      percent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      speedBytesPerSecond: 0,
    },
    downloadDirectory:
      downloadDirectory ||
      resolveRuntimeStorageDirectory({
        create: true,
        createFallback: true,
      }).selectedDirectory ||
      catalog.fallbackDownloadDirectory,
    checksum: {
      algorithm: "sha256",
      expected: null,
      actual: null,
      verified: false,
    },
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };

  state.jobs.unshift(job);

  state.jobs = state.jobs.slice(0, 100);

  writeRuntimeInstallState(state);

  return job;
}

function updateRuntimeInstallJob(
  jobId,
  nextState,
  progress = {}
) {
  const state = readRuntimeInstallState();

  const job = state.jobs.find(
    (item) => item.id === jobId
  );

  if (!job) {
    const error = new Error(
      `Runtime install job not found: ${jobId}`
    );

    error.statusCode = 404;
    throw error;
  }

  if (
    nextState &&
    nextState !== job.state
  ) {
    const allowed =
      runtimeInstallTransitions[job.state] || [];

    if (!allowed.includes(nextState)) {
      const error = new Error(
        `Invalid runtime install transition: ` +
        `${job.state} -> ${nextState}`
      );

      error.statusCode = 409;
      throw error;
    }

    job.state = nextState;
  }

  if (
    progress &&
    typeof progress === "object"
  ) {
    if (
      Number.isFinite(progress.percent)
    ) {
      job.progress.percent = Math.max(
        0,
        Math.min(100, progress.percent)
      );
    }

    if (
      Number.isFinite(progress.downloadedBytes)
    ) {
      job.progress.downloadedBytes =
        Math.max(0, progress.downloadedBytes);
    }

    if (
      Number.isFinite(progress.totalBytes)
    ) {
      job.progress.totalBytes =
        Math.max(0, progress.totalBytes);
    }

    if (
      Number.isFinite(progress.speedBytesPerSecond)
    ) {
      job.progress.speedBytesPerSecond =
        Math.max(
          0,
          progress.speedBytesPerSecond
        );
    }
  }

  if (job.state === "completed") {
    job.progress.percent = 100;
    job.completedAt = new Date().toISOString();
  }

  if (
    ["failed", "cancelled", "rolled-back"].includes(
      job.state
    )
  ) {
    job.completedAt = new Date().toISOString();
  }

  job.updatedAt = new Date().toISOString();

  writeRuntimeInstallState(state);

  return job;
}

function getRuntimeInstallJob(jobId) {
  const state = readRuntimeInstallState();

  return state.jobs.find(
    (job) => job.id === jobId
  ) || null;
}

function listRuntimeInstallJobs() {
  return readRuntimeInstallState().jobs;
}

function readJsonRequestBody(req, limitBytes = 1048576) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;

      if (size > limitBytes) {
        const error = new Error(
          "Request body is too large."
        );

        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(
          JSON.parse(
            Buffer.concat(chunks).toString("utf8")
          )
        );
      } catch {
        const error = new Error(
          "Invalid JSON request body."
        );

        error.statusCode = 400;
        reject(error);
      }
    });

    req.on("error", reject);
  });
}


// LUKE_AI_RUNTIME_SAFE_DOWNLOAD_WORKER_V1
const runtimeDownloadControllers = new Map();

function getRuntimeDownloadRoot(job) {
  if (
    typeof job.downloadDirectory === "string" &&
    job.downloadDirectory.trim()
  ) {
    return expandRuntimeHomePath(
      job.downloadDirectory
    );
  }

  const storage =
    resolveRuntimeStorageDirectory({
      create: true,
      createFallback: true,
    });

  if (
    !storage.ok ||
    !storage.selectedDirectory
  ) {
    const error = new Error(
      "No writable runtime download directory is available."
    );

    error.code =
      "RUNTIME_STORAGE_UNAVAILABLE";

    throw error;
  }

  return storage.selectedDirectory;
}

function getRuntimeJobPaths(job) {
  const root = getRuntimeDownloadRoot(job);
  const jobRoot = path.join(
    root,
    ".luke-runtime",
    job.id
  );

  return {
    root,
    jobRoot,
    temporaryFile: path.join(
      jobRoot,
      "download.part"
    ),
    verifiedFile: path.join(
      jobRoot,
      "download.verified"
    ),
    installDirectory: path.join(
      root,
      "installed",
      job.dependencyId
    ),
    backupDirectory: path.join(
      root,
      ".luke-runtime-backups",
      `${job.dependencyId}-${job.id}`
    ),
  };
}

function ensureWritableDirectory(directory) {
  fs.mkdirSync(directory, {
    recursive: true,
  });

  fs.accessSync(
    directory,
    fs.constants.W_OK
  );
}

function calculateFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = require("node:crypto").createHash("sha256");
    const input = fs.createReadStream(filePath);

    input.on("error", reject);

    input.on("data", (chunk) => {
      hash.update(chunk);
    });

    input.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

function removeRuntimePath(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return;
  }

  fs.rmSync(targetPath, {
    recursive: true,
    force: true,
  });
}

function copyRuntimePath(source, destination) {
  if (!fs.existsSync(source)) {
    return;
  }

  ensureWritableDirectory(
    path.dirname(destination)
  );

  fs.cpSync(
    source,
    destination,
    {
      recursive: true,
      force: true,
    }
  );
}

function updateRuntimeJobFields(
  jobId,
  fields = {}
) {
  const state = readRuntimeInstallState();

  const job = state.jobs.find(
    (item) => item.id === jobId
  );

  if (!job) {
    const error = new Error(
      `Runtime install job not found: ${jobId}`
    );

    error.statusCode = 404;
    throw error;
  }

  Object.assign(job, fields);
  job.updatedAt = new Date().toISOString();

  writeRuntimeInstallState(state);

  return job;
}

function getRuntimeDependencyAsset(
  dependencyId,
  override = {}
) {
  const catalog = readRuntimeDependencyCatalog();

  const dependency = catalog.dependencies.find(
    (item) => item.id === dependencyId
  );

  if (!dependency) {
    const error = new Error(
      `Unknown runtime dependency: ${dependencyId}`
    );

    error.statusCode = 404;
    throw error;
  }

  const source = {
    ...(dependency.download || {}),
    ...(override || {}),
  };

  if (
    typeof source.url !== "string" ||
    !source.url.trim()
  ) {
    const error = new Error(
      `No download URL configured for ${dependencyId}`
    );

    error.statusCode = 400;
    throw error;
  }

  if (
    typeof source.sha256 !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(source.sha256)
  ) {
    const error = new Error(
      `A valid SHA256 is required for ${dependencyId}`
    );

    error.statusCode = 400;
    throw error;
  }

  return {
    dependency,
    url: source.url.trim(),
    sha256: source.sha256.toLowerCase(),
    filename:
      typeof source.filename === "string" &&
      source.filename.trim()
        ? path.basename(source.filename.trim())
        : `${dependencyId}.package`,
  };
}

async function downloadRuntimeAsset(
  job,
  asset,
  controller
) {
  const paths = getRuntimeJobPaths(job);

  ensureWritableDirectory(paths.jobRoot);

  removeRuntimePath(paths.temporaryFile);
  removeRuntimePath(paths.verifiedFile);

  const response = await fetch(
    asset.url,
    {
      redirect: "follow",
      signal: controller.signal,
    }
  );

  if (!response.ok || !response.body) {
    throw new Error(
      `Runtime download failed with HTTP ${response.status}`
    );
  }

  const totalBytesHeader =
    response.headers.get("content-length");

  const totalBytes =
    totalBytesHeader &&
    Number.isFinite(Number(totalBytesHeader))
      ? Number(totalBytesHeader)
      : null;

  const output = fs.createWriteStream(
    paths.temporaryFile,
    {
      flags: "wx",
    }
  );

  const reader = response.body.getReader();
  const startedAt = Date.now();
  let downloadedBytes = 0;
  let lastPersistedAt = 0;

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      const chunk = Buffer.from(result.value);

      await new Promise((resolve, reject) => {
        output.write(chunk, (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      downloadedBytes += chunk.length;

      const now = Date.now();

      if (
        now - lastPersistedAt >= 250 ||
        (
          totalBytes &&
          downloadedBytes >= totalBytes
        )
      ) {
        const elapsedSeconds = Math.max(
          0.001,
          (now - startedAt) / 1000
        );

        const percent = totalBytes
          ? Math.min(
              99,
              Math.floor(
                downloadedBytes /
                totalBytes *
                100
              )
            )
          : 0;

        updateRuntimeInstallJob(
          job.id,
          undefined,
          {
            percent,
            downloadedBytes,
            totalBytes,
            speedBytesPerSecond:
              Math.floor(
                downloadedBytes /
                elapsedSeconds
              ),
          }
        );

        lastPersistedAt = now;
      }
    }
  } finally {
    await new Promise((resolve) => {
      output.end(resolve);
    });
  }

  return {
    ...paths,
    downloadedBytes,
    totalBytes,
  };
}

async function verifyRuntimeDownload(
  job,
  asset,
  paths
) {
  const actualSha256 =
    await calculateFileSha256(
      paths.temporaryFile
    );

  updateRuntimeJobFields(
    job.id,
    {
      checksum: {
        algorithm: "sha256",
        expected: asset.sha256,
        actual: actualSha256,
        verified:
          actualSha256 === asset.sha256,
      },
    }
  );

  if (actualSha256 !== asset.sha256) {
    const error = new Error(
      "Runtime package SHA256 verification failed."
    );

    error.code = "CHECKSUM_MISMATCH";
    throw error;
  }

  fs.renameSync(
    paths.temporaryFile,
    paths.verifiedFile
  );

  return actualSha256;
}

function prepareRuntimeRollback(job, paths) {
  removeRuntimePath(paths.backupDirectory);

  if (fs.existsSync(paths.installDirectory)) {
    copyRuntimePath(
      paths.installDirectory,
      paths.backupDirectory
    );
  }

  updateRuntimeJobFields(
    job.id,
    {
      rollback: {
        backupDirectory:
          paths.backupDirectory,
        previousInstallExisted:
          fs.existsSync(
            paths.backupDirectory
          ),
        restored: false,
      },
    }
  );
}

function installRuntimePackage(job, asset, paths) {
  ensureWritableDirectory(
    paths.installDirectory
  );

  const destination = path.join(
    paths.installDirectory,
    asset.filename
  );

  fs.copyFileSync(
    paths.verifiedFile,
    destination
  );

  updateRuntimeJobFields(
    job.id,
    {
      installedAsset: {
        path: destination,
        filename: asset.filename,
        sha256: asset.sha256,
      },
    }
  );

  return destination;
}

function rollbackRuntimeInstallation(
  job,
  paths
) {
  removeRuntimePath(
    paths.installDirectory
  );

  if (
    fs.existsSync(
      paths.backupDirectory
    )
  ) {
    copyRuntimePath(
      paths.backupDirectory,
      paths.installDirectory
    );
  }

  updateRuntimeJobFields(
    job.id,
    {
      rollback: {
        ...job.rollback,
        restored: true,
        restoredAt:
          new Date().toISOString(),
      },
    }
  );
}

async function runRuntimeInstallJob(
  jobId,
  assetOverride = {}
) {
  let job = getRuntimeInstallJob(jobId);

  if (!job) {
    throw new Error(
      `Runtime install job not found: ${jobId}`
    );
  }

  const controller = new AbortController();

  runtimeDownloadControllers.set(
    jobId,
    controller
  );

  let paths = null;

  try {
    const asset = getRuntimeDependencyAsset(
      job.dependencyId,
      assetOverride
    );

    job = updateRuntimeInstallJob(
      jobId,
      "preparing",
      {
        percent: 1,
      }
    );

    paths = getRuntimeJobPaths(job);

    ensureWritableDirectory(paths.root);
    ensureWritableDirectory(paths.jobRoot);

    updateRuntimeJobFields(
      jobId,
      {
        source: {
          url: asset.url,
          filename: asset.filename,
        },
        error: null,
      }
    );

    job = updateRuntimeInstallJob(
      jobId,
      "downloading",
      {
        percent: 2,
      }
    );

    paths = await downloadRuntimeAsset(
      job,
      asset,
      controller
    );

    job = updateRuntimeInstallJob(
      jobId,
      "verifying",
      {
        percent: 99,
        downloadedBytes:
          paths.downloadedBytes,
        totalBytes:
          paths.totalBytes ||
          paths.downloadedBytes,
      }
    );

    await verifyRuntimeDownload(
      job,
      asset,
      paths
    );

    job = updateRuntimeInstallJob(
      jobId,
      "installing",
      {
        percent: 99,
      }
    );

    prepareRuntimeRollback(
      job,
      paths
    );

    installRuntimePackage(
      job,
      asset,
      paths
    );

    job = updateRuntimeInstallJob(
      jobId,
      "completed",
      {
        percent: 100,
      }
    );

    updateRuntimeJobFields(
      jobId,
      {
        error: null,
      }
    );

    removeRuntimePath(paths.jobRoot);

    return getRuntimeInstallJob(jobId);
  } catch (error) {
    job = getRuntimeInstallJob(jobId);

    const cancelled =
      error &&
      (
        error.name === "AbortError" ||
        error.code === "ABORT_ERR"
      );

    if (cancelled) {
      if (
        job &&
        ![
          "completed",
          "cancelled",
          "rolled-back",
        ].includes(job.state)
      ) {
        updateRuntimeInstallJob(
          jobId,
          "cancelled"
        );
      }
    } else {
      if (
        job &&
        job.state === "installing"
      ) {
        updateRuntimeInstallJob(
          jobId,
          "rolling-back"
        );

        rollbackRuntimeInstallation(
          getRuntimeInstallJob(jobId),
          paths || getRuntimeJobPaths(job)
        );

        updateRuntimeInstallJob(
          jobId,
          "rolled-back"
        );
      } else if (
        job &&
        ![
          "failed",
          "cancelled",
          "rolled-back",
        ].includes(job.state)
      ) {
        updateRuntimeInstallJob(
          jobId,
          "failed"
        );
      }

      updateRuntimeJobFields(
        jobId,
        {
          error: {
            message:
              error instanceof Error
                ? error.message
                : String(error),
            code:
              error && error.code
                ? String(error.code)
                : null,
            occurredAt:
              new Date().toISOString(),
          },
        }
      );
    }

    if (paths) {
      removeRuntimePath(
        paths.temporaryFile
      );

      removeRuntimePath(
        paths.verifiedFile
      );
    }

    throw error;
  } finally {
    runtimeDownloadControllers.delete(jobId);
  }
}

function startRuntimeInstallJob(
  jobId,
  assetOverride = {}
) {
  setImmediate(() => {
    runRuntimeInstallJob(
      jobId,
      assetOverride
    ).catch((error) => {
      console.error(
        `[runtime] Install job ${jobId} failed:`,
        error instanceof Error
          ? error.message
          : String(error)
      );
    });
  });
}

function cancelRuntimeInstallWorker(jobId) {
  const controller =
    runtimeDownloadControllers.get(jobId);

  if (controller) {
    controller.abort();
    return true;
  }

  return false;
}


// LUKE_AI_RUNTIME_STORAGE_AVAILABILITY_V1
function expandRuntimeHomePath(value) {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return "";
  }

  const homeDirectory =
    process.env.HOME ||
    process.env.USERPROFILE ||
    ROOT;

  return path.resolve(
    value.trim().replace(
      /^~(?=$|\/)/,
      homeDirectory
    )
  );
}

function inspectRuntimeStorageDirectory(
  directory,
  options = {}
) {
  const resolvedPath =
    expandRuntimeHomePath(directory);

  const result = {
    path: resolvedPath,
    exists: false,
    directory: false,
    writable: false,
    created: false,
    freeBytes: null,
    totalBytes: null,
    error: null,
  };

  if (!resolvedPath) {
    result.error =
      "Runtime storage path is empty.";

    return result;
  }

  try {
    if (
      !fs.existsSync(resolvedPath) &&
      options.create === true
    ) {
      fs.mkdirSync(
        resolvedPath,
        {
          recursive: true,
        }
      );

      result.created = true;
    }

    result.exists =
      fs.existsSync(resolvedPath);

    if (!result.exists) {
      return result;
    }

    result.directory =
      fs.statSync(resolvedPath).isDirectory();

    if (!result.directory) {
      result.error =
        "Runtime storage path is not a directory.";

      return result;
    }

    fs.accessSync(
      resolvedPath,
      fs.constants.W_OK
    );

    result.writable = true;

    if (typeof fs.statfsSync === "function") {
      const stats =
        fs.statfsSync(resolvedPath);

      result.freeBytes =
        Number(stats.bavail) *
        Number(stats.bsize);

      result.totalBytes =
        Number(stats.blocks) *
        Number(stats.bsize);
    }
  } catch (error) {
    result.error =
      error instanceof Error
        ? error.message
        : String(error);
  }

  return result;
}

function resolveRuntimeStorageDirectory(
  options = {}
) {
  const catalog =
    readRuntimeDependencyCatalog();

  const policy =
    catalog.storagePolicy || {};

  const minimumFreeBytes =
    Number.isFinite(
      Number(policy.minimumFreeBytes)
    )
      ? Number(policy.minimumFreeBytes)
      : 0;

  // LUKE_AI_RUNTIME_STORAGE_MOUNT_GUARD_V1
  const preferredDirectory =
    expandRuntimeHomePath(
      catalog.defaultDownloadDirectory
    );

  const configuredExternalRoot =
    expandRuntimeHomePath(
      policy.externalVolumeRoot || ""
    );

  const externalRootMounted =
    Boolean(configuredExternalRoot) &&
    fs.existsSync(configuredExternalRoot) &&
    fs.statSync(configuredExternalRoot).isDirectory();

  const preferredIsInsideExternalRoot =
    externalRootMounted &&
    (
      preferredDirectory === configuredExternalRoot ||
      preferredDirectory.startsWith(
        `${configuredExternalRoot}${path.sep}`
      )
    );

  const mayCreateExternalDirectory =
    options.create === true &&
    policy.createDirectoryWhenWritable === true &&
    preferredIsInsideExternalRoot;

  const external =
    inspectRuntimeStorageDirectory(
      preferredDirectory,
      {
        create: mayCreateExternalDirectory,
      }
    );

  external.volumeRoot =
    configuredExternalRoot || null;

  external.volumeMounted =
    externalRootMounted;

  external.creationAllowed =
    mayCreateExternalDirectory;

  const externalHasSpace =
    external.freeBytes === null ||
    external.freeBytes >= minimumFreeBytes;

  const externalAvailable =
    external.exists &&
    external.directory &&
    external.writable &&
    externalHasSpace;

  const fallback =
    inspectRuntimeStorageDirectory(
      catalog.fallbackDownloadDirectory,
      {
        create:
          options.createFallback !== false,
      }
    );

  const fallbackHasSpace =
    fallback.freeBytes === null ||
    fallback.freeBytes >= minimumFreeBytes;

  const fallbackAvailable =
    fallback.exists &&
    fallback.directory &&
    fallback.writable &&
    fallbackHasSpace;

  let selected = null;
  let usingFallback = false;
  let reason = null;

  if (externalAvailable) {
    selected = external;
  } else if (
    policy.fallbackWhenUnavailable !== false &&
    fallbackAvailable
  ) {
    selected = fallback;
    usingFallback = true;

    if (!external.exists) {
      reason = "external-drive-not-mounted";
    } else if (!external.directory) {
      reason = "external-path-not-directory";
    } else if (!external.writable) {
      reason = "external-path-not-writable";
    } else if (!externalHasSpace) {
      reason = "external-drive-low-space";
    } else {
      reason = "external-drive-unavailable";
    }
  } else {
    reason = "no-writable-storage";
  }

  return {
    ok: Boolean(selected),
    preferredDirectory,
    externalVolumeRoot:
      configuredExternalRoot || null,
    externalVolumeMounted:
      externalRootMounted,
    externalDirectoryCreationAllowed:
      mayCreateExternalDirectory,
    fallbackDirectory:
      expandRuntimeHomePath(
        catalog.fallbackDownloadDirectory
      ),
    selectedDirectory:
      selected?.path || null,
    usingFallback,
    reason,
    minimumFreeBytes,
    external,
    fallback,
  };
}


// LUKE_AI_RUNTIME_STORAGE_CLEANUP_V1
const runtimeCleanupCategories = {
  outputs: {
    label: "Generated outputs",
    path: path.join(ROOT, "app", "outputs"),
    cleanupAllowed: true,
    preserveDirectory: true,
  },
  transcriptions: {
    label: "Transcriptions",
    path: path.join(ROOT, "app", "transcriptions"),
    cleanupAllowed: true,
    preserveDirectory: true,
  },
  cache: {
    label: "Runtime cache",
    resolvePath() {
      const storage =
        resolveRuntimeStorageDirectory({
          create: false,
          createFallback: true,
        });

      return storage.selectedDirectory
        ? path.join(
            storage.selectedDirectory,
            ".luke-runtime"
          )
        : null;
    },
    cleanupAllowed: true,
    preserveDirectory: true,
  },
  backups: {
    label: "Runtime backups",
    resolvePath() {
      const storage =
        resolveRuntimeStorageDirectory({
          create: false,
          createFallback: true,
        });

      return storage.selectedDirectory
        ? path.join(
            storage.selectedDirectory,
            ".luke-runtime-backups"
          )
        : null;
    },
    cleanupAllowed: true,
    preserveDirectory: true,
  },
  models: {
    label: "AI models",
    path: path.join(ROOT, "app", "models"),
    cleanupAllowed: false,
    preserveDirectory: true,
  },
  chatHistory: {
    label: "Chat history",
    path: path.join(ROOT, "app", "chat-history"),
    cleanupAllowed: false,
    preserveDirectory: true,
  },
  installedRuntimes: {
    label: "Installed runtimes",
    resolvePath() {
      const storage =
        resolveRuntimeStorageDirectory({
          create: false,
          createFallback: true,
        });

      return storage.selectedDirectory
        ? path.join(
            storage.selectedDirectory,
            "installed"
          )
        : null;
    },
    cleanupAllowed: false,
    preserveDirectory: true,
  },
};

function resolveRuntimeCleanupCategoryPath(
  category
) {
  if (!category) {
    return null;
  }

  if (typeof category.resolvePath === "function") {
    return category.resolvePath();
  }

  return category.path || null;
}

function isPathInside(parentPath, childPath) {
  if (!parentPath || !childPath) {
    return false;
  }

  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);

  return (
    child === parent ||
    child.startsWith(`${parent}${path.sep}`)
  );
}

function collectRuntimeProtectedPaths() {
  const protectedPaths = new Set();
  const state = readRuntimeInstallState();

  for (const job of state.jobs) {
    if (
      !job ||
      ![
        "queued",
        "preparing",
        "downloading",
        "verifying",
        "installing",
        "rolling-back",
      ].includes(job.state)
    ) {
      continue;
    }

    const paths = getRuntimeJobPaths(job);

    for (const protectedPath of [
      paths.jobRoot,
      paths.temporaryFile,
      paths.verifiedFile,
      paths.installDirectory,
      paths.backupDirectory,
      job.installedAsset?.path,
    ]) {
      if (protectedPath) {
        protectedPaths.add(
          path.resolve(protectedPath)
        );
      }
    }
  }

  return [...protectedPaths];
}

function isRuntimePathProtected(
  candidatePath,
  protectedPaths
) {
  const candidate = path.resolve(candidatePath);

  return protectedPaths.some(
    (protectedPath) =>
      isPathInside(candidate, protectedPath) ||
      isPathInside(protectedPath, candidate)
  );
}

// LUKE_AI_RUNTIME_STORAGE_CLEANUP_PROTECTION_FIX_V1
function isRuntimeCleanupRootBlocked(
  cleanupRoot,
  protectedPaths
) {
  const resolvedRoot = path.resolve(cleanupRoot);

  return protectedPaths.some(
    (protectedPath) =>
      isPathInside(
        path.resolve(protectedPath),
        resolvedRoot
      )
  );
}

function inspectRuntimeStorageEntry(
  entryPath,
  protectedPaths
) {
  const resolvedPath = path.resolve(entryPath);

  const result = {
    path: resolvedPath,
    exists: false,
    type: "missing",
    sizeBytes: 0,
    fileCount: 0,
    directoryCount: 0,
    symlinkCount: 0,
    protected: isRuntimeCleanupRootBlocked(
      resolvedPath,
      protectedPaths
    ),
    error: null,
  };

  if (!fs.existsSync(resolvedPath)) {
    return result;
  }

  try {
    const rootStat = fs.lstatSync(resolvedPath);

    result.exists = true;

    if (rootStat.isSymbolicLink()) {
      result.type = "symlink";
      result.symlinkCount = 1;
      result.protected = true;
      return result;
    }

    if (rootStat.isFile()) {
      result.type = "file";
      result.sizeBytes = rootStat.size;
      result.fileCount = 1;
      return result;
    }

    if (!rootStat.isDirectory()) {
      result.type = "other";
      result.protected = true;
      return result;
    }

    result.type = "directory";

    const stack = [resolvedPath];

    while (stack.length > 0) {
      const current = stack.pop();

      let entries = [];

      try {
        entries = fs.readdirSync(
          current,
          {
            withFileTypes: true,
          }
        );
      } catch (error) {
        result.error =
          error instanceof Error
            ? error.message
            : String(error);

        continue;
      }

      for (const entry of entries) {
        const childPath = path.join(
          current,
          entry.name
        );

        let stat;

        try {
          stat = fs.lstatSync(childPath);
        } catch {
          continue;
        }

        if (stat.isSymbolicLink()) {
          result.symlinkCount += 1;
          continue;
        }

        if (stat.isDirectory()) {
          result.directoryCount += 1;
          stack.push(childPath);
          continue;
        }

        if (stat.isFile()) {
          result.fileCount += 1;
          result.sizeBytes += stat.size;
        }
      }
    }
  } catch (error) {
    result.error =
      error instanceof Error
        ? error.message
        : String(error);
  }

  return result;
}

function buildRuntimeStorageUsage() {
  const protectedPaths =
    collectRuntimeProtectedPaths();

  const categories = Object.entries(
    runtimeCleanupCategories
  ).map(([id, category]) => {
    const categoryPath =
      resolveRuntimeCleanupCategoryPath(
        category
      );

    const usage = categoryPath
      ? inspectRuntimeStorageEntry(
          categoryPath,
          protectedPaths
        )
      : {
          path: null,
          exists: false,
          type: "missing",
          sizeBytes: 0,
          fileCount: 0,
          directoryCount: 0,
          symlinkCount: 0,
          protected: false,
          error: null,
        };

    return {
      id,
      label: category.label,
      cleanupAllowed:
        category.cleanupAllowed === true,
      preserveDirectory:
        category.preserveDirectory === true,
      ...usage,
    };
  });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    protectedPaths,
    summary: {
      totalBytes: categories.reduce(
        (total, category) =>
          total + category.sizeBytes,
        0
      ),
      cleanableBytes: categories
        .filter(
          (category) =>
            category.cleanupAllowed &&
            !category.protected
        )
        .reduce(
          (total, category) =>
            total + category.sizeBytes,
          0
        ),
      categoryCount: categories.length,
      protectedCategoryCount:
        categories.filter(
          (category) => category.protected
        ).length,
    },
    categories,
  };
}

function removeRuntimeCleanupContents(
  rootPath,
  protectedPaths,
  options = {}
) {
  const resolvedRoot = path.resolve(rootPath);

  const result = {
    deletedBytes: 0,
    deletedFiles: 0,
    deletedDirectories: 0,
    skippedProtected: [],
    skippedSymlinks: [],
    errors: [],
  };

  if (!fs.existsSync(resolvedRoot)) {
    return result;
  }

  const rootStat = fs.lstatSync(resolvedRoot);

  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory()
  ) {
    result.errors.push(
      "Cleanup root must be a real directory."
    );

    return result;
  }

  function visit(directory) {
    let entries = [];

    try {
      entries = fs.readdirSync(
        directory,
        {
          withFileTypes: true,
        }
      );
    } catch (error) {
      result.errors.push(
        error instanceof Error
          ? error.message
          : String(error)
      );

      return;
    }

    for (const entry of entries) {
      const childPath = path.join(
        directory,
        entry.name
      );

      if (
        !isPathInside(
          resolvedRoot,
          childPath
        )
      ) {
        result.errors.push(
          `Unsafe cleanup path rejected: ${childPath}`
        );

        continue;
      }

      let stat;

      try {
        stat = fs.lstatSync(childPath);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) {
        result.skippedSymlinks.push(
          childPath
        );

        continue;
      }

      if (
        isRuntimePathProtected(
          childPath,
          protectedPaths
        )
      ) {
        result.skippedProtected.push(
          childPath
        );

        continue;
      }

      if (stat.isDirectory()) {
        visit(childPath);

        if (options.dryRun !== true) {
          try {
            const remaining =
              fs.readdirSync(childPath);

            if (remaining.length === 0) {
              fs.rmdirSync(childPath);
              result.deletedDirectories += 1;
            }
          } catch (error) {
            result.errors.push(
              error instanceof Error
                ? error.message
                : String(error)
            );
          }
        }

        continue;
      }

      if (stat.isFile()) {
        result.deletedBytes += stat.size;
        result.deletedFiles += 1;

        if (options.dryRun !== true) {
          try {
            fs.unlinkSync(childPath);
          } catch (error) {
            result.errors.push(
              error instanceof Error
                ? error.message
                : String(error)
            );
          }
        }
      }
    }
  }

  visit(resolvedRoot);

  return result;
}

function cleanupRuntimeStorageCategory(
  categoryId,
  options = {}
) {
  const category =
    runtimeCleanupCategories[categoryId];

  if (!category) {
    const error = new Error(
      `Unknown cleanup category: ${categoryId}`
    );

    error.statusCode = 404;
    throw error;
  }

  if (category.cleanupAllowed !== true) {
    const error = new Error(
      `Cleanup is not allowed for ${categoryId}`
    );

    error.statusCode = 403;
    throw error;
  }

  const categoryPath =
    resolveRuntimeCleanupCategoryPath(
      category
    );

  if (!categoryPath) {
    const error = new Error(
      `Cleanup path is unavailable for ${categoryId}`
    );

    error.statusCode = 503;
    throw error;
  }

  const protectedPaths =
    collectRuntimeProtectedPaths();

  if (
    isRuntimeCleanupRootBlocked(
      categoryPath,
      protectedPaths
    )
  ) {
    const error = new Error(
      `Cleanup category root is currently protected: ${categoryId}`
    );

    error.statusCode = 409;
    throw error;
  }

  const before =
    inspectRuntimeStorageEntry(
      categoryPath,
      protectedPaths
    );

  const cleanup =
    removeRuntimeCleanupContents(
      categoryPath,
      protectedPaths,
      {
        dryRun: options.dryRun === true,
      }
    );

  const after =
    options.dryRun === true
      ? before
      : inspectRuntimeStorageEntry(
          categoryPath,
          protectedPaths
        );

  return {
    ok: cleanup.errors.length === 0,
    categoryId,
    dryRun: options.dryRun === true,
    before,
    after,
    cleanup,
  };
}


// LUKE_AI_TEXT_MODEL_CATALOG_QUEUE_V1
const textModelCatalogPath = path.join(
  ROOT,
  "app",
  "config",
  "text-models",
  "signed-catalog.json"
);

const textModelPolicyPath = path.join(
  ROOT,
  "app",
  "config",
  "text-models",
  "catalog-policy.json"
);

const textModelQueuePath = path.join(
  ROOT,
  "app",
  "runtime-state",
  "text-models",
  "download-queue.json"
);

function readJsonFileStrict(filePath, label) {
  const value = JSON.parse(
    fs.readFileSync(filePath, "utf8")
  );

  if (!value || typeof value !== "object") {
    throw new Error(`${label} is invalid.`);
  }

  return value;
}

function writeJsonFileAtomic(filePath, value) {
  fs.mkdirSync(
    path.dirname(filePath),
    {
      recursive: true,
    }
  );

  const temporaryPath = `${filePath}.tmp`;

  fs.writeFileSync(
    temporaryPath,
    JSON.stringify(value, null, 2) + "\n",
    "utf8"
  );

  fs.renameSync(
    temporaryPath,
    filePath
  );
}

function readTextModelCatalog() {
  const catalog = readJsonFileStrict(
    textModelCatalogPath,
    "Text model catalog"
  );

  if (!Array.isArray(catalog.models)) {
    throw new Error(
      "Text model catalog contains no models."
    );
  }

  return catalog;
}

function readTextModelPolicy() {
  return readJsonFileStrict(
    textModelPolicyPath,
    "Text model policy"
  );
}

function readTextModelQueue() {
  const queue = readJsonFileStrict(
    textModelQueuePath,
    "Text model queue"
  );

  if (!Array.isArray(queue.items)) {
    throw new Error(
      "Text model queue is invalid."
    );
  }

  return queue;
}

function writeTextModelQueue(queue) {
  queue.updatedAt = new Date().toISOString();

  writeJsonFileAtomic(
    textModelQueuePath,
    queue
  );
}

function getCatalogModelVariant(
  modelId,
  variantId
) {
  const catalog =
    readTextModelCatalog();

  const model =
    catalog.models.find(
      (item) =>
        item.id === modelId
    );

  if (!model) {
    const error = new Error(
      `Unknown text model: ${modelId}`
    );

    error.statusCode = 404;
    throw error;
  }

  const hardwareRecommendation =
    typeof getTextModelHardwareRecommendation ===
      "function"
      ? getTextModelHardwareRecommendation(
          modelId
        )
      : null;

  const selectedVariantId =
    variantId ||
    hardwareRecommendation
      ?.recommendedVariantId ||
    model.recommendedVariant ||
    model.variants?.[0]?.id;

  const variant =
    (model.variants || []).find(
      (item) =>
        item.id === selectedVariantId
    );

  if (!variant) {
    const error = new Error(
      `Unknown model variant: ${selectedVariantId}`
    );

    error.statusCode = 404;
    throw error;
  }

  return {
    model,
    variant,
  };
}

function validateTrustedModelDownload(
  model,
  variant
) {
  const catalog = readTextModelCatalog();

  const allowedHosts = new Set(
    catalog.trust?.allowedHosts || []
  );

  const allowedPublishers = new Set(
    catalog.trust?.allowedPublishers || []
  );

  if (!allowedPublishers.has(model.publisher)) {
    const error = new Error(
      "Model publisher is not trusted."
    );

    error.statusCode = 403;
    throw error;
  }

  const downloadUrl = new URL(
    variant.download?.url
  );

  const trustedTestLoopback =
    process.env.NODE_ENV === "test" &&
    downloadUrl.protocol === "http:" &&
    [
      "127.0.0.1",
      "localhost",
      "::1",
    ].includes(downloadUrl.hostname);

  if (
    (
      downloadUrl.protocol !== "https:" &&
      !trustedTestLoopback
    ) ||
    !allowedHosts.has(downloadUrl.hostname)
  ) {
    const error = new Error(
      "Model download URL is not trusted."
    );

    error.statusCode = 403;
    throw error;
  }
}

async function resolveHuggingFaceSha256(
  model,
  variant
) {
  if (
    typeof variant.download?.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(
      variant.download.sha256
    )
  ) {
    return variant.download.sha256.toLowerCase();
  }

  if (
    variant.download?.provider !== "huggingface" ||
    variant.download?.resolveSha256FromMetadata !== true
  ) {
    throw new Error(
      "Trusted SHA256 is unavailable."
    );
  }

  const metadataUrl = new URL(
    variant.download.metadataUrl
  );

  if (
    metadataUrl.protocol !== "https:" ||
    metadataUrl.hostname !== "huggingface.co"
  ) {
    throw new Error(
      "Untrusted model metadata URL."
    );
  }

  const response = await fetch(
    metadataUrl,
    {
      headers: {
        accept: "application/json",
        "user-agent":
          "LUKE-AI-STUDIO/TextModelManager",
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `Unable to resolve model metadata: HTTP ${response.status}`
    );
  }

  const metadata = await response.json();

  const sibling = (
    metadata.siblings || []
  ).find(
    (item) =>
      item.rfilename === variant.filename
  );

  const sha256 =
    sibling?.lfs?.sha256 ||
    sibling?.xetHash ||
    null;

  if (
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(sha256)
  ) {
    throw new Error(
      "Model metadata did not provide a valid SHA256."
    );
  }

  return sha256.toLowerCase();
}

function sanitizeTextModelQueue(queue) {
  const policy = readTextModelPolicy();

  const maximumBatchSelection =
    Number(
      policy.downloadPolicy
        ?.maximumBatchSelection
    ) || 3;

  const activeItems = queue.items.filter(
    (item) =>
      ![
        "completed",
        "cancelled",
        "failed",
        "skipped",
      ].includes(item.state)
  );

  if (
    activeItems.length >
    maximumBatchSelection
  ) {
    throw new Error(
      `Text model queue cannot contain more than ${maximumBatchSelection} active items.`
    );
  }

  return queue;
}

async function enqueueTextModel(
  modelId,
  variantId
) {
  const policy = readTextModelPolicy();

  const maximumBatchSelection =
    Number(
      policy.downloadPolicy
        ?.maximumBatchSelection
    ) || 3;

  const queue = readTextModelQueue();

  const activeItems = queue.items.filter(
    (item) =>
      ![
        "completed",
        "cancelled",
        "failed",
        "skipped",
      ].includes(item.state)
  );

  if (
    activeItems.length >=
    maximumBatchSelection
  ) {
    const error = new Error(
      `เลือกดาวน์โหลดได้สูงสุด ${maximumBatchSelection} โมเดลต่อชุด`
    );

    error.statusCode = 409;
    throw error;
  }

  const duplicate = activeItems.find(
    (item) =>
      item.modelId === modelId &&
      item.variantId === variantId
  );

  if (duplicate) {
    const error = new Error(
      "โมเดลนี้อยู่ในคิวดาวน์โหลดแล้ว"
    );

    error.statusCode = 409;
    throw error;
  }

  const {
    model,
    variant,
  } = getCatalogModelVariant(
    modelId,
    variantId
  );

  const hardwareStatus =
    getTextModelHardwareRecommendation(
      modelId
    );

  const selectedHardwareVariant =
    hardwareStatus
      ?.variants
      ?.find(
        (item) =>
          item.id === variant.id
      );

  if (
    selectedHardwareVariant &&
    selectedHardwareVariant.downloadable !==
      true
  ) {
    const insufficientStorage =
      selectedHardwareVariant
        .reasons
        ?.includes(
          "insufficient-storage"
        );

    const error = new Error(
      insufficientStorage
        ? "พื้นที่จัดเก็บไม่เพียงพอสำหรับโมเดลนี้"
        : "โมเดลรุ่นนี้ไม่เหมาะกับสเปกเครื่องปัจจุบัน"
    );

    error.statusCode = 409;
    error.code =
      insufficientStorage
        ? "INSUFFICIENT_STORAGE"
        : "HARDWARE_INCOMPATIBLE";

    throw error;
  }

  validateTrustedModelDownload(
    model,
    variant
  );

  const sha256 =
    await resolveHuggingFaceSha256(
      model,
      variant
    );

  const now = new Date().toISOString();

  const item = {
    id:
      `text-model-${Date.now()}-` +
      Math.random().toString(16).slice(2, 10),
    modelId: model.id,
    variantId: variant.id,
    publisher: model.publisher,
    modelName:
      model.name?.th ||
      model.name?.en ||
      model.id,
    version: model.version,
    format: model.format,
    runtime: model.runtime,
    filename: variant.filename,
    sizeBytes: variant.sizeBytes,
    quantization: variant.quantization,
    download: {
      url: variant.download.url,
      sha256,
    },
    state: "queued",
    progress: {
      percent: 0,
      downloadedBytes: 0,
      totalBytes: variant.sizeBytes,
      speedBytesPerSecond: 0,
    },
    queuePosition:
      activeItems.length + 1,
    createdAt: now,
    updatedAt: now,
  };

  queue.items.push(item);

  sanitizeTextModelQueue(queue);
  writeTextModelQueue(queue);

  startTextModelQueueWorker();

  return item;
}


// LUKE_AI_TEXT_MODEL_DOWNLOAD_WORKER_V1
const textModelDownloadControllers = new Map();
let textModelQueueWorkerRunning = false;

const textModelTerminalStates = new Set([
  "completed",
  "cancelled",
  "failed",
  "skipped",
]);

function getTextModelQueueItem(itemId) {
  return (
    readTextModelQueue().items.find(
      (item) => item.id === itemId
    ) || null
  );
}

function updateTextModelQueueItem(
  itemId,
  updates = {}
) {
  const queue = readTextModelQueue();

  const item = queue.items.find(
    (entry) => entry.id === itemId
  );

  if (!item) {
    const error = new Error(
      `Text model queue item not found: ${itemId}`
    );

    error.statusCode = 404;
    throw error;
  }

  if (
    updates.progress &&
    typeof updates.progress === "object"
  ) {
    item.progress = {
      ...(item.progress || {}),
      ...updates.progress,
    };
  }

  for (
    const [key, value]
    of Object.entries(updates)
  ) {
    if (key !== "progress") {
      item[key] = value;
    }
  }

  item.updatedAt = new Date().toISOString();

  writeTextModelQueue(queue);

  return item;
}

function normalizeTextModelQueuePositions() {
  const queue = readTextModelQueue();

  const activeItems = queue.items
    .filter(
      (item) =>
        !textModelTerminalStates.has(item.state)
    )
    .sort(
      (left, right) =>
        Number(left.queuePosition || 0) -
        Number(right.queuePosition || 0)
    );

  activeItems.forEach((item, index) => {
    item.queuePosition = index + 1;
  });

  writeTextModelQueue(queue);
}

function getNextQueuedTextModelItem() {
  return (
    readTextModelQueue()
      .items
      .filter(
        (item) => item.state === "queued"
      )
      .sort(
        (left, right) =>
          Number(left.queuePosition || 0) -
          Number(right.queuePosition || 0)
      )[0] || null
  );
}

function getTextModelStorageRoot() {
  if (
    typeof resolveRuntimeStorageDirectory ===
    "function"
  ) {
    const storage =
      resolveRuntimeStorageDirectory({
        create: true,
        createFallback: true,
      });

    if (
      storage.ok &&
      storage.selectedDirectory
    ) {
      return storage.selectedDirectory;
    }
  }

  const homeDirectory =
    process.env.HOME ||
    process.env.USERPROFILE ||
    ROOT;

  const fallbackDirectory = path.join(
    homeDirectory,
    "Downloads",
    "LUKE-AI-STUDIO"
  );

  fs.mkdirSync(
    fallbackDirectory,
    {
      recursive: true,
    }
  );

  return fallbackDirectory;
}

function getTextModelItemPaths(item) {
  const storageRoot =
    getTextModelStorageRoot();

  const stagingDirectory = path.join(
    storageRoot,
    ".luke-text-model-staging",
    item.id
  );

  const modelDirectory = path.join(
    storageRoot,
    "models",
    "text",
    item.modelId,
    item.version,
    item.variantId
  );

  return {
    storageRoot,
    stagingDirectory,
    modelDirectory,
    temporaryFile: path.join(
      stagingDirectory,
      `${item.filename}.part`
    ),
    completedFile: path.join(
      modelDirectory,
      item.filename
    ),
  };
}

function calculateTextModelSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash =
      require("node:crypto")
        .createHash("sha256");

    const input =
      fs.createReadStream(filePath);

    input.on("error", reject);

    input.on("data", (chunk) => {
      hash.update(chunk);
    });

    input.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

async function downloadTextModelQueueItem(item) {
  const controller =
    new AbortController();

  textModelDownloadControllers.set(
    item.id,
    controller
  );

  const paths =
    getTextModelItemPaths(item);

  fs.mkdirSync(
    paths.stagingDirectory,
    {
      recursive: true,
    }
  );

  fs.mkdirSync(
    paths.modelDirectory,
    {
      recursive: true,
    }
  );

  let existingBytes = 0;

  if (fs.existsSync(paths.temporaryFile)) {
    existingBytes =
      fs.statSync(paths.temporaryFile).size;
  }

  const headers = {};

  if (existingBytes > 0) {
    headers.range =
      `bytes=${existingBytes}-`;
  }

  updateTextModelQueueItem(
    item.id,
    {
      state: "downloading",
      error: null,
      storage: {
        root: paths.storageRoot,
        temporaryFile:
          paths.temporaryFile,
        completedFile:
          paths.completedFile,
      },
      progress: {
        downloadedBytes:
          existingBytes,
      },
    }
  );

  const response = await fetch(
    item.download.url,
    {
      headers,
      redirect: "follow",
      signal: controller.signal,
    }
  );

  if (
    !response.ok ||
    !response.body
  ) {
    throw new Error(
      `Model download failed with HTTP ${response.status}`
    );
  }

  const rangeAccepted =
    existingBytes > 0 &&
    response.status === 206;

  if (
    existingBytes > 0 &&
    !rangeAccepted
  ) {
    fs.rmSync(
      paths.temporaryFile,
      {
        force: true,
      }
    );

    existingBytes = 0;
  }

  const contentLength = Number(
    response.headers.get(
      "content-length"
    )
  );

  const totalBytes =
    Number.isFinite(contentLength)
      ? existingBytes + contentLength
      : Number(item.sizeBytes) || null;

  const output =
    fs.createWriteStream(
      paths.temporaryFile,
      {
        flags:
          rangeAccepted
            ? "a"
            : "w",
      }
    );

  const reader =
    response.body.getReader();

  let downloadedBytes =
    existingBytes;

  const startedAt = Date.now();
  let lastPersistedAt = 0;

  try {
    while (true) {
      const result =
        await reader.read();

      if (result.done) {
        break;
      }

      const chunk =
        Buffer.from(result.value);

      await new Promise(
        (resolve, reject) => {
          output.write(
            chunk,
            (error) => {
              if (error) {
                reject(error);
                return;
              }

              resolve();
            }
          );
        }
      );

      downloadedBytes +=
        chunk.length;

      const now = Date.now();

      if (
        now - lastPersistedAt >= 300
      ) {
        const elapsedSeconds =
          Math.max(
            0.001,
            (now - startedAt) / 1000
          );

        const sessionBytes =
          downloadedBytes -
          existingBytes;

        const percent =
          totalBytes
            ? Math.min(
                99,
                Math.floor(
                  downloadedBytes /
                  totalBytes *
                  100
                )
              )
            : 0;

        updateTextModelQueueItem(
          item.id,
          {
            progress: {
              percent,
              downloadedBytes,
              totalBytes,
              speedBytesPerSecond:
                Math.floor(
                  sessionBytes /
                  elapsedSeconds
                ),
            },
          }
        );

        lastPersistedAt = now;
      }
    }
  } finally {
    await new Promise((resolve) => {
      output.end(resolve);
    });
  }

  updateTextModelQueueItem(
    item.id,
    {
      state: "verifying",
      progress: {
        percent: 99,
        downloadedBytes,
        totalBytes:
          totalBytes ||
          downloadedBytes,
        speedBytesPerSecond: 0,
      },
    }
  );

  const actualSha256 =
    await calculateTextModelSha256(
      paths.temporaryFile
    );

  const expectedSha256 =
    String(
      item.download.sha256 || ""
    ).toLowerCase();

  if (
    !expectedSha256 ||
    actualSha256 !== expectedSha256
  ) {
    const error = new Error(
      "Text model SHA256 verification failed."
    );

    error.code = "CHECKSUM_MISMATCH";
    throw error;
  }

  if (fs.existsSync(paths.completedFile)) {
    const installedSha256 =
      await calculateTextModelSha256(
        paths.completedFile
      );

    if (installedSha256 === expectedSha256) {
      fs.rmSync(
        paths.temporaryFile,
        {
          force: true,
        }
      );
    } else {
      const conflictPath =
        `${paths.completedFile}.previous-${Date.now()}`;

      fs.renameSync(
        paths.completedFile,
        conflictPath
      );

      fs.renameSync(
        paths.temporaryFile,
        paths.completedFile
      );
    }
  } else {
    fs.renameSync(
      paths.temporaryFile,
      paths.completedFile
    );
  }

  fs.rmSync(
    paths.stagingDirectory,
    {
      recursive: true,
      force: true,
    }
  );

  const completedItem =
    updateTextModelQueueItem(
      item.id,
      {
        state: "completed",
        installedPath:
          paths.completedFile,
        checksum: {
          algorithm: "sha256",
          expected:
            expectedSha256,
          actual:
            actualSha256,
          verified: true,
        },
        completedAt:
          new Date().toISOString(),
        progress: {
          percent: 100,
          downloadedBytes,
          totalBytes:
            totalBytes ||
            downloadedBytes,
          speedBytesPerSecond: 0,
        },
      }
    );

  registerInstalledTextModel(
    completedItem
  );
}

async function processTextModelQueue() {
  if (textModelQueueWorkerRunning) {
    return;
  }

  textModelQueueWorkerRunning = true;

  try {
    while (true) {
      const item =
        getNextQueuedTextModelItem();

      if (!item) {
        break;
      }

      const queue =
        readTextModelQueue();

      queue.activeItemId = item.id;
      writeTextModelQueue(queue);

      try {
        await downloadTextModelQueueItem(
          item
        );
      } catch (error) {
        const latestItem =
          getTextModelQueueItem(item.id);

        const paused =
          latestItem?.state === "paused";

        const cancelled =
          latestItem?.state === "cancelled";

        updateTextModelQueueItem(
          item.id,
          {
            state:
              paused
                ? "paused"
                : cancelled
                  ? "cancelled"
                  : "failed",
            error:
              paused || cancelled
                ? null
                : {
                    message:
                      error instanceof Error
                        ? error.message
                        : String(error),
                    code:
                      error?.code
                        ? String(error.code)
                        : null,
                    occurredAt:
                      new Date().toISOString(),
                  },
          }
        );
      } finally {
        textModelDownloadControllers.delete(
          item.id
        );

        const latestQueue =
          readTextModelQueue();

        if (
          latestQueue.activeItemId ===
          item.id
        ) {
          latestQueue.activeItemId = null;
          writeTextModelQueue(
            latestQueue
          );
        }

        normalizeTextModelQueuePositions();
      }
    }
  } finally {
    textModelQueueWorkerRunning = false;
  }
}

function startTextModelQueueWorker() {
  setImmediate(() => {
    processTextModelQueue().catch(
      (error) => {
        console.error(
          "[text-models] Queue worker failed:",
          error instanceof Error
            ? error.message
            : String(error)
        );
      }
    );
  });
}

function pauseTextModelQueueItem(itemId) {
  const item =
    getTextModelQueueItem(itemId);

  if (!item) {
    const error = new Error(
      "Text model queue item not found."
    );

    error.statusCode = 404;
    throw error;
  }

  if (item.state !== "downloading") {
    const error = new Error(
      "Only an active download can be paused."
    );

    error.statusCode = 409;
    throw error;
  }

  updateTextModelQueueItem(
    itemId,
    {
      state: "paused",
    }
  );

  textModelDownloadControllers
    .get(itemId)
    ?.abort();

  return getTextModelQueueItem(itemId);
}

function resumeTextModelQueueItem(itemId) {
  const item =
    getTextModelQueueItem(itemId);

  if (!item) {
    const error = new Error(
      "Text model queue item not found."
    );

    error.statusCode = 404;
    throw error;
  }

  if (
    ![
      "paused",
      "failed",
    ].includes(item.state)
  ) {
    const error = new Error(
      "Only paused or failed downloads can resume."
    );

    error.statusCode = 409;
    throw error;
  }

  const updated =
    updateTextModelQueueItem(
      itemId,
      {
        state: "queued",
        error: null,
      }
    );

  startTextModelQueueWorker();

  return updated;
}

function cancelTextModelQueueItem(itemId) {
  const item =
    getTextModelQueueItem(itemId);

  if (!item) {
    const error = new Error(
      "Text model queue item not found."
    );

    error.statusCode = 404;
    throw error;
  }

  if (
    textModelTerminalStates.has(
      item.state
    )
  ) {
    const error = new Error(
      "Queue item is already finished."
    );

    error.statusCode = 409;
    throw error;
  }

  const updated =
    updateTextModelQueueItem(
      itemId,
      {
        state: "cancelled",
        cancelledAt:
          new Date().toISOString(),
      }
    );

  textModelDownloadControllers
    .get(itemId)
    ?.abort();

  normalizeTextModelQueuePositions();

  return updated;
}

function skipTextModelQueueItem(itemId) {
  const item =
    getTextModelQueueItem(itemId);

  if (!item) {
    const error = new Error(
      "Text model queue item not found."
    );

    error.statusCode = 404;
    throw error;
  }

  if (item.state !== "queued") {
    const error = new Error(
      "Only queued items can be skipped."
    );

    error.statusCode = 409;
    throw error;
  }

  const updated =
    updateTextModelQueueItem(
      itemId,
      {
        state: "skipped",
        skippedAt:
          new Date().toISOString(),
      }
    );

  normalizeTextModelQueuePositions();

  return updated;
}

function moveTextModelQueueItem(
  itemId,
  direction
) {
  const queue =
    readTextModelQueue();

  const activeItems = queue.items
    .filter(
      (item) =>
        !textModelTerminalStates.has(
          item.state
        )
    )
    .sort(
      (left, right) =>
        Number(left.queuePosition || 0) -
        Number(right.queuePosition || 0)
    );

  const index =
    activeItems.findIndex(
      (item) => item.id === itemId
    );

  if (index < 0) {
    const error = new Error(
      "Queue item is not movable."
    );

    error.statusCode = 404;
    throw error;
  }

  const targetIndex =
    direction === "up"
      ? index - 1
      : direction === "down"
        ? index + 1
        : 0;

  if (
    targetIndex < 0 ||
    targetIndex >= activeItems.length
  ) {
    return activeItems[index];
  }

  const current =
    activeItems[index];

  const target =
    activeItems[targetIndex];

  const currentPosition =
    current.queuePosition;

  current.queuePosition =
    target.queuePosition;

  target.queuePosition =
    currentPosition;

  writeTextModelQueue(queue);
  normalizeTextModelQueuePositions();

  return getTextModelQueueItem(itemId);
}


// LUKE_AI_TEXT_MODEL_UPDATE_MANAGER_V1
const installedTextModelsPath = path.join(
  ROOT,
  "app",
  "runtime-state",
  "text-models",
  "installed-models.json"
);

function readInstalledTextModels() {
  if (!fs.existsSync(installedTextModelsPath)) {
    const initialState = {
      schemaVersion: 1,
      updatedAt: null,
      activeModelId: null,
      models: [],
    };

    writeJsonFileAtomic(
      installedTextModelsPath,
      initialState
    );

    return initialState;
  }

  const registry = readJsonFileStrict(
    installedTextModelsPath,
    "Installed text model registry"
  );

  if (!Array.isArray(registry.models)) {
    throw new Error(
      "Installed text model registry is invalid."
    );
  }

  return registry;
}

function writeInstalledTextModels(registry) {
  registry.updatedAt =
    new Date().toISOString();

  writeJsonFileAtomic(
    installedTextModelsPath,
    registry
  );
}

function compareSemanticVersions(
  leftVersion,
  rightVersion
) {
  const normalize = (value) =>
    String(value || "0")
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => {
        const numeric = Number.parseInt(
          part,
          10
        );

        return Number.isFinite(numeric)
          ? numeric
          : 0;
      });

  const left = normalize(leftVersion);
  const right = normalize(rightVersion);

  for (let index = 0; index < 3; index += 1) {
    const difference =
      (left[index] || 0) -
      (right[index] || 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function registerInstalledTextModel(
  queueItem
) {
  const registry =
    readInstalledTextModels();

  const existingIndex =
    registry.models.findIndex(
      (model) =>
        model.modelId === queueItem.modelId &&
        model.version === queueItem.version &&
        model.variantId === queueItem.variantId
    );

  const installedRecord = {
    id:
      `${queueItem.modelId}@${queueItem.version}:${queueItem.variantId}`,
    modelId: queueItem.modelId,
    modelName: queueItem.modelName,
    publisher: queueItem.publisher,
    version: queueItem.version,
    variantId: queueItem.variantId,
    quantization: queueItem.quantization,
    format: queueItem.format,
    runtime: queueItem.runtime,
    installedPath: queueItem.installedPath,
    checksum: queueItem.checksum,
    installedAt:
      queueItem.completedAt ||
      new Date().toISOString(),
    active: false,
    rollbackAvailable: false,
  };

  if (existingIndex >= 0) {
    registry.models[existingIndex] = {
      ...registry.models[existingIndex],
      ...installedRecord,
    };
  } else {
    const olderVersions =
      registry.models.filter(
        (model) =>
          model.modelId === queueItem.modelId &&
          model.variantId === queueItem.variantId
      );

    installedRecord.rollbackAvailable =
      olderVersions.length > 0;

    registry.models.push(
      installedRecord
    );

    for (const olderModel of olderVersions) {
      olderModel.rollbackAvailable = true;
    }
  }

  writeInstalledTextModels(registry);

  return installedRecord;
}

function buildTextModelUpdateStatus() {
  const catalog =
    readTextModelCatalog();

  const registry =
    readInstalledTextModels();

  const models = catalog.models.map(
    (catalogModel) => {
      const installedVersions =
        registry.models
          .filter(
            (installedModel) =>
              installedModel.modelId ===
              catalogModel.id
          )
          .sort(
            (left, right) =>
              compareSemanticVersions(
                right.version,
                left.version
              )
          );

      const latestInstalled =
        installedVersions[0] || null;

      const updateAvailable =
        Boolean(latestInstalled) &&
        compareSemanticVersions(
          catalogModel.version,
          latestInstalled.version
        ) > 0;

      return {
        modelId: catalogModel.id,
        modelName:
          catalogModel.name?.th ||
          catalogModel.name?.en ||
          catalogModel.id,
        category:
          catalogModel.category ||
          "official",
        installed:
          installedVersions.length > 0,
        installedVersion:
          latestInstalled?.version || null,
        installedVariantId:
          latestInstalled?.variantId || null,
        latestVersion:
          catalogModel.version,
        recommendedVariant:
          catalogModel.recommendedVariant,
        updateAvailable,
        rollbackAvailable:
          installedVersions.length > 1 ||
          installedVersions.some(
            (model) =>
              model.rollbackAvailable === true
          ),
        installedVersions,
        updateChannel:
          catalogModel.updateChannel || null,
      };
    }
  );

  return {
    ok: true,
    checkedAt:
      new Date().toISOString(),
    automaticCheckIntervalHours:
      Number(
        readTextModelPolicy()
          .updatePolicy
          ?.automaticCheckIntervalHours
      ) || 24,
    summary: {
      catalogModels: models.length,
      installedModels:
        models.filter(
          (model) => model.installed
        ).length,
      updatesAvailable:
        models.filter(
          (model) => model.updateAvailable
        ).length,
      rollbackAvailable:
        models.filter(
          (model) =>
            model.rollbackAvailable
        ).length,
    },
    models,
  };
}

function getTextModelUpdateStatus(
  modelId
) {
  return (
    buildTextModelUpdateStatus()
      .models
      .find(
        (model) =>
          model.modelId === modelId
      ) || null
  );
}


// LUKE_AI_TEXT_MODEL_HARDWARE_COMPATIBILITY_V3
const textModelHardwareOs = require("node:os");

function getTextModelHardwareProfile() {
  const testTotalRam =
    Number(
      process.env
        .LUKE_AI_TEST_TOTAL_RAM_BYTES
    );

  const testAvailableRam =
    Number(
      process.env
        .LUKE_AI_TEST_AVAILABLE_RAM_BYTES
    );

  const totalRamBytes =
    process.env.NODE_ENV === "test" &&
    Number.isFinite(testTotalRam)
      ? testTotalRam
      : textModelHardwareOs.totalmem();

  const availableRamBytes =
    process.env.NODE_ENV === "test" &&
    Number.isFinite(testAvailableRam)
      ? testAvailableRam
      : textModelHardwareOs.freemem();

  const storage =
    typeof resolveRuntimeStorageDirectory ===
      "function"
      ? resolveRuntimeStorageDirectory({
          create: true,
          createFallback: true,
        })
      : null;

  const selectedStorage =
    storage?.usingFallback
      ? storage.fallback
      : storage?.external;

  const freeStorageCandidate =
    Number(
      selectedStorage?.freeBytes
    );

  return {
    platform: process.platform,
    architecture: process.arch,
    appleSilicon:
      process.platform === "darwin" &&
      process.arch === "arm64",
    cpuCount:
      textModelHardwareOs.cpus()?.length ||
      1,
    totalRamBytes,
    availableRamBytes,
    selectedStorageDirectory:
      storage?.selectedDirectory || null,
    usingStorageFallback:
      storage?.usingFallback === true,
    freeStorageBytes:
      Number.isFinite(
        freeStorageCandidate
      )
        ? freeStorageCandidate
        : null,
  };
}

function getTextModelQuantizationRank(
  quantization
) {
  const value =
    String(quantization || "")
      .toUpperCase();

  if (value.startsWith("Q8")) {
    return 80;
  }

  if (value.startsWith("Q6")) {
    return 60;
  }

  if (value.startsWith("Q5")) {
    return 50;
  }

  if (value.startsWith("Q4")) {
    return 40;
  }

  if (value.startsWith("Q3")) {
    return 30;
  }

  return 10;
}

function evaluateTextModelHardwareVariant(
  variant,
  hardware
) {
  const sizeBytes =
    Number(variant.sizeBytes) || 0;

  const minimumRamBytes =
    Number(
      variant.minimumRamBytes
    ) ||
    Math.ceil(sizeBytes * 1.4);

  const recommendedRamBytes =
    Number(
      variant.recommendedRamBytes
    ) ||
    Math.ceil(sizeBytes * 2);

  const reserveBytes =
    Math.max(
      10 * 1024 ** 3,
      Math.ceil(sizeBytes * 0.25)
    );

  const requiredStorageBytes =
    sizeBytes + reserveBytes;

  const totalRamCompatible =
    hardware.totalRamBytes >=
    minimumRamBytes;

  const availableRamCompatible =
    hardware.availableRamBytes >=
    Math.min(
      minimumRamBytes,
      Math.floor(
        hardware.totalRamBytes * 0.75
      )
    );

  const storageCompatible =
    hardware.freeStorageBytes == null ||
    hardware.freeStorageBytes >=
    requiredStorageBytes;

  const reasons = [];

  if (!totalRamCompatible) {
    reasons.push(
      "total-ram-below-minimum"
    );
  }

  if (!availableRamCompatible) {
    reasons.push(
      "available-ram-too-low"
    );
  }

  if (!storageCompatible) {
    reasons.push(
      "insufficient-storage"
    );
  }

  let compatibility = "incompatible";
  let score = 0;

  if (
    totalRamCompatible &&
    availableRamCompatible &&
    storageCompatible
  ) {
    const fullyRecommended =
      hardware.totalRamBytes >=
      recommendedRamBytes;

    compatibility =
      fullyRecommended
        ? "recommended"
        : "compatible";

    score =
      getTextModelQuantizationRank(
        variant.quantization
      ) +
      (
        fullyRecommended
          ? 100
          : 0
      );
  }

  return {
    id: variant.id,
    quantization:
      variant.quantization,
    filename:
      variant.filename,
    sizeBytes,
    minimumRamBytes,
    recommendedRamBytes,
    requiredStorageBytes,
    compatibility,
    recommended:
      compatibility === "recommended",
    downloadable:
      totalRamCompatible &&
      storageCompatible,
    reasons,
    score,
  };
}

function buildTextModelHardwareCompatibility() {
  const hardware =
    getTextModelHardwareProfile();

  const catalog =
    readTextModelCatalog();

  const models =
    catalog.models.map((model) => {
      const variants =
        (model.variants || [])
          .map(
            (variant) =>
              evaluateTextModelHardwareVariant(
                variant,
                hardware
              )
          )
          .sort(
            (left, right) =>
              right.score - left.score
          );

      const recommendation =
        variants.find(
          (variant) =>
            variant.compatibility ===
            "recommended"
        ) ||
        variants.find(
          (variant) =>
            variant.compatibility ===
            "compatible"
        ) ||
        null;

      return {
        modelId: model.id,
        modelName:
          model.name?.th ||
          model.name?.en ||
          model.id,
        compatible:
          Boolean(recommendation),
        recommendedVariantId:
          recommendation?.id || null,
        recommendedQuantization:
          recommendation?.quantization ||
          null,
        variants,
      };
    });

  return {
    ok: true,
    checkedAt:
      new Date().toISOString(),
    hardware,
    summary: {
      modelCount: models.length,
      compatibleModelCount:
        models.filter(
          (model) => model.compatible
        ).length,
      incompatibleModelCount:
        models.filter(
          (model) => !model.compatible
        ).length,
    },
    models,
  };
}

function getTextModelHardwareRecommendation(
  modelId
) {
  return (
    buildTextModelHardwareCompatibility()
      .models
      .find(
        (model) =>
          model.modelId === modelId
      ) ||
    null
  );
}


// LUKE_AI_PERSISTENT_TEXT_CHAT_V1
const textChatStorePath = path.join(
  ROOT,
  "app",
  "runtime-state",
  "text-chat",
  "conversations.json"
);

function createInitialTextChatStore() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    lastOpenedConversationId: null,
    conversations: [],
  };
}

function readTextChatStore() {
  if (!fs.existsSync(textChatStorePath)) {
    const initialStore =
      createInitialTextChatStore();

    writeJsonFileAtomic(
      textChatStorePath,
      initialStore
    );

    return initialStore;
  }

  const store = readJsonFileStrict(
    textChatStorePath,
    "Text chat conversation store"
  );

  if (!Array.isArray(store.conversations)) {
    throw new Error(
      "Text chat conversation store is invalid."
    );
  }

  return store;
}

function writeTextChatStore(store) {
  store.updatedAt =
    new Date().toISOString();

  writeJsonFileAtomic(
    textChatStorePath,
    store
  );
}

function createTextChatId(prefix) {
  return (
    `${prefix}-${Date.now()}-` +
    Math.random()
      .toString(16)
      .slice(2, 10)
  );
}

function normalizeTextChatTitle(value) {
  const title =
    String(value || "")
      .replace(/\s+/g, " ")
      .trim();

  if (!title) {
    return "บทสนทนาใหม่";
  }

  return title.slice(0, 80);
}

function generateConversationTitle(message) {
  return normalizeTextChatTitle(
    String(message || "")
      .replace(/\n+/g, " ")
      .slice(0, 60)
  );
}

function findTextChatConversation(
  store,
  conversationId
) {
  return store.conversations.find(
    (conversation) =>
      conversation.id === conversationId
  ) || null;
}

function createTextChatConversation({
  title,
  modelId = null,
  systemPrompt = "",
} = {}) {
  const store =
    readTextChatStore();

  const now =
    new Date().toISOString();

  const conversation = {
    id:
      createTextChatId("conversation"),
    title:
      normalizeTextChatTitle(title),
    createdAt: now,
    updatedAt: now,
    pinned: false,
    archived: false,
    modelId,
    systemPrompt:
      String(systemPrompt || ""),
    settings: {
      temperature: 0.7,
      contextLength: null,
    },
    memory: {
      summary: "",
      facts: [],
      lastCompactedAt: null,
    },
    messages: [],
  };

  store.conversations.unshift(
    conversation
  );

  store.lastOpenedConversationId =
    conversation.id;

  writeTextChatStore(store);

  return conversation;
}

function appendTextChatMessage(
  conversationId,
  {
    role,
    content,
    modelId = null,
    metadata = {},
  }
) {
  const allowedRoles =
    new Set([
      "user",
      "assistant",
      "system",
      "tool",
    ]);

  if (!allowedRoles.has(role)) {
    const error = new Error(
      "Invalid chat message role."
    );

    error.statusCode = 400;
    throw error;
  }

  const normalizedContent =
    String(content || "").trim();

  if (!normalizedContent) {
    const error = new Error(
      "Chat message content is required."
    );

    error.statusCode = 400;
    throw error;
  }

  const store =
    readTextChatStore();

  const conversation =
    findTextChatConversation(
      store,
      conversationId
    );

  if (!conversation) {
    const error = new Error(
      "Conversation was not found."
    );

    error.statusCode = 404;
    throw error;
  }

  const now =
    new Date().toISOString();

  const message = {
    id:
      createTextChatId("message"),
    role,
    content:
      normalizedContent,
    modelId,
    createdAt: now,
    metadata:
      metadata &&
      typeof metadata === "object"
        ? metadata
        : {},
  };

  conversation.messages.push(
    message
  );

  if (
    conversation.title ===
      "บทสนทนาใหม่" &&
    role === "user"
  ) {
    conversation.title =
      generateConversationTitle(
        normalizedContent
      );
  }

  conversation.updatedAt = now;

  store.lastOpenedConversationId =
    conversation.id;

  writeTextChatStore(store);

  setImmediate(() => {
    autoOptimizeTextChatConversation(
      conversation.id
    );
  });

  return {
    conversation,
    message,
  };
}

function updateTextChatConversation(
  conversationId,
  updates = {}
) {
  const store =
    readTextChatStore();

  const conversation =
    findTextChatConversation(
      store,
      conversationId
    );

  if (!conversation) {
    const error = new Error(
      "Conversation was not found."
    );

    error.statusCode = 404;
    throw error;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      updates,
      "title"
    )
  ) {
    conversation.title =
      normalizeTextChatTitle(
        updates.title
      );
  }

  if (
    Object.prototype.hasOwnProperty.call(
      updates,
      "pinned"
    )
  ) {
    conversation.pinned =
      updates.pinned === true;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      updates,
      "archived"
    )
  ) {
    conversation.archived =
      updates.archived === true;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      updates,
      "modelId"
    )
  ) {
    conversation.modelId =
      updates.modelId || null;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      updates,
      "systemPrompt"
    )
  ) {
    conversation.systemPrompt =
      String(
        updates.systemPrompt || ""
      );
  }

  if (
    updates.settings &&
    typeof updates.settings === "object"
  ) {
    conversation.settings = {
      ...(conversation.settings || {}),
      ...updates.settings,
    };
  }

  conversation.updatedAt =
    new Date().toISOString();

  store.lastOpenedConversationId =
    conversation.id;

  writeTextChatStore(store);

  return conversation;
}

function deleteTextChatConversation(
  conversationId
) {
  const store =
    readTextChatStore();

  const index =
    store.conversations.findIndex(
      (conversation) =>
        conversation.id ===
        conversationId
    );

  if (index < 0) {
    const error = new Error(
      "Conversation was not found."
    );

    error.statusCode = 404;
    throw error;
  }

  const [removed] =
    store.conversations.splice(
      index,
      1
    );

  if (
    store.lastOpenedConversationId ===
    conversationId
  ) {
    store.lastOpenedConversationId =
      store.conversations[0]?.id ||
      null;
  }

  writeTextChatStore(store);

  return removed;
}


// LUKE_AI_TEXT_CHAT_MEMORY_MANAGER_V1
const textChatMemoryPolicyPath = path.join(
  ROOT,
  "app",
  "config",
  "text-chat",
  "memory-policy.json"
);

function readTextChatMemoryPolicy() {
  return readJsonFileStrict(
    textChatMemoryPolicyPath,
    "Text chat memory policy"
  );
}

function estimateTextChatTokens(value) {
  const policy =
    readTextChatMemoryPolicy();

  const charactersPerToken =
    Number(
      policy.context
        ?.charactersPerEstimatedToken
    ) || 4;

  return Math.max(
    0,
    Math.ceil(
      String(value || "").length /
      charactersPerToken
    )
  );
}

function getConversationContextLimit(
  conversation
) {
  const policy =
    readTextChatMemoryPolicy();

  return (
    Number(
      conversation.settings
        ?.contextLength
    ) ||
    Number(
      policy.context
        ?.defaultContextTokens
    ) ||
    32768
  );
}

function calculateConversationContextStatus(
  conversation
) {
  const contextLimitTokens =
    getConversationContextLimit(
      conversation
    );

  const systemPromptTokens =
    estimateTextChatTokens(
      conversation.systemPrompt
    );

  const summaryTokens =
    estimateTextChatTokens(
      conversation.memory?.summary
    );

  const messageTokens =
    (conversation.messages || [])
      .reduce(
        (total, message) =>
          total +
          estimateTextChatTokens(
            message.content
          ) +
          8,
        0
      );

  const estimatedTokens =
    systemPromptTokens +
    summaryTokens +
    messageTokens;

  const usagePercent =
    contextLimitTokens > 0
      ? Math.min(
          999,
          Number(
            (
              estimatedTokens /
              contextLimitTokens *
              100
            ).toFixed(2)
          )
        )
      : 0;

  const policy =
    readTextChatMemoryPolicy();

  const summaryThreshold =
    Number(
      policy.context
        ?.summaryThresholdPercent
    ) || 80;

  const snapshotThreshold =
    Number(
      policy.context
        ?.snapshotThresholdPercent
    ) || 90;

  const refreshThreshold =
    Number(
      policy.context
        ?.sessionRefreshThresholdPercent
    ) || 95;

  let action = "none";

  if (usagePercent >= refreshThreshold) {
    action = "refresh";
  } else if (
    usagePercent >= snapshotThreshold
  ) {
    action = "snapshot";
  } else if (
    usagePercent >= summaryThreshold
  ) {
    action = "summarize";
  }

  return {
    contextLimitTokens,
    estimatedTokens,
    usagePercent,
    remainingTokens:
      Math.max(
        0,
        contextLimitTokens -
        estimatedTokens
      ),
    action,
    thresholds: {
      summary: summaryThreshold,
      snapshot: snapshotThreshold,
      refresh: refreshThreshold,
    },
  };
}

function getTextChatRamStatus() {
  const os =
    require("node:os");

  const policy =
    readTextChatMemoryPolicy();

  const testTotal =
    Number(
      process.env
        .LUKE_AI_TEST_TOTAL_RAM_BYTES
    );

  const testFree =
    Number(
      process.env
        .LUKE_AI_TEST_FREE_RAM_BYTES
    );

  const totalBytes =
    process.env.NODE_ENV === "test" &&
    Number.isFinite(testTotal)
      ? testTotal
      : os.totalmem();

  const freeBytes =
    process.env.NODE_ENV === "test" &&
    Number.isFinite(testFree)
      ? testFree
      : os.freemem();

  const usedBytes =
    Math.max(
      0,
      totalBytes - freeBytes
    );

  const usedPercent =
    totalBytes > 0
      ? Number(
          (
            usedBytes /
            totalBytes *
            100
          ).toFixed(2)
        )
      : 0;

  const prepareThreshold =
    Number(
      policy.ram
        ?.prepareRefreshAtUsedPercent
    ) || 85;

  const refreshThreshold =
    Number(
      policy.ram
        ?.refreshAtUsedPercent
    ) || 92;

  const emergencyThreshold =
    Number(
      policy.ram
        ?.emergencyRefreshAtUsedPercent
    ) || 95;

  const minimumFreeBytes =
    Number(
      policy.ram
        ?.minimumFreeBytes
    ) ||
    1024 ** 3;

  let action = "none";

  if (
    usedPercent >= emergencyThreshold ||
    freeBytes < minimumFreeBytes
  ) {
    action = "emergency-refresh";
  } else if (
    usedPercent >= refreshThreshold
  ) {
    action = "refresh";
  } else if (
    usedPercent >= prepareThreshold
  ) {
    action = "prepare";
  }

  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent,
    action,
    thresholds: {
      prepare: prepareThreshold,
      refresh: refreshThreshold,
      emergency: emergencyThreshold,
    },
  };
}

function uniqueMemoryValues(values) {
  return [
    ...new Set(
      values
        .map(
          (value) =>
            String(value || "")
              .replace(/\s+/g, " ")
              .trim()
        )
        .filter(Boolean)
    ),
  ];
}

function extractConversationMemory(
  conversation
) {
  const messages =
    conversation.messages || [];

  const userMessages =
    messages.filter(
      (message) =>
        message.role === "user"
    );

  const assistantMessages =
    messages.filter(
      (message) =>
        message.role === "assistant"
    );

  const facts = [];
  const decisions = [];
  const tasks = [];

  const factPatterns = [
    /(?:จำไว้ว่า|ข้อมูลคือ|ข้อเท็จจริง|ชื่อ|ต้องการ|ใช้|เก็บไว้)[\s:：]*(.+)/i,
  ];

  const decisionPatterns = [
    /(?:ตกลง|สรุปว่า|เลือก|ตัดสินใจ|ตามนี้|ให้ใช้)[\s:：]*(.+)/i,
  ];

  const taskPatterns = [
    /(?:ต้องทำ|ขั้นต่อไป|ต่อไป|อย่าลืม|เพิ่ม|แก้ไข|พัฒนา)[\s:：]*(.+)/i,
  ];

  for (const message of messages) {
    const content =
      String(message.content || "");

    for (const pattern of factPatterns) {
      const match =
        content.match(pattern);

      if (match?.[1]) {
        facts.push(
          match[1].slice(0, 500)
        );
      }
    }

    for (const pattern of decisionPatterns) {
      const match =
        content.match(pattern);

      if (match?.[1]) {
        decisions.push(
          match[1].slice(0, 500)
        );
      }
    }

    for (const pattern of taskPatterns) {
      const match =
        content.match(pattern);

      if (match?.[1]) {
        tasks.push(
          match[1].slice(0, 500)
        );
      }
    }
  }

  const latestUserMessages =
    userMessages
      .slice(-5)
      .map(
        (message) =>
          message.content
      );

  const latestAssistantMessages =
    assistantMessages
      .slice(-3)
      .map(
        (message) =>
          message.content
      );

  return {
    facts:
      uniqueMemoryValues(facts)
        .slice(-100),
    decisions:
      uniqueMemoryValues(decisions)
        .slice(-100),
    tasks:
      uniqueMemoryValues(tasks)
        .slice(-100),
    latestUserMessages,
    latestAssistantMessages,
  };
}

function buildConversationSummary(
  conversation
) {
  const policy =
    readTextChatMemoryPolicy();

  const extracted =
    extractConversationMemory(
      conversation
    );

  const parts = [
    `หัวข้อ: ${conversation.title}`,
  ];

  if (extracted.facts.length) {
    parts.push(
      "ข้อเท็จจริงสำคัญ:\n" +
      extracted.facts
        .map(
          (value) => `- ${value}`
        )
        .join("\n")
    );
  }

  if (extracted.decisions.length) {
    parts.push(
      "การตัดสินใจ:\n" +
      extracted.decisions
        .map(
          (value) => `- ${value}`
        )
        .join("\n")
    );
  }

  if (extracted.tasks.length) {
    parts.push(
      "สิ่งที่ต้องทำต่อ:\n" +
      extracted.tasks
        .map(
          (value) => `- ${value}`
        )
        .join("\n")
    );
  }

  if (
    extracted
      .latestUserMessages
      .length
  ) {
    parts.push(
      "ข้อความล่าสุดของผู้ใช้:\n" +
      extracted
        .latestUserMessages
        .map(
          (value) =>
            `- ${String(value).slice(0, 1000)}`
        )
        .join("\n")
    );
  }

  const maximumCharacters =
    Number(
      policy.memory
        ?.maximumSummaryCharacters
    ) || 12000;

  return {
    summary:
      parts
        .join("\n\n")
        .slice(
          0,
          maximumCharacters
        ),
    facts:
      extracted.facts,
    decisions:
      extracted.decisions,
    tasks:
      extracted.tasks,
  };
}

function createConversationMemorySnapshot(
  conversation,
  reason
) {
  const built =
    buildConversationSummary(
      conversation
    );

  const now =
    new Date().toISOString();

  const snapshot = {
    id:
      createTextChatId(
        "memory-snapshot"
      ),
    createdAt: now,
    reason,
    conversationId:
      conversation.id,
    messageCount:
      conversation.messages?.length ||
      0,
    summary:
      built.summary,
    facts:
      built.facts,
    decisions:
      built.decisions,
    tasks:
      built.tasks,
    settings: {
      modelId:
        conversation.modelId ||
        null,
      systemPrompt:
        conversation.systemPrompt ||
        "",
      generationSettings: {
        ...(conversation.settings || {}),
      },
    },
  };

  conversation.memory = {
    ...(conversation.memory || {}),
    summary:
      built.summary,
    facts:
      built.facts,
    decisions:
      built.decisions,
    tasks:
      built.tasks,
    lastCompactedAt: now,
    latestSnapshotId:
      snapshot.id,
    snapshots: [
      ...(
        conversation.memory
          ?.snapshots || []
      ),
      snapshot,
    ].slice(-20),
  };

  return snapshot;
}

function refreshConversationSession(
  conversation,
  reason
) {
  const snapshot =
    createConversationMemorySnapshot(
      conversation,
      reason
    );

  const policy =
    readTextChatMemoryPolicy();

  const recentMessageCount =
    Number(
      policy.context
        ?.recentMessagesToPreserve
    ) || 20;

  const previousSessionId =
    conversation.session?.id ||
    null;

  const nextSessionId =
    createTextChatId(
      "chat-session"
    );

  conversation.session = {
    id: nextSessionId,
    previousSessionId,
    refreshedAt:
      new Date().toISOString(),
    refreshCount:
      Number(
        conversation.session
          ?.refreshCount
      ) + 1 || 1,
    refreshReason: reason,
    memorySnapshotId:
      snapshot.id,
    restoreContext: {
      summary:
        conversation.memory.summary,
      facts:
        conversation.memory.facts,
      decisions:
        conversation.memory.decisions,
      tasks:
        conversation.memory.tasks,
      recentMessages:
        (
          conversation.messages || []
        ).slice(
          -recentMessageCount
        ),
    },
  };

  return {
    snapshot,
    session:
      conversation.session,
  };
}

function optimizeTextChatConversation(
  conversationId,
  {
    force = false,
    reason = "automatic",
  } = {}
) {
  const store =
    readTextChatStore();

  const conversation =
    findTextChatConversation(
      store,
      conversationId
    );

  if (!conversation) {
    const error = new Error(
      "Conversation was not found."
    );

    error.statusCode = 404;
    throw error;
  }

  const context =
    calculateConversationContextStatus(
      conversation
    );

  const ram =
    getTextChatRamStatus();

  let action =
    force
      ? "refresh"
      : context.action;

  if (
    [
      "refresh",
      "emergency-refresh",
    ].includes(ram.action)
  ) {
    action = "refresh";
  } else if (
    ram.action === "prepare" &&
    action === "none"
  ) {
    action = "summarize";
  }

  let snapshot = null;
  let session = null;

  if (action === "summarize") {
    const built =
      buildConversationSummary(
        conversation
      );

    conversation.memory = {
      ...(conversation.memory || {}),
      summary:
        built.summary,
      facts:
        built.facts,
      decisions:
        built.decisions,
      tasks:
        built.tasks,
      lastCompactedAt:
        new Date().toISOString(),
    };
  }

  if (action === "snapshot") {
    snapshot =
      createConversationMemorySnapshot(
        conversation,
        reason
      );
  }

  if (action === "refresh") {
    const refreshed =
      refreshConversationSession(
        conversation,
        reason
      );

    snapshot =
      refreshed.snapshot;

    session =
      refreshed.session;
  }

  conversation.updatedAt =
    new Date().toISOString();

  store.lastOpenedConversationId =
    conversation.id;

  writeTextChatStore(store);

  return {
    conversation,
    action,
    context:
      calculateConversationContextStatus(
        conversation
      ),
    ram,
    snapshot,
    session,
  };
}

function getTextChatMemoryStatus(
  conversationId
) {
  const store =
    readTextChatStore();

  const conversation =
    findTextChatConversation(
      store,
      conversationId
    );

  if (!conversation) {
    const error = new Error(
      "Conversation was not found."
    );

    error.statusCode = 404;
    throw error;
  }

  return {
    conversationId,
    context:
      calculateConversationContextStatus(
        conversation
      ),
    ram:
      getTextChatRamStatus(),
    memory: {
      hasSummary:
        Boolean(
          conversation.memory
            ?.summary
        ),
      factCount:
        conversation.memory
          ?.facts?.length || 0,
      decisionCount:
        conversation.memory
          ?.decisions?.length || 0,
      taskCount:
        conversation.memory
          ?.tasks?.length || 0,
      snapshotCount:
        conversation.memory
          ?.snapshots?.length || 0,
      lastCompactedAt:
        conversation.memory
          ?.lastCompactedAt ||
        null,
    },
    session: {
      id:
        conversation.session?.id ||
        null,
      refreshCount:
        conversation.session
          ?.refreshCount || 0,
      refreshedAt:
        conversation.session
          ?.refreshedAt || null,
      refreshReason:
        conversation.session
          ?.refreshReason || null,
    },
  };
}

function autoOptimizeTextChatConversation(
  conversationId
) {
  try {
    return optimizeTextChatConversation(
      conversationId,
      {
        force: false,
        reason:
          "automatic-threshold",
      }
    );
  } catch (error) {
    console.error(
      "[text-chat] Memory optimization failed:",
      error instanceof Error
        ? error.message
        : String(error)
    );

    return null;
  }
}


// LUKE_AI_TEXT_RUNTIME_SESSION_REFRESH_V1
const textRuntimeSessionPolicyPath = path.join(
  ROOT,
  "app",
  "config",
  "text-chat",
  "runtime-session-policy.json"
);

const textRuntimeSessionState = new Map();

function readTextRuntimeSessionPolicy() {
  return readJsonFileStrict(
    textRuntimeSessionPolicyPath,
    "Text runtime session policy"
  );
}

function getTextRuntimeBaseUrl() {
  const policy =
    readTextRuntimeSessionPolicy();

  return String(
    process.env
      .LUKE_AI_TEXT_RUNTIME_BASE_URL ||
    policy.runtime?.baseUrl ||
    "http://127.0.0.1:10086"
  ).replace(/\/+$/, "");
}

function buildTextRuntimeUrl(pathname) {
  const normalizedPath =
    String(pathname || "")
      .startsWith("/")
      ? String(pathname)
      : `/${String(pathname || "")}`;

  return (
    getTextRuntimeBaseUrl() +
    normalizedPath
  );
}

async function requestTextRuntime(
  pathname,
  {
    method = "GET",
    body = undefined,
    timeoutMs = null,
  } = {}
) {
  const policy =
    readTextRuntimeSessionPolicy();

  const controller =
    new AbortController();

  const effectiveTimeout =
    Number(timeoutMs) ||
    Number(
      policy.runtime
        ?.requestTimeoutMs
    ) ||
    15000;

  const timer =
    setTimeout(
      () => controller.abort(),
      effectiveTimeout
    );

  try {
    const response =
      await fetch(
        buildTextRuntimeUrl(pathname),
        {
          method,
          headers: {
            "content-type":
              "application/json",
          },
          body:
            body === undefined
              ? undefined
              : JSON.stringify(body),
          signal:
            controller.signal,
        }
      );

    const responseText =
      await response.text();

    let data = null;

    if (responseText) {
      try {
        data =
          JSON.parse(responseText);
      } catch {
        data = {
          raw: responseText,
        };
      }
    }

    if (!response.ok) {
      const error = new Error(
        data?.error ||
        data?.message ||
        `Text runtime HTTP ${response.status}`
      );

      error.statusCode =
        response.status;

      error.runtimeData = data;
      throw error;
    }

    return {
      ok: true,
      status:
        response.status,
      data,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getTextRuntimeHealth() {
  const policy =
    readTextRuntimeSessionPolicy();

  try {
    const result =
      await requestTextRuntime(
        policy.runtime
          ?.healthPath ||
        "/health"
      );

    return {
      reachable: true,
      healthy: true,
      response:
        result.data,
    };
  } catch (error) {
    return {
      reachable: false,
      healthy: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

function formatRestorePromptSection(
  heading,
  values
) {
  const items =
    Array.isArray(values)
      ? values
          .map(
            (value) =>
              String(value || "")
                .trim()
          )
          .filter(Boolean)
      : [];

  if (!items.length) {
    return "";
  }

  return (
    `${heading}:\n` +
    items
      .map(
        (value) =>
          `- ${value}`
      )
      .join("\n")
  );
}

function buildConversationRestorePrompt(
  conversation
) {
  const policy =
    readTextRuntimeSessionPolicy();

  const restorePolicy =
    policy.restorePrompt || {};

  const memory =
    conversation.memory || {};

  const restoreContext =
    conversation.session
      ?.restoreContext || {};

  const sections = [];

  sections.push(
    "คุณกำลังดำเนินบทสนทนาเดิมต่อจากเซสชันก่อนหน้า"
  );

  sections.push(
    `Conversation ID: ${conversation.id}`
  );

  sections.push(
    `ชื่อบทสนทนา: ${conversation.title}`
  );

  if (
    restorePolicy
      .includeSystemPrompt !== false &&
    conversation.systemPrompt
  ) {
    sections.push(
      "System Prompt เดิม:\n" +
      conversation.systemPrompt
    );
  }

  if (
    restorePolicy
      .includeSummary !== false &&
    (
      restoreContext.summary ||
      memory.summary
    )
  ) {
    sections.push(
      "สรุปบริบทก่อนหน้า:\n" +
      (
        restoreContext.summary ||
        memory.summary
      )
    );
  }

  if (
    restorePolicy
      .includeFacts !== false
  ) {
    const section =
      formatRestorePromptSection(
        "ข้อเท็จจริงที่ต้องจำ",
        restoreContext.facts ||
        memory.facts
      );

    if (section) {
      sections.push(section);
    }
  }

  if (
    restorePolicy
      .includeDecisions !== false
  ) {
    const section =
      formatRestorePromptSection(
        "การตัดสินใจที่ตกลงแล้ว",
        restoreContext.decisions ||
        memory.decisions
      );

    if (section) {
      sections.push(section);
    }
  }

  if (
    restorePolicy
      .includeTasks !== false
  ) {
    const section =
      formatRestorePromptSection(
        "งานที่ต้องดำเนินการต่อ",
        restoreContext.tasks ||
        memory.tasks
      );

    if (section) {
      sections.push(section);
    }
  }

  if (
    restorePolicy
      .includeRecentMessages !== false
  ) {
    const maximumRecentMessages =
      Number(
        restorePolicy
          .maximumRecentMessages
      ) || 20;

    const recentMessages =
      (
        restoreContext.recentMessages ||
        conversation.messages ||
        []
      ).slice(
        -maximumRecentMessages
      );

    if (recentMessages.length) {
      sections.push(
        "ข้อความล่าสุด:\n" +
        recentMessages
          .map(
            (message) =>
              `[${message.role}] ${message.content}`
          )
          .join("\n")
      );
    }
  }

  sections.push(
    "ตอบต่อเนื่องจากบริบทนี้ โดยไม่เริ่มบทสนทนาใหม่และไม่ถามข้อมูลที่มีอยู่แล้วซ้ำ"
  );

  const maximumCharacters =
    Number(
      restorePolicy
        .maximumPromptCharacters
    ) || 32000;

  return sections
    .filter(Boolean)
    .join("\n\n")
    .slice(
      0,
      maximumCharacters
    );
}

function getTextRuntimeModelLoadPayload(
  conversation,
  restorePrompt
) {
  const activeModelId =
    conversation.modelId ||
    readInstalledTextModels()
      .activeModelId ||
    null;

  const installedRegistry =
    readInstalledTextModels();

  const installedModel =
    installedRegistry.models
      .filter(
        (model) =>
          !activeModelId ||
          model.modelId ===
          activeModelId
      )
      .sort(
        (left, right) =>
          new Date(
            right.installedAt || 0
          ).getTime() -
          new Date(
            left.installedAt || 0
          ).getTime()
      )[0] ||
    null;

  return {
    modelId:
      activeModelId ||
      installedModel?.modelId ||
      null,
    modelPath:
      installedModel
        ?.installedPath ||
      null,
    runtime:
      installedModel?.runtime ||
      "llama.cpp",
    variantId:
      installedModel
        ?.variantId ||
      null,
    quantization:
      installedModel
        ?.quantization ||
      null,
    contextLength:
      getConversationContextLimit(
        conversation
      ),
    systemPrompt:
      restorePrompt,
    conversationId:
      conversation.id,
    sessionId:
      conversation.session?.id ||
      null,
  };
}

async function unloadTextRuntimeModel(
  conversation
) {
  const policy =
    readTextRuntimeSessionPolicy();

  return requestTextRuntime(
    policy.runtime
      ?.unloadPath ||
    "/v1/models/unload",
    {
      method: "POST",
      body: {
        conversationId:
          conversation.id,
        modelId:
          conversation.modelId ||
          null,
      },
    }
  );
}

async function loadTextRuntimeModel(
  conversation,
  restorePrompt
) {
  const policy =
    readTextRuntimeSessionPolicy();

  return requestTextRuntime(
    policy.runtime
      ?.loadPath ||
    "/v1/models/load",
    {
      method: "POST",
      timeoutMs:
        Number(
          policy.runtime
            ?.loadTimeoutMs
        ) ||
        120000,
      body:
        getTextRuntimeModelLoadPayload(
          conversation,
          restorePrompt
        ),
    }
  );
}

async function refreshTextRuntimeSession(
  conversationId,
  {
    forceMemoryRefresh = true,
    reason =
      "context-or-ram-threshold",
  } = {}
) {
  const store =
    readTextChatStore();

  let conversation =
    findTextChatConversation(
      store,
      conversationId
    );

  if (!conversation) {
    const error = new Error(
      "Conversation was not found."
    );

    error.statusCode = 404;
    throw error;
  }

  if (forceMemoryRefresh) {
    optimizeTextChatConversation(
      conversationId,
      {
        force: true,
        reason,
      }
    );

    const refreshedStore =
      readTextChatStore();

    conversation =
      findTextChatConversation(
        refreshedStore,
        conversationId
      );
  }

  const restorePrompt =
    buildConversationRestorePrompt(
      conversation
    );

  const policy =
    readTextRuntimeSessionPolicy();

  const beforeHealth =
    policy.refresh
      ?.healthCheckBeforeRefresh ===
      false
      ? null
      : await getTextRuntimeHealth();

  const state = {
    conversationId,
    status: "preparing",
    startedAt:
      new Date().toISOString(),
    completedAt: null,
    reason,
    beforeHealth,
    unload: null,
    load: null,
    afterHealth: null,
    restorePromptCharacters:
      restorePrompt.length,
    runtimeOffline: false,
    error: null,
  };

  textRuntimeSessionState.set(
    conversationId,
    state
  );

  const runtimeReachable =
    beforeHealth?.reachable !==
    false;

  if (
    !runtimeReachable &&
    policy.runtime
      ?.allowOfflinePreparation ===
      true
  ) {
    state.status =
      "prepared-offline";

    state.runtimeOffline = true;

    state.completedAt =
      new Date().toISOString();

    textRuntimeSessionState.set(
      conversationId,
      state
    );

    return {
      ...state,
      restorePrompt,
      conversation,
    };
  }

  try {
    if (
      policy.refresh
        ?.unloadBeforeReload !==
        false
    ) {
      state.status =
        "unloading";

      state.unload =
        await unloadTextRuntimeModel(
          conversation
        );
    }

    state.status = "loading";

    state.load =
      await loadTextRuntimeModel(
        conversation,
        restorePrompt
      );

    if (
      policy.refresh
        ?.healthCheckAfterReload !==
        false
    ) {
      state.status =
        "verifying";

      state.afterHealth =
        await getTextRuntimeHealth();

      if (
        state.afterHealth
          ?.healthy !== true
      ) {
        throw new Error(
          "Text runtime did not become healthy after reload."
        );
      }
    }

    state.status = "ready";

    state.completedAt =
      new Date().toISOString();

    textRuntimeSessionState.set(
      conversationId,
      state
    );

    return {
      ...state,
      restorePrompt,
      conversation,
    };
  } catch (error) {
    state.status = "failed";

    state.completedAt =
      new Date().toISOString();

    state.error =
      error instanceof Error
        ? error.message
        : String(error);

    textRuntimeSessionState.set(
      conversationId,
      state
    );

    throw error;
  }
}

function getTextRuntimeSessionStatus(
  conversationId
) {
  return (
    textRuntimeSessionState.get(
      conversationId
    ) || {
      conversationId,
      status: "idle",
      startedAt: null,
      completedAt: null,
      runtimeOffline: false,
      error: null,
    }
  );
}


// LUKE_AI_TEXT_GENERATION_STREAMING_V1
const textGenerationPolicyPath = path.join(
  ROOT,
  "app",
  "config",
  "text-chat",
  "generation-policy.json"
);

const activeTextGenerations = new Map();

function readTextGenerationPolicy() {
  return readJsonFileStrict(
    textGenerationPolicyPath,
    "Text generation policy"
  );
}

function writeTextGenerationEvent(
  response,
  event,
  data
) {
  if (
    response.destroyed ||
    response.writableEnded
  ) {
    return;
  }

  response.write(
    `event: ${event}\n`
  );

  response.write(
    `data: ${JSON.stringify(data)}\n\n`
  );
}

function getTextGenerationMessages(
  conversation
) {
  const policy =
    readTextGenerationPolicy();

  const messages = [];

  if (
    policy.conversation
      ?.includeRestorePrompt !== false
  ) {
    const restorePrompt =
      buildConversationRestorePrompt(
        conversation
      );

    if (restorePrompt) {
      messages.push({
        role: "system",
        content: restorePrompt,
      });
    }
  } else if (
    conversation.systemPrompt
  ) {
    messages.push({
      role: "system",
      content:
        conversation.systemPrompt,
    });
  }

  if (
    policy.conversation
      ?.includeRecentMessages !== false
  ) {
    const maximumRecentMessages =
      Number(
        policy.conversation
          ?.maximumRecentMessages
      ) || 20;

    const recentMessages =
      (
        conversation.messages || []
      )
        .filter(
          (message) =>
            [
              "user",
              "assistant",
              "system",
            ].includes(message.role)
        )
        .slice(
          -maximumRecentMessages
        );

    for (const message of recentMessages) {
      messages.push({
        role: message.role,
        content: message.content,
      });
    }
  }

  return messages;
}

function getTextGenerationModelId(
  conversation
) {
  if (conversation.modelId) {
    return conversation.modelId;
  }

  try {
    const registry =
      readInstalledTextModels();

    if (registry.activeModelId) {
      return registry.activeModelId;
    }

    const latest =
      [...(registry.models || [])]
        .sort(
          (left, right) =>
            new Date(
              right.installedAt || 0
            ).getTime() -
            new Date(
              left.installedAt || 0
            ).getTime()
        )[0];

    return (
      latest?.modelId ||
      "local-model"
    );
  } catch {
    return "local-model";
  }
}

function createTextGenerationPayload(
  conversation,
  overrides = {}
) {
  const policy =
    readTextGenerationPolicy();

  return {
    model:
      overrides.modelId ||
      (
        overrides.autoRoute ===
          false
          ? getTextGenerationModelId(
              conversation
            )
          : (
              routeTextModel({
                prompt:
                  [...(
                    conversation.messages ||
                    []
                  )]
                    .reverse()
                    .find(
                      (message) =>
                        message.role ===
                        "user"
                    )
                    ?.content ||
                  "",
                conversationId:
                  conversation.id,
              })
                .selectedModel
                .modelId
            )
      ),
    messages:
      getTextGenerationMessages(
        conversation
      ),
    stream: true,
    temperature:
      Number(
        overrides.temperature ??
        conversation.settings
          ?.temperature ??
        policy.generation
          ?.temperature
      ) || 0.7,
    top_p:
      Number(
        overrides.topP ??
        policy.generation?.topP
      ) || 0.9,
    max_tokens:
      Number(
        overrides.maxTokens ??
        policy.generation
          ?.maxTokens
      ) || 2048,
    stop:
      Array.isArray(
        overrides.stop
      )
        ? overrides.stop
        : (
            policy.generation
              ?.stopSequences || []
          ),
  };
}

function extractTextGenerationDelta(
  payload
) {
  if (!payload) {
    return "";
  }

  if (typeof payload === "string") {
    return payload;
  }

  const openAiDelta =
    payload.choices?.[0]
      ?.delta?.content;

  if (
    typeof openAiDelta ===
    "string"
  ) {
    return openAiDelta;
  }

  const openAiText =
    payload.choices?.[0]
      ?.text;

  if (
    typeof openAiText ===
    "string"
  ) {
    return openAiText;
  }

  if (
    typeof payload.content ===
    "string"
  ) {
    return payload.content;
  }

  if (
    typeof payload.token ===
    "string"
  ) {
    return payload.token;
  }

  if (
    typeof payload.response ===
    "string"
  ) {
    return payload.response;
  }

  return "";
}

function appendAssistantGenerationMessage(
  conversationId,
  content,
  {
    modelId = null,
    stopped = false,
    generationId = null,
  } = {}
) {
  const normalized =
    String(content || "").trim();

  if (!normalized) {
    return null;
  }

  return appendTextChatMessage(
    conversationId,
    {
      role: "assistant",
      content: normalized,
      modelId,
      metadata: {
        source:
          "text-runtime-stream",
        stopped,
        partial: stopped,
        generationId,
        autosaved: true,
      },
    }
  );
}

async function streamTextRuntimeGeneration(
  conversationId,
  response,
  options = {}
) {
  const policy =
    readTextGenerationPolicy();

  const store =
    readTextChatStore();

  const conversation =
    findTextChatConversation(
      store,
      conversationId
    );

  if (!conversation) {
    const error = new Error(
      "Conversation was not found."
    );

    error.statusCode = 404;
    throw error;
  }

  if (
    policy.conversation
      ?.preventConcurrentGeneration !==
      false &&
    activeTextGenerations.has(
      conversationId
    )
  ) {
    const error = new Error(
      "A response is already being generated for this conversation."
    );

    error.statusCode = 409;
    throw error;
  }

  const controller =
    new AbortController();

  const generationId =
    createTextChatId(
      "generation"
    );

  const runtimePolicy =
    readTextRuntimeSessionPolicy();

  const generationPath =
    policy.runtime
      ?.generationPath ||
    "/v1/chat/completions";

  const timeoutMs =
    Number(
      policy.runtime
        ?.requestTimeoutMs
    ) || 300000;

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  const state = {
    generationId,
    conversationId,
    controller,
    status: "starting",
    startedAt:
      new Date().toISOString(),
    completedAt: null,
    accumulatedText: "",
    modelId:
      getTextGenerationModelId(
        conversation
      ),
    stopped: false,
    error: null,
  };

  activeTextGenerations.set(
    conversationId,
    state
  );

  response.writeHead(
    200,
    {
      "content-type":
        "text/event-stream; charset=utf-8",
      "cache-control":
        "no-cache, no-transform",
      connection:
        "keep-alive",
      "x-accel-buffering":
        "no",
    }
  );

  response.flushHeaders?.();

  writeTextGenerationEvent(
    response,
    "start",
    {
      generationId,
      conversationId,
      modelId:
        state.modelId,
    }
  );

  try {
    state.status = "streaming";

    const runtimeResponse =
      await fetch(
        buildTextRuntimeUrl(
          generationPath
        ),
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json",
            accept:
              "text/event-stream, application/json",
          },
          body: JSON.stringify(
            createTextGenerationPayload(
              conversation,
              options
            )
          ),
          signal:
            controller.signal,
        }
      );

    if (!runtimeResponse.ok) {
      const errorText =
        await runtimeResponse.text();

      throw new Error(
        errorText ||
        `Text runtime HTTP ${runtimeResponse.status}`
      );
    }

    if (!runtimeResponse.body) {
      throw new Error(
        "Text runtime returned no response body."
      );
    }

    const contentType =
      String(
        runtimeResponse.headers.get(
          "content-type"
        ) || ""
      ).toLowerCase();

    if (
      contentType.includes(
        "application/json"
      )
    ) {
      const payload =
        await runtimeResponse.json();

      const content =
        extractTextGenerationDelta(
          payload
        );

      if (content) {
        state.accumulatedText +=
          content;

        writeTextGenerationEvent(
          response,
          "delta",
          {
            generationId,
            content,
          }
        );
      }
    } else {
      const reader =
        runtimeResponse.body
          .getReader();

      const decoder =
        new TextDecoder();

      let buffer = "";

      while (true) {
        const result =
          await reader.read();

        if (result.done) {
          break;
        }

        buffer += decoder.decode(
          result.value,
          {
            stream: true,
          }
        );

        const lines =
          buffer.split(/\r?\n/);

        buffer =
          lines.pop() || "";

        for (const rawLine of lines) {
          const line =
            rawLine.trim();

          if (
            !line ||
            line.startsWith(":")
          ) {
            continue;
          }

          let serialized = line;

          if (
            serialized.startsWith(
              "data:"
            )
          ) {
            serialized =
              serialized
                .slice(5)
                .trim();
          }

          if (
            serialized === "[DONE]"
          ) {
            continue;
          }

          let payload = null;

          try {
            payload =
              JSON.parse(serialized);
          } catch {
            payload = serialized;
          }

          const content =
            extractTextGenerationDelta(
              payload
            );

          if (!content) {
            continue;
          }

          state.accumulatedText +=
            content;

          writeTextGenerationEvent(
            response,
            "delta",
            {
              generationId,
              content,
            }
          );
        }
      }

      const remaining =
        buffer.trim();

      if (
        remaining &&
        remaining !== "[DONE]"
      ) {
        const serialized =
          remaining.startsWith(
            "data:"
          )
            ? remaining
                .slice(5)
                .trim()
            : remaining;

        let payload = null;

        try {
          payload =
            JSON.parse(serialized);
        } catch {
          payload = serialized;
        }

        const content =
          extractTextGenerationDelta(
            payload
          );

        if (content) {
          state.accumulatedText +=
            content;

          writeTextGenerationEvent(
            response,
            "delta",
            {
              generationId,
              content,
            }
          );
        }
      }
    }

    state.status = "completed";

    state.completedAt =
      new Date().toISOString();

    let savedMessage = null;

    if (
      policy.generation
        ?.autosaveAssistantResponse !==
        false
    ) {
      const saved =
        appendAssistantGenerationMessage(
          conversationId,
          state.accumulatedText,
          {
            modelId:
              state.modelId,
            stopped: false,
            generationId,
          }
        );

      savedMessage =
        saved?.message || null;
    }

    writeTextGenerationEvent(
      response,
      "complete",
      {
        generationId,
        conversationId,
        content:
          state.accumulatedText,
        message:
          savedMessage,
        autosaved:
          Boolean(savedMessage),
      }
    );
  } catch (error) {
    const stopped =
      error?.name ===
        "AbortError" ||
      state.stopped === true;

    state.stopped = stopped;

    state.status =
      stopped
        ? "stopped"
        : "failed";

    state.completedAt =
      new Date().toISOString();

    state.error =
      stopped
        ? null
        : (
            error instanceof Error
              ? error.message
              : String(error)
          );

    let savedMessage = null;

    const minimumPartialCharacters =
      Number(
        policy.generation
          ?.minimumPartialResponseCharacters
      ) || 1;

    if (
      stopped &&
      policy.generation
        ?.savePartialResponseWhenStopped !==
        false &&
      state.accumulatedText
        .trim().length >=
        minimumPartialCharacters
    ) {
      const saved =
        appendAssistantGenerationMessage(
          conversationId,
          state.accumulatedText,
          {
            modelId:
              state.modelId,
            stopped: true,
            generationId,
          }
        );

      savedMessage =
        saved?.message || null;
    }

    if (stopped) {
      writeTextGenerationEvent(
        response,
        "stopped",
        {
          generationId,
          conversationId,
          content:
            state.accumulatedText,
          message:
            savedMessage,
          autosaved:
            Boolean(savedMessage),
        }
      );
    } else {
      writeTextGenerationEvent(
        response,
        "error",
        {
          generationId,
          conversationId,
          error:
            state.error,
        }
      );
    }
  } finally {
    clearTimeout(timer);

    activeTextGenerations.delete(
      conversationId
    );

    if (!response.writableEnded) {
      response.end();
    }
  }
}

function stopTextRuntimeGeneration(
  conversationId
) {
  const state =
    activeTextGenerations.get(
      conversationId
    );

  if (!state) {
    return {
      stopped: false,
      reason:
        "No active generation.",
    };
  }

  state.stopped = true;
  state.status = "stopping";
  state.controller.abort();

  return {
    stopped: true,
    generationId:
      state.generationId,
  };
}

function getTextRuntimeGenerationStatus(
  conversationId
) {
  const state =
    activeTextGenerations.get(
      conversationId
    );

  if (!state) {
    return {
      conversationId,
      active: false,
      status: "idle",
      generationId: null,
    };
  }

  return {
    conversationId,
    active: true,
    status:
      state.status,
    generationId:
      state.generationId,
    startedAt:
      state.startedAt,
    accumulatedCharacters:
      state.accumulatedText.length,
    modelId:
      state.modelId,
  };
}


// LUKE_AI_MULTI_MODEL_PARALLEL_GENERATION_V1
const multiModelPolicyPath = path.join(
  ROOT,
  "app",
  "config",
  "text-chat",
  "multi-model-policy.json"
);

const activeMultiModelGenerations =
  new Map();

function readMultiModelPolicy() {
  return readJsonFileStrict(
    multiModelPolicyPath,
    "Multi-model generation policy"
  );
}

function normalizeSelectedModelIds(
  modelIds
) {
  const policy =
    readMultiModelPolicy();

  const maximumModels =
    Number(
      policy.selection
        ?.maximumModels
    ) || 3;

  const normalized = [
    ...new Set(
      (
        Array.isArray(modelIds)
          ? modelIds
          : []
      )
        .map(
          (modelId) =>
            String(modelId || "")
              .trim()
        )
        .filter(Boolean)
    ),
  ];

  if (!normalized.length) {
    const error = new Error(
      "Select at least one text model."
    );

    error.statusCode = 400;
    throw error;
  }

  if (
    normalized.length >
    maximumModels
  ) {
    const error = new Error(
      `Select no more than ${maximumModels} models.`
    );

    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function tokenizeForSimilarity(
  value
) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .replace(
        /[^\p{L}\p{N}\s]/gu,
        " "
      )
      .split(/\s+/)
      .map(
        (token) =>
          token.trim()
      )
      .filter(
        (token) =>
          token.length > 1
      )
  );
}

function calculateJaccardSimilarity(
  left,
  right
) {
  const leftTokens =
    tokenizeForSimilarity(left);

  const rightTokens =
    tokenizeForSimilarity(right);

  if (
    !leftTokens.size &&
    !rightTokens.size
  ) {
    return 1;
  }

  const intersection =
    [...leftTokens]
      .filter(
        (token) =>
          rightTokens.has(token)
      )
      .length;

  const union =
    new Set([
      ...leftTokens,
      ...rightTokens,
    ]).size;

  return union > 0
    ? intersection / union
    : 0;
}

function calculateResponseMetrics(
  response,
  prompt,
  allResponses
) {
  const content =
    String(response.content || "")
      .trim();

  const promptTokens =
    tokenizeForSimilarity(prompt);

  const responseTokens =
    tokenizeForSimilarity(content);

  const overlappingPromptTokens =
    [...promptTokens]
      .filter(
        (token) =>
          responseTokens.has(token)
      )
      .length;

  const relevance =
    promptTokens.size > 0
      ? Math.min(
          1,
          overlappingPromptTokens /
          Math.max(
            1,
            promptTokens.size
          )
        )
      : 0.5;

  const characterCount =
    content.length;

  const sentenceCount =
    content
      .split(/[.!?。！？\n]+/)
      .map(
        (value) =>
          value.trim()
      )
      .filter(Boolean)
      .length;

  const completeness =
    Math.min(
      1,
      characterCount / 700
    );

  const clarity =
    sentenceCount > 0
      ? Math.min(
          1,
          1 -
          Math.abs(
            characterCount /
            sentenceCount -
            110
          ) /
          300
        )
      : 0;

  const detail =
    Math.min(
      1,
      responseTokens.size / 120
    );

  const similarities =
    allResponses
      .filter(
        (candidate) =>
          candidate.modelId !==
          response.modelId
      )
      .map(
        (candidate) =>
          calculateJaccardSimilarity(
            content,
            candidate.content
          )
      );

  const maximumSimilarity =
    similarities.length
      ? Math.max(
          ...similarities
        )
      : 0;

  const uniqueness =
    Math.max(
      0,
      1 - maximumSimilarity
    );

  return {
    relevance:
      Number(
        relevance.toFixed(4)
      ),
    completeness:
      Number(
        completeness.toFixed(4)
      ),
    clarity:
      Number(
        Math.max(
          0,
          clarity
        ).toFixed(4)
      ),
    detail:
      Number(
        detail.toFixed(4)
      ),
    uniqueness:
      Number(
        uniqueness.toFixed(4)
      ),
    characterCount,
    sentenceCount,
    maximumSimilarity:
      Number(
        maximumSimilarity.toFixed(4)
      ),
  };
}

function evaluateMultiModelResponses(
  responses,
  prompt
) {
  const policy =
    readMultiModelPolicy();

  const weights =
    policy.evaluation
      ?.weights || {};

  const evaluated =
    responses.map(
      (response) => {
        const metrics =
          calculateResponseMetrics(
            response,
            prompt,
            responses
          );

        const score =
          metrics.relevance *
            Number(
              weights.relevance ??
              0.35
            ) +
          metrics.completeness *
            Number(
              weights.completeness ??
              0.3
            ) +
          metrics.clarity *
            Number(
              weights.clarity ??
              0.2
            ) +
          metrics.detail *
            Number(
              weights.detail ??
              0.1
            ) +
          metrics.uniqueness *
            Number(
              weights.uniqueness ??
              0.05
            );

        return {
          ...response,
          metrics,
          score:
            Number(
              score.toFixed(4)
            ),
        };
      }
    )
      .sort(
        (left, right) =>
          right.score -
          left.score
      )
      .map(
        (response, index) => ({
          ...response,
          rank:
            index + 1,
          best:
            index === 0,
        })
      );

  return {
    winner:
      evaluated[0] || null,
    responses:
      evaluated,
  };
}

function getInstalledTextModelsForSelection() {
  try {
    const registry =
      readInstalledTextModels();

    return (
      registry.models || []
    )
      .filter(
        (model) =>
          model.installedPath
      )
      .map(
        (model) => ({
          modelId:
            model.modelId,
          modelName:
            model.modelName ||
            model.modelId,
          version:
            model.version,
          variantId:
            model.variantId,
          quantization:
            model.quantization,
          runtime:
            model.runtime,
          installedPath:
            model.installedPath,
          active:
            registry.activeModelId ===
            model.modelId,
        })
      );
  } catch {
    return [];
  }
}

async function requestSingleModelGeneration(
  conversation,
  modelId,
  prompt,
  controller,
  onDelta
) {
  const policy =
    readTextGenerationPolicy();

  const generationPath =
    policy.runtime
      ?.generationPath ||
    "/v1/chat/completions";

  const payload =
    createTextGenerationPayload(
      conversation,
      {
        modelId,
      }
    );

  const runtimeResponse =
    await fetch(
      buildTextRuntimeUrl(
        generationPath
      ),
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json",
          accept:
            "text/event-stream, application/json",
          "x-luke-model-id":
            modelId,
        },
        body:
          JSON.stringify(payload),
        signal:
          controller.signal,
      }
    );

  if (!runtimeResponse.ok) {
    const errorText =
      await runtimeResponse.text();

    throw new Error(
      errorText ||
      `Model ${modelId} returned HTTP ${runtimeResponse.status}`
    );
  }

  if (!runtimeResponse.body) {
    throw new Error(
      `Model ${modelId} returned no response body.`
    );
  }

  const contentType =
    String(
      runtimeResponse.headers.get(
        "content-type"
      ) || ""
    ).toLowerCase();

  let accumulatedText = "";

  if (
    contentType.includes(
      "application/json"
    )
  ) {
    const body =
      await runtimeResponse.json();

    const delta =
      extractTextGenerationDelta(
        body
      );

    if (delta) {
      accumulatedText += delta;

      onDelta(delta);
    }
  } else {
    const reader =
      runtimeResponse.body
        .getReader();

    const decoder =
      new TextDecoder();

    let buffer = "";

    while (true) {
      const result =
        await reader.read();

      if (result.done) {
        break;
      }

      buffer += decoder.decode(
        result.value,
        {
          stream: true,
        }
      );

      const lines =
        buffer.split(/\r?\n/);

      buffer =
        lines.pop() || "";

      for (const rawLine of lines) {
        let line =
          rawLine.trim();

        if (
          !line ||
          line.startsWith(":")
        ) {
          continue;
        }

        if (
          line.startsWith("data:")
        ) {
          line =
            line
              .slice(5)
              .trim();
        }

        if (
          line === "[DONE]"
        ) {
          continue;
        }

        let eventPayload = null;

        try {
          eventPayload =
            JSON.parse(line);
        } catch {
          eventPayload = line;
        }

        const delta =
          extractTextGenerationDelta(
            eventPayload
          );

        if (!delta) {
          continue;
        }

        accumulatedText += delta;

        onDelta(delta);
      }
    }
  }

  return {
    modelId,
    content:
      accumulatedText.trim(),
    status:
      "completed",
    error:
      null,
  };
}

async function streamMultiModelGeneration(
  conversationId,
  modelIds,
  response
) {
  const selectedModelIds =
    normalizeSelectedModelIds(
      modelIds
    );

  if (
    activeMultiModelGenerations
      .has(conversationId)
  ) {
    const error = new Error(
      "Multi-model generation is already running for this conversation."
    );

    error.statusCode = 409;
    throw error;
  }

  const store =
    readTextChatStore();

  const conversation =
    findTextChatConversation(
      store,
      conversationId
    );

  if (!conversation) {
    const error = new Error(
      "Conversation was not found."
    );

    error.statusCode = 404;
    throw error;
  }

  const lastUserMessage =
    [...(
      conversation.messages || []
    )]
      .reverse()
      .find(
        (message) =>
          message.role === "user"
      );

  const prompt =
    lastUserMessage?.content || "";

  const generationId =
    createTextChatId(
      "multi-generation"
    );

  const controllers =
    new Map();

  const state = {
    generationId,
    conversationId,
    modelIds:
      selectedModelIds,
    status:
      "running",
    startedAt:
      new Date().toISOString(),
    stopped:
      false,
    controllers,
  };

  activeMultiModelGenerations.set(
    conversationId,
    state
  );

  response.writeHead(
    200,
    {
      "content-type":
        "text/event-stream; charset=utf-8",
      "cache-control":
        "no-cache, no-transform",
      connection:
        "keep-alive",
      "x-accel-buffering":
        "no",
    }
  );

  response.flushHeaders?.();

  writeTextGenerationEvent(
    response,
    "multi-start",
    {
      generationId,
      conversationId,
      modelIds:
        selectedModelIds,
      modelCount:
        selectedModelIds.length,
    }
  );

  try {
    const tasks =
      selectedModelIds.map(
        async (modelId) => {
          const controller =
            new AbortController();

          controllers.set(
            modelId,
            controller
          );

          try {
            const result =
              await requestSingleModelGeneration(
                conversation,
                modelId,
                prompt,
                controller,
                (delta) => {
                  writeTextGenerationEvent(
                    response,
                    "model-delta",
                    {
                      generationId,
                      modelId,
                      content:
                        delta,
                    }
                  );
                }
              );

            writeTextGenerationEvent(
              response,
              "model-complete",
              {
                generationId,
                modelId,
                content:
                  result.content,
              }
            );

            return result;
          } catch (error) {
            const stopped =
              state.stopped ||
              error?.name ===
                "AbortError";

            const result = {
              modelId,
              content: "",
              status:
                stopped
                  ? "stopped"
                  : "failed",
              error:
                stopped
                  ? null
                  : (
                      error instanceof Error
                        ? error.message
                        : String(error)
                    ),
            };

            writeTextGenerationEvent(
              response,
              stopped
                ? "model-stopped"
                : "model-error",
              {
                generationId,
                ...result,
              }
            );

            return result;
          }
        }
      );

    const rawResults =
      await Promise.all(tasks);

    const completedResponses =
      rawResults.filter(
        (result) =>
          result.status ===
            "completed" &&
          result.content.trim()
      );

    const baseEvaluation =
      evaluateMultiModelResponses(
        completedResponses,
        prompt
      );

    const adaptiveResponses =
      applyAdaptiveFeedbackScores(
        baseEvaluation.responses
      );

    const evaluation = {
      winner:
        adaptiveResponses[0] || null,
      responses:
        adaptiveResponses,
    };

    const savedMessages = [];

    for (
      const evaluated
      of evaluation.responses
    ) {
      const saved =
        appendTextChatMessage(
          conversationId,
          {
            role:
              "assistant",
            content:
              evaluated.content,
            modelId:
              evaluated.modelId,
            metadata: {
              source:
                "multi-model-generation",
              generationId,
              multiModel: true,
              score:
                evaluated.score,
              rank:
                evaluated.rank,
              best:
                evaluated.best,
              metrics:
                evaluated.metrics,
              autosaved:
                true,
            },
          }
        );

      if (saved?.message) {
        savedMessages.push(
          saved.message
        );
      }
    }

    state.status =
      state.stopped
        ? "stopped"
        : "completed";

    state.completedAt =
      new Date().toISOString();

    writeTextGenerationEvent(
      response,
      "multi-complete",
      {
        generationId,
        conversationId,
        stopped:
          state.stopped,
        winnerModelId:
          evaluation.winner
            ?.modelId ||
          null,
        winnerScore:
          evaluation.winner
            ?.score ||
          null,
        responses:
          evaluation.responses,
        savedMessages,
      }
    );
  } finally {
    activeMultiModelGenerations
      .delete(conversationId);

    if (!response.writableEnded) {
      response.end();
    }
  }
}

function stopMultiModelGeneration(
  conversationId
) {
  const state =
    activeMultiModelGenerations
      .get(conversationId);

  if (!state) {
    return {
      stopped: false,
      reason:
        "No active multi-model generation.",
    };
  }

  state.stopped = true;
  state.status =
    "stopping";

  for (
    const controller
    of state.controllers.values()
  ) {
    controller.abort();
  }

  return {
    stopped: true,
    generationId:
      state.generationId,
    modelIds:
      state.modelIds,
  };
}


// LUKE_AI_JUDGE_SYNTHESIS_V1
const aiJudgePolicyPath = path.join(
  ROOT,
  "app",
  "config",
  "text-chat",
  "judge-synthesis-policy.json"
);

const activeJudgeSyntheses =
  new Map();

function readAiJudgePolicy() {
  return readJsonFileStrict(
    aiJudgePolicyPath,
    "AI Judge synthesis policy"
  );
}

function getLatestMultiModelResponses(
  conversation
) {
  const messages =
    conversation.messages || [];

  const candidates =
    messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          message.metadata?.multiModel === true
      )
      .slice(-3)
      .map(
        (message) => ({
          messageId: message.id,
          modelId:
            message.modelId ||
            "unknown-model",
          content:
            message.content,
          score:
            Number(
              message.metadata?.score
            ) || 0,
          rank:
            Number(
              message.metadata?.rank
            ) || 999,
          best:
            message.metadata?.best === true,
          metrics:
            message.metadata?.metrics || {},
        })
      )
      .sort(
        (left, right) =>
          left.rank - right.rank
      );

  return candidates;
}

function buildAiJudgePrompt(
  conversation,
  responses
) {
  const lastUserMessage =
    [...(
      conversation.messages || []
    )]
      .reverse()
      .find(
        (message) =>
          message.role === "user"
      );

  const responseSections =
    responses.map(
      (response, index) => (
        `คำตอบที่ ${index + 1}\n` +
        `Model ID: ${response.modelId}\n` +
        `Rank: ${response.rank}\n` +
        `เนื้อหา:\n${response.content}`
      )
    );

  return [
    "คุณคือ AI Judge และ Final Answer Synthesizer",
    "หน้าที่คือรวมคำตอบจากหลายโมเดลให้เป็นคำตอบสุดท้ายเพียงคำตอบเดียว",
    "",
    "ข้อกำหนด:",
    "- ตอบด้วยภาษาเดียวกับผู้ใช้",
    "- รักษาข้อมูลที่ถูกต้องและมีประโยชน์",
    "- รวมจุดแข็งของแต่ละคำตอบ",
    "- ลบข้อความซ้ำ",
    "- แก้ความขัดแย้งโดยเลือกข้อมูลที่สมเหตุสมผลและสอดคล้องที่สุด",
    "- ไม่กล่าวถึงคะแนน อันดับ หรือขั้นตอนประเมินภายใน",
    "- ไม่กล่าวว่าเป็นการรวมจากหลายโมเดล",
    "- ไม่ถามข้อมูลเดิมที่มีอยู่แล้วซ้ำ",
    "",
    `คำถามของผู้ใช้:\n${lastUserMessage?.content || ""}`,
    "",
    ...responseSections,
    "",
    "สร้าง Final Answer ที่สมบูรณ์ ชัดเจน และพร้อมส่งให้ผู้ใช้:",
  ].join("\n\n");
}

function selectJudgeModelId(
  conversation,
  responses,
  requestedJudgeModelId
) {
  if (
    typeof requestedJudgeModelId ===
      "string" &&
    requestedJudgeModelId.trim()
  ) {
    return requestedJudgeModelId.trim();
  }

  const policy =
    readAiJudgePolicy();

  if (
    policy.judge
      ?.preferBestResponseModel !== false
  ) {
    const best =
      responses.find(
        (response) =>
          response.best === true
      ) ||
      responses[0];

    if (best?.modelId) {
      return best.modelId;
    }
  }

  return getTextGenerationModelId(
    conversation
  );
}

function saveAiJudgeFinalAnswer(
  conversationId,
  content,
  {
    judgeModelId,
    sourceResponses,
    synthesisId,
    fallback = false,
  }
) {
  const normalized =
    String(content || "").trim();

  if (!normalized) {
    return null;
  }

  const saved =
    appendTextChatMessage(
      conversationId,
      {
        role: "assistant",
        content: normalized,
        modelId:
          judgeModelId || null,
        metadata: {
          source:
            fallback
              ? "ai-judge-fallback"
              : "ai-judge-synthesis",
          synthesisId,
          finalAnswer: true,
          best: true,
          fallback,
          judgeModelId:
            judgeModelId || null,
          sourceModelIds:
            sourceResponses.map(
              (response) =>
                response.modelId
            ),
          sourceMessageIds:
            sourceResponses.map(
              (response) =>
                response.messageId
            ),
          autosaved: true,
        },
      }
    );

  return saved?.message || null;
}

async function streamAiJudgeSynthesis(
  conversationId,
  response,
  {
    judgeModelId = null,
  } = {}
) {
  if (
    activeJudgeSyntheses.has(
      conversationId
    )
  ) {
    const error = new Error(
      "AI Judge synthesis is already running for this conversation."
    );

    error.statusCode = 409;
    throw error;
  }

  const store =
    readTextChatStore();

  const conversation =
    findTextChatConversation(
      store,
      conversationId
    );

  if (!conversation) {
    const error = new Error(
      "Conversation was not found."
    );

    error.statusCode = 404;
    throw error;
  }

  const sourceResponses =
    getLatestMultiModelResponses(
      conversation
    );

  if (!sourceResponses.length) {
    const error = new Error(
      "No multi-model responses are available for synthesis."
    );

    error.statusCode = 409;
    throw error;
  }

  const selectedJudgeModelId =
    selectJudgeModelId(
      conversation,
      sourceResponses,
      judgeModelId
    );

  const policy =
    readAiJudgePolicy();

  const generationPolicy =
    readTextGenerationPolicy();

  const synthesisId =
    createTextChatId(
      "judge-synthesis"
    );

  const controller =
    new AbortController();

  const state = {
    synthesisId,
    conversationId,
    judgeModelId:
      selectedJudgeModelId,
    controller,
    status: "starting",
    accumulatedText: "",
    startedAt:
      new Date().toISOString(),
    completedAt: null,
    fallback: false,
    error: null,
  };

  activeJudgeSyntheses.set(
    conversationId,
    state
  );

  response.writeHead(
    200,
    {
      "content-type":
        "text/event-stream; charset=utf-8",
      "cache-control":
        "no-cache, no-transform",
      connection:
        "keep-alive",
      "x-accel-buffering":
        "no",
    }
  );

  response.flushHeaders?.();

  writeTextGenerationEvent(
    response,
    "judge-start",
    {
      synthesisId,
      conversationId,
      judgeModelId:
        selectedJudgeModelId,
      sourceModelIds:
        sourceResponses.map(
          (item) =>
            item.modelId
        ),
    }
  );

  try {
    state.status = "streaming";

    const runtimeResponse =
      await fetch(
        buildTextRuntimeUrl(
          generationPolicy.runtime
            ?.generationPath ||
          "/v1/chat/completions"
        ),
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json",
            accept:
              "text/event-stream, application/json",
            "x-luke-model-id":
              selectedJudgeModelId,
            "x-luke-generation-mode":
              "judge-synthesis",
          },
          body: JSON.stringify({
            model:
              selectedJudgeModelId,
            messages: [
              {
                role: "system",
                content:
                  "You are an expert AI judge and response synthesizer.",
              },
              {
                role: "user",
                content:
                  buildAiJudgePrompt(
                    conversation,
                    sourceResponses
                  ),
              },
            ],
            stream: true,
            temperature:
              Number(
                policy.judge
                  ?.temperature
              ) || 0.3,
            top_p:
              Number(
                policy.judge
                  ?.topP
              ) || 0.85,
            max_tokens:
              Number(
                policy.judge
                  ?.maxTokens
              ) || 3072,
          }),
          signal:
            controller.signal,
        }
      );

    if (!runtimeResponse.ok) {
      throw new Error(
        await runtimeResponse.text() ||
        `Judge runtime HTTP ${runtimeResponse.status}`
      );
    }

    if (!runtimeResponse.body) {
      throw new Error(
        "Judge runtime returned no response body."
      );
    }

    const contentType =
      String(
        runtimeResponse.headers.get(
          "content-type"
        ) || ""
      ).toLowerCase();

    if (
      contentType.includes(
        "application/json"
      )
    ) {
      const payload =
        await runtimeResponse.json();

      const delta =
        extractTextGenerationDelta(
          payload
        );

      if (delta) {
        state.accumulatedText +=
          delta;

        writeTextGenerationEvent(
          response,
          "judge-delta",
          {
            synthesisId,
            content: delta,
          }
        );
      }
    } else {
      const reader =
        runtimeResponse.body
          .getReader();

      const decoder =
        new TextDecoder();

      let buffer = "";

      while (true) {
        const result =
          await reader.read();

        if (result.done) {
          break;
        }

        buffer += decoder.decode(
          result.value,
          {
            stream: true,
          }
        );

        const lines =
          buffer.split(/\r?\n/);

        buffer =
          lines.pop() || "";

        for (const rawLine of lines) {
          let line =
            rawLine.trim();

          if (
            !line ||
            line.startsWith(":")
          ) {
            continue;
          }

          if (
            line.startsWith("data:")
          ) {
            line =
              line
                .slice(5)
                .trim();
          }

          if (
            line === "[DONE]"
          ) {
            continue;
          }

          let payload = null;

          try {
            payload =
              JSON.parse(line);
          } catch {
            payload = line;
          }

          const delta =
            extractTextGenerationDelta(
              payload
            );

          if (!delta) {
            continue;
          }

          state.accumulatedText +=
            delta;

          writeTextGenerationEvent(
            response,
            "judge-delta",
            {
              synthesisId,
              content: delta,
            }
          );
        }
      }
    }

    if (!state.accumulatedText.trim()) {
      throw new Error(
        "AI Judge returned an empty response."
      );
    }

    const savedMessage =
      saveAiJudgeFinalAnswer(
        conversationId,
        state.accumulatedText,
        {
          judgeModelId:
            selectedJudgeModelId,
          sourceResponses,
          synthesisId,
          fallback: false,
        }
      );

    state.status = "completed";

    state.completedAt =
      new Date().toISOString();

    writeTextGenerationEvent(
      response,
      "judge-complete",
      {
        synthesisId,
        conversationId,
        judgeModelId:
          selectedJudgeModelId,
        content:
          state.accumulatedText,
        message:
          savedMessage,
        fallback: false,
        autosaved:
          Boolean(savedMessage),
      }
    );
  } catch (error) {
    const fallbackEnabled =
      policy.fallback?.enabled !==
        false;

    const fallbackResponse =
      sourceResponses.find(
        (item) =>
          item.best === true
      ) ||
      sourceResponses[0];

    if (
      fallbackEnabled &&
      fallbackResponse?.content
    ) {
      state.fallback = true;

      state.status =
        "completed-with-fallback";

      state.accumulatedText =
        fallbackResponse.content;

      state.completedAt =
        new Date().toISOString();

      const savedMessage =
        saveAiJudgeFinalAnswer(
          conversationId,
          fallbackResponse.content,
          {
            judgeModelId:
              fallbackResponse.modelId,
            sourceResponses,
            synthesisId,
            fallback: true,
          }
        );

      writeTextGenerationEvent(
        response,
        "judge-fallback",
        {
          synthesisId,
          conversationId,
          judgeModelId:
            fallbackResponse.modelId,
          content:
            fallbackResponse.content,
          message:
            savedMessage,
          fallback: true,
          autosaved:
            Boolean(savedMessage),
          reason:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    } else {
      state.status = "failed";

      state.error =
        error instanceof Error
          ? error.message
          : String(error);

      state.completedAt =
        new Date().toISOString();

      writeTextGenerationEvent(
        response,
        "error",
        {
          synthesisId,
          error:
            state.error,
        }
      );
    }
  } finally {
    activeJudgeSyntheses.delete(
      conversationId
    );

    if (!response.writableEnded) {
      response.end();
    }
  }
}

function stopAiJudgeSynthesis(
  conversationId
) {
  const state =
    activeJudgeSyntheses.get(
      conversationId
    );

  if (!state) {
    return {
      stopped: false,
      reason:
        "No active AI Judge synthesis.",
    };
  }

  state.status = "stopping";
  state.controller.abort();

  return {
    stopped: true,
    synthesisId:
      state.synthesisId,
  };
}


// LUKE_AI_TEXT_MODEL_FEEDBACK_V1
const textModelFeedbackPolicyPath = path.join(
  ROOT,
  "app",
  "config",
  "text-chat",
  "feedback-policy.json"
);

const textModelFeedbackStorePath = path.join(
  ROOT,
  "app",
  "runtime-state",
  "text-chat",
  "model-feedback.json"
);

function readTextModelFeedbackPolicy() {
  return readJsonFileStrict(
    textModelFeedbackPolicyPath,
    "Text model feedback policy"
  );
}

function createInitialTextModelFeedbackStore() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    modelScores: {},
    messageFeedback: {},
    events: [],
  };
}

function readTextModelFeedbackStore() {
  if (!fs.existsSync(textModelFeedbackStorePath)) {
    const initial =
      createInitialTextModelFeedbackStore();

    writeJsonFileAtomic(
      textModelFeedbackStorePath,
      initial
    );

    return initial;
  }

  return readJsonFileStrict(
    textModelFeedbackStorePath,
    "Text model feedback store"
  );
}

function writeTextModelFeedbackStore(store) {
  store.updatedAt =
    new Date().toISOString();

  writeJsonFileAtomic(
    textModelFeedbackStorePath,
    store
  );
}

function findConversationMessage(
  conversation,
  messageId
) {
  return (
    conversation.messages?.find(
      (message) =>
        message.id === messageId
    ) || null
  );
}

function getFeedbackPoints(
  feedbackType
) {
  const policy =
    readTextModelFeedbackPolicy();

  if (feedbackType === "like") {
    return Number(
      policy.scoring?.likePoints
    ) || 1;
  }

  if (feedbackType === "dislike") {
    return Number(
      policy.scoring?.dislikePoints
    ) || -1;
  }

  if (feedbackType === "preferred") {
    return Number(
      policy.scoring?.preferredPoints
    ) || 3;
  }

  if (feedbackType === "regenerate") {
    return Number(
      policy.scoring?.regeneratePenalty
    ) || -0.25;
  }

  return 0;
}

function clampFeedbackScore(value) {
  const policy =
    readTextModelFeedbackPolicy();

  const minimum =
    Number(
      policy.scoring
        ?.minimumFeedbackScore
    );

  const maximum =
    Number(
      policy.scoring
        ?.maximumFeedbackScore
    );

  return Math.max(
    Number.isFinite(minimum)
      ? minimum
      : -10,
    Math.min(
      Number.isFinite(maximum)
        ? maximum
        : 10,
      value
    )
  );
}

function calculateModelFeedbackSummary(
  modelEntry
) {
  const likes =
    Number(modelEntry.likes) || 0;

  const dislikes =
    Number(modelEntry.dislikes) || 0;

  const preferred =
    Number(modelEntry.preferred) || 0;

  const regenerations =
    Number(modelEntry.regenerations) || 0;

  const total =
    likes +
    dislikes +
    preferred +
    regenerations;

  const rawScore =
    Number(modelEntry.rawScore) || 0;

  const normalizedScore =
    total > 0
      ? Math.max(
          -1,
          Math.min(
            1,
            rawScore /
            Math.max(1, total * 3)
          )
        )
      : 0;

  return {
    ...modelEntry,
    total,
    normalizedScore:
      Number(
        normalizedScore.toFixed(4)
      ),
  };
}

function recordTextModelFeedback({
  conversationId,
  messageId,
  feedbackType,
}) {
  const allowed =
    new Set([
      "like",
      "dislike",
      "preferred",
      "regenerate",
      "clear",
    ]);

  if (!allowed.has(feedbackType)) {
    const error = new Error(
      "Invalid feedback type."
    );

    error.statusCode = 400;
    throw error;
  }

  const chatStore =
    readTextChatStore();

  const conversation =
    findTextChatConversation(
      chatStore,
      conversationId
    );

  if (!conversation) {
    const error = new Error(
      "Conversation was not found."
    );

    error.statusCode = 404;
    throw error;
  }

  const message =
    findConversationMessage(
      conversation,
      messageId
    );

  if (
    !message ||
    message.role !== "assistant"
  ) {
    const error = new Error(
      "Assistant message was not found."
    );

    error.statusCode = 404;
    throw error;
  }

  const modelId =
    message.modelId ||
    message.metadata?.judgeModelId ||
    "unknown-model";

  const feedbackStore =
    readTextModelFeedbackStore();

  const previous =
    feedbackStore.messageFeedback[
      messageId
    ] || null;

  const modelEntry =
    feedbackStore.modelScores[
      modelId
    ] || {
      modelId,
      likes: 0,
      dislikes: 0,
      preferred: 0,
      regenerations: 0,
      rawScore: 0,
    };

  if (
    previous &&
    previous.feedbackType !== "clear"
  ) {
    const previousPoints =
      getFeedbackPoints(
        previous.feedbackType
      );

    modelEntry.rawScore =
      Number(modelEntry.rawScore) -
      previousPoints;

    if (previous.feedbackType === "like") {
      modelEntry.likes =
        Math.max(
          0,
          Number(modelEntry.likes) - 1
        );
    }

    if (previous.feedbackType === "dislike") {
      modelEntry.dislikes =
        Math.max(
          0,
          Number(modelEntry.dislikes) - 1
        );
    }

    if (previous.feedbackType === "preferred") {
      modelEntry.preferred =
        Math.max(
          0,
          Number(modelEntry.preferred) - 1
        );
    }

    if (previous.feedbackType === "regenerate") {
      modelEntry.regenerations =
        Math.max(
          0,
          Number(modelEntry.regenerations) - 1
        );
    }
  }

  if (feedbackType !== "clear") {
    const points =
      getFeedbackPoints(
        feedbackType
      );

    modelEntry.rawScore =
      clampFeedbackScore(
        Number(modelEntry.rawScore) +
        points
      );

    if (feedbackType === "like") {
      modelEntry.likes =
        Number(modelEntry.likes) + 1;
    }

    if (feedbackType === "dislike") {
      modelEntry.dislikes =
        Number(modelEntry.dislikes) + 1;
    }

    if (feedbackType === "preferred") {
      modelEntry.preferred =
        Number(modelEntry.preferred) + 1;
    }

    if (feedbackType === "regenerate") {
      modelEntry.regenerations =
        Number(modelEntry.regenerations) + 1;
    }
  }

  const now =
    new Date().toISOString();

  feedbackStore.modelScores[
    modelId
  ] = calculateModelFeedbackSummary(
    modelEntry
  );

  feedbackStore.messageFeedback[
    messageId
  ] = {
    conversationId,
    messageId,
    modelId,
    feedbackType,
    updatedAt: now,
  };

  feedbackStore.events.push({
    id:
      createTextChatId(
        "feedback"
      ),
    conversationId,
    messageId,
    modelId,
    feedbackType,
    previousFeedbackType:
      previous?.feedbackType || null,
    createdAt: now,
  });

  const policy =
    readTextModelFeedbackPolicy();

  const maximumEvents =
    Number(
      policy.history
        ?.maximumEvents
    ) || 10000;

  feedbackStore.events =
    feedbackStore.events.slice(
      -maximumEvents
    );

  message.metadata = {
    ...(message.metadata || {}),
    userFeedback:
      feedbackType,
    feedbackUpdatedAt:
      now,
  };

  if (feedbackType === "preferred") {
    for (
      const candidate
      of conversation.messages || []
    ) {
      if (
        candidate.role === "assistant"
      ) {
        candidate.metadata = {
          ...(candidate.metadata || {}),
          userPreferred:
            candidate.id === messageId,
        };
      }
    }
  }

  conversation.updatedAt = now;

  writeTextChatStore(chatStore);
  writeTextModelFeedbackStore(
    feedbackStore
  );

  return {
    message,
    feedback:
      feedbackStore.messageFeedback[
        messageId
      ],
    modelScore:
      feedbackStore.modelScores[
        modelId
      ],
  };
}

function getAdaptiveModelScore(
  modelId
) {
  const store =
    readTextModelFeedbackStore();

  return (
    store.modelScores?.[
      modelId
    ]?.normalizedScore || 0
  );
}

function applyAdaptiveFeedbackScores(
  responses
) {
  const policy =
    readTextModelFeedbackPolicy();

  const baseWeight =
    Number(
      policy.scoring?.baseWeight
    ) || 0.85;

  const feedbackWeight =
    Number(
      policy.scoring
        ?.feedbackWeight
    ) || 0.15;

  return responses
    .map(
      (response) => {
        const feedbackScore =
          getAdaptiveModelScore(
            response.modelId
          );

        const adjustedScore =
          response.score *
            baseWeight +
          (
            (feedbackScore + 1) /
            2
          ) *
            feedbackWeight;

        return {
          ...response,
          originalScore:
            response.score,
          feedbackScore,
          score:
            Number(
              adjustedScore.toFixed(4)
            ),
        };
      }
    )
    .sort(
      (left, right) =>
        right.score -
        left.score
    )
    .map(
      (response, index) => ({
        ...response,
        rank: index + 1,
        best: index === 0,
      })
    );
}

function getTextModelFeedbackSummary() {
  const store =
    readTextModelFeedbackStore();

  return {
    updatedAt:
      store.updatedAt,
    modelScores:
      Object.values(
        store.modelScores || {}
      )
        .map(
          calculateModelFeedbackSummary
        )
        .sort(
          (left, right) =>
            right.normalizedScore -
            left.normalizedScore
        ),
    feedbackCount:
      Object.keys(
        store.messageFeedback || {}
      ).length,
    eventCount:
      store.events?.length || 0,
  };
}


// LUKE_AI_AUTOMATIC_MODEL_ROUTER_V1
const automaticModelRouterPolicyPath = path.join(
  ROOT,
  "app",
  "config",
  "text-chat",
  "model-router-policy.json"
);

function readAutomaticModelRouterPolicy() {
  return readJsonFileStrict(
    automaticModelRouterPolicyPath,
    "Automatic model router policy"
  );
}

function normalizeRouterText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function detectModelRouterTaskType(prompt) {
  const policy =
    readAutomaticModelRouterPolicy();

  const normalizedPrompt =
    normalizeRouterText(prompt);

  let selectedType = "general";
  let selectedScore = 0;
  const matches = {};

  for (
    const [
      taskType,
      taskConfig,
    ]
    of Object.entries(
      policy.taskTypes || {}
    )
  ) {
    const keywords =
      Array.isArray(taskConfig.keywords)
        ? taskConfig.keywords
        : [];

    let score = 0;
    const matchedKeywords = [];

    for (const keyword of keywords) {
      const normalizedKeyword =
        normalizeRouterText(keyword);

      if (
        normalizedKeyword &&
        normalizedPrompt.includes(
          normalizedKeyword
        )
      ) {
        score +=
          normalizedKeyword.length > 8
            ? 2
            : 1;

        matchedKeywords.push(keyword);
      }
    }

    matches[taskType] = {
      score,
      matchedKeywords,
    };

    if (score > selectedScore) {
      selectedType = taskType;
      selectedScore = score;
    }
  }

  const thaiCharacterCount =
    (
      String(prompt || "")
        .match(/[\u0E00-\u0E7F]/g)
      || []
    ).length;

  const totalCharacters =
    Math.max(
      1,
      String(prompt || "").length
    );

  const thaiRatio =
    thaiCharacterCount /
    totalCharacters;

  if (
    thaiRatio >= 0.35 &&
    selectedScore === 0
  ) {
    selectedType = "thai";
  }

  return {
    taskType: selectedType,
    confidence:
      selectedScore > 0
        ? Math.min(
            1,
            0.45 +
            selectedScore * 0.12
          )
        : 0.35,
    thaiRatio:
      Number(thaiRatio.toFixed(4)),
    matches,
  };
}

function getRouterInstalledModels() {
  try {
    const registry =
      readInstalledTextModels();

    return (
      registry.models || []
    )
      .filter(
        (model) =>
          model.installedPath
      )
      .map(
        (model) => ({
          modelId:
            model.modelId,
          modelName:
            model.modelName ||
            model.modelId,
          version:
            model.version || null,
          variantId:
            model.variantId || null,
          quantization:
            model.quantization || null,
          runtime:
            model.runtime || null,
          installedPath:
            model.installedPath,
          contextLength:
            Number(
              model.contextLength
            ) || null,
          capabilities:
            Array.isArray(
              model.capabilities
            )
              ? model.capabilities
              : [],
          active:
            registry.activeModelId ===
            model.modelId,
        })
      );
  } catch {
    return [];
  }
}

function getRouterCapabilityText(model) {
  return normalizeRouterText([
    model.modelId,
    model.modelName,
    model.variantId,
    model.quantization,
    model.runtime,
    ...(model.capabilities || []),
  ].join(" "));
}

function calculateRouterTaskCapability(
  model,
  taskType
) {
  const policy =
    readAutomaticModelRouterPolicy();

  const hints =
    policy.capabilityHints?.[
      taskType
    ] ||
    policy.capabilityHints?.general ||
    [];

  const capabilityText =
    getRouterCapabilityText(model);

  if (!hints.length) {
    return 0.5;
  }

  const matched =
    hints.filter(
      (hint) =>
        capabilityText.includes(
          normalizeRouterText(hint)
        )
    );

  return Math.min(
    1,
    0.3 +
    matched.length /
      Math.max(1, hints.length) *
      0.7
  );
}

function getRouterFeedbackScore(
  modelId
) {
  try {
    return Math.max(
      0,
      Math.min(
        1,
        (
          getAdaptiveModelScore(
            modelId
          ) +
          1
        ) / 2
      )
    );
  } catch {
    return 0.5;
  }
}

function getRouterHardwareScore(
  modelId
) {
  try {
    const hardware =
      getTextModelHardwareRecommendation(
        modelId
      );

    if (!hardware) {
      return 0.5;
    }

    const selected =
      hardware.variants?.find(
        (variant) =>
          variant.id ===
          hardware.recommendedVariantId
      );

    if (!selected) {
      return hardware.compatible
        ? 0.65
        : 0;
    }

    if (
      selected.compatibility ===
      "recommended"
    ) {
      return 1;
    }

    if (
      selected.compatibility ===
      "compatible"
    ) {
      return 0.72;
    }

    return 0;
  } catch {
    return 0.5;
  }
}

function getRouterContextScore(
  model,
  estimatedPromptTokens
) {
  const contextLength =
    Number(model.contextLength) ||
    32768;

  if (
    estimatedPromptTokens >
    contextLength
  ) {
    return 0;
  }

  const usage =
    estimatedPromptTokens /
    contextLength;

  if (usage <= 0.25) {
    return 1;
  }

  if (usage <= 0.5) {
    return 0.85;
  }

  if (usage <= 0.75) {
    return 0.65;
  }

  return 0.4;
}

function getRouterLanguageScore(
  model,
  taskDetection
) {
  const capabilityText =
    getRouterCapabilityText(model);

  if (
    taskDetection.thaiRatio <
    0.2
  ) {
    return 0.7;
  }

  if (
    capabilityText.includes("thai") ||
    capabilityText.includes(
      "multilingual"
    ) ||
    capabilityText.includes("qwen") ||
    capabilityText.includes("llama")
  ) {
    return 1;
  }

  return 0.55;
}

function routeTextModel({
  prompt,
  conversationId = null,
  excludedModelIds = [],
} = {}) {
  const normalizedPrompt =
    String(prompt || "").trim();

  if (!normalizedPrompt) {
    const error = new Error(
      "Prompt is required for model routing."
    );

    error.statusCode = 400;
    throw error;
  }

  const policy =
    readAutomaticModelRouterPolicy();

  const taskDetection =
    detectModelRouterTaskType(
      normalizedPrompt
    );

  const installedModels =
    getRouterInstalledModels();

  if (!installedModels.length) {
    const error = new Error(
      "No installed text models are available."
    );

    error.statusCode = 409;
    throw error;
  }

  const excluded =
    new Set(
      (
        Array.isArray(excludedModelIds)
          ? excludedModelIds
          : []
      )
        .map(
          (modelId) =>
            String(modelId || "")
              .trim()
        )
        .filter(Boolean)
    );

  const estimatedPromptTokens =
    estimateTextChatTokens(
      normalizedPrompt
    );

  const weights =
    policy.weights || {};

  const scoredModels =
    installedModels
      .filter(
        (model) =>
          !excluded.has(
            model.modelId
          )
      )
      .map(
        (model) => {
          const components = {
            taskCapability:
              calculateRouterTaskCapability(
                model,
                taskDetection.taskType
              ),
            userFeedback:
              getRouterFeedbackScore(
                model.modelId
              ),
            hardwareCompatibility:
              getRouterHardwareScore(
                model.modelId
              ),
            contextFit:
              getRouterContextScore(
                model,
                estimatedPromptTokens
              ),
            languageFit:
              getRouterLanguageScore(
                model,
                taskDetection
              ),
            availability:
              model.installedPath
                ? 1
                : 0,
          };

          const score =
            components.taskCapability *
              Number(
                weights.taskCapability ??
                0.38
              ) +
            components.userFeedback *
              Number(
                weights.userFeedback ??
                0.22
              ) +
            components.hardwareCompatibility *
              Number(
                weights.hardwareCompatibility ??
                0.15
              ) +
            components.contextFit *
              Number(
                weights.contextFit ??
                0.1
              ) +
            components.languageFit *
              Number(
                weights.languageFit ??
                0.08
              ) +
            components.availability *
              Number(
                weights.availability ??
                0.07
              );

          return {
            ...model,
            routeScore:
              Number(
                score.toFixed(4)
              ),
            components: {
              taskCapability:
                Number(
                  components
                    .taskCapability
                    .toFixed(4)
                ),
              userFeedback:
                Number(
                  components
                    .userFeedback
                    .toFixed(4)
                ),
              hardwareCompatibility:
                Number(
                  components
                    .hardwareCompatibility
                    .toFixed(4)
                ),
              contextFit:
                Number(
                  components
                    .contextFit
                    .toFixed(4)
                ),
              languageFit:
                Number(
                  components
                    .languageFit
                    .toFixed(4)
                ),
              availability:
                components.availability,
            },
          };
        }
      )
      .filter(
        (model) =>
          model.routeScore >=
          Number(
            policy.routing
              ?.minimumScore ??
            0.1
          )
      )
      .sort(
        (left, right) =>
          right.routeScore -
          left.routeScore
      );

  const selectedModel =
    scoredModels[0] || null;

  if (!selectedModel) {
    const error = new Error(
      "No compatible model was found for this prompt."
    );

    error.statusCode = 409;
    throw error;
  }

  const maximumFallbackModels =
    Number(
      policy.routing
        ?.maximumFallbackModels
    ) || 2;

  const fallbackModels =
    scoredModels
      .slice(
        1,
        1 + maximumFallbackModels
      );

  const reasons = [];

  reasons.push(
    `เหมาะกับงานประเภท ${taskDetection.taskType}`
  );

  if (
    selectedModel.components
      .userFeedback >= 0.6
  ) {
    reasons.push(
      "มีคะแนนความพึงพอใจจากผู้ใช้ในระดับดี"
    );
  }

  if (
    selectedModel.components
      .hardwareCompatibility >=
    0.7
  ) {
    reasons.push(
      "เหมาะกับ Hardware ปัจจุบัน"
    );
  }

  if (
    selectedModel.components
      .languageFit >= 0.8
  ) {
    reasons.push(
      "รองรับภาษาของคำถามได้ดี"
    );
  }

  return {
    conversationId,
    prompt:
      normalizedPrompt,
    taskDetection,
    estimatedPromptTokens,
    selectedModel,
    fallbackModels,
    reasons,
    evaluatedModels:
      scoredModels,
    routedAt:
      new Date().toISOString(),
  };
}

function getConversationLatestUserPrompt(
  conversationId
) {
  const store =
    readTextChatStore();

  const conversation =
    findTextChatConversation(
      store,
      conversationId
    );

  if (!conversation) {
    return null;
  }

  return (
    [...(
      conversation.messages || []
    )]
      .reverse()
      .find(
        (message) =>
          message.role === "user"
      )
      ?.content ||
    null
  );
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST" });
    res.end(); return;
  }

  if ((req.url.startsWith("/v1/") || req.url.startsWith("/sdapi/")) && ["GET", "POST"].includes(req.method)) {
    return proxyImageBackendRequest(req, res);
  }
  // ── Management API ────────────────────────────────────────────────────────
  // GET /api/health
  // POST /api/runtime/install/jobs/:jobId/start
  const runtimeInstallStartMatch =
    req.url.match(
      /^\/api\/runtime\/install\/jobs\/([^/?]+)\/start$/
    );

  if (
    runtimeInstallStartMatch &&
    req.method === "POST"
  ) {
    try {
      const jobId = decodeURIComponent(
        runtimeInstallStartMatch[1]
      );

      const job = getRuntimeInstallJob(jobId);

      if (!job) {
        return json(res, 404, {
          ok: false,
          error: "Runtime install job not found",
        });
      }

      if (job.state !== "queued") {
        return json(res, 409, {
          ok: false,
          error:
            "Only queued runtime jobs can start",
        });
      }

      const body = await readJsonRequestBody(req);

      startRuntimeInstallJob(
        jobId,
        {
          url:
            typeof body.url === "string"
              ? body.url
              : undefined,
          sha256:
            typeof body.sha256 === "string"
              ? body.sha256
              : undefined,
          filename:
            typeof body.filename === "string"
              ? body.filename
              : undefined,
        }
      );

      return json(res, 202, {
        ok: true,
        jobId,
        state: "queued",
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  // GET /api/runtime/install/jobs
  if (
    req.url === "/api/runtime/install/jobs" &&
    req.method === "GET"
  ) {
    return json(res, 200, {
      ok: true,
      jobs: listRuntimeInstallJobs(),
    });
  }

  // POST /api/runtime/install/jobs
  if (
    req.url === "/api/runtime/install/jobs" &&
    req.method === "POST"
  ) {
    try {
      const body = await readJsonRequestBody(req);

      if (
        typeof body.dependencyId !== "string" ||
        !body.dependencyId.trim()
      ) {
        return json(res, 400, {
          ok: false,
          error: "dependencyId is required",
        });
      }

      const job = createRuntimeInstallJob(
        body.dependencyId.trim(),
        typeof body.downloadDirectory === "string"
          ? body.downloadDirectory.trim()
          : undefined
      );

      return json(res, 201, {
        ok: true,
        job,
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  const runtimeInstallJobMatch =
    req.url.match(
      /^\/api\/runtime\/install\/jobs\/([^/?]+)$/
    );

  // GET /api/runtime/install/jobs/:jobId
  if (
    runtimeInstallJobMatch &&
    req.method === "GET"
  ) {
    const job = getRuntimeInstallJob(
      decodeURIComponent(
        runtimeInstallJobMatch[1]
      )
    );

    if (!job) {
      return json(res, 404, {
        ok: false,
        error: "Runtime install job not found",
      });
    }

    return json(res, 200, {
      ok: true,
      job,
    });
  }

  // PATCH /api/runtime/install/jobs/:jobId
  if (
    runtimeInstallJobMatch &&
    req.method === "PATCH"
  ) {
    try {
      const body = await readJsonRequestBody(req);

      const job = updateRuntimeInstallJob(
        decodeURIComponent(
          runtimeInstallJobMatch[1]
        ),
        typeof body.state === "string"
          ? body.state
          : undefined,
        body.progress
      );

      return json(res, 200, {
        ok: true,
        job,
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  // POST /api/runtime/install/jobs/:jobId/cancel
  const runtimeInstallCancelMatch =
    req.url.match(
      /^\/api\/runtime\/install\/jobs\/([^/?]+)\/cancel$/
    );

  if (
    runtimeInstallCancelMatch &&
    req.method === "POST"
  ) {
    try {
      const jobId = decodeURIComponent(
        runtimeInstallCancelMatch[1]
      );

      const activeWorkerCancelled =
        cancelRuntimeInstallWorker(jobId);

      const currentJob =
        getRuntimeInstallJob(jobId);

      if (!currentJob) {
        return json(res, 404, {
          ok: false,
          error: "Runtime install job not found",
        });
      }

      const job =
        currentJob.state === "queued"
          ? updateRuntimeInstallJob(
              jobId,
              "cancelled"
            )
          : currentJob;

      if (
        !activeWorkerCancelled &&
        job.state !== "cancelled"
      ) {
        return json(res, 409, {
          ok: false,
          error:
            "Runtime install job is not cancellable",
        });
      }

      return json(res, 200, {
        ok: true,
        job,
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  // GET /api/runtime/storage/usage
  if (
    req.url === "/api/runtime/storage/usage" &&
    req.method === "GET"
  ) {
    try {
      return json(
        res,
        200,
        buildRuntimeStorageUsage()
      );
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // POST /api/runtime/storage/cleanup
  if (
    req.url === "/api/runtime/storage/cleanup" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      if (
        typeof body.categoryId !== "string" ||
        !body.categoryId.trim()
      ) {
        return json(res, 400, {
          ok: false,
          error: "categoryId is required",
        });
      }

      const result =
        cleanupRuntimeStorageCategory(
          body.categoryId.trim(),
          {
            dryRun: body.dryRun !== false,
          }
        );

      return json(
        res,
        result.ok ? 200 : 500,
        result
      );
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  // GET /api/runtime/storage
  if (
    req.url === "/api/runtime/storage" &&
    req.method === "GET"
  ) {
    try {
      return json(
        res,
        200,
        resolveRuntimeStorageDirectory({
          create: false,
          createFallback: true,
        })
      );
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // POST /api/runtime/storage/resolve
  if (
    req.url === "/api/runtime/storage/resolve" &&
    req.method === "POST"
  ) {
    try {
      const storage =
        resolveRuntimeStorageDirectory({
          create: true,
          createFallback: true,
        });

      return json(
        res,
        storage.ok ? 200 : 503,
        storage
      );
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // POST /api/text-models/download-queue/start
  if (
    req.url === "/api/text-models/download-queue/start" &&
    req.method === "POST"
  ) {
    startTextModelQueueWorker();

    return json(res, 202, {
      ok: true,
      message:
        "เริ่มประมวลผลคิวดาวน์โหลดแล้ว",
    });
  }

  const textModelQueueActionMatch =
    req.url.match(
      /^\/api\/text-models\/download-queue\/([^/?]+)\/(pause|resume|cancel|skip|move)$/
    );

  if (
    textModelQueueActionMatch &&
    req.method === "POST"
  ) {
    try {
      const itemId =
        decodeURIComponent(
          textModelQueueActionMatch[1]
        );

      const action =
        textModelQueueActionMatch[2];

      const body =
        action === "move"
          ? await readJsonRequestBody(req)
          : {};

      let item;

      if (action === "pause") {
        item =
          pauseTextModelQueueItem(itemId);
      } else if (action === "resume") {
        item =
          resumeTextModelQueueItem(itemId);
      } else if (action === "cancel") {
        item =
          cancelTextModelQueueItem(itemId);
      } else if (action === "skip") {
        item =
          skipTextModelQueueItem(itemId);
      } else {
        item =
          moveTextModelQueueItem(
            itemId,
            body.direction
          );
      }

      return json(res, 200, {
        ok: true,
        item,
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  // GET /api/text-models/installed
  if (
    req.url === "/api/text-models/installed" &&
    req.method === "GET"
  ) {
    try {
      return json(res, 200, {
        ok: true,
        registry:
          readInstalledTextModels(),
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // GET /api/text-models/updates
  if (
    req.url === "/api/text-models/updates" &&
    req.method === "GET"
  ) {
    try {
      return json(
        res,
        200,
        buildTextModelUpdateStatus()
      );
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // LUKE_AI_TEXT_MODEL_STATIC_UPDATE_ENDPOINT_V1
  // POST /api/text-models/update
  if (
    req.url === "/api/text-models/update" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      if (
        typeof body.modelId !== "string" ||
        !body.modelId.trim()
      ) {
        return json(res, 400, {
          ok: false,
          error: "modelId is required",
        });
      }

      const modelId =
        body.modelId.trim();

      const updateStatus =
        getTextModelUpdateStatus(
          modelId
        );

      if (!updateStatus) {
        return json(res, 404, {
          ok: false,
          error:
            "Text model was not found.",
        });
      }

      if (!updateStatus.installed) {
        return json(res, 409, {
          ok: false,
          error:
            "Model is not installed. Use Download instead.",
        });
      }

      if (!updateStatus.updateAvailable) {
        return json(res, 409, {
          ok: false,
          error:
            "This model is already up to date.",
        });
      }

      const item =
        await enqueueTextModel(
          modelId,
          updateStatus.recommendedVariant
        );

      updateTextModelQueueItem(
        item.id,
        {
          operation: "update",
          previousVersion:
            updateStatus.installedVersion,
        }
      );

      return json(res, 202, {
        ok: true,
        item:
          getTextModelQueueItem(item.id),
        message:
          "เพิ่มการอัปเดตโมเดลลงคิวแล้ว",
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  const textModelUpdateMatch =
    req.url.match(
      /^\/api\/text-models\/([^/?]+)\/update$/
    );

  if (
    textModelUpdateMatch &&
    req.method === "POST"
  ) {
    try {
      const modelId =
        decodeURIComponent(
          textModelUpdateMatch[1]
        );

      const updateStatus =
        getTextModelUpdateStatus(
          modelId
        );

      if (!updateStatus) {
        return json(res, 404, {
          ok: false,
          error:
            "Text model was not found.",
        });
      }

      if (!updateStatus.installed) {
        return json(res, 409, {
          ok: false,
          error:
            "Model is not installed. Use Download instead.",
        });
      }

      if (!updateStatus.updateAvailable) {
        return json(res, 409, {
          ok: false,
          error:
            "This model is already up to date.",
        });
      }

      const item =
        await enqueueTextModel(
          modelId,
          updateStatus.recommendedVariant
        );

      item.operation = "update";
      item.previousVersion =
        updateStatus.installedVersion;

      updateTextModelQueueItem(
        item.id,
        {
          operation: "update",
          previousVersion:
            updateStatus.installedVersion,
        }
      );

      return json(res, 202, {
        ok: true,
        item:
          getTextModelQueueItem(item.id),
        message:
          "เพิ่มการอัปเดตโมเดลลงคิวแล้ว",
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  // GET /api/text-models/hardware
  if (
    req.url === "/api/text-models/hardware" &&
    req.method === "GET"
  ) {
    try {
      return json(
        res,
        200,
        buildTextModelHardwareCompatibility()
      );
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // POST /api/text-runtime/model-router/route
  if (
    req.url === "/api/text-runtime/model-router/route" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      const conversationId =
        String(
          body.conversationId || ""
        ).trim() ||
        null;

      const prompt =
        String(
          body.prompt ||
          (
            conversationId
              ? getConversationLatestUserPrompt(
                  conversationId
                )
              : ""
          ) ||
          ""
        ).trim();

      const result =
        routeTextModel({
          prompt,
          conversationId,
          excludedModelIds:
            body.excludedModelIds,
        });

      return json(res, 200, {
        ok: true,
        ...result,
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  // GET /api/text-runtime/model-router/policy
  if (
    req.url === "/api/text-runtime/model-router/policy" &&
    req.method === "GET"
  ) {
    try {
      return json(res, 200, {
        ok: true,
        policy:
          readAutomaticModelRouterPolicy(),
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // POST /api/text-chat/feedback
  if (
    req.url === "/api/text-chat/feedback" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      const result =
        recordTextModelFeedback({
          conversationId:
            String(
              body.conversationId || ""
            ).trim(),
          messageId:
            String(
              body.messageId || ""
            ).trim(),
          feedbackType:
            String(
              body.feedbackType || ""
            ).trim(),
        });

      return json(res, 200, {
        ok: true,
        ...result,
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  // GET /api/text-chat/feedback/summary
  if (
    req.url === "/api/text-chat/feedback/summary" &&
    req.method === "GET"
  ) {
    try {
      return json(res, 200, {
        ok: true,
        ...getTextModelFeedbackSummary(),
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // POST /api/text-runtime/judge-synthesis
  if (
    req.url === "/api/text-runtime/judge-synthesis" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      if (
        typeof body.conversationId !==
          "string" ||
        !body.conversationId.trim()
      ) {
        return json(res, 400, {
          ok: false,
          error:
            "conversationId is required",
        });
      }

      await streamAiJudgeSynthesis(
        body.conversationId.trim(),
        res,
        {
          judgeModelId:
            body.judgeModelId ||
            null,
        }
      );

      return;
    } catch (error) {
      if (!res.headersSent) {
        return json(
          res,
          error.statusCode || 500,
          {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          }
        );
      }

      writeTextGenerationEvent(
        res,
        "error",
        {
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );

      res.end();
      return;
    }
  }

  // POST /api/text-runtime/judge-synthesis/stop
  if (
    req.url === "/api/text-runtime/judge-synthesis/stop" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      if (
        typeof body.conversationId !==
          "string" ||
        !body.conversationId.trim()
      ) {
        return json(res, 400, {
          ok: false,
          error:
            "conversationId is required",
        });
      }

      return json(res, 200, {
        ok: true,
        ...stopAiJudgeSynthesis(
          body.conversationId.trim()
        ),
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // GET /api/text-runtime/models/available
  if (
    req.url === "/api/text-runtime/models/available" &&
    req.method === "GET"
  ) {
    try {
      return json(res, 200, {
        ok: true,
        maximumSelection:
          Number(
            readMultiModelPolicy()
              .selection
              ?.maximumModels
          ) || 3,
        models:
          getInstalledTextModelsForSelection(),
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // POST /api/text-runtime/multi-generate-stream
  if (
    req.url === "/api/text-runtime/multi-generate-stream" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      if (
        typeof body.conversationId !==
          "string" ||
        !body.conversationId.trim()
      ) {
        return json(res, 400, {
          ok: false,
          error:
            "conversationId is required",
        });
      }

      await streamMultiModelGeneration(
        body.conversationId.trim(),
        body.modelIds,
        res
      );

      return;
    } catch (error) {
      if (!res.headersSent) {
        return json(
          res,
          error.statusCode || 500,
          {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          }
        );
      }

      writeTextGenerationEvent(
        res,
        "error",
        {
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );

      res.end();
      return;
    }
  }

  // POST /api/text-runtime/multi-generation/stop
  if (
    req.url === "/api/text-runtime/multi-generation/stop" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      if (
        typeof body.conversationId !==
          "string" ||
        !body.conversationId.trim()
      ) {
        return json(res, 400, {
          ok: false,
          error:
            "conversationId is required",
        });
      }

      return json(res, 200, {
        ok: true,
        ...stopMultiModelGeneration(
          body.conversationId.trim()
        ),
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // POST /api/text-runtime/generate-stream
  if (
    req.url === "/api/text-runtime/generate-stream" &&
    req.method === "POST"
  ) {
    let body;

    try {
      body =
        await readJsonRequestBody(req);
    } catch (error) {
      return json(res, 400, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }

    if (
      typeof body.conversationId !==
        "string" ||
      !body.conversationId.trim()
    ) {
      return json(res, 400, {
        ok: false,
        error:
          "conversationId is required",
      });
    }

    try {
      await streamTextRuntimeGeneration(
        body.conversationId.trim(),
        res,
        {
          modelId:
            body.modelId || null,
          temperature:
            body.temperature,
          topP:
            body.topP,
          maxTokens:
            body.maxTokens,
          stop:
            body.stop,
        }
      );

      return;
    } catch (error) {
      if (!res.headersSent) {
        return json(
          res,
          error.statusCode || 500,
          {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          }
        );
      }

      writeTextGenerationEvent(
        res,
        "error",
        {
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );

      res.end();
      return;
    }
  }

  // POST /api/text-runtime/generation/stop
  if (
    req.url === "/api/text-runtime/generation/stop" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      if (
        typeof body.conversationId !==
          "string" ||
        !body.conversationId.trim()
      ) {
        return json(res, 400, {
          ok: false,
          error:
            "conversationId is required",
        });
      }

      return json(res, 200, {
        ok: true,
        ...stopTextRuntimeGeneration(
          body.conversationId.trim()
        ),
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // POST /api/text-runtime/generation/status
  if (
    req.url === "/api/text-runtime/generation/status" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      if (
        typeof body.conversationId !==
          "string" ||
        !body.conversationId.trim()
      ) {
        return json(res, 400, {
          ok: false,
          error:
            "conversationId is required",
        });
      }

      return json(res, 200, {
        ok: true,
        ...getTextRuntimeGenerationStatus(
          body.conversationId.trim()
        ),
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // POST /api/text-runtime/session/refresh
  if (
    req.url === "/api/text-runtime/session/refresh" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      if (
        typeof body.conversationId !==
          "string" ||
        !body.conversationId.trim()
      ) {
        return json(res, 400, {
          ok: false,
          error:
            "conversationId is required",
        });
      }

      const result =
        await refreshTextRuntimeSession(
          body.conversationId.trim(),
          {
            forceMemoryRefresh:
              body.forceMemoryRefresh !==
              false,
            reason:
              String(
                body.reason ||
                "manual-runtime-refresh"
              ),
          }
        );

      return json(res, 200, {
        ok: true,
        ...result,
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  // POST /api/text-runtime/session/status
  if (
    req.url === "/api/text-runtime/session/status" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      if (
        typeof body.conversationId !==
          "string" ||
        !body.conversationId.trim()
      ) {
        return json(res, 400, {
          ok: false,
          error:
            "conversationId is required",
        });
      }

      return json(res, 200, {
        ok: true,
        ...getTextRuntimeSessionStatus(
          body.conversationId.trim()
        ),
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // POST /api/text-runtime/restore-prompt
  if (
    req.url === "/api/text-runtime/restore-prompt" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      const store =
        readTextChatStore();

      const conversation =
        findTextChatConversation(
          store,
          String(
            body.conversationId || ""
          )
        );

      if (!conversation) {
        return json(res, 404, {
          ok: false,
          error:
            "Conversation was not found.",
        });
      }

      return json(res, 200, {
        ok: true,
        conversationId:
          conversation.id,
        restorePrompt:
          buildConversationRestorePrompt(
            conversation
          ),
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // POST /api/text-chat/memory/optimize
  if (
    req.url === "/api/text-chat/memory/optimize" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      if (
        typeof body.conversationId !==
          "string" ||
        !body.conversationId.trim()
      ) {
        return json(res, 400, {
          ok: false,
          error:
            "conversationId is required",
        });
      }

      const result =
        optimizeTextChatConversation(
          body.conversationId.trim(),
          {
            force:
              body.force === true,
            reason:
              String(
                body.reason ||
                "manual"
              ),
          }
        );

      return json(res, 200, {
        ok: true,
        ...result,
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  // POST /api/text-chat/memory/status
  if (
    req.url === "/api/text-chat/memory/status" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      if (
        typeof body.conversationId !==
          "string" ||
        !body.conversationId.trim()
      ) {
        return json(res, 400, {
          ok: false,
          error:
            "conversationId is required",
        });
      }

      return json(res, 200, {
        ok: true,
        ...getTextChatMemoryStatus(
          body.conversationId.trim()
        ),
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  // GET /api/text-chat/conversations
  if (
    req.url === "/api/text-chat/conversations" &&
    req.method === "GET"
  ) {
    try {
      const store =
        readTextChatStore();

      return json(res, 200, {
        ok: true,
        lastOpenedConversationId:
          store.lastOpenedConversationId,
        conversations:
          store.conversations,
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // POST /api/text-chat/conversations
  if (
    req.url === "/api/text-chat/conversations" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      const conversation =
        createTextChatConversation(
          body || {}
        );

      return json(res, 201, {
        ok: true,
        conversation,
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  const textChatConversationMatch =
    req.url.match(
      /^\/api\/text-chat\/conversations\/([^/?]+)$/
    );

  if (
    textChatConversationMatch &&
    req.method === "GET"
  ) {
    try {
      const conversationId =
        decodeURIComponent(
          textChatConversationMatch[1]
        );

      const store =
        readTextChatStore();

      const conversation =
        findTextChatConversation(
          store,
          conversationId
        );

      if (!conversation) {
        return json(res, 404, {
          ok: false,
          error:
            "Conversation was not found.",
        });
      }

      store.lastOpenedConversationId =
        conversation.id;

      writeTextChatStore(store);

      return json(res, 200, {
        ok: true,
        conversation,
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  if (
    textChatConversationMatch &&
    req.method === "PATCH"
  ) {
    try {
      const conversationId =
        decodeURIComponent(
          textChatConversationMatch[1]
        );

      const body =
        await readJsonRequestBody(req);

      const conversation =
        updateTextChatConversation(
          conversationId,
          body || {}
        );

      return json(res, 200, {
        ok: true,
        conversation,
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  if (
    textChatConversationMatch &&
    req.method === "DELETE"
  ) {
    try {
      const conversationId =
        decodeURIComponent(
          textChatConversationMatch[1]
        );

      const removed =
        deleteTextChatConversation(
          conversationId
        );

      return json(res, 200, {
        ok: true,
        removed,
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  const textChatMessageMatch =
    req.url.match(
      /^\/api\/text-chat\/conversations\/([^/?]+)\/messages$/
    );

  if (
    textChatMessageMatch &&
    req.method === "POST"
  ) {
    try {
      const conversationId =
        decodeURIComponent(
          textChatMessageMatch[1]
        );

      const body =
        await readJsonRequestBody(req);

      const result =
        appendTextChatMessage(
          conversationId,
          body || {}
        );

      return json(res, 201, {
        ok: true,
        ...result,
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  // GET /api/text-models/catalog
  if (
    req.url === "/api/text-models/catalog" &&
    req.method === "GET"
  ) {
    try {
      const catalog = readTextModelCatalog();

      return json(res, 200, {
        ok: true,
        catalogId: catalog.catalogId,
        catalogVersion:
          catalog.catalogVersion,
        trust: catalog.trust,
        models: catalog.models,
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // GET /api/text-models/download-queue
  if (
    req.url === "/api/text-models/download-queue" &&
    req.method === "GET"
  ) {
    try {
      return json(res, 200, {
        ok: true,
        queue: readTextModelQueue(),
        policy:
          readTextModelPolicy()
            .downloadPolicy,
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  // POST /api/text-models/download-queue
  if (
    req.url === "/api/text-models/download-queue" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonRequestBody(req);

      if (
        typeof body.modelId !== "string" ||
        !body.modelId.trim()
      ) {
        return json(res, 400, {
          ok: false,
          error: "modelId is required",
        });
      }

      const item =
        await enqueueTextModel(
          body.modelId.trim(),
          typeof body.variantId === "string"
            ? body.variantId.trim()
            : undefined
        );

      return json(res, 201, {
        ok: true,
        item,
        message:
          "เพิ่มโมเดลลงคิวดาวน์โหลดแล้ว",
      });
    } catch (error) {
      return json(
        res,
        error.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  }

  // GET /api/runtime/dependencies
  if (
    req.url === "/api/runtime/dependencies" &&
    req.method === "GET"
  ) {
    try {
      return json(
        res,
        200,
        buildRuntimeDependencyStatus()
      );
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }

    return;
  }

  if (req.url === "/api/health" && req.method === "GET") {
    return json(res, 200, await getHealth());
  }

  // GET /api/diagnostics
  if (req.url === "/api/diagnostics" && req.method === "GET") {
    return json(res, 200, {
      generatedAt: new Date().toISOString(),
      health: await getHealth(),
      cleanupCandidates: getCleanupCandidates(),
      download: downloadState,
      generation: generationState,
      llm: {
        ready: llmReady,
        running: llmProc !== null,
        error: llmError,
        settings: llmSettings,
        port: PORT_LLM,
      },
      speech: {
        ready: speechReady,
        error: speechError,
        settings: speechSettings,
        backend: getSpeechBackend(),
        transcription: speechTranscriptionState,
      },
      hardware: getHardwareSpecs(),
      telemetry: getTelemetry(),
    });
  }

  // GET /api/cleanup-candidates
  if (req.url === "/api/cleanup-candidates" && req.method === "GET") {
    return json(res, 200, { candidates: getCleanupCandidates() });
  }

  // POST /api/cleanup
  if (req.url === "/api/cleanup" && req.method === "POST") {
    try {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const deleted = cleanupSelected(Array.isArray(body.ids) ? body.ids : []);
      return json(res, 200, { ok: true, deleted });
    } catch (err) {
      console.error("  [api] Cleanup failed:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  // GET /api/backend-status
  if (req.url === "/api/backend-status" && req.method === "GET") {
    return json(res, 200, {
      ready: backendReady || openvinoReady,
      running: backendProc !== null || openvinoProc !== null,
      port: PORT_BACKEND,
      preferredPort: PREFERRED_BACKEND_PORT,
      error: backendError,
      loading: backendLoadState,
      unloading: backendUnloadState,
      settings: currentSettings,
      build: SERVER_BUILD,
    });
  }

  if (req.url === "/api/llm/status" && req.method === "GET") {
    const backend = getLlmBackend();
    const probe = getLlmBackendProbe();
    return json(res, 200, {
      ready: llmReady,
      running: llmProc !== null,
      port: PORT_LLM,
      preferredPort: PREFERRED_LLM_PORT,
      error: llmError,
      settings: llmSettings,
      backendInstalled: Boolean(backend),
      backendMode: backend?.mode || "",
      backendPath: backend?.path || "",
      selectedBackend: probe.selected,
      availableBackends: probe.available,
    });
  }

  if (req.url.startsWith("/api/llm/backends") && req.method === "GET") {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    return json(res, 200, { ok: true, ...getLlmBackendProbe(parsed.searchParams.get("refresh") === "1") });
  }

  if (req.url === "/api/llm/stats" && req.method === "GET") {
    return json(res, 200, getLlmRuntimeStats());
  }

  if (req.url === "/api/llm/model-settings" && req.method === "GET") {
    return json(res, 200, { ok: true, ...getPersistedLlmModelSettings() });
  }

  if (req.url === "/api/llm/model-settings" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.model || ""));
    if (!filename) return json(res, 400, { ok: false, error: "model is required" });
    const updated = updateLlmModelSettings(filename, {
      preferredBackend: body.preferredBackend ? String(body.preferredBackend).toLowerCase() : undefined,
    });
    return json(res, 200, { ok: true, model: filename, settings: updated });
  }

  if (req.url === "/api/llm/conversations" && req.method === "GET") {
    return json(res, 200, { ok: true, conversations: listChatConversations() });
  }

  if (req.url === "/api/llm/save-conversation" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const conversation = saveChatConversation(body.conversation || body);
      return json(res, 200, { ok: true, conversation });
    } catch (err) {
      console.error("  [api] Failed to save chat conversation:", err);
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  }

  if (req.url === "/api/llm/delete-conversation" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const deleted = deleteChatConversation(body.id);
      return json(res, 200, { ok: true, deleted });
    } catch (err) {
      console.error("  [api] Failed to delete chat conversation:", err);
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  }

  if (req.url === "/api/llm/models" && req.method === "GET") {
    return json(res, 200, { models: getLlmModels() });
  }

  if (req.url.startsWith("/api/huggingface/models") && req.method === "GET") {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const query = String(parsed.searchParams.get("query") || "").slice(0, 120);
    const filters = String(parsed.searchParams.get("filters") || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => ["vision", "uncensored"].includes(value));
    const page = Math.max(1, Math.min(20, Number(parsed.searchParams.get("page")) || 1));
    const pageSize = 9;
    try {
      const rankedModels = await searchHuggingFaceModels(query, [...new Set(filters)]);
      const start = (page - 1) * pageSize;
      const pageModels = rankedModels.slice(start, start + pageSize);
      const models = await Promise.all(pageModels.map(addHuggingFaceFileSize));
      return json(res, 200, {
        ok: true,
        source: "huggingface",
        models,
        page,
        hasMore: start + models.length < rankedModels.length,
      });
    } catch (err) {
      return json(res, 502, { ok: false, error: err.message || "Hugging Face search failed." });
    }
  }

  if (req.url === "/api/llm/start" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      await runExclusiveLlmOperation(() => startLlm(body));
      return json(res, 200, { ok: true, ready: llmReady, port: PORT_LLM, settings: llmSettings });
    } catch (err) {
      llmError = err.message || String(err);
      if (err.code !== "MODEL_ALREADY_ACTIVE") {
        await runExclusiveLlmOperation(() => killLlm());
      }
      return json(res, jsonErrorStatus(err), { ok: false, error: llmError, code: err.code || "", activeRuntime: err.activeRuntime || null });
    }
  }

  if (req.url === "/api/llm/stop" && req.method === "POST") {
    await runExclusiveLlmOperation(() => killLlm());
    return json(res, 200, { ok: true });
  }

  if (req.url === "/api/llm/benchmark" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const result = await runExclusiveLlmOperation(() => benchmarkLlmModel(body));
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  }

  if (req.url === "/api/speech/status" && req.method === "GET") {
    const backend = getSpeechBackend();
    return json(res, 200, {
      ok: true,
      ready: speechReady,
      running: speechReady,
      port: PORT_SPEECH,
      preferredPort: PREFERRED_SPEECH_PORT,
      backendInstalled: Boolean(backend.cli),
      backendPath: backend.cli || "",
      serverPath: backend.server || "",
      backendMode: backend.mode,
      backendPreference: backend.preference,
      backends: backend.candidates,
      error: speechError,
      settings: speechSettings,
      transcription: speechTranscriptionState,
    });
  }

  if (req.url === "/api/speech/models" && req.method === "GET") {
    return json(res, 200, { ok: true, models: getSpeechModels() });
  }

  if (req.url === "/api/speech/start" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      await runExclusiveSpeechOperation(() => startSpeech(body));
      return json(res, 200, { ok: true, ready: speechReady, settings: speechSettings, port: PORT_SPEECH });
    } catch (err) {
      speechError = err.message || String(err);
      return json(res, jsonErrorStatus(err), { ok: false, error: speechError, code: err.code || "", activeRuntime: err.activeRuntime || null });
    }
  }

  if (req.url === "/api/speech/stop" && req.method === "POST") {
    await stopSpeech();
    return json(res, 200, { ok: true });
  }

  if (req.url.startsWith("/api/speech/transcribe") && req.method === "POST") {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      const audio = await readBinaryBody(req);
      const result = await runExclusiveSpeechOperation(() => transcribeWavBuffer(audio, {
        model: parsed.searchParams.get("model") || speechSettings.model,
        language: parsed.searchParams.get("language") || "auto",
        filename: parsed.searchParams.get("filename") || req.headers["x-filename"] || "recording.wav",
        threads: parsed.searchParams.get("threads") || speechSettings.threads,
        backendPreference: parsed.searchParams.get("backendPreference") || speechSettings.backendPreference,
        translate: parsed.searchParams.get("translate") === "true",
      }));
      return json(res, 200, { ok: true, transcription: result });
    } catch (err) {
      speechError = err.message || String(err);
      return json(res, err.message?.includes("too large") ? 413 : 500, { ok: false, error: speechError });
    }
  }

  if (req.url === "/api/speech/download-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const modelId = String(body.modelId || body.model_id || body.model || "");
    const catalogModel = SPEECH_MODEL_CATALOG.find((model) => model.id === modelId || model.filename === modelId);
    const url = body.url ? String(body.url) : (catalogModel ? `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${catalogModel.filename}` : "");
    const filename = path.basename(String(body.filename || catalogModel?.filename || ""));
    if (!url || !filename || !filename.toLowerCase().endsWith(".bin")) {
      return json(res, 400, { ok: false, error: "A speech model .bin URL or catalog model id is required." });
    }
    try {
      const job = startModelDownload(url, filename, SPEECH_MODELS, "speech");
      return json(res, 200, { ok: true, message: "Speech model download started", filename, downloadId: job.id });
    } catch (err) {
      return json(res, 409, { ok: false, error: err.message || String(err) });
    }
  }

  if (req.url.startsWith("/api/speech/import-model") && req.method === "POST") {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await streamModelUpload(req, parsed.searchParams.get("filename"), SPEECH_MODELS, "speech");
      return json(res, 200, { ok: true, message: `Imported ${result.filename}`, model: result });
    } catch (err) {
      console.error("  [api] Failed to import speech model:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.url === "/api/speech/delete-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    const modelPath = path.join(SPEECH_MODELS, filename);
    if (!filename || !pathInside(modelPath, SPEECH_MODELS)) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    if (speechSettings.model === filename) await stopSpeech();
    try {
      fs.unlinkSync(modelPath);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, err.code === "ENOENT" ? 404 : 500, { ok: false, error: err.code === "ENOENT" ? "Speech model not found" : err.message });
    }
  }

  if (req.url === "/api/speech/transcriptions" && req.method === "GET") {
    return json(res, 200, { ok: true, transcriptions: listTranscriptions() });
  }

  if (req.url === "/api/speech/delete-transcription" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    if (!filename || !filename.endsWith(".json")) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    const jsonPath = path.join(TRANSCRIPTIONS, filename);
    if (!pathInside(jsonPath, TRANSCRIPTIONS)) {
      return json(res, 400, { ok: false, error: "Invalid path" });
    }
    try {
      if (!fs.existsSync(jsonPath)) {
        return json(res, 404, { ok: false, error: "Transcription metadata not found" });
      }
      
      const metadata = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const textFile = metadata.textFile ? path.basename(String(metadata.textFile)) : "";
      
      fs.unlinkSync(jsonPath);
      
      if (textFile) {
        const textPath = path.join(TRANSCRIPTIONS, textFile);
        if (pathInside(textPath, TRANSCRIPTIONS) && fs.existsSync(textPath)) {
          fs.unlinkSync(textPath);
        }
      }
      
      return json(res, 200, { ok: true });
    } catch (err) {
      console.error("  [api] Failed to delete transcription:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.url === "/api/tts/status" && req.method === "GET") {
    const runtime = getTtsRuntimeStatus();
    return json(res, 200, {
      ok: true,
      ready: ttsReady,
      running: ttsReady,
      port: PORT_TTS,
      preferredPort: PREFERRED_TTS_PORT,
      runtimeInstalled: runtime.installed,
      runtimePath: runtime.runtime,
      workerPath: runtime.worker,
      cachePath: runtime.cache,
      backendMode: runtime.backendMode,
      error: ttsError,
      settings: ttsSettings,
      generation: ttsGenerationState,
      voices: TTS_VOICES,
    });
  }

  if (req.url === "/api/tts/models" && req.method === "GET") {
    return json(res, 200, { ok: true, models: getTtsModels(), voices: TTS_VOICES });
  }

  if (req.url === "/api/tts/start" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      await runExclusiveTtsOperation(() => startTts(body));
      return json(res, 200, { ok: true, ready: ttsReady, settings: ttsSettings, port: PORT_TTS });
    } catch (err) {
      ttsError = err.message || String(err);
      return json(res, jsonErrorStatus(err), { ok: false, error: ttsError, code: err.code || "", activeRuntime: err.activeRuntime || null });
    }
  }

  if (req.url === "/api/tts/stop" && req.method === "POST") {
    await stopTts();
    return json(res, 200, { ok: true });
  }

  if (req.url === "/api/tts/speak" && req.method === "POST") {
    const body = await readJsonBody(req, res, 512 * 1024);
    if (!body) return;
    try {
      if (!ttsReady || (body.model && ttsSettings.model !== body.model)) {
        await runExclusiveTtsOperation(() => startTts(body));
      }
      const output = await runExclusiveTtsOperation(() => synthesizeTts(body.text, body));
      return json(res, 200, { ok: true, output });
    } catch (err) {
      ttsError = err.message || String(err);
      return json(res, jsonErrorStatus(err), { ok: false, error: ttsError, code: err.code || "", activeRuntime: err.activeRuntime || null });
    }
  }

  if (req.url === "/api/tts/download-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const model = installTtsCatalogModel(body.modelId || body.model_id || body.model || body.filename);
      return json(res, 200, { ok: true, message: "TTS model manifest installed", filename: model.filename, model });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  }

  if (req.url.startsWith("/api/tts/import-model") && req.method === "POST") {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await streamModelUpload(req, parsed.searchParams.get("filename"), TTS_MODELS, "tts");
      return json(res, 200, { ok: true, message: `Imported ${result.filename}`, model: result });
    } catch (err) {
      console.error("  [api] Failed to import TTS model:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.url === "/api/tts/delete-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    const modelPath = path.join(TTS_MODELS, filename);
    if (!filename || !filename.endsWith(".json") || !pathInside(modelPath, TTS_MODELS)) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    if (ttsSettings.model === filename) await stopTts();
    try {
      fs.unlinkSync(modelPath);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, err.code === "ENOENT" ? 404 : 500, { ok: false, error: err.code === "ENOENT" ? "TTS model not found" : err.message });
    }
  }

  if (req.url === "/api/tts/outputs" && req.method === "GET") {
    return json(res, 200, { ok: true, outputs: listTtsOutputs() });
  }

  if (req.url === "/api/tts/delete-output" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    if (!filename || !filename.endsWith(".json")) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    const jsonPath = path.join(TTS_OUTPUTS, filename);
    if (!pathInside(jsonPath, TTS_OUTPUTS)) {
      return json(res, 400, { ok: false, error: "Invalid path" });
    }
    try {
      if (!fs.existsSync(jsonPath)) {
        return json(res, 404, { ok: false, error: "TTS output metadata not found" });
      }
      const metadata = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const audioFile = metadata.audioFile ? path.basename(String(metadata.audioFile)) : "";
      fs.unlinkSync(jsonPath);
      if (audioFile) {
        const audioPath = path.join(TTS_OUTPUTS, audioFile);
        if (pathInside(audioPath, TTS_OUTPUTS) && fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath);
        }
      }
      return json(res, 200, { ok: true });
    } catch (err) {
      console.error("  [api] Failed to delete TTS output:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  }

function isOomError(msg) {
  if (!msg) return false;
  const lower = String(msg).toLowerCase();
  return lower.includes("out of memory") ||
         lower.includes("failed to allocate") ||
         lower.includes("failed to initialize the context") ||
         lower.includes("oom") ||
         lower.includes("not enough memory") ||
         lower.includes("allocation failed") ||
         lower.includes("failed to create context");
}

async function retryLowerContext() {
  const currentCtx = llmSettings.contextSize || 4096;
  const contextLadder = [20000, 16384, 12288, 8192, 4096, 2048, 1024, 512];
  const nextLimit = contextLadder.find(limit => limit < currentCtx);
  if (!nextLimit) {
    throw new Error("Cannot lower context size any further.");
  }
  console.log(`  [llm] Retrying with lower context limit: ${nextLimit} (was ${currentCtx})`);
  
  const originalModel = llmSettings.model;
  const newSettings = {
    model: originalModel,
    threads: llmSettings.threads,
    contextSize: nextLimit,
    gpuLayers: llmSettings.gpuLayers,
    enableThinking: llmSettings.enableThinking,
  };
  
  await runExclusiveLlmOperation(() => startLlm(newSettings));
}

function getMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (typeof item?.text === "string") return item.text;
      if (typeof item?.content === "string") return item.content;
      return "";
    }).join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
  }
  return "";
}

function getLastUserQuery(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      return getMessageText(messages[i].content).trim();
    }
  }
  return "";
}

async function augmentMessagesWithWebSearch(messages, body) {
  if (body.useWeb !== true && body.use_web !== true) {
    return { messages, webSources: [], webContext: "" };
  }
  const query = String(body.webQuery || body.query || getLastUserQuery(messages) || "").trim();
  if (!query) return { messages, webSources: [], webContext: "" };

  const result = await comprehensiveWebSearch(query, {
    timeFilter: body.timeFilter || body.time_filter || "any",
    resultLimit: body.webResultLimit || 5,
    fetchLimit: body.webFetchLimit || 3,
    cacheDir: WEB_SEARCH_CACHE,
  });
  if (!result.context || !result.sources.length) {
    return { messages, webSources: [], webContext: "" };
  }
  let insertAt = 0;
  while (insertAt < messages.length && messages[insertAt]?.role === "system") {
    insertAt += 1;
  }
  const augmentedMessages = [
    ...messages.slice(0, insertAt),
    { role: "user", content: result.context },
    ...messages.slice(insertAt),
  ];
  return {
    messages: augmentedMessages,
    webSources: result.sources,
    webContext: result.context,
  };
}

async function doLlmChat(req, res, body, retryCount = 0) {
  try {
    const isStream = body.stream === true;
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const webAugmentation = await augmentMessagesWithWebSearch(rawMessages, body);
    const requestData = JSON.stringify({
      model: llmSettings.model || "local-model",
      messages: webAugmentation.messages,
      temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.7,
      max_tokens: Math.max(1, Math.min(4096, Number(body.max_tokens) || Number(body.maxTokens) || 1024)),
      stream: isStream,
      // New sampling parameters
      top_p: Number.isFinite(Number(body.top_p)) ? Number(body.top_p) : 0.95,
      top_k: Number.isFinite(Number(body.top_k)) ? Number(body.top_k) : 40,
      min_p: Number.isFinite(Number(body.min_p)) ? Number(body.min_p) : 0.05,
      repeat_penalty: Number.isFinite(Number(body.repeat_penalty)) ? Number(body.repeat_penalty) : 1.1,
      frequency_penalty: Number.isFinite(Number(body.frequency_penalty)) ? Number(body.frequency_penalty) : 0.0,
      presence_penalty: Number.isFinite(Number(body.presence_penalty)) ? Number(body.presence_penalty) : 0.0,
      seed: Number.isInteger(Number(body.seed)) ? Number(body.seed) : undefined,
      stop: Array.isArray(body.stop) ? body.stop : (body.stop ? [body.stop] : undefined),
    });

    if (isStream) {
      const clientReq = http.request({
        hostname: "127.0.0.1",
        port: PORT_LLM,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestData),
        },
        agent: llmHttpAgent,  // ✅ HTTP keep-alive: eliminates TCP handshake per turn
      }, (clientRes) => {
        if (clientRes.statusCode < 200 || clientRes.statusCode >= 300) {
          let errorBody = "";
          clientRes.setEncoding("utf8");
          clientRes.on("data", (chunk) => { errorBody += chunk; });
          clientRes.on("end", async () => {
            let message = `Text backend returned HTTP ${clientRes.statusCode}`;
            try {
              message = JSON.parse(errorBody || "{}").error?.message || message;
            } catch (_) {}
            
            if (isOomError(message) && retryCount === 0) {
              try {
                await retryLowerContext();
                return doLlmChat(req, res, body, retryCount + 1);
              } catch (retryErr) {
                console.error("Failed OOM recovery retry:", retryErr);
              }
            }
            json(res, clientRes.statusCode || 500, { ok: false, error: message });
          });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        });
        const socket = res.socket || res.connection;
        socket?.setNoDelay?.(true);
        res.flushHeaders?.();
        if (webAugmentation.webSources.length) {
          res.write(`event: web_sources\ndata: ${JSON.stringify({ sources: webAugmentation.webSources })}\n\n`);
        }
        clientRes.on("data", (chunk) => res.write(chunk));
        clientRes.on("end", () => res.end());
        clientRes.on("error", (err) => res.destroy(err));
      });

      clientReq.on("error", async (err) => {
        console.error("LLM stream request error:", err);
        if (isOomError(err.message) && retryCount === 0) {
          try {
            await retryLowerContext();
            return doLlmChat(req, res, body, retryCount + 1);
          } catch (retryErr) {
            console.error("Failed OOM recovery retry:", retryErr);
          }
        }
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        } else {
          res.end();
        }
      });

      clientReq.write(requestData);
      clientReq.end();
      res.on("close", () => {
        if (!res.writableEnded && !clientReq.destroyed) clientReq.destroy();
      });
      return;
    } else {
      try {
        const result = await requestJson(`http://127.0.0.1:${PORT_LLM}/v1/chat/completions`, JSON.parse(requestData), 300000);
        if (webAugmentation.webSources.length) {
          result.web_sources = webAugmentation.webSources;
        }
        return json(res, 200, result);
      } catch (err) {
        if (isOomError(err.message) && retryCount === 0) {
          try {
            await retryLowerContext();
            return doLlmChat(req, res, body, retryCount + 1);
          } catch (retryErr) {
            console.error("Failed OOM recovery retry:", retryErr);
          }
        }
        throw err;
      }
    }
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message || String(err) });
  }
}

function getLlmRuntimeStats() {
  const benchmarks = getPersistedLlmBenchmarks();
  return {
    ok: true,
    ready: llmReady,
    running: llmProc !== null,
    selectedBackend: getLlmBackendProbe().selected,
    settings: llmSettings,
    modelSettings: getPersistedLlmModelSettings(),
    benchmarks: (benchmarks.results || []).slice(0, 20),
  };
}

async function benchmarkLlmBackend(model, backend, baseSettings = {}) {
  const prompt = String(baseSettings.prompt || "Reply with one short sentence about local AI performance.");
  const startedAt = Date.now();
  await startLlmWithBackend({
    ...baseSettings,
    model,
    contextSize: Math.min(2048, Number(baseSettings.contextSize) || 2048),
    gpuLayers: Number.isFinite(Number(baseSettings.gpuLayers)) ? Number(baseSettings.gpuLayers) : -1,
    enableThinking: false,
  }, backend);

  const result = await requestJson(`http://127.0.0.1:${PORT_LLM}/v1/chat/completions`, {
    model: llmSettings.model || "local-model",
    messages: [
      { role: "system", content: "You are a concise local benchmark assistant." },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 64,
    stream: false,
  }, 180000);
  const finishedAt = Date.now();
  const timings = result.timings || {};
  return {
    backendKey: backend.key,
    backendMode: llmSettings.backendMode || backend.mode,
    backendBinary: llmSettings.backendBinary || path.basename(backend.path),
    model,
    ok: true,
    total_ms: finishedAt - startedAt,
    prompt_ms: Number(timings.prompt_ms) || null,
    predicted_ms: Number(timings.predicted_ms) || null,
    predicted_n: Number(timings.predicted_n) || null,
    predicted_per_second: Number(timings.predicted_per_second) || null,
    prompt_per_second: Number(timings.prompt_per_second) || null,
  };
}

async function benchmarkLlmModel(settings = {}) {
  const filename = path.basename(String(settings.model || llmSettings.model || ""));
  const modelPath = path.join(LLM_MODELS, filename);
  if (!filename || !pathInside(modelPath, LLM_MODELS) || !fs.existsSync(modelPath)) {
    throw new Error("Select a downloaded GGUF text model before benchmarking.");
  }

  const previous = {
    ready: llmReady,
    model: llmSettings.model,
    settings: { ...llmSettings },
  };
  const requestedBackends = Array.isArray(settings.backends)
    ? settings.backends.map((item) => String(item).toLowerCase())
    : [];
  const candidates = getLlmBackendCandidates()
    .filter((backend) => backend.key !== "cpu" || settings.includeCpu !== false)
    .filter((backend) => requestedBackends.length === 0 || requestedBackends.includes(backend.key));

  if (candidates.length === 0) {
    throw new Error("No available text backends were detected for benchmarking.");
  }

  const results = [];
  for (const backend of candidates) {
    try {
      const result = await benchmarkLlmBackend(filename, backend, settings);
      results.push(recordLlmBenchmark(result));
    } catch (err) {
      results.push(recordLlmBenchmark({
        backendKey: backend.key,
        backendMode: backend.mode,
        backendBinary: path.basename(backend.path),
        model: filename,
        ok: false,
        error: (err.message || String(err)).slice(-800),
      }));
      await killLlm();
    }
  }

  const successful = results
    .filter((item) => item.ok && Number(item.predicted_per_second) > 0)
    .sort((a, b) => Number(b.predicted_per_second) - Number(a.predicted_per_second));
  const winner = successful[0] || null;
  if (winner) {
    updateLlmModelSettings(filename, {
      preferredBackend: winner.backendKey,
      benchmarkWinner: {
        backendMode: winner.backendMode,
        predicted_per_second: winner.predicted_per_second,
        createdAt: winner.createdAt,
      },
    });
  }

  if (previous.ready && previous.model && previous.model === filename && winner) {
    try {
      await startLlm({ ...previous.settings, model: filename, preferredBackend: winner.backendKey });
    } catch (err) {
      console.warn("  [llm] Failed to restore text model after benchmark:", err.message || err);
    }
  }

  return { ok: true, model: filename, winner, results };
}

// ── llmfit Integration ──────────────────────────────────────────────────────────
let cachedLlmfitResults = new Map();

function getHardwareHash() {
  const cpus = os.cpus();
  const gpu = getGpuInfo();
  const ram = os.totalmem();
  return `${cpus.length}-${cpus[0]?.model || 'unknown'}-${gpu.name}-${ram}`;
}

async function getLlmfitRecommendations(useCase = "chat", limit = 10) {
  const hardwareHash = getHardwareHash();
  const cacheKey = `${hardwareHash}:${useCase}:${limit}`;
  
  const cached = cachedLlmfitResults.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < 3600000) { // 1 hour cache
    return cached.data;
  }
  
  // Try to find llmfit binary
  const llmfitPaths = [
    path.join(ROOT, "app", "tools", "llmfit", osPlatform === "win32" ? "llmfit.exe" : "llmfit"),
    "llmfit", // PATH
  ];
  
  let llmfitPath = null;
  for (const p of llmfitPaths) {
    try {
      if (fs.existsSync(p)) {
        llmfitPath = p;
        break;
      }
      if (osPlatform !== "win32") {
        const whichResult = spawnSync("which", [p], { stdio: "ignore" });
        if (whichResult.status === 0) {
          llmfitPath = p;
          break;
        }
      }
    } catch (_) {}
  }
  
  if (!llmfitPath) return null; // Fallback to tier table
  
  try {
    const result = spawnSync(llmfitPath, [
      "recommend", "--json", "--limit", String(limit),
      "--use-case", useCase, "--force-runtime", "llamacpp"
    ], {
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    
    if (result.status !== 0) return null;
    
    const data = JSON.parse(result.stdout);
    cachedLlmfitResults.set(cacheKey, { timestamp: Date.now(), data });
    return data;
  } catch (_) {
    return null;
  }
}

  if (req.url === "/api/web-search/config" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      provider: "duckduckgo",
      providers: [{ key: "duckduckgo", name: "DuckDuckGo", requiresApiKey: false, active: true }],
      cachePath: WEB_SEARCH_CACHE,
      defaults: { resultLimit: 5, fetchLimit: 3, timeFilter: "any" },
    });
  }

  if (req.url === "/api/web-search" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const result = await comprehensiveWebSearch(body.query || body.q || "", {
        timeFilter: body.timeFilter || body.time_filter || "any",
        resultLimit: body.resultLimit || 5,
        fetchLimit: body.fetchLimit || 3,
        cacheDir: WEB_SEARCH_CACHE,
      });
      return json(res, 200, { ok: true, ...result });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  }

  if (req.url === "/api/llm/chat" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (!llmReady) return json(res, 409, { ok: false, error: "Load a text model before sending a message." });
    await doLlmChat(req, res, body);
    return;
  }

  // GET /api/llm/recommend — llmfit recommendations
  if (req.url.startsWith("/api/llm/recommend") && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const useCase = url.searchParams.get("useCase") || "chat";
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 10));
    const recommendations = await getLlmfitRecommendations(useCase, limit);
    return json(res, 200, { ok: true, recommendations, source: recommendations ? "llmfit" : "fallback" });
  }



  // GET /api/capabilities/image-to-video/status
  if (req.url === "/api/capabilities/image-to-video/status" && req.method === "GET") {
    const runtimeDir = path.join(ROOT, "app", "runtimes", "image-to-video");
    const installedPath = path.join(runtimeDir, "installed.json");
    const statusPath = path.join(runtimeDir, "install-status.json");
    let state = { state: fs.existsSync(installedPath) ? "ready" : "not-installed", installed: fs.existsSync(installedPath) };
    try { if (fs.existsSync(statusPath)) state = { ...state, ...JSON.parse(fs.readFileSync(statusPath, "utf8")) }; } catch (_) {}
    if (fs.existsSync(installedPath)) {
      try { state.manifest = JSON.parse(fs.readFileSync(installedPath, "utf8")); state.installed = true; if (state.state !== "installing") state.state = "ready"; } catch (_) {}
    }
    return json(res, 200, { ok: true, ...state });
  }

  // POST /api/capabilities/image-to-video/install
  if (req.url === "/api/capabilities/image-to-video/install" && req.method === "POST") {
    const body = await readJsonBody(req, res) || {};
    const runtimeDir = path.join(ROOT, "app", "runtimes", "image-to-video");
    const statusPath = path.join(runtimeDir, "install-status.json");
    fs.mkdirSync(runtimeDir, { recursive: true });
    let current = {};
    try { if (fs.existsSync(statusPath)) current = JSON.parse(fs.readFileSync(statusPath, "utf8")); } catch (_) {}
    if (current.state === "installing") return json(res, 202, { ok: true, state: "installing", message: current.message || "Installation is already running." });
    const installer = path.join(ROOT, "scripts", "workers", "install_image_to_video_runtime.py");
    const systemPython = process.platform === "win32" ? "python" : "python3";
    const args = [installer, "--root", ROOT, "--status", statusPath];
    if (body.repair === true) args.push("--repair");
    fs.writeFileSync(statusPath, JSON.stringify({ state: "installing", step: "Starting", message: "Starting Image-to-Video installation…" }, null, 2));
    const child = spawn(systemPython, args, { cwd: ROOT, detached: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const logPath = path.join(runtimeDir, "install.log");
    const log = fs.createWriteStream(logPath, { flags: "a" });
    child.stdout.pipe(log); child.stderr.pipe(log);
    child.on("error", (err) => { try { fs.writeFileSync(statusPath, JSON.stringify({ state:"error", message:`Could not start installer: ${err.message}` }, null, 2)); } catch (_) {} });
    child.on("exit", () => log.end());
    return json(res, 202, { ok: true, state: "installing", message: "Image-to-Video components are being installed." });
  }

  // GET /api/image-to-video/compatibility
  if (req.url === "/api/image-to-video/compatibility" && req.method === "GET") {
    const hw = getHardwareSpecs();
    const apple = process.platform === "darwin" && process.arch === "arm64";
    const ram = Number(hw.ram_total_gb || 0);
    const vram = Number(hw.gpu_vram_gb || hw.vram_total_gb || 0);
    const gpuName = String(hw.gpu_name || "").toLowerCase();
    const cuda = /nvidia|geforce|quadro|tesla|rtx|gtx/.test(gpuName);
    const models = [
      { id: "svd", name: "Stable Video Diffusion", minRamGb: 16, recommendedRamGb: 32, minVramGb: 8, recommendedVramGb: 12, backends: ["CUDA", "Metal (experimental)"] },
      { id: "svd-xt", name: "Stable Video Diffusion XT", minRamGb: 24, recommendedRamGb: 48, minVramGb: 12, recommendedVramGb: 16, backends: ["CUDA", "Metal (experimental)"] },
      { id: "wan-i2v-small", name: "Wan Image-to-Video (small profile)", minRamGb: 32, recommendedRamGb: 64, minVramGb: 16, recommendedVramGb: 24, backends: ["CUDA"] },
      { id: "cogvideox-i2v", name: "CogVideoX Image-to-Video", minRamGb: 32, recommendedRamGb: 64, minVramGb: 16, recommendedVramGb: 24, backends: ["CUDA"] },
    ].map((m) => {
      let status = "blocked", label = "Not supported", reason = "No compatible GPU runtime was detected.";
      const effective = apple ? ram : vram;
      const minimum = apple ? m.minRamGb : m.minVramGb;
      const recommended = apple ? m.recommendedRamGb : m.recommendedVramGb;
      const backendOkay = (apple && m.backends.some(x => x.startsWith("Metal"))) || (cuda && m.backends.includes("CUDA"));
      if (backendOkay && effective >= recommended) { status = "recommended"; label = "Recommended"; reason = `Detected ${effective} GB ${apple ? "unified memory" : "VRAM"}; meets the recommended profile.`; }
      else if (backendOkay && effective >= minimum) { status = "limited"; label = "Supported with limits"; reason = `Meets minimum memory (${minimum} GB), but lower resolution, fewer frames, CPU offload and longer render times may be required.`; }
      else if (backendOkay) { reason = `Compatible GPU detected, but only ${effective} GB memory is available; at least ${minimum} GB is required.`; }
      return { ...m, compatibility: { status, label, reason }, workerReady: ["svd", "svd-xt"].includes(m.id) };
    });
    return json(res, 200, { ok: true, hardware: hw, models });
  }

  // POST /api/image-to-video/generate
  if (req.url === "/api/image-to-video/generate" && req.method === "POST") {
    try {
      const body = await readJsonBody(req, res);
      if (!body) return;
      let modelId = String(body.modelId || "");
      const imageDataUrl = String(body.imageDataUrl || "");
      const references = Array.isArray(body.references) ? body.references.slice(0, 8) : [];
      const automaticMatch = body.automaticMatch === true;
      if (modelId === "auto") {
        const hw = getHardwareSpecs();
        const apple = process.platform === "darwin" && process.arch === "arm64";
        const ram = Number(hw.ram_total_gb || 0);
        const vram = Number(hw.gpu_vram_gb || hw.vram_total_gb || 0);
        modelId = (apple ? ram >= 48 : vram >= 16) ? "svd-xt" : "svd";
      }
      if (!imageDataUrl.startsWith("data:image/")) return json(res, 400, { ok: false, error: "A valid source image is required." });
      if (!["svd", "svd-xt"].includes(modelId)) return json(res, 400, { ok: false, error: "This model is shown for compatibility planning, but its verified local worker adapter is not installed yet." });
      const match = imageDataUrl.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
      if (!match) return json(res, 400, { ok: false, error: "Unsupported image encoding." });
      const jobId = `i2v-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const inputDir = path.join(ROOT, "app", "cache", "image-to-video");
      const outputDir = path.join(ROOT, "app", "outputs", "video");
      fs.mkdirSync(inputDir, { recursive: true }); fs.mkdirSync(outputDir, { recursive: true });
      const inputPath = path.join(inputDir, `${jobId}.png`);
      const outputPath = path.join(outputDir, `${jobId}.mp4`);
      fs.writeFileSync(inputPath, Buffer.from(match[1], "base64"));
      const referenceDir = path.join(inputDir, jobId + "-references");
      fs.mkdirSync(referenceDir, { recursive: true });
      const referenceManifest = [];
      for (let i = 0; i < references.length; i++) {
        const ref = references[i] || {};
        const refMatch = String(ref.dataUrl || "").match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
        if (!refMatch) continue;
        const refPath = path.join(referenceDir, `ref-${i}.png`);
        fs.writeFileSync(refPath, Buffer.from(refMatch[1], "base64"));
        referenceManifest.push({ path: refPath, type: automaticMatch ? "auto" : String(ref.type || "product"), weight: automaticMatch ? 1 : Math.max(0.2, Math.min(1, Number(ref.weight) || 0.85)) });
      }
      const manifestPath = path.join(referenceDir, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(referenceManifest, null, 2));
      const worker = path.join(ROOT, "scripts", "workers", "image_to_video_worker.py");
      const runtimePython = path.join(ROOT, "app", "runtimes", "image-to-video", "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
      if (!fs.existsSync(runtimePython)) return json(res, 409, { ok: false, code: "I2V_NOT_INSTALLED", error: "Image-to-Video is not installed yet. Use the Install button in Image-to-Video." });
      const result = spawnSync(runtimePython, [worker, "--model", modelId, "--image", inputPath, "--output", outputPath, "--prompt", String(body.prompt || ""), "--seconds", String(Math.max(2, Math.min(10, Number(body.seconds) || 5))), "--references", manifestPath, "--reference-lock", body.referenceLock === false ? "0" : "1", "--automatic-match", automaticMatch ? "1" : "0"], { encoding: "utf8", timeout: 60 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 });
      let parsed = null; try { parsed = JSON.parse(String(result.stdout || "").trim().split(/\r?\n/).pop()); } catch (_) {}
      if (result.error || result.status !== 0 || !parsed?.ok) return json(res, 500, { ok: false, error: parsed?.error || String(result.stderr || result.error?.message || "Image-to-video worker failed.") });
      return json(res, 200, { ok: true, output: path.relative(ROOT, outputPath), message: `Video saved to ${path.relative(ROOT, outputPath)}` });
    } catch (err) { return json(res, 500, { ok: false, error: err.message || String(err) }); }
  }

  // GET /api/hardware-specs
  if (req.url === "/api/hardware-specs" && req.method === "GET") {
    return json(res, 200, getHardwareSpecs());
  }

  // GET /api/backend-options
  if (req.url === "/api/backend-options" && req.method === "GET") {
    return json(res, 200, getBackendOptions());
  }

  // GET /api/telemetry
  if (req.url === "/api/telemetry" && req.method === "GET") {
    return json(res, 200, getTelemetry());
  }

  // GET /api/models — list available model files
  if (req.url === "/api/models" && req.method === "GET") {
    try {
      let files = fs.readdirSync(MODELS).filter(isModelFile).map(getModelInfo);
      if (downloadState.active && downloadState.filename) {
        files = files.filter(model => model.filename !== downloadState.filename);
      }
      return json(res, 200, { models: files });
    } catch (_) { return json(res, 200, { models: [] }); }
  }

  if (req.url === "/api/openvino-models" && req.method === "GET") {
    const npuInfo = getOpenVinoNpuInfo();
    return json(res, 200, {
      supported: npuInfo.supported,
      reason: npuInfo.reason || "",
      npu: npuInfo.npu || null,
      python: npuInfo.python || "",
      models: npuInfo.supported ? getOpenVinoModelInfo() : [],
    });
  }

  // POST /api/restart-backend — restart with new settings
  if (req.url === "/api/restart-backend" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    console.log("  [api] Restart backend request:", body);
    const newSettings = {};
    if (body.model)    newSettings.model    = body.backend_type === "openvino-npu" ? String(body.model) : path.join(MODELS, body.model);
    if (body.steps)    newSettings.steps    = parseInt(body.steps);
    if (body.cfgScale) newSettings.cfgScale = parseFloat(body.cfgScale);
    if (body.sampler)  newSettings.sampler  = body.sampler;
    if (body.threads)  newSettings.threads  = parseInt(body.threads);
    if (body.width)    newSettings.width    = parseInt(body.width);
    if (body.height)   newSettings.height   = parseInt(body.height);
    if (typeof body.use_gpu === "boolean") newSettings.useGpu = body.use_gpu;
    if (body.backend_type) {
      newSettings.backendType = String(body.backend_type);
      newSettings.useGpu = body.backend_type !== "cpu";
    }
    if (typeof body.vae_tiling === "boolean") newSettings.vaeTiling = body.vae_tiling;
    if (typeof body.vae_on_cpu === "boolean") newSettings.vaeOnCpu = body.vae_on_cpu;
    if (typeof body.flash_attn === "boolean") newSettings.flashAttn = body.flash_attn;
    try {
      const targetModel = newSettings.model || currentSettings.model || getDefaultModel();
      assertNoOtherActiveRuntime("image", targetModel);
      const requestedSettings = { ...currentSettings, ...newSettings, model: targetModel };
      const imageBackendReady = (backendReady && backendProc) || (openvinoReady && openvinoProc);
      if (imageBackendReady && backendSettingsMatch(currentSettings, requestedSettings)) {
        return json(res, 200, { ok: true, message: "Backend already running with requested settings.", settings: currentSettings, port: PORT_BACKEND });
      }
      if (backendReady && backendProc && appleNpuRuntimeMatches(currentSettings, requestedSettings)) {
        currentSettings = requestedSettings;
        return json(res, 200, { ok: true, message: "Apple NPU backend already running; updated generation defaults.", settings: currentSettings, port: PORT_BACKEND });
      }
      await killBackend();
      await new Promise(r => setTimeout(r, 500));
      if (newSettings.backendType === "openvino-npu") {
        startBackend(newSettings).catch((err) => {
          backendError = err.message || String(err);
          backendLoadState = {
            ...backendLoadState,
            active: false,
            phase: "OpenVINO NPU model load failed",
          };
          console.error("  [openvino-npu] Startup failed:", backendError);
        });
        return json(res, 200, { ok: true, message: "OpenVINO NPU backend starting...", settings: currentSettings, port: PORT_BACKEND });
      }
      if (newSettings.backendType === "apple-npu") {
        const backendPort = await findAvailableBackendPort();
        PORT_BACKEND = backendPort;
        newSettings.backendPort = backendPort;
        currentSettings = { ...currentSettings, ...newSettings };
        backendLoadState = {
          active: true,
          phase: "Starting Apple NPU backend...",
          progress: 1,
          current: 0,
          total: 0,
          speed: "",
          model: path.basename(newSettings.model || targetModel),
          backendMode: "Apple NPU",
          backendBinary: path.basename(getCoreMLPythonPath()),
          device: "",
        };
        startBackend(newSettings).catch((err) => {
          backendError = err.message || String(err);
          backendLoadState = {
            ...backendLoadState,
            active: false,
            phase: "Apple NPU model load failed",
          };
          console.error("  [coreml-npu] Startup failed:", backendError);
        });
        return json(res, 200, { ok: true, message: "Apple NPU backend starting...", settings: { ...currentSettings, ...newSettings }, port: backendPort });
      }
      await startBackend(newSettings);
      return json(res, 200, { ok: true, message: "Backend restarting...", settings: currentSettings, port: PORT_BACKEND });
    } catch (err) {
      backendError = err.message || String(err);
      return json(res, jsonErrorStatus(err), { ok: false, error: backendError, code: err.code || "", activeRuntime: err.activeRuntime || null, port: PORT_BACKEND });
    }
  }

  // POST /api/stop-backend
  if (req.url === "/api/stop-backend" && req.method === "POST") {
    await killBackend();
    await killOpenVinoWorker();
    return json(res, 200, { ok: true });
  }

  // POST /api/download-backend
  if (req.url === "/api/download-backend" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (downloadState.active) return json(res, 409, { ok: false, error: "Another download is already active." });
    try {
      const backendId = String(body.backend_id || body.backendId || body.id || "");
      startImageBackendDownload(backendId);
      return json(res, 200, { ok: true, message: "Backend download started", backendId });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message || String(err) });
    }
  }

  // POST /api/download-model
  if (req.url === "/api/download-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { url } = body;
    if (!url) return json(res, 400, { error: "URL is required" });
    try {
      const job = startModelDownload(url);
      return json(res, 200, { ok: true, message: "Download started", filename: job.filename, downloadId: job.id });
    } catch (err) {
      return json(res, 409, { ok: false, error: err.message || String(err) });
    }
  }

  if (req.url === "/api/llm/download-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const url = String(body.url || "");
    if (!url) return json(res, 400, { ok: false, error: "URL is required" });
    try {
      const directUrl = url.includes("huggingface.co") ? url.replace("/blob/", "/resolve/") : url;
      const overrideFilename = body.filename ? path.basename(String(body.filename)) : null;
      const filename = overrideFilename || path.basename(new URL(directUrl).pathname);
      if (!filename.toLowerCase().endsWith(".gguf")) {
        return json(res, 400, { ok: false, error: "Text model URL must point to a .gguf file." });
      }
      const projector = body.projectorUrl && body.projectorFilename
        ? { url: String(body.projectorUrl), filename: path.basename(String(body.projectorFilename)) }
        : await resolveHuggingFaceProjector(directUrl, filename);
      const job = startModelDownload(directUrl, filename, LLM_MODELS, "text");
      return json(res, 200, {
        ok: true,
        message: "Text model download started",
        filename,
        downloadId: job.id,
        projectorUrl: projector?.url || "",
        projectorFilename: projector?.filename || "",
      });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message || String(err) });
    }
  }

  if (req.url === "/api/download-openvino-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const modelId = String(body.model_id || body.modelId || "");
    if (!modelId) return json(res, 400, { ok: false, error: "model_id is required" });
    try {
      startOpenVinoModelDownload(modelId);
      return json(res, 200, { ok: true, message: "OpenVINO model download started" });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  }

  // GET /api/download-progress
  if (req.url === "/api/download-progress" && req.method === "GET") {
    if (!downloadState.active && downloadState.kind === "backend" && downloadState.backendId) {
      const backend = IMAGE_BACKEND_DOWNLOADS[downloadState.backendId];
      const installed = backend &&
        fs.existsSync(path.join(backend.destDir, backend.exeName)) &&
        fs.existsSync(path.join(backend.destDir, backend.requiredDll));
      if (installed && !downloadState.error) {
        cachedBackendOptions = null;
        downloadState = {
          active: false,
          filename: "",
          progress: 0,
          speed: "0 MB/s",
          eta: 0,
          totalBytes: 0,
          downloadedBytes: 0,
          error: null,
        };
      }
    }
    const modelSummary = summarizeModelDownloads();
    if ((modelSummary.downloads || []).length > 0) {
      return json(res, 200, modelSummary);
    }
    return json(res, 200, downloadState);
  }

  // POST /api/cancel-download
  if (req.url === "/api/cancel-download" && req.method === "POST") {
    let body = {};
    try { body = await readJsonBody(req, res, 64 * 1024) || {}; } catch (_) {}
    const cancelled = cancelModelDownload(body.filename || body.id || "");
    return json(res, 200, { ok: true, cancelled });
  }

  // GET /api/generation-progress
  if (req.url === "/api/generation-progress" && req.method === "GET") {
    return json(res, 200, {
      ...generationState,
      backendMode: generationState.backendMode || currentSettings.backendMode || "",
      backendDevice: generationState.backendDevice || currentSettings.backendDevice || "",
    });
  }

  if (req.url === "/api/openvino-generate" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      return json(res, 200, await generateWithOpenVino(body));
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  }

  // GET /api/outputs
  if (req.url === "/api/outputs" && req.method === "GET") {
    return json(res, 200, { outputs: listGeneratedOutputs() });
  }

  // GET /api/output-file?filename=...
  if (req.url.startsWith("/api/output-file") && req.method === "GET") {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const filename = path.basename(parsed.searchParams.get("filename") || "");
    const filePath = path.join(OUTPUTS, filename);
    if (!filename || !fs.existsSync(filePath)) {
      return json(res, 404, { error: "Output file not found" });
    }
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (err, data) => {
      if (err) return json(res, 500, { error: err.message });
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Access-Control-Allow-Origin": "*" });
      res.end(data);
    });
    return;
  }

  if (req.url.startsWith("/tts-outputs/") && req.method === "GET") {
    const filename = path.basename(decodeURIComponent(req.url.replace(/^\/tts-outputs\//, "").split("?")[0] || ""));
    const filePath = path.join(TTS_OUTPUTS, filename);
    if (!filename || !pathInside(filePath, TTS_OUTPUTS) || !fs.existsSync(filePath)) {
      return json(res, 404, { ok: false, error: "TTS output not found" });
    }
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (err, data) => {
      if (err) return json(res, 500, { ok: false, error: err.message });
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Access-Control-Allow-Origin": "*" });
      res.end(data);
    });
    return;
  }

  // POST /api/save-output
  if (req.url === "/api/save-output" && req.method === "POST") {
    try {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const saved = saveGeneratedOutput(body.image, body.metadata || {});
      return json(res, 200, { ok: true, output: { ...saved, url: `/api/output-file?filename=${encodeURIComponent(saved.image)}` } });
    } catch (err) {
      console.error("  [api] Failed to save output:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  // POST /api/delete-outputs
  if (req.url === "/api/delete-outputs" && req.method === "POST") {
    try {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const deleted = deleteGeneratedOutputs(body.outputs || []);
      return json(res, 200, { ok: true, deleted });
    } catch (err) {
      console.error("  [api] Failed to delete outputs:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  // POST /api/import-model?filename=...
  if (req.url.startsWith("/api/import-model") && req.method === "POST") {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await streamModelUpload(req, parsed.searchParams.get("filename"));
      return json(res, 200, { ok: true, message: `Imported ${result.filename}`, model: result, filename: result.filename });
    } catch (err) {
      console.error("  [api] Failed to import model:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.url.startsWith("/api/llm/import-model") && req.method === "POST") {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await streamModelUpload(req, parsed.searchParams.get("filename"), LLM_MODELS, "text");
      return json(res, 200, { ok: true, message: `Imported ${result.filename}`, model: result });
    } catch (err) {
      console.error("  [api] Failed to import text model:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.url === "/api/llm/delete-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    const modelPath = path.join(LLM_MODELS, filename);
    if (!filename || !pathInside(modelPath, LLM_MODELS)) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    if (llmSettings.model === filename && llmProc) await killLlm();
    try {
      fs.unlinkSync(modelPath);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, err.code === "ENOENT" ? 404 : 500, {
        ok: false,
        error: err.code === "ENOENT" ? "Text model not found" : err.message,
      });
    }
  }

  // POST /api/delete-model
  if (req.url === "/api/delete-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { filename } = body;
    if (!filename) return json(res, 400, { error: "Filename is required" });
    
    const openvinoModel = findOpenVinoModel(filename);
    const safeFilename = path.basename(filename);
    const modelPath = path.join(MODELS, safeFilename);
    
    try {
      if (openvinoModel?.installed && openvinoModel.path && pathInside(openvinoModel.path, OPENVINO_MODELS)) {
        fs.rmSync(openvinoModel.path, { recursive: true, force: true });
        cachedBackendOptions = null;
        console.log(`  [api] Deleted OpenVINO model: ${openvinoModel.id}`);
        return json(res, 200, { ok: true, message: `Deleted ${openvinoModel.name}` });
      } else if (fs.existsSync(modelPath)) {
        fs.unlinkSync(modelPath);
        console.log(`  [api] Deleted model file: ${safeFilename}`);
        return json(res, 200, { ok: true, message: `Deleted ${safeFilename}` });
      } else {
        return json(res, 404, { error: "Model file not found" });
      }
    } catch (err) {
      console.error(`  [api] Failed to delete model ${safeFilename}:`, err);
      return json(res, 500, { error: err.message });
    }
  }

  if (req.url.startsWith("/api/")) {
    return json(res, 404, { ok: false, error: "Unknown API endpoint" });
  }

  // ── Static frontend files ─────────────────────────────────────────────────
  let filePath = path.join(DIST, req.url === "/" ? "index.html" : req.url);
  filePath = filePath.split("?")[0];
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, "index.html");
  }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": mime, "Access-Control-Allow-Origin": "*" });
    res.end(data);
  });
});

server.timeout = 0; // Disable socket timeout for large model uploads/downloads

server.listen(PORT_FRONTEND, "0.0.0.0", () => {
  console.log("");
  console.log("  ============================================================");
  console.log("   LUKE AI STUDIO      |  Running");
  console.log("   Server Build: " + SERVER_BUILD);
  console.log("   Frontend : http://localhost:" + PORT_FRONTEND);
  console.log("   Image API: http://127.0.0.1:" + PORT_BACKEND);
  console.log("   Text API : starts on http://127.0.0.1:" + PREFERRED_LLM_PORT);
  console.log("   Speech   : managed locally, API on frontend port");
  console.log("   TTS      : Kokoro ONNX managed locally, API on frontend port");
  console.log("  ============================================================");
  console.log("");

  // Do not auto-start backend; wait for selection from the Web UI
  console.log("  [backend] Ready. Waiting for model load request from the webapp...");
});

// Graceful shutdown
process.on("SIGINT",  async () => { await killBackend(); await killOpenVinoWorker(); await killLlm(); await stopSpeech(); await stopTts(); process.exit(0); });
process.on("SIGTERM", async () => { await killBackend(); await killOpenVinoWorker(); await killLlm(); await stopSpeech(); await stopTts(); process.exit(0); });

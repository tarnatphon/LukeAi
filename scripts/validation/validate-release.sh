#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fail(){ echo "FAIL: $*" >&2; exit 1; }
pass(){ echo "PASS: $*"; }

bash -n "$ROOT/mac.sh" || fail "mac.sh syntax"
bash -n "$ROOT/scripts/setup/setup.sh" || fail "setup.sh syntax"
bash -n "$ROOT/scripts/setup/setup-tts.sh" || fail "setup-tts.sh syntax"
node --check "$ROOT/scripts/server/serve.cjs" || fail "server syntax"
node --check "$ROOT/scripts/updater/update.cjs" || fail "updater syntax"
python3 -m py_compile "$ROOT/scripts/workers/image_to_video_worker.py" || fail "image-to-video worker"
python3 -m py_compile "$ROOT/scripts/workers/install_image_to_video_runtime.py" || fail "image-to-video installer"
[ -f "$ROOT/app/capabilities/image-to-video/manifest.json" ] || fail "capability manifest missing"
[ -f "$ROOT/app/frontend/src/components/ImageToVideo.jsx" ] || fail "ImageToVideo UI missing"
find "$ROOT" -type d -name '__pycache__' -prune -exec rm -rf {} +
find "$ROOT" -type f -name '*.pyc' -delete
pass "release structure and syntax"


# LUKE_AI_PORTABLE_RUNTIME_VALIDATION_V2
validate_portable_runtime_policy() {
  local runtime_root="app/tools/node-mac"
  local runtime_metadata="$runtime_root/runtime.json"
  local packaging_mode="${LUKE_AI_PACKAGING_MODE:-0}"

  if [ ! -d "$runtime_root" ]; then
    echo "PASS: No portable Node runtime present in source workspace"
    return 0
  fi

  if [ ! -f "$runtime_metadata" ]; then
    echo "FAIL: Portable Node runtime exists without runtime.json"
    return 1
  fi

  if ! python3 -m json.tool "$runtime_metadata" >/dev/null 2>&1; then
    echo "FAIL: Portable Node runtime metadata is invalid"
    return 1
  fi

  if [ "$packaging_mode" = "1" ]; then
    for required_file in \
      "$runtime_root/bin/node" \
      "$runtime_root/bin/npm" \
      "$runtime_root/bin/npx" \
      "$runtime_root/lib/node_modules/npm/package.json"
    do
      if [ ! -f "$required_file" ]; then
        echo "FAIL: Packaging runtime is missing $required_file"
        return 1
      fi
    done

    if [ ! -x "$runtime_root/bin/node" ] \
      || [ ! -x "$runtime_root/bin/npm" ] \
      || [ ! -x "$runtime_root/bin/npx" ]; then
      echo "FAIL: Portable runtime executables do not have execute permission"
      return 1
    fi

    if ! "$runtime_root/bin/node" --version >/dev/null 2>&1 \
      || ! "$runtime_root/bin/npm" --version >/dev/null 2>&1 \
      || ! "$runtime_root/bin/npx" --version >/dev/null 2>&1; then
      echo "FAIL: Portable runtime executables are not functional"
      return 1
    fi

    echo "PASS: Portable Node runtime is valid for packaging"
    return 0
  fi

  if [ -f "$runtime_root/bin/node" ] \
    || [ -d "$runtime_root/lib/node_modules/npm" ]; then
    echo "FAIL: stale portable Node runtime present"
    echo "Set LUKE_AI_PACKAGING_MODE=1 only during validated release packaging"
    return 1
  fi

  echo "PASS: Runtime metadata present without stale packaged binaries"
  return 0
}

validate_portable_runtime_policy

# LUKE AI STUDIO API contract validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/check-api-contracts.cjs
else
  echo "FAIL: Node.js is required for API contract validation"
  exit 1
fi

# LUKE AI STUDIO backend API smoke test
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-backend-api.cjs
else
  echo "FAIL: Node.js is required for backend API smoke testing"
  exit 1
fi

# LUKE AI STUDIO runtime dependency catalog validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-runtime-dependencies.cjs
else
  echo "FAIL: Node.js is required for runtime dependency validation"
  exit 1
fi

# LUKE AI STUDIO runtime install state machine validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-runtime-install-state.cjs
else
  echo "FAIL: Node.js is required for runtime install state validation"
  exit 1
fi

# LUKE AI STUDIO safe runtime download worker validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-runtime-download-worker.cjs
else
  echo "FAIL: Node.js is required for runtime download worker validation"
  exit 1
fi

# LUKE AI STUDIO runtime download dashboard validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-runtime-dashboard.cjs
else
  echo "FAIL: Node.js is required for runtime dashboard validation"
  exit 1
fi

# LUKE AI STUDIO external drive availability validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-runtime-storage-availability.cjs
else
  echo "FAIL: Node.js is required for runtime storage validation"
  exit 1
fi

# LUKE AI STUDIO runtime storage usage and cleanup validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-runtime-storage-cleanup.cjs
else
  echo "FAIL: Node.js is required for runtime storage cleanup validation"
  exit 1
fi

# LUKE AI STUDIO Text Model Manager foundation validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-text-model-manager-foundation.cjs
else
  echo "FAIL: Node.js is required for Text Model Manager validation"
  exit 1
fi

# LUKE AI STUDIO Text Model Catalog API validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-text-model-catalog-api.cjs
else
  echo "FAIL: Node.js is required for Text Model Catalog validation"
  exit 1
fi

# LUKE AI STUDIO Community Text Model Catalog validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-community-text-model-catalog.cjs
else
  echo "FAIL: Node.js is required for Community Model validation"
  exit 1
fi

# LUKE AI STUDIO sequential Text Model download validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-text-model-download-worker.cjs
else
  echo "FAIL: Node.js is required for Text Model download validation"
  exit 1
fi

# LUKE AI STUDIO Text Model Manager UI validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-text-model-manager-ui.cjs
else
  echo "FAIL: Node.js is required for Text Model Manager UI validation"
  exit 1
fi

# LUKE AI STUDIO Text Model automatic update validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-text-model-update-manager.cjs
else
  echo "FAIL: Node.js is required for Text Model Update validation"
  exit 1
fi

# LUKE AI STUDIO Text Model hardware compatibility validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-text-model-hardware-compatibility.cjs
else
  echo "FAIL: Node.js is required for Text Model hardware validation"
  exit 1
fi

# LUKE AI STUDIO Persistent Text Chat validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-persistent-text-chat.cjs
else
  echo "FAIL: Node.js is required for Persistent Text Chat validation"
  exit 1
fi

# LUKE AI STUDIO Text Chat Context Memory validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-text-chat-memory-manager.cjs
else
  echo "FAIL: Node.js is required for Text Chat Memory validation"
  exit 1
fi

# LUKE AI STUDIO Text Runtime Session Refresh validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-text-runtime-session-refresh.cjs
else
  echo "FAIL: Node.js is required for Text Runtime Session validation"
  exit 1
fi

# LUKE AI STUDIO Text Generation Streaming validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-text-generation-streaming.cjs
else
  echo "FAIL: Node.js is required for Text Generation Streaming validation"
  exit 1
fi

# LUKE AI STUDIO Multi-Model Parallel Generation validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-multi-model-parallel-generation.cjs
else
  echo "FAIL: Node.js is required for Multi-Model Generation validation"
  exit 1
fi

# LUKE AI STUDIO AI Judge Synthesis validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-ai-judge-synthesis.cjs
else
  echo "FAIL: Node.js is required for AI Judge Synthesis validation"
  exit 1
fi

# LUKE AI STUDIO Text Model Feedback validation
if command -v node >/dev/null 2>&1; then
  node scripts/validation/test-text-model-feedback.cjs
else
  echo "FAIL: Node.js is required for Text Model Feedback validation"
  exit 1
fi

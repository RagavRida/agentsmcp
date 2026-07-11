#!/bin/bash
# ============================================================
# AgentMailbox — On-Prem Quick Start
#
# Deploys the full stack on a machine with NVIDIA GPU.
# Run: ./deploy-onprem.sh [gpu-type]
#
# GPU types: t4, l4, a100-40, a100-80, h100
# ============================================================

set -euo pipefail

GPU_TYPE="${1:-t4}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.onprem.yml"

echo "╔══════════════════════════════════════════╗"
echo "║  AgentMailbox On-Prem Deployment         ║"
echo "║  GPU: ${GPU_TYPE}                        ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── GPU-Aware Model Selection ─────────────────────────────
case "$GPU_TYPE" in
  t4)
    export VLLM_MODEL="Qwen/Qwen2.5-3B-Instruct"
    export MAX_MODEL_LEN=4096
    export GPU_MEM_UTIL=0.85
    export EMBED_MODEL="BAAI/bge-base-en-v1.5"
    echo "  Model:  Qwen2.5-3B (fits T4 16GB)"
    echo "  Embed:  bge-base-en"
    ;;
  l4)
    export VLLM_MODEL="Qwen/Qwen2.5-7B-Instruct"
    export MAX_MODEL_LEN=8192
    export GPU_MEM_UTIL=0.85
    export EMBED_MODEL="BAAI/bge-large-en-v1.5"
    echo "  Model:  Qwen2.5-7B (fits L4 24GB)"
    echo "  Embed:  bge-large-en"
    ;;
  a100-40)
    export VLLM_MODEL="deepseek-ai/DeepSeek-V2-Lite-Chat"
    export MAX_MODEL_LEN=16384
    export GPU_MEM_UTIL=0.90
    export EMBED_MODEL="BAAI/bge-large-en-v1.5"
    echo "  Model:  DeepSeek-V2-Lite (MLA on A100-40GB)"
    echo "  Embed:  bge-large-en"
    ;;
  a100-80|h100)
    export VLLM_MODEL="deepseek-ai/DeepSeek-V2-Lite-Chat"
    export MAX_MODEL_LEN=32768
    export GPU_MEM_UTIL=0.90
    export GPU_COUNT=1
    export EMBED_MODEL="BAAI/bge-large-en-v1.5"
    echo "  Model:  DeepSeek-V2-Lite (MLA, full context)"
    echo "  Embed:  bge-large-en"
    ;;
  *)
    echo "❌ Unknown GPU type: $GPU_TYPE"
    echo "   Options: t4, l4, a100-40, a100-80, h100"
    exit 1
    ;;
esac

echo ""

# ── Pre-flight Checks ────────────────────────────────────
echo "── Pre-flight Checks ──────────────────────"

# Check Docker
if ! command -v docker &> /dev/null; then
  echo "  ❌ Docker not found. Install: https://docs.docker.com/engine/install/"
  exit 1
fi
echo "  ✅ Docker found"

# Check NVIDIA
if ! command -v nvidia-smi &> /dev/null; then
  echo "  ❌ nvidia-smi not found. Install NVIDIA drivers."
  exit 1
fi
echo "  ✅ NVIDIA drivers found"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | while read line; do
  echo "  📊 GPU: $line"
done

# Check Docker Compose
if ! docker compose version &> /dev/null; then
  echo "  ❌ Docker Compose V2 not found."
  exit 1
fi
echo "  ✅ Docker Compose found"

# Check NVIDIA Container Toolkit
if ! docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi &> /dev/null; then
  echo "  ⚠️  NVIDIA Container Toolkit may not be configured."
  echo "     Install: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
fi
echo ""

# ── Deploy ────────────────────────────────────────────────
echo "── Deploying Stack ────────────────────────"
echo "  Compose: ${COMPOSE_FILE}"
echo ""

docker compose -f "$COMPOSE_FILE" up -d

echo ""
echo "── Waiting for Services ─────────────────"

# Wait for health
for service in inference neo4j minio; do
  echo -n "  Waiting for $service..."
  timeout=300
  while ! docker compose -f "$COMPOSE_FILE" exec -T $service curl -sf http://localhost:8000/health &>/dev/null 2>&1; do
    sleep 5
    timeout=$((timeout - 5))
    if [ $timeout -le 0 ]; then
      echo " ⚠️ timeout"
      break
    fi
    echo -n "."
  done
  echo " ✅"
done

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  ✅ On-Prem Stack Running                 ║"
echo "╠══════════════════════════════════════════╣"
echo "║  Inference: http://localhost:8000         ║"
echo "║  Embedder:  http://localhost:8001         ║"
echo "║  Neo4j:     http://localhost:7474         ║"
echo "║  MinIO:     http://localhost:9001         ║"
echo "║  App:       http://localhost:3000         ║"
echo "╠══════════════════════════════════════════╣"
echo "║  No external API calls. Air-gapped.       ║"
echo "║  All data stays on this machine.          ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Test:  curl http://localhost:8000/v1/chat/completions \\"
echo "           -H 'Content-Type: application/json' \\"
echo "           -d '{\"model\":\"${VLLM_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}'"

#!/usr/bin/env bash
# ============================================================
# On-Prem Deployment Script for AgentMailbox Inference
#
# Deploys a vLLM-based inference server on your own GPU hardware.
# Supports multiple models and GPU configurations.
#
# Usage:
#   ./deploy-onprem.sh                     # Interactive setup
#   ./deploy-onprem.sh --model glm-5.2     # Direct deploy
#   ./deploy-onprem.sh --model qwen-7b     # Small model
#   ./deploy-onprem.sh --model deepseek-v3 # DeepSeek
#   ./deploy-onprem.sh --ollama            # Use Ollama instead
# ============================================================

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${GREEN}[AgentMailbox]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; }

# ── Model Presets ───────────────────────────────────────────

declare -A MODEL_REPO
MODEL_REPO[glm-4]="THUDM/glm-4-9b-chat"
MODEL_REPO[glm-5.2]="zai-org/GLM-5.2-FP8"
MODEL_REPO[qwen-7b]="Qwen/Qwen2.5-7B-Instruct"
MODEL_REPO[qwen-3b]="Qwen/Qwen2.5-3B-Instruct"
MODEL_REPO[qwen-72b]="Qwen/Qwen2.5-72B-Instruct-AWQ"
MODEL_REPO[deepseek-v3]="deepseek-ai/DeepSeek-V3"
MODEL_REPO[codestral]="mistralai/Codestral-22B-v0.1"

declare -A MODEL_GPU
MODEL_GPU[glm-4]="1xA10G"
MODEL_GPU[glm-5.2]="8xH200"
MODEL_GPU[qwen-7b]="1xT4"
MODEL_GPU[qwen-3b]="1xT4"
MODEL_GPU[qwen-72b]="2xA100"
MODEL_GPU[deepseek-v3]="8xH100"
MODEL_GPU[codestral]="1xA100"

declare -A MODEL_TP
MODEL_TP[glm-4]="1"
MODEL_TP[glm-5.2]="8"
MODEL_TP[qwen-7b]="1"
MODEL_TP[qwen-3b]="1"
MODEL_TP[qwen-72b]="2"
MODEL_TP[deepseek-v3]="8"
MODEL_TP[codestral]="1"

declare -A MODEL_MAXLEN
MODEL_MAXLEN[glm-4]="8192"
MODEL_MAXLEN[glm-5.2]="32768"
MODEL_MAXLEN[qwen-7b]="32768"
MODEL_MAXLEN[qwen-3b]="4096"
MODEL_MAXLEN[qwen-72b]="32768"
MODEL_MAXLEN[deepseek-v3]="32768"
MODEL_MAXLEN[codestral]="32768"

# ── Parse Args ──────────────────────────────────────────────

MODEL_KEY=""
USE_OLLAMA=false
PORT=8000
DOCKER=true
CUSTOM_MODEL=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --model) MODEL_KEY="$2"; shift 2 ;;
    --ollama) USE_OLLAMA=true; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --no-docker) DOCKER=false; shift ;;
    --custom-model) CUSTOM_MODEL="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --model KEY      Model preset: glm-5.2, qwen-7b, qwen-3b, qwen-72b, deepseek-v3, codestral"
      echo "  --ollama         Use Ollama instead of vLLM"
      echo "  --port PORT      Port to serve on (default: 8000)"
      echo "  --no-docker      Run vLLM directly (no Docker)"
      echo "  --custom-model   HuggingFace model ID (overrides preset)"
      echo ""
      echo "Examples:"
      echo "  $0 --model qwen-7b                     # Quick start on a single T4"
      echo "  $0 --model glm-5.2                     # Full GLM-5.2-FP8 on 8xH200"
      echo "  $0 --ollama --model qwen-7b             # Use Ollama backend"
      echo "  $0 --custom-model my-org/my-model --port 9000"
      exit 0
      ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Interactive Selection ───────────────────────────────────

if [[ -z "$MODEL_KEY" ]] && [[ -z "$CUSTOM_MODEL" ]]; then
  echo ""
  echo -e "${BLUE}╔═══════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║   AgentMailbox On-Prem Model Deployment              ║${NC}"
  echo -e "${BLUE}╚═══════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "Available models:"
  echo ""
  echo "  1) qwen-3b      — Qwen2.5-3B-Instruct     (1x T4,   free tier)"
  echo "  2) qwen-7b      — Qwen2.5-7B-Instruct     (1x T4,   dev/test)"
  echo "  3) codestral    — Codestral-22B            (1x A100, code-focused)"
  echo "  4) qwen-72b     — Qwen2.5-72B-AWQ          (2x A100, production)"
  echo "  5) deepseek-v3  — DeepSeek-V3 671B MoE     (8x H100, enterprise)"
  echo "  6) glm-5.2      — GLM-5.2-FP8 753B MoE     (8x H200, frontier)"
  echo ""
  read -p "Select model [1-6]: " choice
  case $choice in
    1) MODEL_KEY="qwen-3b" ;;
    2) MODEL_KEY="qwen-7b" ;;
    3) MODEL_KEY="codestral" ;;
    4) MODEL_KEY="qwen-72b" ;;
    5) MODEL_KEY="deepseek-v3" ;;
    6) MODEL_KEY="glm-5.2" ;;
    *) err "Invalid choice"; exit 1 ;;
  esac
fi

# ── Resolve Model ───────────────────────────────────────────

if [[ -n "$CUSTOM_MODEL" ]]; then
  HF_MODEL="$CUSTOM_MODEL"
  TP_SIZE="1"
  MAX_LEN="32768"
  log "Custom model: $HF_MODEL"
else
  HF_MODEL="${MODEL_REPO[$MODEL_KEY]}"
  TP_SIZE="${MODEL_TP[$MODEL_KEY]}"
  MAX_LEN="${MODEL_MAXLEN[$MODEL_KEY]}"
  log "Model:     $HF_MODEL"
  log "GPU:       ${MODEL_GPU[$MODEL_KEY]}"
  log "TP Size:   $TP_SIZE"
  log "Max Len:   $MAX_LEN"
fi

echo ""

# ── Ollama Path ─────────────────────────────────────────────

if $USE_OLLAMA; then
  log "Deploying via Ollama..."

  if ! command -v ollama &> /dev/null; then
    warn "Ollama not found. Installing..."
    curl -fsSL https://ollama.com/install.sh | sh
  fi

  OLLAMA_MODEL="${HF_MODEL##*/}"  # Extract model name from repo
  OLLAMA_MODEL=$(echo "$OLLAMA_MODEL" | tr '[:upper:]' '[:lower:]' | sed 's/-instruct//')

  log "Pulling model: $OLLAMA_MODEL"
  ollama pull "$OLLAMA_MODEL"

  log "Starting Ollama server on port $PORT..."
  OLLAMA_HOST="0.0.0.0:$PORT" ollama serve &
  OLLAMA_PID=$!

  sleep 3
  log "Ollama running (PID: $OLLAMA_PID)"
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  Set in your environment:${NC}"
  echo ""
  echo "  export OLLAMA_URL=http://localhost:$PORT"
  echo "  export AGENTSMCP_MODEL=$OLLAMA_MODEL"
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  wait $OLLAMA_PID
  exit 0
fi

# ── vLLM Docker Path ────────────────────────────────────────

if $DOCKER; then
  log "Deploying via vLLM Docker..."

  if ! command -v docker &> /dev/null; then
    err "Docker not found. Install Docker with NVIDIA GPU support first."
    err "See: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
    exit 1
  fi

  # Check NVIDIA GPU access
  if ! docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi &> /dev/null; then
    err "NVIDIA GPU not accessible via Docker."
    err "Install nvidia-container-toolkit: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/"
    exit 1
  fi

  CONTAINER_NAME="agentmailbox-vllm"

  # Stop existing container if running
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true

  log "Starting vLLM container..."
  docker run -d \
    --name "$CONTAINER_NAME" \
    --gpus all \
    --shm-size 16g \
    -p "$PORT":8000 \
    -e "HF_TOKEN=${HF_TOKEN:-}" \
    -e "VLLM_ALLOW_LONG_MAX_MODEL_LEN=1" \
    vllm/vllm-openai:latest \
    --model "$HF_MODEL" \
    --tensor-parallel-size "$TP_SIZE" \
    --max-model-len "$MAX_LEN" \
    --enable-prefix-caching \
    --gpu-memory-utilization 0.90 \
    --dtype auto \
    --trust-remote-code

  log "Waiting for vLLM to load model..."

  # Poll until healthy
  for i in $(seq 1 120); do
    if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
      echo ""
      log "✅ vLLM is ready!"
      echo ""
      echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
      echo -e "${GREEN}  Set in your environment:${NC}"
      echo ""
      echo "  export AGENTSMCP_VLLM_URL=http://localhost:$PORT"
      echo "  export AGENTSMCP_MODEL=$HF_MODEL"
      echo ""
      echo -e "${GREEN}  Test it:${NC}"
      echo ""
      echo "  curl http://localhost:$PORT/v1/chat/completions \\"
      echo "    -H 'Content-Type: application/json' \\"
      echo "    -d '{\"model\": \"$HF_MODEL\", \"messages\": [{\"role\": \"user\", \"content\": \"Hello\"}]}'"
      echo ""
      echo -e "${GREEN}  Logs:${NC}"
      echo ""
      echo "  docker logs -f $CONTAINER_NAME"
      echo ""
      echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
      exit 0
    fi
    sleep 5
    printf "."
  done

  err "vLLM failed to start in 10 minutes. Check logs:"
  err "  docker logs $CONTAINER_NAME"
  exit 1

else
  # ── vLLM Direct (no Docker) ─────────────────────────────

  log "Deploying vLLM directly (no Docker)..."

  if ! python3 -c "import vllm" 2>/dev/null; then
    err "vLLM not installed. Run: pip install vllm"
    exit 1
  fi

  log "Starting vLLM server..."
  python3 -m vllm.entrypoints.openai.api_server \
    --model "$HF_MODEL" \
    --tensor-parallel-size "$TP_SIZE" \
    --max-model-len "$MAX_LEN" \
    --enable-prefix-caching \
    --gpu-memory-utilization 0.90 \
    --port "$PORT" \
    --dtype auto \
    --trust-remote-code
fi

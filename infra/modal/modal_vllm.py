import modal
from pydantic import BaseModel
import os
from pathlib import Path

# ============================================================
# Dual-Mode Inference Engine
#
# MODE 1: Self-hosted GLM-5.2 FP8 on Modal H200s
#   - Prefix caching via vLLM
#   - Weights stored on a persistent Modal Volume
#
# MODE 2: DeepSeek-V3 API (Production MLA)
#   - Real Multi-Latent Attention (MLA)
#   - 93% KV cache compression via latent vectors c^KV
#   - 671B MoE (37B active), $0.27/M tokens
#   - Set DEEPSEEK_API_KEY env var to enable
#
# The system auto-selects: if DEEPSEEK_API_KEY is set → MLA mode.
# Otherwise → self-hosted Qwen on T4.
# ============================================================

app = modal.App("agentmailbox-inference")

# Self-hosted model (GLM-5.2 FP8 MoE on 8x H200/H100)
SELFHOSTED_MODEL = os.environ.get("AGENTSMCP_MODAL_MODEL", "zai-org/GLM-5.2-FP8")
MODEL_REVISION = os.environ.get("AGENTSMCP_MODAL_MODEL_REVISION") or None
MODEL_VOLUME_NAME = os.environ.get("AGENTSMCP_MODAL_MODEL_VOLUME", "agentmailbox-glm-5-2-weights")
MODEL_ROOT = Path("/models")
MODEL_DIR = MODEL_ROOT / SELFHOSTED_MODEL.replace("/", "--")
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "vllm==0.8.5.post1",
        "transformers>=4.45.0,<5.0.0",
        "torch",
        "fastapi[standard]",
        "pydantic",
        "openai",
    )
    .env({"HF_HOME": str(MODEL_ROOT / ".cache"), "HF_XET_HIGH_PERFORMANCE": "1"})
)

download_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("huggingface_hub[hf_xet]", "pydantic", "fastapi")
    .env({"HF_HOME": str(MODEL_ROOT / ".cache"), "HF_XET_HIGH_PERFORMANCE": "1"})
)


@app.function(
    image=download_image,
    volumes={str(MODEL_ROOT): model_volume},
    secrets=[modal.Secret.from_name("huggingface-secret")],
    timeout=24 * 60 * 60,
)
def download_model():
    """Download GLM weights directly into a persistent Modal Volume."""
    from huggingface_hub import snapshot_download

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=SELFHOSTED_MODEL,
        revision=MODEL_REVISION,
        local_dir=MODEL_DIR,
        max_workers=int(os.environ.get("AGENTSMCP_MODAL_DOWNLOAD_WORKERS", "8")),
    )
    model_volume.commit()
    return {"model": SELFHOSTED_MODEL, "path": str(MODEL_DIR), "volume": MODEL_VOLUME_NAME}


class GenerateRequest(BaseModel):
    prompt: str
    system_context: str = ""
    max_tokens: int = 2048
    temperature: float = 0.1
    return_logprobs: bool = False
    top_logprobs: int = 5
    force_mode: str = ""  # "selfhosted" or "mla" to override auto-select


class PrewarmRequest(BaseModel):
    program_name: str
    semantic_context: str


# ── Self-Hosted Engine (8x H200) ────────────────────────────

@app.cls(
    image=image,
    gpu="H200:8",
    scaledown_window=60,
    volumes={str(MODEL_ROOT): model_volume},
    timeout=30 * 60,
)
class SelfHostedEngine:
    @modal.enter()
    def setup(self):
        from vllm import LLM
        print(f"Loading {SELFHOSTED_MODEL} on 8x H200...")
        self.llm = LLM(
            model=str(MODEL_DIR),
            enable_prefix_caching=True,
            max_model_len=8192,
            tensor_parallel_size=8,
            gpu_memory_utilization=0.90,
            dtype="auto",
            trust_remote_code=True,
            enforce_eager=False,
        )
        print("✅ GLM-5.2 loaded. Prefix caching active.")

    @modal.method()
    def generate(self, prompt, system_context="", max_tokens=2048,
                 temperature=0.1, return_logprobs=False, top_logprobs=5):
        from vllm import SamplingParams
        messages = []
        if system_context:
            messages.append({"role": "system", "content": system_context})
        messages.append({"role": "user", "content": prompt})

        params = SamplingParams(
            max_tokens=max_tokens, temperature=temperature,
            logprobs=top_logprobs if return_logprobs else None,
        )
        output = self.llm.chat(messages, params)
        r = output[0]

        resp = {
            "text": r.outputs[0].text,
            "tokens_generated": len(r.outputs[0].token_ids),
            "prompt_tokens": len(r.prompt_token_ids),
            "prefix_cached": True,
            "mla_active": False,
            "mode": "selfhosted",
            "model": SELFHOSTED_MODEL,
        }
        if return_logprobs and r.outputs[0].logprobs:
            resp["logprobs"] = [
                {"token": str(tid), "logprob": list(lp.values())[0].logprob if isinstance(lp, dict) else -1.0}
                for tid, lp in zip(r.outputs[0].token_ids, r.outputs[0].logprobs)
            ]
        return resp

    @modal.method()
    def prewarm(self, program_name, semantic_context):
        from vllm import SamplingParams
        messages = [{"role": "system", "content": semantic_context}, {"role": "user", "content": "Acknowledge."}]
        output = self.llm.chat(messages, SamplingParams(max_tokens=5))
        return {
            "program": program_name,
            "context_tokens": len(output[0].prompt_token_ids),
            "prefix_cached": True, "mla_compressed": False, "mode": "selfhosted",
        }


# ── DeepSeek V3 MLA Engine (API) ───────────────────────────

def _call_deepseek(prompt, system_context="", max_tokens=2048,
                   temperature=0.1, return_logprobs=False, top_logprobs=5):
    from openai import OpenAI
    api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key:
        return {"text": "ERROR: DEEPSEEK_API_KEY not set", "tokens_generated": 0,
                "prompt_tokens": 0, "mla_active": True, "mode": "mla"}

    client = OpenAI(api_key=api_key, base_url="https://api.deepseek.com")
    messages = []
    if system_context:
        messages.append({"role": "system", "content": system_context})
    messages.append({"role": "user", "content": prompt})

    kwargs = {"model": "deepseek-chat", "messages": messages,
              "max_tokens": max_tokens, "temperature": temperature}
    if return_logprobs:
        kwargs["logprobs"] = True
        kwargs["top_logprobs"] = top_logprobs

    try:
        response = client.chat.completions.create(**kwargs)
    except Exception as e:
        err = str(e)
        if "402" in err or "Insufficient" in err:
            err = "Insufficient Balance. Top up at https://platform.deepseek.com/top_up"
        return {"text": f"ERROR: {err}", "tokens_generated": 0,
                "prompt_tokens": 0, "mla_active": True, "mode": "mla"}

    choice = response.choices[0]
    resp = {
        "text": choice.message.content or "",
        "tokens_generated": response.usage.completion_tokens if response.usage else 0,
        "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
        "mla_active": True,
        "mode": "mla",
        "model": "deepseek-ai/DeepSeek-V3 (671B MoE)",
    }
    if return_logprobs and choice.logprobs and choice.logprobs.content:
        resp["logprobs"] = [{"token": lp.token, "logprob": lp.logprob}
                            for lp in choice.logprobs.content]
    return resp


# ── FastAPI (auto-selects mode) ─────────────────────────────

from fastapi import FastAPI

web_app = FastAPI(
    title="AgentMailbox Inference — Dual Mode",
    description="Self-hosted (free) + DeepSeek-V3 MLA (production)",
    version="2.0.0",
)


def _has_deepseek_key():
    return bool(os.environ.get("DEEPSEEK_API_KEY"))


@web_app.post("/generate")
async def generate_endpoint(req: GenerateRequest):
    use_mla = (req.force_mode == "mla") or (_has_deepseek_key() and req.force_mode != "selfhosted")

    if use_mla:
        return _call_deepseek(
            prompt=req.prompt, system_context=req.system_context,
            max_tokens=req.max_tokens, temperature=req.temperature,
            return_logprobs=req.return_logprobs, top_logprobs=req.top_logprobs,
        )
    else:
        engine = SelfHostedEngine()
        return engine.generate.remote(
            prompt=req.prompt, system_context=req.system_context,
            max_tokens=req.max_tokens, temperature=req.temperature,
            return_logprobs=req.return_logprobs, top_logprobs=req.top_logprobs,
        )


@web_app.post("/prewarm")
async def prewarm_endpoint(req: PrewarmRequest):
    engine = SelfHostedEngine()
    return engine.prewarm.remote(
        program_name=req.program_name, semantic_context=req.semantic_context,
    )


@web_app.get("/health")
async def health():
    has_mla = _has_deepseek_key()
    return {
        "status": "ok",
        "active_mode": "mla" if has_mla else "selfhosted",
        "selfhosted": {
            "model": SELFHOSTED_MODEL,
            "gpu": "8x H200 (MoE FP8)",
            "prefix_caching": True,
            "cost": "Modal H200 usage",
        },
        "mla": {
            "model": "deepseek-ai/DeepSeek-V3 (671B MoE)",
            "attention": "Multi-Latent Attention (MLA)",
            "kv_compression": "93% via latent vectors c^KV",
            "enabled": has_mla,
            "cost": "$0.27/M input tokens",
        },
    }


@app.function(image=image)
@modal.asgi_app()
def fastapi_app():
    return web_app

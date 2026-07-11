/**
 * Model Provider — Unified interface for all inference backends.
 *
 * Supports 3 deployment modes:
 *
 *   1. MODAL ENDPOINT (Serverless)
 *      - GLM-5.2-FP8 via Modal managed endpoint
 *      - Zero infra management, pay-per-token
 *      - Set: AGENTSMCP_MODAL_ENDPOINT_URL
 *
 *   2. ON-PREM vLLM (Self-hosted)
 *      - Any model on your own GPU servers
 *      - vLLM, Ollama, or TGI behind OpenAI-compatible API
 *      - Set: AGENTSMCP_VLLM_URL
 *
 *   3. API PROVIDER (DeepSeek, OpenAI, etc.)
 *      - External API with key
 *      - Set: DEEPSEEK_API_KEY or OPENAI_API_KEY
 *
 * Auto-selection priority: Modal Endpoint > On-Prem vLLM > API Provider > None
 */

export interface ModelConfig {
  /** Active provider */
  provider: "modal" | "vllm" | "ollama" | "deepseek" | "openai" | "none";
  /** Base URL for the inference API */
  baseUrl: string;
  /** Model identifier */
  model: string;
  /** API key (if needed) */
  apiKey?: string;
  /** Whether this is an OpenAI-compatible endpoint */
  openaiCompatible: boolean;
}

export interface GenerateRequest {
  prompt: string;
  systemContext?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateResponse {
  text: string;
  tokensGenerated: number;
  promptTokens: number;
  model: string;
  provider: string;
  latencyMs: number;
}

import { defaultMetrics } from "../observability/metrics";

/**
 * Auto-detect the best available model provider from environment variables.
 */
export function detectModelConfig(): ModelConfig {
  // Priority 1: Modal managed endpoint (GLM-4-9B / GLM-5.2)
  const modalUrl = process.env.AGENTSMCP_MODAL_ENDPOINT_URL;
  if (modalUrl) {
    return {
      provider: "modal",
      baseUrl: modalUrl.replace(/\/+$/, ""),
      model: process.env.AGENTSMCP_MODEL || "zai-org/GLM-5.2-FP8",
      openaiCompatible: false,
    };
  }

  // Priority 2: Self-hosted vLLM on-prem
  const vllmUrl = process.env.AGENTSMCP_VLLM_URL;
  if (vllmUrl) {
    return {
      provider: "vllm",
      baseUrl: vllmUrl.replace(/\/+$/, ""),
      model: process.env.AGENTSMCP_MODEL || "zai-org/GLM-5.2-FP8",
      apiKey: process.env.AGENTSMCP_VLLM_API_KEY || process.env.VLLM_API_KEY,
      openaiCompatible: true,
    };
  }

  // Priority 3: Ollama (local)
  const ollamaUrl = process.env.OLLAMA_URL || process.env.OLLAMA_HOST;
  if (ollamaUrl) {
    return {
      provider: "ollama",
      baseUrl: ollamaUrl.replace(/\/+$/, ""),
      model: process.env.AGENTSMCP_MODEL || "qwen2.5:7b",
      openaiCompatible: true,
    };
  }

  // Priority 4: DeepSeek API
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (deepseekKey) {
    return {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      apiKey: deepseekKey,
      openaiCompatible: true,
    };
  }

  // Priority 5: OpenAI API
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      provider: "openai",
      baseUrl: "https://api.openai.com",
      model: process.env.AGENTSMCP_MODEL || "gpt-4o-mini",
      apiKey: openaiKey,
      openaiCompatible: true,
    };
  }

  // No provider — pure deterministic mode
  return {
    provider: "none",
    baseUrl: "",
    model: "none",
    openaiCompatible: false,
  };
}

/**
 * Unified generation call — works with any configured provider.
 */
export async function generate(
  req: GenerateRequest,
  config?: ModelConfig
): Promise<GenerateResponse> {
  const cfg = config || detectModelConfig();
  const startTime = Date.now();

  if (cfg.provider === "none") {
    throw new Error(
      "No model provider configured. Set one of: " +
      "AGENTSMCP_MODAL_ENDPOINT_URL, AGENTSMCP_VLLM_URL, OLLAMA_URL, " +
      "DEEPSEEK_API_KEY, or OPENAI_API_KEY"
    );
  }

  try {
    if (cfg.provider === "modal") {
      const result = await callModalGenerate(req, cfg, startTime);
      defaultMetrics.recordModelCall(result.latencyMs);
      return result;
    }

  // vLLM, Ollama, and external providers expose the OpenAI-compatible contract.
    if (cfg.openaiCompatible) {
      const result = await callOpenAICompatible(req, cfg, startTime);
      defaultMetrics.recordModelCall(result.latencyMs);
      return result;
    }

    throw new Error(`Unsupported provider: ${cfg.provider}`);
  } catch (error) {
    defaultMetrics.recordModelCall(Date.now() - startTime, true);
    throw error;
  }
}

async function callModalGenerate(
  req: GenerateRequest,
  cfg: ModelConfig,
  startTime: number,
): Promise<GenerateResponse> {
  const response = await fetch(`${cfg.baseUrl}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: req.prompt,
      system_context: req.systemContext ?? "",
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.1,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${cfg.provider} request failed (${response.status}): ${body}`);
  }

  const data = await response.json() as {
    text?: string;
    tokens_generated?: number;
    prompt_tokens?: number;
    model?: string;
  };
  return {
    text: data.text ?? "",
    tokensGenerated: data.tokens_generated ?? 0,
    promptTokens: data.prompt_tokens ?? 0,
    model: data.model ?? cfg.model,
    provider: cfg.provider,
    latencyMs: Date.now() - startTime,
  };
}

async function callOpenAICompatible(
  req: GenerateRequest,
  cfg: ModelConfig,
  startTime: number
): Promise<GenerateResponse> {
  const url = `${cfg.baseUrl}/v1/chat/completions`;

  const messages: Array<{ role: string; content: string }> = [];
  if (req.systemContext) {
    messages.push({ role: "system", content: req.systemContext });
  }
  messages.push({ role: "user", content: req.prompt });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) {
    headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.1,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${cfg.provider} request failed (${response.status}): ${body}`);
  }

  const data = await response.json() as any;
  const choice = data.choices?.[0];

  return {
    text: choice?.message?.content || "",
    tokensGenerated: data.usage?.completion_tokens || 0,
    promptTokens: data.usage?.prompt_tokens || 0,
    model: data.model || cfg.model,
    provider: cfg.provider,
    latencyMs: Date.now() - startTime,
  };
}

/**
 * Health check — verify the configured provider is reachable.
 */
export async function checkModelHealth(config?: ModelConfig): Promise<{
  provider: string;
  model: string;
  status: "ok" | "error" | "not_configured";
  latencyMs?: number;
  error?: string;
}> {
  const cfg = config || detectModelConfig();

  if (cfg.provider === "none") {
    return { provider: "none", model: "none", status: "not_configured" };
  }

  try {
    const start = Date.now();

    if (cfg.provider === "modal" || cfg.provider === "vllm") {
      // Try the /health endpoint first
      const healthUrl = `${cfg.baseUrl}/health`;
      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
      const resp = await fetch(healthUrl, { headers, signal: AbortSignal.timeout(5000) });
      return {
        provider: cfg.provider,
        model: cfg.model,
        status: resp.ok ? "ok" : "error",
        latencyMs: Date.now() - start,
      };
    }

    if (cfg.provider === "ollama") {
      const resp = await fetch(`${cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      return {
        provider: cfg.provider,
        model: cfg.model,
        status: resp.ok ? "ok" : "error",
        latencyMs: Date.now() - start,
      };
    }

    // API providers — try /v1/models
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
    const resp = await fetch(`${cfg.baseUrl}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    return {
      provider: cfg.provider,
      model: cfg.model,
      status: resp.ok ? "ok" : "error",
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      provider: cfg.provider,
      model: cfg.model,
      status: "error",
      error: String(err),
    };
  }
}

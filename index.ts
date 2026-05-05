/**
 * CrofAI Provider Extension
 *
 * Registers CrofAI (crof.ai) as a custom provider using the openai-completions API.
 * Base URL: https://beta.crof.ai/v1
 *
 * CrofAI proxies multiple model families (DeepSeek, GLM, Kimi, Qwen, MiniMax,
 * Gemma, Greg, MiMo) through an OpenAI-compatible API. The /v1/models endpoint does
 * NOT reliably report reasoning capability — many models that support thinking
 * are missing the `custom_reasoning` or `reasoning_effort` flags. The patch.json
 * file corrects these discrepancies based on E2E testing.
 *
 * Key API differences from native providers:
 *   - Uses `max_tokens` (NOT `max_completion_tokens`) — the latter is silently ignored
 *   - All reasoning models return `reasoning_content` in OpenAI format
 *   - Developer role is supported across all models
 *   - `reasoning_effort` parameter is accepted by all reasoning models
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background: live API /models → merge with embedded → cache → hot-swap
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json
 *
 * Usage:
 *   # Option 1: Store in auth.json (recommended)
 *   # Add to ~/.pi/agent/auth.json:
 *   #   "crofai": { "type": "api_key", "key": "your-api-key" }
 *
 *   # Option 2: Set as environment variable
 *   export CROFAI_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-crof-provider
 *
 * Then use /model to select from available models like Kimi K2.5, GLM 5.1,
 * DeepSeek V4 Pro, Qwen3.5, MiniMax M2.5, Gemma 4, and MiMo-V2.5-Pro.
 *
 * @see https://crof.ai/docs
 */

import type { ExtensionAPI, ModelRegistry } from "@mariozechner/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import fs from "fs";
import os from "os";
import path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    thinkingFormat?: "openai" | "zai" | "qwen" | "qwen-chat-template";
    supportsReasoningEffort?: boolean;
  };
}

interface PatchEntry {
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
}

type PatchData = Record<string, PatchEntry>;

// ─── Patch Application ────────────────────────────────────────────────────────

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
  const result = { ...model };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;

  if (patch.cost) {
    result.cost = {
      input: patch.cost.input ?? result.cost.input,
      output: patch.cost.output ?? result.cost.output,
      cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
      cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
    };
  }
  if (patch.compat) {
    result.compat = { ...(result.compat || {}), ...patch.compat };
  }

  if (!result.reasoning && result.compat?.thinkingFormat) {
    delete result.compat.thinkingFormat;
  }
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }

  return result;
}

/** Full pipeline: base models → patch → custom → result */
function buildModels(base: JsonModel[], custom: JsonModel[], patch: PatchData): JsonModel[] {
  const modelMap = new Map<string, JsonModel>();

  for (const model of base) {
    modelMap.set(model.id, model);
  }

  for (const [id, patchEntry] of Object.entries(patch)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }

  for (const model of custom) {
    const existing = modelMap.get(model.id);
    const patchEntry = patch[model.id];
    if (existing && patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else if (existing) {
      modelMap.set(model.id, model);
    } else if (patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else {
      modelMap.set(model.id, model);
    }
  }

  return Array.from(modelMap.values());
}

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────────

const PROVIDER_ID = "crofai";
const BASE_URL = "https://beta.crof.ai/v1";
const MODELS_URL = `${BASE_URL}/models`; // https://beta.crof.ai/v1/models
const CACHE_DIR = path.join(os.homedir(), ".pi", "agent", "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

/** Transform a model from the CrofAI /v1/models API. custom_reasoning is unreliable. */
function transformApiModel(apiModel: any): JsonModel | null {
  const pricing = apiModel.pricing || {};
  // CrofAI API returns prices as $/million tokens (e.g., "0.28"), parse directly
  const toPerM = (v: any) => Math.round((typeof v === "string" ? parseFloat(v) : (v || 0)) * 100) / 100;
  const name = (apiModel.name || apiModel.id).replace(/^[^:]+:\s*/, "");
  return {
    id: apiModel.id,
    name,
    reasoning: false, // CrofAI's custom_reasoning is unreliable, patch.json corrects
    input: ["text"],
    cost: {
      input: toPerM(pricing.prompt),
      output: toPerM(pricing.completion),
      cacheRead: toPerM(pricing.cache_prompt),
      cacheWrite: 0,
    },
    contextWindow: apiModel.context_length || 131072,
    maxTokens: apiModel.max_completion_tokens || 131072,
  };
}

async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<JsonModel[] | null> {
  try {
    const response = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const apiModels = Array.isArray(data) ? data : (data.data || []);
    if (!Array.isArray(apiModels) || apiModels.length === 0) return null;
    return apiModels.map(transformApiModel).filter((m): m is JsonModel => m !== null);
  } catch {
    return null;
  }
}

function loadCachedModels(): JsonModel[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function cacheModels(models: JsonModel[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2) + "\n");
  } catch {
    // Cache write failure is non-fatal
  }
}

function mergeWithEmbedded(liveModels: JsonModel[], embeddedModels: JsonModel[]): JsonModel[] {
  const embeddedIds = new Set(embeddedModels.map(m => m.id));
  const result = [...embeddedModels];
  for (const model of liveModels) {
    if (!embeddedIds.has(model.id)) {
      result.push(model);
    }
  }
  return result;
}

function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
  const cached = loadCachedModels();
  if (cached && cached.length > 0) return cached;
  return embeddedModels;
}

async function revalidateModels(apiKey: string | undefined, embeddedModels: JsonModel[], signal?: AbortSignal): Promise<JsonModel[] | null> {
  if (!apiKey) return null;
  const liveModels = await fetchLiveModels(apiKey, signal);
  if (!liveModels || liveModels.length === 0) return null;
  const merged = mergeWithEmbedded(liveModels, embeddedModels);
  cacheModels(merged);
  return merged;
}

// ─── API Key Resolution (via ModelRegistry) ────────────────────────────────────

let cachedApiKey: string | undefined;
let revalidateAbort: AbortController | null = null;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = await modelRegistry.getApiKeyForProvider("crofai") ?? undefined;
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const embeddedModels = modelsData as JsonModel[];
  const customModels = customModelsData as JsonModel[];
  const patches = patchData as PatchData;

  const staleBase = loadStaleModels(embeddedModels);
  const staleModels = buildModels(staleBase, customModels, patches);

  pi.registerProvider("crofai", {
    baseUrl: BASE_URL,
    apiKey: "CROFAI_API_KEY",
    api: "openai-completions",
    models: staleModels,
  });

  pi.on("session_start", async (_event, ctx) => {
    revalidateAbort?.abort();
    revalidateAbort = new AbortController();
    const signal = revalidateAbort.signal;
    await resolveApiKey(ctx.modelRegistry);
    revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
      if (freshBase && !signal.aborted) {
        pi.registerProvider("crofai", {
          baseUrl: BASE_URL,
          apiKey: "CROFAI_API_KEY",
          api: "openai-completions",
          models: buildModels(freshBase, customModels, patches),
        });
      }
    });
  });

  pi.on("session_shutdown", () => {
    revalidateAbort?.abort();
  });
}

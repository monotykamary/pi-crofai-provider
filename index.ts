/**
 * CrofAI Provider Extension
 *
 * Registers CrofAI (crof.ai) as a custom provider using the openai-completions API.
 * Base URL: https://crof.ai/v1
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

import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import fs from "fs";
import os from "os";
import path from "path";

// ─── Usage/Credits Types ──────────────────────────────────────────────────────

const USAGE_API_URL = "https://crof.ai/usage_api/";
const USAGE_FETCH_TIMEOUT_MS = 5000;

let sessionRequests: number | null = null;
let sessionCredits: number | null = null;
let sessionRequestCost: number | null = null;

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
  thinkingLevelMap?: Record<string, string | null>;
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
  thinkingLevelMap?: Record<string, string | null>;
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
  if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = { ...patch.thinkingLevelMap };

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
const BASE_URL = "https://crof.ai/v1";
const MODELS_URL = `${BASE_URL}/models`; // https://crof.ai/v1/models
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
  const embeddedMap = new Map(embeddedModels.map(m => [m.id, m]));
  const seen = new Set<string>();
  const result: JsonModel[] = [];
  for (const liveModel of liveModels) {
    const embedded = embeddedMap.get(liveModel.id);
    seen.add(liveModel.id);
    if (embedded) {
      result.push({
        ...liveModel,
        ...embedded,
        contextWindow: liveModel.contextWindow || embedded.contextWindow,
      });
    } else {
      result.push(liveModel);
    }
  }
  // Append any embedded models that the live API didn't return
  for (const em of embeddedModels) {
    if (!seen.has(em.id)) {
      result.push(em);
    }
  }
  return result;
}

function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
  const cached = loadCachedModels();
  if (!cached || cached.length === 0) return embeddedModels;

  // Merge embedded models that are missing from cache (newly added models)
  const cachedMap = new Map(cached.map(m => [m.id, m]));
  for (const em of embeddedModels) {
    if (!cachedMap.has(em.id)) {
      cached.push(em);
    }
  }
  return cached;
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

// ─── Usage/Credits Footer Status Bar ──────────────────────────────────────────

interface Usage {
  usable_requests: number | null;
  credits: number;
}

async function fetchUsage(apiKey: string | undefined, signal?: AbortSignal): Promise<Usage | null> {
  if (!apiKey) return null;
  try {
    const response = await fetch(USAGE_API_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS), signal])
        : AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (typeof data.credits !== "number") return null;
    return {
      usable_requests: data.usable_requests ?? null,
      credits: data.credits,
    };
  } catch {
    return null;
  }
}

function buildUsageStatusText(usage: Usage): string | undefined {
  const parts: string[] = [];
  if (usage.credits != null && usage.credits > 0) {
    parts.push(formatCredits(usage.credits));
  }
  if (usage.usable_requests != null) {
    parts.push(`⇄ ${usage.usable_requests}`);
  }
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

function formatCredits(credits: number): string {
  if (credits < 0.01) return `$${credits.toFixed(4)}`;
  if (credits < 1) return `$${credits.toFixed(4)}`;
  return `$${credits.toFixed(2)}`;
}

function updateUsageStatus(ctx: any): void {
  // Never show usage footer when not on a CrofAI model
  if (ctx.model?.provider !== "crofai") {
    ctx.ui.setStatus("crofai-usage", undefined);
    return;
  }
  if (sessionCredits == null && sessionRequests == null) {
    ctx.ui.setStatus("crofai-usage", undefined);
    return;
  }
  const text = buildUsageStatusText({
    credits: sessionCredits ?? 0,
    usable_requests: sessionRequests,
  });
  if (text) {
    ctx.ui.setStatus("crofai-usage", ctx.ui.theme.fg("dim", text));
  }
}

function clearUsageStatus(ctx: any): void {
  sessionCredits = null;
  sessionRequests = null;
  sessionRequestCost = null;
  ctx.ui.setStatus("crofai-usage", undefined);
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
    apiKey: "$CROFAI_API_KEY",
    api: "openai-completions",
    models: staleModels,
  });

  /**
   * Check whether the active model is from the CrofAI provider.
   * Returns true when ctx.model is available and has the matching provider.
   */
  function isCrofaiModel(ctx: any): boolean {
    return ctx.model?.provider === "crofai";
  }

  pi.on("session_start", async (_event, ctx) => {
    revalidateAbort?.abort();
    revalidateAbort = new AbortController();
    const signal = revalidateAbort.signal;
    resolveApiKey(ctx.modelRegistry).then(async () => {
      revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
        if (freshBase && !signal.aborted) {
          pi.registerProvider("crofai", {
            baseUrl: BASE_URL,
            apiKey: "$CROFAI_API_KEY",
            api: "openai-completions",
            models: buildModels(freshBase, customModels, patches),
          });
        }
      });

      if (!isCrofaiModel(ctx)) {
        clearUsageStatus(ctx);
        return;
      }

      const usage = await fetchUsage(cachedApiKey, signal);
      if (usage && !signal.aborted) {
        sessionCredits = usage.credits;
        sessionRequests = usage.usable_requests;
        updateUsageStatus(ctx);
      }
    });
  });

  pi.on("model_select", async (event, ctx) => {
    if (event.model?.provider === "crofai") {
      // Reset cost cache — will be re-measured on first turn_end
      sessionRequestCost = null;
      // Fetch and show usage when switching to a CrofAI model
      const usage = await fetchUsage(cachedApiKey);
      if (usage) {
        sessionCredits = usage.credits;
        sessionRequests = usage.usable_requests;
      }
      updateUsageStatus(ctx);
    } else {
      // Clear when switching away
      sessionRequestCost = null;
      clearUsageStatus(ctx);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (sessionRequests != null) {
      if (sessionRequestCost == null) {
        // First turn after model selection — fetch actual usage to measure cost
        const usage = await fetchUsage(cachedApiKey);
        if (usage && usage.usable_requests != null) {
          sessionRequestCost = Math.max(1, sessionRequests - usage.usable_requests);
          sessionRequests = usage.usable_requests;
        } else {
          sessionRequestCost = 1;
          sessionRequests = Math.max(0, sessionRequests - 1);
        }
      } else {
        // Subsequent turns — use cached cost
        sessionRequests = Math.max(0, sessionRequests - sessionRequestCost);
      }
    }
    updateUsageStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const usage = await fetchUsage(cachedApiKey);
    if (usage) {
      sessionCredits = usage.credits;
      sessionRequests = usage.usable_requests;
    }
    updateUsageStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    updateUsageStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    revalidateAbort?.abort();
  });
}

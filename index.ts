/**
 * CrofAI Provider Extension
 *
 * Registers CrofAI (crof.ai) as a custom provider using the openai-completions API.
 * Base URL: https://crof.ai/v1
 *
 * CrofAI proxies multiple model families (DeepSeek, GLM, Kimi, Qwen, MiniMax,
 * Gemma, Greg) through an OpenAI-compatible API. The /v1/models endpoint does
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
 * DeepSeek V4 Pro, Qwen3.5, MiniMax M2.5, and Gemma 4.
 *
 * CrofAI Features:
 *   - OpenAI-compatible API (https://crof.ai/v1)
 *   - Reasoning/thinking models with reasoning_effort parameter
 *   - Vision models (Kimi K2.5, Gemma 4 31B)
 *   - Tool use support
 *   - Streaming support
 *   - Free tier available for some models
 *
 * @see https://crof.ai/docs
 */

import type { ExtensionAPI, ModelRegistry } from "@mariozechner/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };

// Model data structure from models.json
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

// Patch override structure (keyed by model ID, sparse)
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

// Apply patch overrides on top of models.json data
function applyPatch(models: JsonModel[], patch: PatchData): JsonModel[] {
  return models.map((model) => {
    const overrides = patch[model.id];
    if (!overrides) return model;

    // Deep merge compat, shallow merge everything else
    const merged = { ...model };
    if (overrides.compat && merged.compat) {
      merged.compat = { ...merged.compat, ...overrides.compat };
      delete overrides.compat;
    }
    if (overrides.compat) {
      merged.compat = { ...(merged.compat || {}), ...overrides.compat };
      delete overrides.compat;
    }
    if (overrides.cost) {
      merged.cost = { ...merged.cost, ...overrides.cost };
      delete overrides.cost;
    }
    Object.assign(merged, overrides);

    // Remove thinkingFormat from non-reasoning models
    if (!merged.reasoning && merged.compat?.thinkingFormat) {
      delete merged.compat.thinkingFormat;
    }
    // Remove empty compat leftover
    if (merged.compat && Object.keys(merged.compat).length === 0) {
      delete merged.compat;
    }

    return merged;
  });
}

const models = applyPatch(
  modelsData as JsonModel[],
  patchData as PatchData
);

// ─── API Key Resolution (via ModelRegistry) ────────────────────────────────────

/**
 * Cached API key resolved from ModelRegistry.
 *
 * Pi's core resolves the key via ModelRegistry before making requests,
 * but we also cache it here so we can resolve it in contexts where the resolved
 * key isn't directly available (e.g. future features like quota fetching) and
 * to make the dependency explicit.
 *
 * Resolution order (via ModelRegistry.getApiKeyForProvider):
 *   1. Runtime override (CLI --api-key)
 *   2. auth.json stored credentials (manual entry in ~/.pi/agent/auth.json)
 *   3. OAuth tokens (auto-refreshed)
 *   4. Environment variable (from auth.json or provider config)
 */
let cachedApiKey: string | undefined;

/**
 * Resolve the CrofAI API key via ModelRegistry and cache the result.
 * Called on session_start and whenever ctx.modelRegistry is available.
 */
async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = await modelRegistry.getApiKeyForProvider("crofai") ?? undefined;
}

export default function (pi: ExtensionAPI) {
  // Resolve API key via ModelRegistry on session start
  pi.on("session_start", async (_event, ctx) => {
    await resolveApiKey(ctx.modelRegistry);
  });

  pi.registerProvider("crofai", {
    baseUrl: "https://crof.ai/v1",
    apiKey: "CROFAI_API_KEY",
    api: "openai-completions",
    models,
  });
}

/**
 * CrofAI Provider Extension
 *
 * Registers CrofAI (crof.ai) as a custom provider using the openai-completions API.
 * Base URL: https://crof.ai/v1
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
 * DeepSeek V3.2, Qwen3.5, MiniMax M2.5, and Gemma 4.
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

import type { AuthStorage, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import models from "./models.json" with { type: "json" };

// Pi's expected model structure
interface PiModel {
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
}

// Transform JSON model to Pi's expected format
// CrofAI pricing is in $/token, pi expects $/million tokens
function transformModel(model: CrofModel): PiModel {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

// CrofAI model data structure from JSON
interface CrofModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;      // $ per million input tokens
    output: number;     // $ per million output tokens
    cacheRead: number;  // $ per million cached tokens
    cacheWrite: number; // $ per million cache write tokens
  };
  contextWindow: number;
  maxTokens: number;
}

const piModels = (models as CrofModel[]).map(transformModel);

// ─── API Key Resolution (via AuthStorage) ────────────────────────────────────

/**
 * Cached API key resolved from AuthStorage.
 *
 * Pi's core resolves the key via AuthStorage.getApiKey() before making requests,
 * but we also cache it here so we can resolve it in contexts where the resolved
 * key isn't directly available (e.g. future features like quota fetching) and
 * to make the AuthStorage dependency explicit.
 *
 * Resolution order (via AuthStorage.getApiKey):
 *   1. Runtime override (CLI --api-key)
 *   2. auth.json stored credentials (manual entry in ~/.pi/agent/auth.json)
 *   3. OAuth tokens (auto-refreshed)
 *   4. Environment variable (CROFAI_API_KEY)
 *   5. Fallback resolver
 */
let cachedApiKey: string | undefined;

/**
 * Resolve the CrofAI API key via AuthStorage and cache the result.
 * Called on session_start and whenever ctx.modelRegistry.authStorage is available.
 */
async function resolveApiKey(authStorage: AuthStorage): Promise<void> {
  const key = await authStorage.getApiKey("crofai");
  cachedApiKey = key ?? process.env.CROFAI_API_KEY;
}

export default function (pi: ExtensionAPI) {
  // Resolve API key via AuthStorage on session start
  pi.on("session_start", async (_event, ctx) => {
    await resolveApiKey(ctx.modelRegistry.authStorage);
  });

  pi.registerProvider("crofai", {
    baseUrl: "https://crof.ai/v1",
    apiKey: "CROFAI_API_KEY",
    api: "openai-completions",
    models: piModels,
  });
}

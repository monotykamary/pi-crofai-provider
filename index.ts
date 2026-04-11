/**
 * CrofAI Provider Extension
 *
 * Registers CrofAI (crof.ai) as a custom provider using the openai-completions API.
 * Base URL: https://crof.ai/v1
 *
 * Usage:
 *   # Set your API key
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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

export default function (pi: ExtensionAPI) {
  pi.registerProvider("crofai", {
    baseUrl: "https://crof.ai/v1",
    apiKey: "CROFAI_API_KEY",
    api: "openai-completions",
    models: piModels,
  });
}

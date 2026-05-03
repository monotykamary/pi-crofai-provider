# pi-crof-provider

A [pi](https://github.com/badlogic/pi-mono) extension that adds [CrofAI](https://crof.ai) as a custom model provider.

## Features

- **OpenAI-compatible API** - Uses CrofAI's `/v1/chat/completions` endpoint
- **Reasoning models** - Support for thinking models with `reasoning_effort` parameter
- **Vision models** - Image input support on Kimi K2.5, Kimi K2.6, GLM 5.1 (Precision), and Qwen 3.5 / 3.6
- **Tool use** - Function calling support
- **Streaming** - Real-time token streaming
- **Free tier** - Some models available at no cost (GLM 4.7 Flash, Qwen3.5 9B)

## Available Models

| Model | Context | Vision | Reasoning | Input $/M | Output $/M |
|-------|---------|--------|-----------|-----------|------------|
| DeepSeek V3.2 | 164K | ❌ | ✅ | $0.28 | $0.38 |
| DeepSeek V4 Flash | 1.0M | ❌ | ✅ | $0.12 | $0.21 |
| DeepSeek V4 Pro | 1.0M | ❌ | ✅ | $0.40 | $0.85 |
| DeepSeek V4 Pro (Precision) | 1.0M | ❌ | ✅ | $1.25 | $2.50 |
| Gemma 4 31B IT | 262K | ❌ | ✅ | $0.10 | $0.30 |
| GLM 4.7 | 203K | ❌ | ✅ | $0.25 | $1.10 |
| GLM 4.7 Flash | 203K | ❌ | ✅ | **Free** | **Free** |
| GLM 5 | 203K | ❌ | ✅ | $0.48 | $1.90 |
| GLM 5.1 | 203K | ❌ | ✅ | $0.45 | $2.10 |
| GLM 5.1 (Precision) | 203K | ✅ | ✅ | $0.75 | $2.90 |
| Greg | 200K | ❌ | ❌ | $0.30 | $0.30 |
| Kimi K2.5 | 262K | ✅ | ✅ | $0.35 | $1.70 |
| Kimi K2.5 (Lightning) | 131K | ✅ | ✅ | $1.00 | $3.00 |
| Kimi K2.6 | 262K | ✅ | ✅ | $0.50 | $1.99 |
| Kimi K2.6 (Precision) | 262K | ✅ | ✅ | $0.55 | $2.70 |
| MiniMax M2.5 | 205K | ❌ | ✅ | $0.11 | $0.95 |
| Qwen3.5 397B A17B | 262K | ✅ | ✅ | $0.35 | $1.75 |
| Qwen3.5 9B | 262K | ✅ | ✅ | **Free** | **Free** |
| Qwen3.5 9B (Chat) | 262K | ✅ | ✅ | $0.04 | $0.15 |
| Qwen3.6 27B | 262K | ✅ | ✅ | $0.20 | $1.50 |

## Installation

### Option 1: Using `pi install` (Recommended)

Install directly from GitHub:

```bash
pi install git:github.com/monotykamary/pi-crofai-provider
```

Then set your API key and run pi:
```bash
# Recommended: add to auth.json
# See Authentication section below

# Or set as environment variable
export CROFAI_API_KEY=your-api-key-here

pi
```

Get your API key from [crof.ai](https://crof.ai).

### Option 2: Manual Clone

1. Clone this repository:
   ```bash
   git clone https://github.com/monotykamary/pi-crofai-provider.git
   cd pi-crofai-provider
   ```

2. Set your CrofAI API key:
   ```bash
   # Recommended: add to auth.json
   # See Authentication section below

   # Or set as environment variable
   export CROFAI_API_KEY=your-api-key-here
   ```

3. Run pi with the extension:
   ```bash
   pi -e /path/to/pi-crofai-provider
   ```

## Authentication

The CrofAI API key can be configured in multiple ways (resolved in this order):

1. **`auth.json`** (recommended) — Add to `~/.pi/agent/auth.json`:
   ```json
   { "crofai": { "type": "api_key", "key": "your-api-key" } }
   ```
   The `key` field supports literal values, env var names, and shell commands (prefix with `!`). See [pi's auth file docs](https://github.com/badlogic/pi-mono) for details.
2. **Runtime override** — Use the `--api-key` CLI flag
3. **Environment variable** — Set `CROFAI_API_KEY`

Get your API key from [crof.ai](https://crof.ai).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CROFAI_API_KEY` | No | Your CrofAI API key (fallback if not in auth.json) |

## Configuration

Add to your pi configuration for automatic loading:

```json
{
  "extensions": [
    "/path/to/pi-crofai-provider"
  ]
}
```

## Usage

Once loaded, select a model with:

```
/model crofai kimi-k2.5
```

Or use `/models` to browse all available CrofAI models.

### Reasoning Effort

For reasoning models, control thinking depth:

```
/reasoning high
```

Values: `none`, `low`, `medium`, `high`

## API Compatibility

The CrofAI proxy differs from native provider APIs in several ways. These are handled via `patch.json`:

| Aspect | Native APIs | CrofAI |
|--------|------------|--------|
| Max tokens field | `max_completion_tokens` | `max_tokens` |
| Thinking format | Varies (openai, zai, qwen-chat-template) | `openai` (always `reasoning_content`) |
| Developer role | Varies per model | ✅ Supported on all models |
| Reasoning effort | Varies per model | Accepted by all reasoning models |
| `store` parameter | Varies | ❌ Not supported |

> **Note:** The CrofAI `/v1/models` endpoint does **not** reliably report reasoning capability.
> Many models that support thinking are missing the `custom_reasoning` or `reasoning_effort`
> flags. `patch.json` corrects these based on E2E testing.

## API Documentation

- CrofAI Docs: https://crof.ai/docs
- OpenAI-compatible endpoint: `https://crof.ai/v1`
- Models endpoint: `https://crof.ai/v1/models`
- Usage endpoint: `https://crof.ai/usage_api/`

## License

MIT

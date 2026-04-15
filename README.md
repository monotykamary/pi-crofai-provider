# pi-crof-provider

A [pi](https://github.com/badlogic/pi) extension that adds [CrofAI](https://crof.ai) as a custom model provider.

## Features

- **OpenAI-compatible API** - Uses CrofAI's `/v1/chat/completions` endpoint
- **Reasoning models** - Support for thinking models with `reasoning_effort` parameter
- **Vision models** - Image input support on Kimi K2.5 and Gemma 4 31B
- **Tool use** - Function calling support
- **Streaming** - Real-time token streaming
- **Free tier** - Some models available at no cost (GLM 4.7 Flash, Qwen3.5 9B)

## Available Models

| Model | Context | Vision | Reasoning | Input $/M | Output $/M |
|-------|---------|--------|-----------|-----------|------------|
| DeepSeek V3.2 | 164K | ❌ | ❌ | $0.28 | $0.38 |
| Gemma 4 31B IT | 262K | ✅ | ✅ | $0.10 | $0.30 |
| GLM 4.7 | 203K | ❌ | ❌ | $0.25 | $1.10 |
| GLM 5 | 203K | ❌ | ❌ | $0.48 | $1.90 |
| GLM 5.1 | 203K | ❌ | ❌ | $0.50 | $2.10 |
| GLM 5.1 (Precision) | 203K | ❌ | ❌ | $0.70 | $2.50 |
| Kimi K2.5 | 262K | ✅ | ✅ | $0.35 | $1.70 |
| Kimi K2.5 (Lightning) | 131K | ❌ | ✅ | $1.00 | $3.00 |
| MiniMax M2.5 | 205K | ❌ | ❌ | $0.11 | $0.95 |
| Qwen3.5 397B A17B | 262K | ❌ | ✅ | $0.35 | $1.75 |
| GLM 4.7 Flash | 203K | ❌ | ❌ | **Free** | **Free** |
| Qwen3.5 9B | 262K | ❌ | ✅ | **Free** | **Free** |

## Installation

### Option 1: Using `pi install` (Recommended)

Install directly from GitHub:

```bash
pi install git:github.com/monotykamary/pi-crofai-provider
```

Then set your API key and run pi:
```bash
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
   export CROFAI_API_KEY=your-api-key-here
   ```

3. Run pi with the extension:
   ```bash
   pi -e /path/to/pi-crofai-provider
   ```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CROFAI_API_KEY` | Yes | Your CrofAI API key from [crof.ai](https://crof.ai) |

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

## API Documentation

- CrofAI Docs: https://crof.ai/docs
- OpenAI-compatible endpoint: `https://crof.ai/v1`
- Models endpoint: `https://crof.ai/v1/models`
- Usage endpoint: `https://crof.ai/usage_api/`

## License

MIT

/**
 * Test image support for each CrofAI model by sending a tiny base64 image
 * via the /v1/chat/completions endpoint. Success (2xx + content) = supports images.
 * 500/internal_error for image payloads but text-only works = no image support.
 *
 * Run with: bun run scripts/test-image-support.ts
 * Requires CROFAI_API_KEY env var.
 */

// Tiny 1x1 red PNG (base64)
const tinyImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const BASE_URL = "https://crof.ai/v1";
const API_KEY = process.env.CROFAI_API_KEY;

if (!API_KEY) {
  console.error("CROFAI_API_KEY env var is required");
  process.exit(1);
}

const models = [
  { id: "deepseek-v3.2", name: "DeepSeek V3.2" },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  { id: "deepseek-v4-pro-precision", name: "DeepSeek V4 Pro (Precision)" },
  { id: "gemma-4-31b-it", name: "Gemma 4 31B IT" },
  { id: "glm-4.7", name: "GLM 4.7" },
  { id: "glm-5", name: "GLM 5" },
  { id: "glm-5.1", name: "GLM 5.1" },
  { id: "glm-5.1-precision", name: "GLM 5.1 (Precision)" },
  { id: "greg", name: "Greg" },
  { id: "kimi-k2.5", name: "Kimi K2.5" },
  { id: "kimi-k2.5-lightning", name: "Kimi K2.5 (Lightning)" },
  { id: "kimi-k2.6", name: "Kimi K2.6" },
  { id: "kimi-k2.6-precision", name: "Kimi K2.6 (Precision)" },
  { id: "minimax-m2.5", name: "MiniMax M2.5" },
  { id: "qwen3.5-397b-a17b", name: "Qwen3.5 397B A17B" },
  { id: "qwen3.5-9b-chat", name: "Qwen3.5 9B (Chat)" },
  { id: "qwen3.6-27b", name: "Qwen3.6 27B" },
  { id: "glm-4.7-flash", name: "GLM 4.7 Flash" },
  { id: "qwen3.5-9b", name: "Qwen3.5 9B" },
];

interface TestResult {
  id: string;
  name: string;
  supportsImage: boolean;
  response?: string;
  error?: string;
}

async function testModel(model: (typeof models)[number]): Promise<TestResult> {
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: model.id,
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:image/png;base64,${tinyImage}` } },
              { type: "text", text: "What color is this?" },
            ],
          },
        ],
      }),
    });

    const body = await response.text();

    if (response.ok) {
      try {
        const json = JSON.parse(body);
        const content = json.choices?.[0]?.message?.content;
        const reasoningContent = json.choices?.[0]?.message?.reasoning_content;
        const hasContent = content || reasoningContent;
        return {
          id: model.id,
          name: model.name,
          supportsImage: true,
          response: hasContent || json.choices?.[0]?.finish_reason || "(empty)",
        };
      } catch {
        return { id: model.id, name: model.name, supportsImage: true, response: body.slice(0, 200) };
      }
    } else {
      const lower = body.toLowerCase();
      if (lower.includes("image") || lower.includes("vision") || lower.includes("multimodal") || lower.includes("media")) {
        return { id: model.id, name: model.name, supportsImage: false, error: `${response.status}: Image not supported` };
      }
      if (lower.includes("billing") || lower.includes("paid") || lower.includes("payment") || lower.includes("insufficient funds")) {
        return { id: model.id, name: model.name, supportsImage: false, error: `${response.status}: Billing/Payment required` };
      }
      return { id: model.id, name: model.name, supportsImage: false, error: `${response.status}: ${body.slice(0, 200)}` };
    }
  } catch (err: any) {
    return { id: model.id, name: model.name, supportsImage: false, error: err.message };
  }
}

async function main() {
  console.log(`Testing ${models.length} models for image support...\n`);

  const results: TestResult[] = [];
  for (const model of models) {
    process.stdout.write(`  Testing ${model.name.padEnd(30)} ... `);
    const result = await testModel(model);
    results.push(result);
    if (result.supportsImage) {
      console.log("✅ Supports images");
    } else {
      console.log(`❌ Does NOT support images  (${result.error})`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("\n--- SUMMARY ---\n");
  const withImages = results.filter((r) => r.supportsImage);
  const withoutImages = results.filter((r) => !r.supportsImage);

  console.log(`Models WITH image support (${withImages.length}):`);
  for (const r of withImages) console.log(`  ✅ ${r.name}`);

  console.log(`\nModels WITHOUT image support (${withoutImages.length}):`);
  for (const r of withoutImages) console.log(`  ❌ ${r.name}`);
}

main().catch(console.error);

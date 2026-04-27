#!/usr/bin/env node
/**
 * Update CrofAI models from API
 *
 * Fetches models from https://crof.ai/v1/models and updates:
 * - models.json: Pure API model definitions (no patches baked in)
 * - README.md: Model table with patch.json overrides applied
 *
 * models.json reflects the raw API data as-is. The CrofAI /v1/models API
 * does NOT reliably report reasoning capability — many models that support
 * thinking are missing the `custom_reasoning` or `reasoning_effort` flags.
 * patch.json corrects these discrepancies at runtime (index.ts) and is also
 * applied when generating the README table so the docs reflect reality.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODELS_API_URL = 'https://crof.ai/v1/models';
const MODELS_JSON_PATH = path.join(__dirname, '..', 'models.json');
const PATCH_JSON_PATH = path.join(__dirname, '..', 'patch.json');
const README_PATH = path.join(__dirname, '..', 'README.md');

// Models known to support vision (image input) - exact IDs only
// CrofAI API doesn't report vision capability, so this is maintained manually.
// NOTE: Kimi K2.6 does NOT support vision on CrofAI (returns 500 with image input)
const VISION_MODEL_IDS = [
  'kimi-k2.5', // base model has vision (verified E2E)
  'gemma-4-31b-it', // vision capable (verified E2E)
];

// Models that explicitly do NOT have vision despite similar names
const NO_VISION_MODEL_IDS = [
  'kimi-k2.5-lightning', // lightning variant is text-only
  'kimi-k2.6',           // no vision on CrofAI (500 error with image input)
  'kimi-k2.6-precision', // same family as kimi-k2.6
];

/**
 * Check if a model ID indicates vision capability
 */
function isVisionModel(modelId) {
  const lowerId = modelId.toLowerCase();
  // Explicit exclusions first
  if (NO_VISION_MODEL_IDS.some(id => lowerId === id.toLowerCase())) {
    return false;
  }
  // Exact ID matches for vision support
  return VISION_MODEL_IDS.some(id => lowerId === id.toLowerCase());
}

/**
 * Convert API pricing ($/token) to $/million tokens
 */
function convertPricing(apiPrice) {
  if (!apiPrice) return 0;
  // API returns as string like "0.00000038"
  const pricePerToken = parseFloat(apiPrice);
  // Round to avoid floating point precision issues (e.g., 0.09999999999999999)
  return Math.round(pricePerToken * 1000000 * 100) / 100;
}

/**
 * Apply patch.json overrides on top of transformed models.
 * Deep merges compat, shallow merges everything else.
 */
function applyPatch(models, patch) {
  return models.map(model => {
    const overrides = patch[model.id];
    if (!overrides) return model;

    const merged = { ...model };

    // Deep merge compat
    if (overrides.compat) {
      merged.compat = { ...(merged.compat || {}), ...overrides.compat };
      delete overrides.compat;
    }

    // Deep merge cost
    if (overrides.cost) {
      merged.cost = { ...merged.cost, ...overrides.cost };
      delete overrides.cost;
    }

    // Shallow merge remaining fields (reasoning, input, name, etc.)
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

/**
 * Transform API model to local format
 */
function transformModel(apiModel) {
  const modelId = apiModel.id;
  // Use API reasoning flags if available, fall back to name detection
  // NOTE: The CrofAI API does NOT reliably report reasoning. Many models
  // that support thinking are missing custom_reasoning or reasoning_effort
  // flags. patch.json corrects these at runtime.
  const hasReasoning = apiModel.reasoning_effort === true || apiModel.custom_reasoning === true;
  const hasVision = isVisionModel(modelId);

  // Determine input types
  const inputTypes = ['text'];
  if (hasVision) {
    inputTypes.push('image');
  }

  // Use API name as-is, preserving the original name
  let displayName = apiModel.name.replace(/^[^:]+:\s*/, '');

  // Deduplicate names: if multiple models have same name, append ID variant
  // e.g., "Kimi K2.5" and "Kimi K2.5 Lightning" when API returns same base name
  if (modelId.includes('-') && !displayName.toLowerCase().includes(modelId.split('-').pop().toLowerCase())) {
    const variant = modelId.split('-').pop();
    // Only append if variant adds meaningful distinction (not just version numbers)
    if (!/^v?\d+\.?\d*$/.test(variant)) {
      // Common acronyms that should be uppercase
      const acronyms = { 'it': 'IT', 'fp8': 'FP8', 'awq': 'AWQ', 'gptq': 'GPTQ' };
      const formattedVariant = acronyms[variant.toLowerCase()] ||
        (variant.charAt(0).toUpperCase() + variant.slice(1).toLowerCase());
      displayName = `${displayName} ${formattedVariant}`;
    }
  }

  // Check if model is free (both input and output are 0)
  const inputCost = convertPricing(apiModel.pricing?.prompt);
  const outputCost = convertPricing(apiModel.pricing?.completion);
  const cacheReadCost = convertPricing(apiModel.pricing?.cache_prompt);
  const isFree = inputCost === 0 && outputCost === 0;

  return {
    id: modelId,
    name: displayName,
    reasoning: hasReasoning,
    input: inputTypes,
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead: cacheReadCost,
      cacheWrite: 0, // Not provided by API
    },
    contextWindow: apiModel.context_length || apiModel.max_completion_tokens || 0,
    maxTokens: apiModel.max_completion_tokens || apiModel.context_length || 0,
    // Metadata for README generation
    _meta: {
      isFree,
      quantization: apiModel.quantization,
      speed: apiModel.speed,
    },
  };
}

/**
 * Format cost for display (show "Free" for free models)
 */
function formatCost(cost, isFree) {
  if (isFree) return '**Free**';
  return `$${cost.toFixed(2)}`;
}

/**
 * Format context window (e.g., 262144 -> "262K")
 */
function formatContextWindow(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return n.toString();
}

/**
 * Generate README model table
 */
function generateReadmeTable(models) {
  const lines = [
    '| Model | Context | Vision | Reasoning | Input $/M | Output $/M |',
    '|-------|---------|--------|-----------|-----------|------------|',
  ];

  for (const model of models) {
    const name = model.name.replace(/^CrofAI:\s*/, '');
    const context = formatContextWindow(model.contextWindow);
    const vision = model.input.includes('image') ? '✅' : '❌';
    const reasoning = model.reasoning ? '✅' : '❌';
    const inputCost = formatCost(model.cost.input, model._meta.isFree);
    const outputCost = formatCost(model.cost.output, model._meta.isFree);

    lines.push(`| ${name} | ${context} | ${vision} | ${reasoning} | ${inputCost} | ${outputCost} |`);
  }

  return lines.join('\n');
}

/**
 * Update the README.md with new model table
 */
function updateReadme(models) {
  let readme = fs.readFileSync(README_PATH, 'utf8');
  const newTable = generateReadmeTable(models);

  // Find and replace the model table within the Available Models section
  // Match the table header row and all subsequent table rows (lines starting with |)
  // Also capture trailing newlines to preserve spacing
  const tableRegex = /(## Available Models\n\n)\| Model \| Context \| Vision \| Reasoning \| Input \$\/M \| Output \$\/M \|\n\|[-| ]+\|(\n\|[^\n]+\|)*\n*/;

  if (tableRegex.test(readme)) {
    // Use a replacer function to avoid $ being interpreted as regex group reference
    // Add single blank line after table (standard markdown spacing before next heading)
    readme = readme.replace(tableRegex, (match, header) => `${header}${newTable}\n\n`);
    fs.writeFileSync(README_PATH, readme);
    console.log('✓ Updated README.md');
  } else {
    console.warn('⚠ Could not find model table in "## Available Models" section');
  }
}

/**
 * Clean model data for JSON output (remove _meta fields)
 */
function cleanModelForJson(model) {
  const { _meta, ...cleanModel } = model;
  return cleanModel;
}

/**
 * Main function
 */
async function main() {
  console.log(`Fetching models from ${MODELS_API_URL}...`);

  try {
    const response = await fetch(MODELS_API_URL);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const apiResponse = await response.json();
    const apiModels = apiResponse.data || apiResponse; // Handle both {data: [...]} and direct array

    if (!Array.isArray(apiModels)) {
      throw new Error('API response does not contain an array of models');
    }

    console.log(`✓ Fetched ${apiModels.length} models from API`);

    // Load existing models for comparison
    let existingModels = [];
    try {
      existingModels = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf8'));
    } catch (e) {
      // File might not exist or be invalid
    }

    // Transform models from API (pure API data, no patches)
    let apiTransformed = apiModels.map(transformModel);

    // Sort models: non-free first (by input cost), then free models alphabetically
    apiTransformed.sort((a, b) => {
      const aFree = a._meta.isFree;
      const bFree = b._meta.isFree;
      if (aFree && !bFree) return 1;
      if (!aFree && bFree) return -1;
      return a.id.localeCompare(b.id);
    });

    // Update models.json — pure API data, no patches baked in
    const cleanModels = apiTransformed.map(cleanModelForJson);
    fs.writeFileSync(MODELS_JSON_PATH, JSON.stringify(cleanModels, null, 2) + '\n');
    console.log('✓ Updated models.json (pure API data)');

    // Load patch.json and apply to API models for README generation
    let patch = {};
    try {
      patch = JSON.parse(fs.readFileSync(PATCH_JSON_PATH, 'utf8'));
      console.log(`✓ Loaded ${Object.keys(patch).length} patch overrides from patch.json`);
    } catch (e) {
      console.warn('⚠ Could not load patch.json, README may show incorrect reasoning flags');
    }

    // Patched models for README (reflects actual model behavior)
    let patchedModels = apiTransformed;
    if (Object.keys(patch).length > 0) {
      patchedModels = applyPatch(apiTransformed.map(m => ({...m})), patch);
      console.log('✓ Applied patch.json overrides for README');
    }

    // Update README.md with patched data
    updateReadme(patchedModels);

    // Summary (patched models reflect actual behavior)
    console.log('\n--- Summary ---');
    console.log(`Total models: ${patchedModels.length}`);
    console.log(`Reasoning models (patched): ${patchedModels.filter(m => m.reasoning).length}`);
    console.log(`Reasoning models (API raw):  ${apiTransformed.filter(m => m.reasoning).length}`);
    console.log(`Vision models: ${patchedModels.filter(m => m.input.includes('image')).length}`);
    console.log(`Free models: ${patchedModels.filter(m => m._meta.isFree).length}`);

    const newIds = new Set(apiTransformed.map(m => m.id));
    const oldIds = new Set(existingModels.map(m => m.id));

    const added = [...newIds].filter(id => !oldIds.has(id));
    const removed = [...oldIds].filter(id => !newIds.has(id));

    if (added.length > 0) {
      console.log(`\nNew models: ${added.join(', ')}`);
    }
    if (removed.length > 0) {
      console.log(`\nRemoved models: ${removed.join(', ')}`);
    }

    // Show pricing changes
    for (const model of apiTransformed) {
      const oldModel = existingModels.find(m => m.id === model.id);
      if (oldModel) {
        const oldInput = oldModel.cost?.input || 0;
        const oldOutput = oldModel.cost?.output || 0;
        if (oldInput !== model.cost.input || oldOutput !== model.cost.output) {
          console.log(`\nPricing change for ${model.id}:`);
          if (oldInput !== model.cost.input) {
            console.log(`  Input: $${oldInput}/M → $${model.cost.input}/M`);
          }
          if (oldOutput !== model.cost.output) {
            console.log(`  Output: $${oldOutput}/M → $${model.cost.output}/M`);
          }
        }
      }
    }

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();

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
const CUSTOM_MODELS_JSON_PATH = path.join(__dirname, '..', 'custom-models.json');
const README_PATH = path.join(__dirname, '..', 'README.md');

/**
 * Parse API pricing value. API returns prices as $/million tokens (e.g., "0.28").
 */
function convertPricing(apiPrice) {
  if (!apiPrice) return 0;
  const price = parseFloat(apiPrice);
  // Round to avoid floating point precision issues
  return Math.round(price * 100) / 100;
}

/**
 * Apply patch.json overrides on top of transformed models.
 * Deep merges compat, shallow merges everything else.
 */
function applyPatch(model, patch) {
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

function buildModels(baseModels, customModels, patchData) {
  const modelMap = new Map();
  for (const model of baseModels) {
    modelMap.set(model.id, model);
  }
  for (const [id, patchEntry] of Object.entries(patchData)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }
  for (const model of customModels) {
    const existing = modelMap.get(model.id);
    const patchEntry = patchData[model.id];
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

function transformModel(apiModel, existingModelsMap) {
  const modelId = apiModel.id;

  // Preserve existing curated data (reasoning, vision, compat, etc.)
  if (existingModelsMap[modelId]) {
    const existing = { ...existingModelsMap[modelId] };

    // Update fields from API that may change
    const inputCost = convertPricing(apiModel.pricing?.prompt);
    const outputCost = convertPricing(apiModel.pricing?.completion);
    const cacheReadCost = convertPricing(apiModel.pricing?.cache_prompt);

    if (inputCost > 0) existing.cost.input = inputCost;
    if (outputCost > 0) existing.cost.output = outputCost;
    if (cacheReadCost > 0) existing.cost.cacheRead = cacheReadCost;
    if (apiModel.context_length) existing.contextWindow = apiModel.context_length;
    if (apiModel.max_completion_tokens) existing.maxTokens = apiModel.max_completion_tokens;

    // Update reasoning from API flags (if available)
    const hasReasoning = apiModel.reasoning_effort === true || apiModel.custom_reasoning === true;
    if (hasReasoning) existing.reasoning = true;

    // Ensure _meta exists (stripped from models.json but needed for README generation)
    existing._meta = {
      isFree: inputCost === 0 && outputCost === 0,
      quantization: apiModel.quantization,
      speed: apiModel.speed,
    };

    return existing;
  }

  // New model — build from API data + sensible defaults
  // Curate models.json manually after discovery for vision, reasoning, thinkingFormat, etc.
  const hasReasoning = apiModel.reasoning_effort === true || apiModel.custom_reasoning === true;
  const inputCost = convertPricing(apiModel.pricing?.prompt);
  const outputCost = convertPricing(apiModel.pricing?.completion);
  const cacheReadCost = convertPricing(apiModel.pricing?.cache_prompt);
  const isFree = inputCost === 0 && outputCost === 0;

  let displayName = apiModel.name.replace(/^[^:]+:\s*/, '');

  return {
    id: modelId,
    name: displayName,
    reasoning: hasReasoning,
    input: ['text'],
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead: cacheReadCost,
      cacheWrite: 0,
    },
    contextWindow: apiModel.context_length || 0,
    maxTokens: apiModel.max_completion_tokens || apiModel.context_length || 0,
    _meta: {
      isFree,
      quantization: apiModel.quantization,
      speed: apiModel.speed,
    },
  };
}

/**
 * Load JSON file or return empty object on failure.
 */
function loadJson(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
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

    // Load existing models.json — source of truth for curated specs
    let existingModels = [];
    try {
      existingModels = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf8'));
    } catch (e) {
      // File might not exist or be invalid
    }
    const existingModelsMap = {};
    for (const m of existingModels) {
      existingModelsMap[m.id] = m;
    }

    // Transform models from API, preserving existing curated data
    let apiTransformed = apiModels.map(m => transformModel(m, existingModelsMap));

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
    // Build full model list for README: base → patch → custom
    const customModels = loadJson(CUSTOM_MODELS_JSON_PATH);
    const readmeModels = buildModels(
      apiTransformed,
      Array.isArray(customModels) ? customModels : [],
      patch
    );
    readmeModels.sort((a, b) => a.name.localeCompare(b.name));
    console.log('✓ Built model list (base → patch → custom) for README');

    // Update README.md with patched data
    updateReadme(readmeModels);

    // Summary
    console.log('\n--- Summary ---');
    console.log(`Total models: ${readmeModels.length}`);
    console.log(`Reasoning models (patched): ${readmeModels.filter(m => m.reasoning).length}`);
    console.log(`Reasoning models (API raw):  ${apiTransformed.filter(m => m.reasoning).length}`);
    console.log(`Vision models: ${readmeModels.filter(m => m.input.includes('image')).length}`);
    console.log(`Free models: ${readmeModels.filter(m => m._meta.isFree).length}`);

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

#!/usr/bin/env node
/**
 * Update CrofAI models from API
 *
 * Fetches models from https://crof.ai/v1/models and updates:
 * - models.json: Provider model definitions
 * - README.md: Model table in the Available Models section
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODELS_API_URL = 'https://crof.ai/v1/models';
const MODELS_JSON_PATH = path.join(__dirname, '..', 'models.json');
const README_PATH = path.join(__dirname, '..', 'README.md');

// Models known to support vision (image input) - exact IDs only
const VISION_MODEL_IDS = [
  'kimi-k2.5', // base model has vision
  'gemma-4-31b-it', // vision capable
];

// Models that explicitly do NOT have vision despite similar names
const NO_VISION_MODEL_IDS = [
  'kimi-k2.5-lightning', // lightning variant is text-only
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
 * Transform API model to local format
 */
function transformModel(apiModel) {
  const modelId = apiModel.id;
  // Use API reasoning flags if available, fall back to name detection
  const hasReasoning = apiModel.reasoning_effort === true || apiModel.custom_reasoning === true;
  const hasVision = isVisionModel(modelId);

  // Determine input types
  const inputTypes = ['text'];
  if (hasVision) {
    inputTypes.push('image');
  }

  // Use API name but prefix with "CrofAI: "
  let displayName = apiModel.name.startsWith('CrofAI:')
    ? apiModel.name
    : `CrofAI: ${apiModel.name.replace(/^[^:]+:\s*/, '')}`;

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
  // Match the table header row and everything until the next section (## ) or end
  const tableRegex = /(## Available Models\n\n)\| Model \| Context \| Vision \| Reasoning \| Input \$\/M \| Output \$\/M \|\n\|[-|]+\|[\s\S]*?(?=\n## |$)/;

  if (tableRegex.test(readme)) {
    // Use a replacer function to avoid $ being interpreted as regex group reference
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

    // Transform models
    const transformedModels = apiModels.map(transformModel);

    // Sort models: non-free first (by input cost), then free models alphabetically
    transformedModels.sort((a, b) => {
      const aFree = a._meta.isFree;
      const bFree = b._meta.isFree;
      if (aFree && !bFree) return 1;
      if (!aFree && bFree) return -1;
      return a.id.localeCompare(b.id);
    });

    // Load existing models for comparison
    let existingModels = [];
    try {
      existingModels = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf8'));
    } catch (e) {
      // File might not exist or be invalid
    }

    // Update models.json (without _meta fields)
    const cleanModels = transformedModels.map(cleanModelForJson);
    fs.writeFileSync(MODELS_JSON_PATH, JSON.stringify(cleanModels, null, 2) + '\n');
    console.log('✓ Updated models.json');

    // Update README.md
    updateReadme(transformedModels);

    // Summary
    console.log('\n--- Summary ---');
    console.log(`Total models: ${transformedModels.length}`);
    console.log(`Reasoning models: ${transformedModels.filter(m => m.reasoning).length}`);
    console.log(`Vision models: ${transformedModels.filter(m => m.input.includes('image')).length}`);
    console.log(`Free models: ${transformedModels.filter(m => m._meta.isFree).length}`);

    const newIds = new Set(transformedModels.map(m => m.id));
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
    for (const model of transformedModels) {
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

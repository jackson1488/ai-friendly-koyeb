'use strict';

const FAST_TEXT_MODELS = [
  'qwen3-0.6b',
  'qwen3-1.7b',
  'qwen3-14b',
  'qwen3-flash',
  'qwen3.5-flash',
  'qwen3.5-flash-2026-02-23',
  'qwen-flash',
  'qwen-flash-2025-07-28',
  'qwen-turbo',
  'qwen-turbo-latest',
  'qwen-turbo-2025-04-28',
  'qwen2.5-7b-instruct',
  'qwen2.5-7b-instruct-1m',
  'qwen2.5-14b-instruct',
  'qwen2.5-14b-instruct-1m',
  'qwen2.5-32b-instruct',
  'qwen2.5-72b-instruct',
  'qwen-mt-lite',
  'qwen-mt-turbo',
  'qwen3-coder-flash',
  'qwen3-coder-flash-2025-07-28',
  'qwen3-vl-flash',
  'qwen3-vl-flash-2026-01-22',
  'qwen3-vl-flash-2025-10-15',
  'qwen2.5-vl-3b-instruct',
  'qwen2.5-vl-7b-instruct',
  'qwen2.5-vl-32b-instruct',
  'qwen2.5-vl-72b-instruct',
  'qwen-vl-plus',
  'qwen-vl-plus-latest',
  'qwen-vl-plus-2025-08-15',
  'qwen-vl-plus-2025-05-07',
  'qwen-vl-plus-2025-01-25',
  'qwen-vl-ocr',
  'qwen-flash-character'
];

const STANDARD_TEXT_MODELS = [
  'qwen3-4b',
  'qwen3-8b',
  'qwen3-30b-a3b',
  'qwen3-30b-a3b-instruct-2507',
  'qwen3-32b',
  'qwen3-235b-a22b',
  'qwen3-235b-a22b-instruct-2507',
  'qwen3.5-27b',
  'qwen3.5-plus',
  'qwen3.5-plus-2026-02-15',
  'qwen-plus',
  'qwen-plus-2025-07-28',
  'qwen-plus-2025-09-11',
  'qwen-plus-2025-07-14',
  'qwen-plus-2025-04-28',
  'qwen-plus-latest',
  'qwen-plus-character',
  'qwen-mt-plus',
  'qwen-mt-flash',
  'qwen3-coder-next',
  'qwen3-coder-30b-a3b-instruct',
  'qwen3-vl-plus',
  'qwen3-vl-plus-2025-12-19',
  'qwen3-vl-plus-2025-09-23',
  'qwen3-vl-plus-2025-01-25',
  'qwen3-vl-30b-a3b-instruct',
  'qwen3-vl-235b-a22b-instruct',
  'qwen3-vl-8b-instruct',
  'qwen3-vl-8b-thinking',
  'qwen-vl-max',
  'qwen-vl-max-latest',
  'qwen-vl-max-2025-04-08',
  'qwen-vl-max-2025-08-13',
  'qwen-vl-ocr-2025-11-20'
];

const BEST_TEXT_MODELS = [
  'qwen3-max',
  'qwen3-max-2026-01-23',
  'qwen3-max-2025-09-23',
  'qwen3-max-preview',
  'qwen3.5-397b-a17b',
  'qwen3.5-122b-a10b',
  'qwen3.6-plus',
  'qwen3.6-plus-2026-04-02',
  'qwen3-coder-480b-a35b-instruct',
  'qwen3-coder-plus',
  'qwen3-coder-plus-2025-09-23',
  'qwen3-coder-plus-2025-07-22',
  'qwq-plus',
  'qvq-max',
  'qvq-max-latest',
  'qwen3-next-80b-a3b-thinking',
  'qwen3-next-80b-a3b-instruct',
  'qwen3-235b-a22b-thinking-2507',
  'qwen3-30b-a3b-thinking-2507',
  'qwen3-vl-235b-a22b-thinking',
  'qwen3-vl-30b-a3b-thinking',
  'deepseek-v3.2'
];

const TIER_FALLBACK_ORDER = {
  fast: ['fast', 'standard', 'best'],
  standard: ['standard', 'fast', 'best'],
  best: ['best', 'standard', 'fast']
};

function normalizeTier(tier) {
  const normalized = `${tier || ''}`.trim().toLowerCase();
  if (normalized === 'fast' || normalized === 'best' || normalized === 'standard') {
    return normalized;
  }
  return 'standard';
}

function normalizeModelCode(value) {
  const normalized = `${value || ''}`.trim().replace(/\s*\([^)]*\)\s*$/, '');
  return normalized.trim();
}

function isTextModelCode(value) {
  const normalized = normalizeModelCode(value).toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('wan')) return false;
  return true;
}

function pushUnique(list, value) {
  const normalized = normalizeModelCode(value);
  if (!isTextModelCode(normalized)) return;
  if (list.includes(normalized)) return;
  list.push(normalized);
}

function getTierPool(tier) {
  const normalizedTier = normalizeTier(tier);
  if (normalizedTier === 'fast') return FAST_TEXT_MODELS;
  if (normalizedTier === 'best') return BEST_TEXT_MODELS;
  return STANDARD_TEXT_MODELS;
}

function buildTierModelCandidates(tier = 'standard', serverModels = []) {
  const normalizedTier = normalizeTier(tier);
  const order = TIER_FALLBACK_ORDER[normalizedTier] || TIER_FALLBACK_ORDER.standard;
  const candidates = [];

  for (const tierName of order) {
    const pool = getTierPool(tierName);
    for (const model of pool) {
      pushUnique(candidates, model);
    }
  }

  const external = Array.isArray(serverModels) ? serverModels : [];
  for (const model of external) {
    pushUnique(candidates, model);
  }

  return candidates;
}

function getTierPrimaryModel(tier = 'standard', serverModels = []) {
  const candidates = buildTierModelCandidates(tier, serverModels);
  return candidates[0] || null;
}

function getTierModelPools() {
  return {
    fast: [...FAST_TEXT_MODELS],
    standard: [...STANDARD_TEXT_MODELS],
    best: [...BEST_TEXT_MODELS]
  };
}


module.exports = {
  normalizeTier,
  buildTierModelCandidates,
  getTierPrimaryModel,
  getTierModelPools
};


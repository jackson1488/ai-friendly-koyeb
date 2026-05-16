const { AppError } = require('../utils/errors');

function extractProviderMessage(rawText) {
  const text = `${rawText || ''}`.trim();
  if (!text) return '';

  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || parsed?.error?.metadata?.raw || text;
  } catch (_error) {
    return text;
  }
}

function extractAssistantText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        return `${item.text || item.content || ''}`;
      })
      .join('')
      .trim();
  }
  if (content && typeof content === 'object') {
    return `${content.text || content.content || ''}`.trim();
  }
  return '';
}

function extractStreamDelta(parsed) {
  const firstChoice = parsed?.choices?.[0] || null;
  if (!firstChoice) return '';

  const deltaContent = firstChoice?.delta?.content;
  if (typeof deltaContent === 'string') {
    return deltaContent;
  }
  if (Array.isArray(deltaContent)) {
    return extractAssistantText(deltaContent);
  }

  const messageContent = firstChoice?.message?.content;
  if (typeof messageContent === 'string') {
    return messageContent;
  }
  if (Array.isArray(messageContent)) {
    return extractAssistantText(messageContent);
  }

  return '';
}

function extractStreamReasoningDelta(parsed) {
  const firstChoice = parsed?.choices?.[0] || null;
  if (!firstChoice) return '';

  const reasoningDeltaCandidates = [
    firstChoice?.delta?.reasoning_content,
    firstChoice?.delta?.reasoning,
    firstChoice?.delta?.thinking,
    firstChoice?.delta?.reasoning_text
  ];
  for (const candidate of reasoningDeltaCandidates) {
    if (typeof candidate === 'string' && candidate) {
      return candidate;
    }
    if (Array.isArray(candidate)) {
      const normalized = extractAssistantText(candidate);
      if (normalized) return normalized;
    }
  }

  const reasoningMessageCandidates = [
    firstChoice?.message?.reasoning_content,
    firstChoice?.message?.reasoning,
    firstChoice?.message?.thinking,
    firstChoice?.message?.reasoning_text
  ];
  for (const candidate of reasoningMessageCandidates) {
    if (typeof candidate === 'string' && candidate) {
      return candidate;
    }
    if (Array.isArray(candidate)) {
      const normalized = extractAssistantText(candidate);
      if (normalized) return normalized;
    }
  }

  return '';
}

function normalizeBaseUrl(baseUrl) {
  return `${baseUrl || ''}`.trim().replace(/\/+$/, '');
}

function resolveDashScopeOrigin(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    const host = `${parsed.hostname || ''}`.toLowerCase();
    if (!host.includes('dashscope')) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_error) {
    return null;
  }
}

function normalizeDashScopeSize(size, fallback = '1024*1024') {
  const text = `${size || ''}`.trim().toLowerCase();
  if (!text) return fallback;
  const normalized = text.replace('×', 'x').replace(/x/g, '*');
  return normalized;
}

function normalizeApiKeys(apiKey, apiKeys = []) {
  const normalized = [];
  const push = (value) => {
    const text = `${value || ''}`.trim();
    if (!text) return;
    if (!normalized.includes(text)) normalized.push(text);
  };

  push(apiKey);
  if (Array.isArray(apiKeys)) {
    for (const item of apiKeys) push(item);
  }

  return normalized;
}

function maskKey(value) {
  const text = `${value || ''}`.trim();
  if (!text) return 'empty';
  if (text.length <= 8) return '***';
  return `***${text.slice(-4)}`;
}

function createJsonHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
}

function buildChatCompletionBody({
  model,
  stream,
  messages,
  temperature,
  maxTokens,
  enableSearch,
  enableThinking,
  dashScopeEnabled
}) {
  const payload = {
    model,
    stream,
    messages,
    temperature,
    max_tokens: maxTokens
  };
  if (dashScopeEnabled && enableSearch === true) {
    payload.enable_search = true;
  }
  if (dashScopeEnabled && enableThinking === true) {
    payload.extra_body = {
      ...(payload.extra_body || {}),
      enable_thinking: true
    };
  }
  return payload;
}

const IMAGE_MODEL_FALLBACKS = [
  'qwen-image-2.0',
  'qwen-image-2.0-2026-03-03',
  'qwen-image-2.0-pro',
  'qwen-image-2.0-pro-2026-03-03',
  'qwen-image-plus',
  'qwen-image-plus-2026-01-09',
  'qwen-image-max',
  'qwen-image-max-2025-12-30',
  'qwen-image',
  'z-image-turbo',
  'wan2.2-t2i-plus',
  'wan2.2-t2i-flash',
  'wan2.6-t2i',
  'wan2.5-t2i-preview',
  'wan2.6-image',
  'wan2.7-image',
  'wan2.7-image-pro',
  'wan2.1-t2i-plus',
  'wan2.1-t2i-turbo'
];

const IMAGE_EDIT_MODEL_FALLBACKS = [
  'qwen-image-edit-plus',
  'qwen-image-edit-plus-2025-10-30',
  'qwen-image-edit-plus-2025-12-15',
  'qwen-image-edit',
  'qwen-image-edit-max',
  'qwen-image-edit-max-2026-01-16',
  'wan2.5-i2i-preview'
];

const VIDEO_MODEL_FALLBACKS = [
  'wan2.2-t2v-plus',
  'wan2.7-t2v',
  'wan2.6-t2v',
  'wan2.5-t2v-preview',
  'wan2.2-i2v-plus',
  'wan2.2-i2v-flash',
  'wan2.7-i2v',
  'wan2.6-i2v',
  'wan2.6-i2v-flash',
  'wan2.1-t2v-plus',
  'wan2.1-t2v-turbo',
  'wan2.1-i2v-plus',
  'wan2.1-i2v-turbo',
  'wan2.5-i2v-preview',
  'wan2.1-kf2v-plus',
  'wan2.7-r2v',
  'wan2.6-r2v',
  'wan2.6-r2v-flash',
  'wan2.2-animate-move',
  'wan2.2-animate-mix',
  'wan2.7-videoedit',
  'wan2.1-vace-plus'
];

function isTextToVideoModel(model) {
  const normalized = `${model || ''}`.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes('-t2v');
}

function isImageOrMediaDrivenVideoModel(model) {
  const normalized = `${model || ''}`.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('-i2v') ||
    normalized.includes('-r2v') ||
    normalized.includes('-kf2v') ||
    normalized.includes('videoedit') ||
    normalized.includes('animate') ||
    normalized.includes('vace')
  );
}

function filterVideoModelCandidatesByInput(models, { hasImage } = {}) {
  const source = Array.isArray(models) ? models : [];
  if (hasImage) {
    const preferred = source.filter((model) => isImageOrMediaDrivenVideoModel(model));
    return preferred.length ? preferred : source;
  }
  const preferred = source.filter((model) => isTextToVideoModel(model));
  return preferred.length ? preferred : source;
}

function normalizeDashScopeVideoSize(size) {
  const raw = `${size || ''}`.trim().toLowerCase();
  if (!raw) return '1920*1080';
  const compact = raw.replace(/\s+/g, '');
  if (/^\d{2,5}\*\d{2,5}$/.test(compact)) return compact;
  if (/^\d{2,5}x\d{2,5}$/.test(compact)) return compact.replace('x', '*');
  if (compact === '1080p') return '1920*1080';
  if (compact === '720p') return '1280*720';
  if (compact === '480p') return '832*480';
  return '1920*1080';
}

function uniqList(values = []) {
  const out = [];
  for (const value of values) {
    const text = `${value || ''}`.trim();
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

function supportsDashScopeCustomDuration(model) {
  const normalized = `${model || ''}`.trim().toLowerCase();
  if (!normalized) return false;
  // Based on official Model Studio docs:
  // - wan2.2 / wan2.1 families are mostly fixed at 5s
  // - wan2.5 / wan2.6 families support duration customization
  return normalized.includes('wan2.5-') || normalized.includes('wan2.6-');
}

function resolveDashScopeVideoSizeCandidates(size, model) {
  const normalizedModel = `${model || ''}`.trim().toLowerCase();
  const preferred = normalizeDashScopeVideoSize(size);

  // wan2.2 plus models do not accept 720p; they typically support 1080p and selected aspect presets.
  if (normalizedModel.includes('wan2.2-') && normalizedModel.includes('-plus') && !normalizedModel.includes('flash')) {
    const allowed = ['1920*1080', '1080*1920', '1632*1248', '1248*1632', '1440*1440', '832*480', '480*832', '624*624'];
    const primary = allowed.includes(preferred) ? preferred : '1920*1080';
    return uniqList([primary, ...allowed]);
  }

  const baseFallback =
    normalizedModel.startsWith('wan2.1-') || normalizedModel.startsWith('wanx2.1-')
      ? ['1280*720', '832*480', '1920*1080']
      : ['1920*1080', '1280*720', '832*480'];
  return uniqList([preferred, ...baseFallback]);
}

const ASR_MODEL_FALLBACKS = [
  'qwen3-asr-flash-filetrans',
  'qwen3-asr-flash',
  'qwen3-omni-flash',
  'qwen3.5-omni-flash',
  'qwen3.5-omni-plus',
  'qwen2.5-omni-7b',
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe',
  'whisper-1'
];

const ASR_FILETRANS_MODEL_FALLBACKS = ['qwen3-asr-flash-filetrans', 'qwen3-asr-flash-filetrans-2025-11-17'];
const DASHSCOPE_ASR_POLL_ATTEMPTS = 18;
const DASHSCOPE_ASR_POLL_INTERVAL_MS = 1300;

function normalizeModelAliases(model) {
  const text = `${model || ''}`.trim();
  if (!text) return '';
  // Common typo in older defaults/admin inputs.
  if (/^wanx2\.1/i.test(text)) {
    return text.replace(/^wanx2\.1/i, 'wan2.1');
  }
  return text;
}

function buildCandidateList(primary = [], fallback = []) {
  const out = [];
  const push = (value) => {
    const normalized = normalizeModelAliases(value);
    if (!normalized || out.includes(normalized)) return;
    out.push(normalized);

    // Providers may expose an undated alias for a dated model id.
    const withoutDateSuffix = normalized.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    if (withoutDateSuffix && !out.includes(withoutDateSuffix)) {
      out.push(withoutDateSuffix);
    }
  };
  for (const item of primary) push(item);
  for (const item of fallback) push(item);
  return out;
}

function normalizeImagePayload(payload) {
  const dataRoot = Array.isArray(payload?.data) ? payload.data[0] || null : null;
  const outputRoot = payload?.output && typeof payload.output === 'object' ? payload.output : null;
  const resultRoot = Array.isArray(outputRoot?.results) ? outputRoot.results[0] || null : null;

  const imageUrl =
    `${dataRoot?.url || ''}`.trim() ||
    `${dataRoot?.image_url || ''}`.trim() ||
    `${dataRoot?.imageUrl || ''}`.trim() ||
    `${resultRoot?.url || ''}`.trim() ||
    `${resultRoot?.image_url || ''}`.trim() ||
    `${outputRoot?.url || ''}`.trim() ||
    `${outputRoot?.image_url || ''}`.trim() ||
    `${payload?.imageUrl || ''}`.trim() ||
    `${payload?.image_url || ''}`.trim();

  const b64Json =
    `${dataRoot?.b64_json || ''}`.trim() ||
    `${dataRoot?.b64Json || ''}`.trim() ||
    `${resultRoot?.b64_json || ''}`.trim() ||
    `${outputRoot?.b64_json || ''}`.trim() ||
    `${outputRoot?.b64Json || ''}`.trim() ||
    `${payload?.b64_json || ''}`.trim() ||
    `${payload?.b64Json || ''}`.trim();

  if (!imageUrl && !b64Json) return null;
  return {
    imageUrl: imageUrl || null,
    b64Json: b64Json || null
  };
}

function normalizeVideoStatus(statusRaw, hasVideoUrl = false) {
  if (hasVideoUrl) return 'succeeded';
  const status = `${statusRaw || ''}`.trim().toLowerCase();
  if (!status) return 'unknown';
  if (['succeeded', 'success', 'completed', 'complete', 'done', 'finished'].includes(status)) {
    return 'succeeded';
  }
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
    return 'failed';
  }
  if (
    [
      'processing',
      'running',
      'queued',
      'queueing',
      'pending',
      'submitted',
      'in_progress',
      'executing'
    ].includes(status)
  ) {
    return 'processing';
  }
  return status;
}

function normalizeVideoPayload(payload) {
  const dataRoot = Array.isArray(payload?.data) ? payload.data[0] || null : null;
  const outputRoot = payload?.output && typeof payload.output === 'object' ? payload.output : null;
  const resultRoot = Array.isArray(outputRoot?.results) ? outputRoot.results[0] || null : null;

  const taskId =
    `${payload?.task_id || ''}`.trim() ||
    `${payload?.taskId || ''}`.trim() ||
    `${payload?.id || ''}`.trim() ||
    `${dataRoot?.task_id || ''}`.trim() ||
    `${dataRoot?.taskId || ''}`.trim() ||
    `${dataRoot?.id || ''}`.trim() ||
    `${outputRoot?.task_id || ''}`.trim() ||
    `${outputRoot?.taskId || ''}`.trim() ||
    `${outputRoot?.id || ''}`.trim();

  const videoUrl =
    `${payload?.video_url || ''}`.trim() ||
    `${payload?.videoUrl || ''}`.trim() ||
    `${payload?.url || ''}`.trim() ||
    `${dataRoot?.video_url || ''}`.trim() ||
    `${dataRoot?.videoUrl || ''}`.trim() ||
    `${dataRoot?.url || ''}`.trim() ||
    `${resultRoot?.video_url || ''}`.trim() ||
    `${resultRoot?.videoUrl || ''}`.trim() ||
    `${resultRoot?.url || ''}`.trim() ||
    `${outputRoot?.video_url || ''}`.trim() ||
    `${outputRoot?.videoUrl || ''}`.trim() ||
    `${outputRoot?.url || ''}`.trim();

  const statusRaw =
    `${payload?.status || ''}`.trim() ||
    `${payload?.state || ''}`.trim() ||
    `${payload?.task_status || ''}`.trim() ||
    `${dataRoot?.status || ''}`.trim() ||
    `${dataRoot?.state || ''}`.trim() ||
    `${outputRoot?.status || ''}`.trim() ||
    `${outputRoot?.state || ''}`.trim() ||
    `${outputRoot?.task_status || ''}`.trim();

  const errorMessage =
    `${payload?.error?.message || ''}`.trim() ||
    `${payload?.error_message || ''}`.trim() ||
    `${payload?.message || ''}`.trim() ||
    `${dataRoot?.error?.message || ''}`.trim() ||
    `${outputRoot?.error?.message || ''}`.trim();

  const status = normalizeVideoStatus(statusRaw, Boolean(videoUrl));
  if (!taskId && !videoUrl && status === 'unknown') return null;

  return {
    taskId: taskId || null,
    status,
    videoUrl: videoUrl || null,
    errorMessage: errorMessage || null
  };
}

async function requestChatCompletion({
  apiKey,
  baseUrl,
  model,
  messages,
  temperature,
  maxTokens,
  enableSearch = false,
  enableThinking = false
}) {
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!resolvedBaseUrl) {
    throw new AppError(500, 'Base URL for PRO mode is not configured');
  }
  const dashScopeEnabled = Boolean(resolveDashScopeOrigin(resolvedBaseUrl));

  let response = null;
  let lastNetworkError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      try {
        response = await fetch(`${resolvedBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: createJsonHeaders(apiKey),
          body: JSON.stringify(buildChatCompletionBody({
            model,
            stream: false,
            messages,
            temperature,
            maxTokens,
            enableSearch,
            enableThinking,
            dashScopeEnabled
          })),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
      break;
    } catch (error) {
      lastNetworkError = error;
      if (attempt < 1) {
        await new Promise((resolve) => setTimeout(resolve, 450));
        continue;
      }
    }
  }

  if (!response) {
    throw new Error(lastNetworkError?.message || 'fetch failed');
  }

  if (!response.ok) {
    const raw = await response.text();
    const providerMessage = extractProviderMessage(raw) || response.statusText;
    throw new Error(providerMessage);
  }

  const data = await response.json();
  const text = extractAssistantText(data?.choices?.[0]?.message?.content);
  if (!text) {
    throw new Error('Provider returned an empty chat completion');
  }

  return {
    text,
    usage: data?.usage || null,
    raw: data
  };
}

async function requestChatCompletionStream({
  apiKey,
  baseUrl,
  model,
  messages,
  temperature,
  maxTokens,
  enableSearch = false,
  enableThinking = false,
  onReasoning,
  onToken
}) {
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!resolvedBaseUrl) {
    throw new AppError(500, 'Base URL for PRO mode is not configured');
  }
  const dashScopeEnabled = Boolean(resolveDashScopeOrigin(resolvedBaseUrl));

  let response = null;
  let lastNetworkError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 65_000);
      try {
        response = await fetch(`${resolvedBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: createJsonHeaders(apiKey),
          body: JSON.stringify(buildChatCompletionBody({
            model,
            stream: true,
            messages,
            temperature,
            maxTokens,
            enableSearch,
            enableThinking,
            dashScopeEnabled
          })),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
      break;
    } catch (error) {
      lastNetworkError = error;
      if (attempt < 1) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        continue;
      }
    }
  }

  if (!response) {
    throw new Error(lastNetworkError?.message || 'fetch failed');
  }

  if (!response.ok) {
    const raw = await response.text();
    const providerMessage = extractProviderMessage(raw) || response.statusText;
    throw new Error(providerMessage);
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const fallback = await requestChatCompletion({
      apiKey,
      baseUrl,
      model,
      messages,
      temperature,
      maxTokens,
      enableSearch,
      enableThinking
    });
    if (typeof onToken === 'function' && fallback?.text) {
      onToken(fallback.text);
    }
    return fallback;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let aggregatedText = '';
  let aggregatedReasoning = '';
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';

    for (const chunk of chunks) {
      const lines = chunk.split('\n').map((line) => line.trim());
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let parsed = null;
        try {
          parsed = JSON.parse(payload);
        } catch (_error) {
          continue;
        }

        const token = extractStreamDelta(parsed);
        const reasoningToken = extractStreamReasoningDelta(parsed);
        if (reasoningToken) {
          aggregatedReasoning += reasoningToken;
          if (typeof onReasoning === 'function') {
            onReasoning(reasoningToken);
          }
        }
        if (token) {
          aggregatedText += token;
          if (typeof onToken === 'function') {
            onToken(token);
          }
        }
        if (parsed?.usage) {
          usage = parsed.usage;
        }
      }
    }
  }

  if (!aggregatedText.trim()) {
    throw new Error('Provider returned an empty chat completion');
  }

  return {
    text: aggregatedText,
    reasoning: aggregatedReasoning,
    usage,
    raw: null
  };
}

async function requestImageGeneration({ apiKey, baseUrl, model, prompt, size }) {
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!resolvedBaseUrl) {
    throw new AppError(500, 'Base URL for PRO mode is not configured');
  }

  const response = await fetch(`${resolvedBaseUrl}/images/generations`, {
    method: 'POST',
    headers: createJsonHeaders(apiKey),
    body: JSON.stringify({
      model,
      prompt,
      size
    })
  });

  if (!response.ok) {
    const raw = await response.text();
    const providerMessage = extractProviderMessage(raw) || response.statusText;
    throw new Error(providerMessage);
  }

  const data = await response.json();
  const normalized = normalizeImagePayload(data);
  if (!normalized) {
    throw new Error('Provider returned an empty image payload');
  }

  return {
    ...normalized,
    raw: data
  };
}

async function requestImageEdit({ apiKey, baseUrl, model, prompt, imageUrl, size }) {
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!resolvedBaseUrl) {
    throw new AppError(500, 'Base URL for PRO mode is not configured');
  }

  const candidates = [
    {
      endpoint: '/images/edits',
      body: {
        model,
        prompt,
        image: imageUrl,
        size
      }
    },
    {
      endpoint: '/images/edits',
      body: {
        model,
        prompt,
        image_url: imageUrl,
        size
      }
    },
    {
      endpoint: '/images/generations',
      body: {
        model,
        prompt,
        image: imageUrl,
        size,
        mode: 'edit'
      }
    }
  ];

  const errors = [];
  for (const candidate of candidates) {
    const response = await fetch(`${resolvedBaseUrl}${candidate.endpoint}`, {
      method: 'POST',
      headers: createJsonHeaders(apiKey),
      body: JSON.stringify(candidate.body)
    });

    if (!response.ok) {
      const raw = await response.text();
      const providerMessage = extractProviderMessage(raw) || response.statusText;
      errors.push(`${candidate.endpoint}: ${providerMessage}`);
      continue;
    }

    const data = await response.json();
    const normalized = normalizeImagePayload(data);
    if (!normalized) {
      errors.push(`${candidate.endpoint}: empty image payload`);
      continue;
    }

    return {
      ...normalized,
      endpoint: candidate.endpoint,
      raw: data
    };
  }

  throw new Error(errors.join(' | ') || 'Image edit request failed');
}

async function requestVideoGeneration({
  apiKey,
  baseUrl,
  model,
  prompt,
  imageUrl,
  size,
  durationSeconds,
  aspectRatio
}) {
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!resolvedBaseUrl) {
    throw new AppError(500, 'Base URL for PRO mode is not configured');
  }

  const baseBody = {
    model,
    prompt,
    size,
    duration: durationSeconds,
    duration_seconds: durationSeconds,
    aspect_ratio: aspectRatio
  };
  if (imageUrl) {
    baseBody.image = imageUrl;
    baseBody.image_url = imageUrl;
  }

  const endpoints = ['/video/generations', '/videos/generations', '/video/generation'];
  const errors = [];

  for (const endpoint of endpoints) {
    const response = await fetch(`${resolvedBaseUrl}${endpoint}`, {
      method: 'POST',
      headers: createJsonHeaders(apiKey),
      body: JSON.stringify(baseBody)
    });

    if (!response.ok) {
      const raw = await response.text();
      const providerMessage = extractProviderMessage(raw) || response.statusText;
      errors.push(`${endpoint}: ${providerMessage}`);
      continue;
    }

    const data = await response.json();
    const normalized = normalizeVideoPayload(data);
    if (!normalized) {
      errors.push(`${endpoint}: empty video payload`);
      continue;
    }

    return {
      ...normalized,
      endpoint,
      raw: data
    };
  }

  throw new Error(errors.join(' | ') || 'Video generation request failed');
}

async function requestVideoStatus({ apiKey, baseUrl, taskId }) {
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!resolvedBaseUrl) {
    throw new AppError(500, 'Base URL for PRO mode is not configured');
  }

  const encodedTaskId = encodeURIComponent(taskId);
  const endpoints = [
    `/video/generations/${encodedTaskId}`,
    `/videos/generations/${encodedTaskId}`,
    `/video/tasks/${encodedTaskId}`,
    `/tasks/${encodedTaskId}`
  ];

  const errors = [];
  for (const endpoint of endpoints) {
    const response = await fetch(`${resolvedBaseUrl}${endpoint}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      const raw = await response.text();
      const providerMessage = extractProviderMessage(raw) || response.statusText;
      errors.push(`${endpoint}: ${providerMessage}`);
      continue;
    }

    const data = await response.json();
    const normalized = normalizeVideoPayload(data);
    if (!normalized) {
      errors.push(`${endpoint}: empty video task payload`);
      continue;
    }

    return {
      ...normalized,
      endpoint,
      raw: data
    };
  }

  throw new Error(errors.join(' | ') || 'Video status request failed');
}

function extractDashScopeTaskMeta(payload) {
  const output = payload?.output && typeof payload.output === 'object' ? payload.output : {};
  const results = Array.isArray(output?.results) ? output.results : [];
  const firstResult = results[0] && typeof results[0] === 'object' ? results[0] : {};

  const taskId =
    `${output?.task_id || ''}`.trim() ||
    `${payload?.task_id || ''}`.trim() ||
    `${payload?.taskId || ''}`.trim() ||
    `${payload?.id || ''}`.trim() ||
    `${payload?.request_id || ''}`.trim();

  const status =
    `${output?.task_status || ''}`.trim() ||
    `${output?.status || ''}`.trim() ||
    `${payload?.task_status || ''}`.trim() ||
    `${payload?.status || ''}`.trim();

  const imageUrl =
    `${output?.image_url || ''}`.trim() ||
    `${output?.url || ''}`.trim() ||
    `${firstResult?.url || ''}`.trim() ||
    `${firstResult?.image_url || ''}`.trim();

  const videoUrl =
    `${output?.video_url || ''}`.trim() ||
    `${firstResult?.video_url || ''}`.trim() ||
    `${firstResult?.url || ''}`.trim();

  const errorMessage =
    `${output?.message || ''}`.trim() ||
    `${payload?.message || ''}`.trim() ||
    `${payload?.error_message || ''}`.trim() ||
    `${payload?.error?.message || ''}`.trim();

  return {
    taskId: taskId || null,
    status: normalizeVideoStatus(status, Boolean(videoUrl)),
    imageUrl: imageUrl || null,
    videoUrl: videoUrl || null,
    errorMessage: errorMessage || null
  };
}

async function requestDashScopeTaskStatus({ apiKey, baseUrl, taskId }) {
  const origin = resolveDashScopeOrigin(baseUrl);
  if (!origin) {
    throw new Error('DashScope task endpoint is unavailable for current baseUrl');
  }

  const response = await fetch(`${origin}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  if (!response.ok) {
    const raw = await response.text();
    const providerMessage = extractProviderMessage(raw) || response.statusText;
    throw new Error(providerMessage);
  }

  const payload = await response.json();
  return {
    ...extractDashScopeTaskMeta(payload),
    raw: payload
  };
}

async function pollDashScopeTaskUntilReady({
  apiKey,
  baseUrl,
  taskId,
  maxAttempts = 12,
  delayMs = 1800
}) {
  let latest = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const status = await requestDashScopeTaskStatus({ apiKey, baseUrl, taskId });
    latest = status;
    if (status?.imageUrl || status?.videoUrl) return status;
    if (status?.status === 'failed') return status;
  }
  return latest;
}

async function requestDashScopeImageGeneration({ apiKey, baseUrl, model, prompt, size }) {
  const origin = resolveDashScopeOrigin(baseUrl);
  if (!origin) {
    throw new Error('DashScope image endpoint is unavailable for current baseUrl');
  }

  const response = await fetch(`${origin}/api/v1/services/aigc/text2image/image-synthesis`, {
    method: 'POST',
    headers: {
      ...createJsonHeaders(apiKey),
      'X-DashScope-Async': 'enable'
    },
    body: JSON.stringify({
      model,
      input: {
        prompt
      },
      parameters: {
        size: normalizeDashScopeSize(size)
      }
    })
  });

  if (!response.ok) {
    const raw = await response.text();
    const providerMessage = extractProviderMessage(raw) || response.statusText;
    throw new Error(providerMessage);
  }

  const payload = await response.json();
  const meta = extractDashScopeTaskMeta(payload);
  if (meta.imageUrl) {
    return {
      imageUrl: meta.imageUrl,
      b64Json: null,
      taskId: meta.taskId,
      status: meta.status,
      raw: payload
    };
  }

  if (meta.taskId) {
    const polled = await pollDashScopeTaskUntilReady({
      apiKey,
      baseUrl,
      taskId: meta.taskId
    });
    if (polled?.imageUrl) {
      return {
        imageUrl: polled.imageUrl,
        b64Json: null,
        taskId: polled.taskId || meta.taskId,
        status: polled.status,
        raw: polled.raw || payload
      };
    }
  }

  throw new Error('DashScope image generation returned no image URL');
}

async function requestDashScopeImageEdit({
  apiKey,
  baseUrl,
  model,
  prompt,
  imageUrl,
  size
}) {
  const origin = resolveDashScopeOrigin(baseUrl);
  if (!origin) {
    throw new Error('DashScope image-edit endpoint is unavailable for current baseUrl');
  }

  const response = await fetch(`${origin}/api/v1/services/aigc/image2image/image-synthesis`, {
    method: 'POST',
    headers: {
      ...createJsonHeaders(apiKey),
      'X-DashScope-Async': 'enable'
    },
    body: JSON.stringify({
      model,
      input: {
        prompt,
        image_url: imageUrl
      },
      parameters: {
        size: normalizeDashScopeSize(size)
      }
    })
  });

  if (!response.ok) {
    const raw = await response.text();
    const providerMessage = extractProviderMessage(raw) || response.statusText;
    throw new Error(providerMessage);
  }

  const payload = await response.json();
  const meta = extractDashScopeTaskMeta(payload);
  if (meta.imageUrl) {
    return {
      imageUrl: meta.imageUrl,
      b64Json: null,
      taskId: meta.taskId,
      status: meta.status,
      raw: payload
    };
  }

  if (meta.taskId) {
    const polled = await pollDashScopeTaskUntilReady({
      apiKey,
      baseUrl,
      taskId: meta.taskId
    });
    if (polled?.imageUrl) {
      return {
        imageUrl: polled.imageUrl,
        b64Json: null,
        taskId: polled.taskId || meta.taskId,
        status: polled.status,
        raw: polled.raw || payload
      };
    }
  }

  throw new Error('DashScope image edit returned no image URL');
}

async function requestDashScopeVideoGeneration({
  apiKey,
  baseUrl,
  model,
  prompt,
  imageUrl,
  size,
  durationSeconds,
  aspectRatio
}) {
  const origin = resolveDashScopeOrigin(baseUrl);
  if (!origin) {
    throw new Error('DashScope video endpoint is unavailable for current baseUrl');
  }

  const input = { prompt };
  if (imageUrl) input.image_url = imageUrl;

  const normalizedAspectRatio = `${aspectRatio || ''}`.trim();
  const supportsDuration = supportsDashScopeCustomDuration(model);
  const requestedDuration = Number.isFinite(Number(durationSeconds)) ? Number(durationSeconds) : null;
  const useDuration = supportsDuration && requestedDuration && requestedDuration > 0 ? requestedDuration : null;
  const sizeCandidates = resolveDashScopeVideoSizeCandidates(size, model);

  const parameterVariants = [];
  for (const sizeCandidate of sizeCandidates) {
    const withDuration = { size: sizeCandidate };
    if (useDuration) withDuration.duration = useDuration;
    if (normalizedAspectRatio) withDuration.aspect_ratio = normalizedAspectRatio;
    parameterVariants.push(withDuration);

    // Fixed-duration models fail with "duration customization is not supported".
    parameterVariants.push(
      normalizedAspectRatio ? { size: sizeCandidate, aspect_ratio: normalizedAspectRatio } : { size: sizeCandidate }
    );
  }
  parameterVariants.push(normalizedAspectRatio ? { aspect_ratio: normalizedAspectRatio } : {});

  const uniqVariants = [];
  const uniqKeys = new Set();
  for (const item of parameterVariants) {
    const key = JSON.stringify(item);
    if (uniqKeys.has(key)) continue;
    uniqKeys.add(key);
    uniqVariants.push(item);
  }

  const variantErrors = [];
  for (const parameters of uniqVariants) {
    const response = await fetch(`${origin}/api/v1/services/aigc/video-generation/video-synthesis`, {
      method: 'POST',
      headers: {
        ...createJsonHeaders(apiKey),
        'X-DashScope-Async': 'enable'
      },
      body: JSON.stringify({
        model,
        input,
        parameters
      })
    });

    if (!response.ok) {
      const raw = await response.text();
      const providerMessage = extractProviderMessage(raw) || response.statusText;
      variantErrors.push(`${JSON.stringify(parameters)}: ${providerMessage}`);
      continue;
    }

    const payload = await response.json();
    const meta = extractDashScopeTaskMeta(payload);
    if (!meta.taskId && !meta.videoUrl) {
      variantErrors.push(`${JSON.stringify(parameters)}: DashScope video generation returned no task id`);
      continue;
    }

    return {
      taskId: meta.taskId,
      status: meta.status,
      videoUrl: meta.videoUrl,
      errorMessage: meta.errorMessage,
      raw: payload
    };
  }

  throw new Error(variantErrors.join(' | ') || 'DashScope video generation failed');
}

function resolveAudioFileExt(mimeType) {
  const text = `${mimeType || ''}`.trim().toLowerCase();
  if (!text) return 'webm';
  if (text.includes('mpeg') || text.includes('mp3')) return 'mp3';
  if (text.includes('wav')) return 'wav';
  if (text.includes('ogg')) return 'ogg';
  if (text.includes('m4a') || text.includes('aac')) return 'm4a';
  if (text.includes('mp4')) return 'mp4';
  return 'webm';
}

function resolveAudioInputFormat(mimeType) {
  const text = `${mimeType || ''}`.trim().toLowerCase();
  if (!text) return 'wav';
  if (text.includes('wav')) return 'wav';
  if (text.includes('mpeg') || text.includes('mp3')) return 'mp3';
  if (text.includes('ogg')) return 'ogg';
  if (text.includes('webm')) return 'webm';
  if (text.includes('m4a') || text.includes('aac') || text.includes('mp4')) return 'm4a';
  return 'wav';
}

function extractTranscriptionText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [payload.text, payload.transcript, payload.result, payload?.output?.text, payload?.data?.text];
  for (const item of candidates) {
    const text = `${item || ''}`.trim();
    if (text) return text;
  }
  return '';
}

function normalizeHttpAudioUrlCandidates(candidates = []) {
  const list = [];
  for (const item of candidates) {
    const text = `${item || ''}`.trim();
    if (!text) continue;
    try {
      const parsed = new URL(text);
      if (!/^https?:$/i.test(parsed.protocol)) continue;
      if (!list.includes(parsed.toString())) {
        list.push(parsed.toString());
      }
    } catch (_error) {
      // Ignore malformed URLs.
    }
  }
  return list;
}

function extractDashScopeAsrTaskMeta(payload) {
  const output = payload?.output && typeof payload.output === 'object' ? payload.output : {};
  const result = output?.result && typeof output.result === 'object' ? output.result : {};

  const taskId =
    `${output?.task_id || ''}`.trim() ||
    `${output?.taskId || ''}`.trim() ||
    `${payload?.task_id || ''}`.trim() ||
    `${payload?.taskId || ''}`.trim();

  const status =
    `${output?.task_status || ''}`.trim() ||
    `${output?.status || ''}`.trim() ||
    `${payload?.status || ''}`.trim() ||
    `${payload?.task_status || ''}`.trim();

  const transcriptionUrl =
    `${result?.transcription_url || ''}`.trim() ||
    `${result?.transcriptionUrl || ''}`.trim() ||
    `${output?.transcription_url || ''}`.trim() ||
    `${output?.transcriptionUrl || ''}`.trim();

  return {
    taskId,
    status,
    transcriptionUrl
  };
}

function extractDashScopeAsrText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const list = Array.isArray(payload.transcripts) ? payload.transcripts : [];
  const chunks = [];
  for (const item of list) {
    const text = `${item?.text || ''}`.trim();
    if (text) chunks.push(text);
  }
  if (chunks.length) return chunks.join('\n').trim();

  const fallback = `${payload?.text || payload?.transcript || ''}`.trim();
  return fallback;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestSpeechTranscription({ apiKey, baseUrl, model, audioBase64, mimeType, language }) {
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!resolvedBaseUrl) {
    throw new AppError(500, 'Base URL for PRO mode is not configured');
  }

  const binary = Buffer.from(`${audioBase64 || ''}`.trim(), 'base64');
  if (!binary.length) {
    throw new AppError(400, 'Empty audio payload');
  }

  const extension = resolveAudioFileExt(mimeType);
  const fileMimeType = `${mimeType || ''}`.trim() || 'audio/webm';
  const fileName = `voice-message.${extension}`;

  const createForm = () => {
    const form = new FormData();
    const audioBlob = new Blob([binary], { type: fileMimeType });
    form.append('file', audioBlob, fileName);
    form.append('model', `${model || ''}`.trim());
    if (language) {
      form.append('language', `${language}`.trim().slice(0, 16));
    }
    return form;
  };

  const endpoints = ['/audio/transcriptions', '/audio/asr', '/audio/speech-to-text'];
  let lastEndpointError = null;

  for (const endpoint of endpoints) {
    let response = null;
    try {
      response = await fetch(`${resolvedBaseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        body: createForm()
      });
    } catch (error) {
      lastEndpointError = error;
      continue;
    }

    if (!response.ok) {
      const raw = await response.text();
      const providerMessage = extractProviderMessage(raw) || response.statusText;
      if (response.status === 404 || response.status === 405) {
        lastEndpointError = new Error(providerMessage || `ASR endpoint not found: ${endpoint}`);
        continue;
      }
      throw new Error(providerMessage);
    }

    const payload = await response.json();
    const transcript = extractTranscriptionText(payload);
    if (!transcript) {
      throw new Error('ASR provider returned an empty transcript');
    }

    return {
      transcript,
      raw: payload
    };
  }

  throw new Error(lastEndpointError?.message || 'ASR endpoint not found');
}

async function requestSpeechTranscriptionViaChat({
  apiKey,
  baseUrl,
  model,
  audioBase64,
  mimeType,
  language,
  audioUrlCandidates = []
}) {
  const urlCandidates = normalizeHttpAudioUrlCandidates(audioUrlCandidates);
  const normalizedAudio = `${audioBase64 || ''}`.trim();
  if (!normalizedAudio && !urlCandidates.length) {
    throw new AppError(400, 'Empty audio payload');
  }

  const audioFormat = resolveAudioInputFormat(mimeType);
  const fileMimeType = `${mimeType || ''}`.trim() || 'audio/webm';
  const languageHint = `${language || ''}`.trim();
  const instruction = languageHint
    ? `Transcribe this audio to plain text in ${languageHint}. Return only transcript text.`
    : 'Transcribe this audio to plain text. Return only transcript text.';

  const messageVariants = [];

  for (const url of urlCandidates) {
    // DashScope compatible qwen3-asr-flash accepts this minimal payload.
    messageVariants.push([{ role: 'user', content: [{ audio: url }] }]);
    // OpenAI-style audio_url for providers that support it.
    messageVariants.push([{ role: 'user', content: [{ type: 'audio_url', audio_url: { url } }] }]);
  }

  if (normalizedAudio) {
    messageVariants.push([
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          {
            type: 'input_audio',
            input_audio: {
              data: normalizedAudio,
              format: audioFormat
            }
          }
        ]
      }
    ]);
    messageVariants.push([
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          {
            type: 'audio_url',
            audio_url: {
              url: `data:${fileMimeType};base64,${normalizedAudio}`
            }
          }
        ]
      }
    ]);
  }

  let lastError = null;
  for (const messages of messageVariants) {
    try {
      const result = await requestChatCompletion({
        apiKey,
        baseUrl,
        model,
        messages,
        temperature: 0,
        maxTokens: 600
      });

      const transcript = `${result?.text || ''}`.trim();
      if (!transcript) {
        throw new Error('Chat ASR returned an empty transcript');
      }
      return {
        transcript,
        raw: result?.raw || null
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError?.message || 'Chat ASR fallback failed');
}

async function requestDashScopeFileTranscription({
  apiKey,
  baseUrl,
  model,
  fileUrl,
  language,
  pollAttempts = DASHSCOPE_ASR_POLL_ATTEMPTS,
  pollIntervalMs = DASHSCOPE_ASR_POLL_INTERVAL_MS
}) {
  const origin = resolveDashScopeOrigin(baseUrl);
  if (!origin) {
    throw new Error('DashScope origin is unavailable for file transcription');
  }
  const normalizedFileUrl = `${fileUrl || ''}`.trim();
  if (!normalizedFileUrl) {
    throw new Error('Public audio URL is required for file transcription');
  }

  const submitPayload = {
    model,
    input: {
      file_url: normalizedFileUrl
    },
    parameters: {
      enable_itn: false
    }
  };

  const normalizedLanguage = `${language || ''}`.trim();
  if (normalizedLanguage) {
    submitPayload.parameters.language = normalizedLanguage.slice(0, 16);
  }

  const submitRes = await fetch(`${origin}/api/v1/services/audio/asr/transcription`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable'
    },
    body: JSON.stringify(submitPayload)
  });

  if (!submitRes.ok) {
    const raw = await submitRes.text();
    const providerMessage = extractProviderMessage(raw) || submitRes.statusText;
    throw new Error(providerMessage);
  }

  const submitPayloadJson = await submitRes.json();
  const submitMeta = extractDashScopeAsrTaskMeta(submitPayloadJson);
  if (!submitMeta.taskId) {
    throw new Error('DashScope ASR returned no task id');
  }

  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    if (attempt > 0) {
      await wait(pollIntervalMs);
    }

    const pollRes = await fetch(`${origin}/api/v1/tasks/${encodeURIComponent(submitMeta.taskId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-DashScope-Async': 'enable',
        'Content-Type': 'application/json'
      }
    });

    if (!pollRes.ok) {
      const raw = await pollRes.text();
      const providerMessage = extractProviderMessage(raw) || pollRes.statusText;
      throw new Error(providerMessage);
    }

    const pollPayload = await pollRes.json();
    const pollMeta = extractDashScopeAsrTaskMeta(pollPayload);
    const status = `${pollMeta.status || ''}`.trim().toUpperCase();

    if (status === 'FAILED') {
      throw new Error(
        extractProviderMessage(JSON.stringify(pollPayload)) || 'DashScope ASR task failed'
      );
    }
    if (!['SUCCEEDED', 'SUCCESS', 'COMPLETED', 'DONE'].includes(status)) {
      continue;
    }

    if (!pollMeta.transcriptionUrl) {
      throw new Error('DashScope ASR task has no transcription url');
    }

    const transcriptRes = await fetch(pollMeta.transcriptionUrl, { method: 'GET' });
    if (!transcriptRes.ok) {
      const raw = await transcriptRes.text();
      throw new Error(extractProviderMessage(raw) || transcriptRes.statusText);
    }

    const transcriptPayload = await transcriptRes.json();
    const transcript = extractDashScopeAsrText(transcriptPayload);
    if (!transcript) {
      throw new Error('DashScope ASR returned an empty transcript');
    }

    return {
      transcript,
      raw: {
        submit: submitPayloadJson,
        poll: pollPayload,
        transcript: transcriptPayload
      }
    };
  }

  throw new Error('DashScope ASR task polling timeout');
}

async function requestSpeechSynthesis({ apiKey, baseUrl, model, input, voice = 'Cherry' }) {
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!resolvedBaseUrl) {
    throw new AppError(500, 'Base URL for PRO mode is not configured');
  }

  const response = await fetch(`${resolvedBaseUrl}/audio/speech`, {
    method: 'POST',
    headers: createJsonHeaders(apiKey),
    body: JSON.stringify({
      model,
      input,
      voice,
      response_format: 'mp3'
    })
  });

  if (!response.ok) {
    const raw = await response.text();
    const providerMessage = extractProviderMessage(raw) || response.statusText;
    throw new Error(providerMessage);
  }

  const contentType = `${response.headers.get('content-type') || ''}`.toLowerCase();
  if (contentType.includes('application/json')) {
    const payload = await response.json();
    const audioBase64 =
      `${payload?.audio || ''}`.trim() ||
      `${payload?.b64_json || ''}`.trim() ||
      `${payload?.data?.audio || ''}`.trim() ||
      `${payload?.data?.b64_json || ''}`.trim();

    if (!audioBase64) {
      throw new Error('TTS provider returned no audio payload');
    }

    return {
      audioBase64,
      mimeType: 'audio/mpeg',
      raw: payload
    };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    throw new Error('TTS provider returned an empty audio stream');
  }

  return {
    audioBase64: buffer.toString('base64'),
    mimeType: contentType || 'audio/mpeg',
    raw: null
  };
}

async function runChatWithFallback({
  apiKey,
  apiKeys,
  baseUrl,
  modelCandidates,
  messages,
  enableSearch = false,
  enableThinking = false,
  temperature,
  maxTokens
}) {
  const keyPool = normalizeApiKeys(apiKey, apiKeys);
  if (!keyPool.length) {
    throw new AppError(503, 'API key for PRO mode is not configured');
  }

  const resolvedCandidates = buildCandidateList(modelCandidates, []);
  if (!resolvedCandidates.length) {
    throw new AppError(502, 'PRO provider error: no model candidates');
  }

  const attempts = [];
  let lastError = null;

  for (const key of keyPool) {
    for (const model of resolvedCandidates) {
      try {
        const result = await requestChatCompletion({
          apiKey: key,
          baseUrl,
          model,
          messages,
          enableSearch,
          enableThinking,
          temperature,
          maxTokens
        });
        return {
          ...result,
          modelUsed: model,
          keyUsed: maskKey(key),
          attempts
        };
      } catch (error) {
        attempts.push({ model, key: maskKey(key), error: error.message });
        lastError = error;
      }
    }
  }

  const reason = lastError ? lastError.message : 'No model candidates';
  throw new AppError(502, `PRO provider error: ${reason}`, { attempts });
}

async function runChatStreamWithFallback({
  apiKey,
  apiKeys,
  baseUrl,
  modelCandidates,
  messages,
  enableSearch = false,
  enableThinking = false,
  temperature,
  maxTokens,
  onReasoning,
  onToken
}) {
  const keyPool = normalizeApiKeys(apiKey, apiKeys);
  if (!keyPool.length) {
    throw new AppError(503, 'API key for PRO mode is not configured');
  }

  const resolvedCandidates = buildCandidateList(modelCandidates, []);
  if (!resolvedCandidates.length) {
    throw new AppError(502, 'PRO provider error: no model candidates');
  }

  const attempts = [];
  let lastError = null;

  for (const key of keyPool) {
    for (const model of resolvedCandidates) {
      try {
        const result = await requestChatCompletionStream({
          apiKey: key,
          baseUrl,
          model,
          messages,
          enableSearch,
          enableThinking,
          temperature,
          maxTokens,
          onReasoning: (token) => {
            if (typeof onReasoning === 'function') {
              onReasoning(token);
            }
          },
          onToken: (token) => {
            if (typeof onToken === 'function') {
              onToken(token);
            }
          }
        });
        return {
          ...result,
          modelUsed: model,
          keyUsed: maskKey(key),
          attempts
        };
      } catch (error) {
        attempts.push({ model, key: maskKey(key), error: error.message });
        lastError = error;
      }
    }
  }

  const reason = lastError ? lastError.message : 'No model candidates';
  throw new AppError(502, `PRO provider error: ${reason}`, { attempts });
}

async function runImageGenerationWithFallback({ apiKey, apiKeys, baseUrl, modelCandidates, prompt, size }) {
  const keyPool = normalizeApiKeys(apiKey, apiKeys);
  if (!keyPool.length) {
    throw new AppError(503, 'API key for PRO mode is not configured');
  }

  const resolvedCandidates = buildCandidateList(modelCandidates, IMAGE_MODEL_FALLBACKS);
  if (!resolvedCandidates.length) {
    throw new AppError(502, 'PRO image provider error: no image models configured');
  }

  const attempts = [];
  let lastError = null;

  for (const key of keyPool) {
    for (const model of resolvedCandidates) {
      try {
        const result = await requestImageGeneration({
          apiKey: key,
          baseUrl,
          model,
          prompt,
          size
        });
        return {
          ...result,
          modelUsed: model,
          keyUsed: maskKey(key),
          attempts
        };
      } catch (error) {
        attempts.push({ model, key: maskKey(key), error: error.message });
        lastError = error;
      }
    }
  }

  // DashScope native fallback for models that are not exposed in compatible-mode image endpoint.
  if (resolveDashScopeOrigin(baseUrl)) {
    for (const key of keyPool) {
      for (const model of resolvedCandidates) {
        try {
          const result = await requestDashScopeImageGeneration({
            apiKey: key,
            baseUrl,
            model,
            prompt,
            size
          });
          return {
            ...result,
            modelUsed: model,
            keyUsed: maskKey(key),
            endpoint: 'dashscope:text2image',
            attempts
          };
        } catch (error) {
          attempts.push({
            model,
            key: maskKey(key),
            endpoint: 'dashscope:text2image',
            error: error.message
          });
          lastError = error;
        }
      }
    }
  }

  const reason = lastError ? lastError.message : 'No model candidates';
  throw new AppError(502, `PRO image provider error: ${reason}`, { attempts });
}

async function runImageEditWithFallback({
  apiKey,
  apiKeys,
  baseUrl,
  modelCandidates,
  prompt,
  imageUrl,
  size
}) {
  const keyPool = normalizeApiKeys(apiKey, apiKeys);
  if (!keyPool.length) {
    throw new AppError(503, 'API key for PRO mode is not configured');
  }

  const resolvedCandidates = buildCandidateList(modelCandidates, IMAGE_EDIT_MODEL_FALLBACKS);
  if (!resolvedCandidates.length) {
    throw new AppError(502, 'PRO image-edit provider error: no image-edit models configured');
  }

  const attempts = [];
  let lastError = null;

  for (const key of keyPool) {
    for (const model of resolvedCandidates) {
      try {
        const result = await requestImageEdit({
          apiKey: key,
          baseUrl,
          model,
          prompt,
          imageUrl,
          size
        });
        return {
          ...result,
          modelUsed: model,
          keyUsed: maskKey(key),
          attempts
        };
      } catch (error) {
        attempts.push({ model, key: maskKey(key), error: error.message });
        lastError = error;
      }
    }
  }

  if (resolveDashScopeOrigin(baseUrl)) {
    for (const key of keyPool) {
      for (const model of resolvedCandidates) {
        try {
          const result = await requestDashScopeImageEdit({
            apiKey: key,
            baseUrl,
            model,
            prompt,
            imageUrl,
            size
          });
          return {
            ...result,
            modelUsed: model,
            keyUsed: maskKey(key),
            endpoint: 'dashscope:image2image',
            attempts
          };
        } catch (error) {
          attempts.push({
            model,
            key: maskKey(key),
            endpoint: 'dashscope:image2image',
            error: error.message
          });
          lastError = error;
        }
      }
    }
  }

  const reason = lastError ? lastError.message : 'No model candidates';
  throw new AppError(502, `PRO image-edit provider error: ${reason}`, { attempts });
}

async function runVideoGenerationWithFallback({
  apiKey,
  apiKeys,
  baseUrl,
  modelCandidates,
  prompt,
  imageUrl,
  size,
  durationSeconds,
  aspectRatio
}) {
  const keyPool = normalizeApiKeys(apiKey, apiKeys);
  if (!keyPool.length) {
    throw new AppError(503, 'API key for PRO mode is not configured');
  }

  const dashScopeEnabled = Boolean(resolveDashScopeOrigin(baseUrl));
  const resolvedCandidates = filterVideoModelCandidatesByInput(
    buildCandidateList(modelCandidates, VIDEO_MODEL_FALLBACKS),
    { hasImage: Boolean(`${imageUrl || ''}`.trim()) }
  );
  if (!resolvedCandidates.length) {
    throw new AppError(502, 'PRO video provider error: no video models configured');
  }

  const attempts = [];
  let lastError = null;

  if (!dashScopeEnabled) {
    for (const key of keyPool) {
      for (const model of resolvedCandidates) {
        try {
          const result = await requestVideoGeneration({
            apiKey: key,
            baseUrl,
            model,
            prompt,
            imageUrl,
            size,
            durationSeconds,
            aspectRatio
          });
          return {
            ...result,
            modelUsed: model,
            keyUsed: maskKey(key),
            attempts
          };
        } catch (error) {
          attempts.push({ model, key: maskKey(key), error: error.message });
          lastError = error;
        }
      }
    }
  }

  if (dashScopeEnabled) {
    for (const key of keyPool) {
      for (const model of resolvedCandidates) {
        try {
          const result = await requestDashScopeVideoGeneration({
            apiKey: key,
            baseUrl,
            model,
            prompt,
            imageUrl,
            size,
            durationSeconds,
            aspectRatio
          });
          return {
            ...result,
            modelUsed: model,
            keyUsed: maskKey(key),
            endpoint: 'dashscope:video-synthesis',
            attempts
          };
        } catch (error) {
          attempts.push({
            model,
            key: maskKey(key),
            endpoint: 'dashscope:video-synthesis',
            error: error.message
          });
          lastError = error;
        }
      }
    }
  }

  const reason = lastError ? lastError.message : 'No model candidates';
  throw new AppError(502, `PRO video provider error: ${reason}`, { attempts });
}

async function runVideoTaskStatusWithFallback({ apiKey, apiKeys, baseUrl, taskId }) {
  const keyPool = normalizeApiKeys(apiKey, apiKeys);
  if (!keyPool.length) {
    throw new AppError(503, 'API key for PRO mode is not configured');
  }

  const dashScopeEnabled = Boolean(resolveDashScopeOrigin(baseUrl));
  const attempts = [];
  let lastError = null;

  if (dashScopeEnabled) {
    for (const key of keyPool) {
      try {
        const result = await requestDashScopeTaskStatus({
          apiKey: key,
          baseUrl,
          taskId
        });
        return {
          taskId: result.taskId || taskId,
          status: result.status || 'unknown',
          videoUrl: result.videoUrl || null,
          errorMessage: result.errorMessage || null,
          keyUsed: maskKey(key),
          endpoint: 'dashscope:tasks',
          attempts
        };
      } catch (error) {
        attempts.push({
          key: maskKey(key),
          endpoint: 'dashscope:tasks',
          error: error.message
        });
        lastError = error;
      }
    }
  }

  if (!dashScopeEnabled) {
    for (const key of keyPool) {
      try {
        const result = await requestVideoStatus({
          apiKey: key,
          baseUrl,
          taskId
        });
        return {
          ...result,
          keyUsed: maskKey(key),
          attempts
        };
      } catch (error) {
        attempts.push({ key: maskKey(key), error: error.message });
        lastError = error;
      }
    }
  }

  const reason = lastError ? lastError.message : 'No api keys';
  throw new AppError(502, `PRO video-status provider error: ${reason}`, { attempts });
}

async function runTranscriptionWithFallback({
  apiKey,
  apiKeys,
  baseUrl,
  modelCandidates,
  audioBase64,
  mimeType,
  language,
  audioUrlCandidates = []
}) {
  const keyPool = normalizeApiKeys(apiKey, apiKeys);
  if (!keyPool.length) {
    throw new AppError(503, 'API key for PRO mode is not configured');
  }

  const resolvedCandidates = buildCandidateList(modelCandidates, ASR_MODEL_FALLBACKS);
  if (!resolvedCandidates.length) {
    throw new AppError(502, 'PRO ASR provider error: no ASR models configured');
  }
  const publicAudioUrls = normalizeHttpAudioUrlCandidates(audioUrlCandidates);
  const dashScopeFileTransModels = buildCandidateList(
    resolvedCandidates.filter((model) => /filetrans/i.test(`${model || ''}`)),
    ASR_FILETRANS_MODEL_FALLBACKS
  );
  const dashScopeOrigin = resolveDashScopeOrigin(baseUrl);

  const attempts = [];
  let lastError = null;

  if (dashScopeOrigin && !publicAudioUrls.length) {
    attempts.push({
      endpoint: 'dashscope:filetrans',
      error: 'Public audio URL is unavailable (set APP_URL to a public https domain)'
    });
  }

  for (const key of keyPool) {
    for (const model of resolvedCandidates) {
      try {
        const result = await requestSpeechTranscription({
          apiKey: key,
          baseUrl,
          model,
          audioBase64,
          mimeType,
          language
        });
        return {
          ...result,
          modelUsed: model,
          keyUsed: maskKey(key),
          endpoint: 'audio/transcriptions',
          attempts
        };
      } catch (error) {
        attempts.push({ model, key: maskKey(key), error: error.message });
        lastError = error;

        try {
          const chatFallback = await requestSpeechTranscriptionViaChat({
            apiKey: key,
            baseUrl,
            model,
            audioBase64,
            mimeType,
            language,
            audioUrlCandidates: publicAudioUrls
          });
          return {
            ...chatFallback,
            modelUsed: model,
            keyUsed: maskKey(key),
            endpoint: 'chat/completions:audio',
            attempts
          };
        } catch (chatError) {
          attempts.push({
            model,
            key: maskKey(key),
            endpoint: 'chat/completions:audio',
            error: chatError.message
          });
          lastError = chatError;
        }
      }
    }
  }

  if (dashScopeOrigin && publicAudioUrls.length && dashScopeFileTransModels.length) {
    for (const key of keyPool) {
      for (const fileUrl of publicAudioUrls) {
        for (const model of dashScopeFileTransModels) {
          try {
            const dashScopeResult = await requestDashScopeFileTranscription({
              apiKey: key,
              baseUrl,
              model,
              fileUrl,
              language
            });
            return {
              ...dashScopeResult,
              modelUsed: model,
              keyUsed: maskKey(key),
              endpoint: 'dashscope:filetrans',
              attempts
            };
          } catch (dashScopeError) {
            attempts.push({
              model,
              key: maskKey(key),
              endpoint: 'dashscope:filetrans',
              fileUrl,
              error: dashScopeError.message
            });
            lastError = dashScopeError;
          }
        }
      }
    }
  }

  const reason = lastError
    ? lastError.message
    : dashScopeOrigin && !publicAudioUrls.length
    ? 'No public audio URL for DashScope filetrans (configure APP_URL or use a public backend URL)'
    : 'No ASR model candidates';
  throw new AppError(502, `PRO ASR provider error: ${reason}`, { attempts });
}

async function runSpeechSynthesisWithFallback({ apiKey, apiKeys, baseUrl, modelCandidates, input, voice }) {
  const keyPool = normalizeApiKeys(apiKey, apiKeys);
  if (!keyPool.length) {
    throw new AppError(503, 'API key for PRO mode is not configured');
  }

  const attempts = [];
  let lastError = null;

  for (const key of keyPool) {
    for (const model of modelCandidates) {
      try {
        const result = await requestSpeechSynthesis({
          apiKey: key,
          baseUrl,
          model,
          input,
          voice
        });
        return {
          ...result,
          modelUsed: model,
          keyUsed: maskKey(key),
          attempts
        };
      } catch (error) {
        attempts.push({ model, key: maskKey(key), error: error.message });
        lastError = error;
      }
    }
  }

  const reason = lastError ? lastError.message : 'No TTS model candidates';
  throw new AppError(502, `PRO TTS provider error: ${reason}`, { attempts });
}

module.exports = {
  runChatWithFallback,
  runChatStreamWithFallback,
  runImageGenerationWithFallback,
  runImageEditWithFallback,
  runVideoGenerationWithFallback,
  runVideoTaskStatusWithFallback,
  runTranscriptionWithFallback,
  runSpeechSynthesisWithFallback
};

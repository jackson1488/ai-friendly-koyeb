const { env } = require('../config/env');
const { AppError } = require('../utils/errors');

function extractProviderMessage(rawText) {
  const text = `${rawText || ''}`.trim();
  if (!text) return '';

  try {
    const parsed = JSON.parse(text);
    return (
      parsed?.error?.message ||
      parsed?.message ||
      parsed?.error?.metadata?.raw ||
      text
    );
  } catch (_error) {
    return text;
  }
}

function buildAiUnavailableMessage() {
  return 'Сейчас я временно недоступна. Возможно, есть технические неполадки или идёт обновление. Давайте продолжим чуть позже.';
}

function normalizeTemperature(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(2, number));
}

async function streamOpenRouterCompletion({ messages, model, apiKey, appTitle, onToken, temperature }) {
  const resolvedApiKey = (apiKey || env.openRouterApiKey || '').trim();
  if (!resolvedApiKey) {
    throw new AppError(500, 'На сервере не настроен OPENROUTER_API_KEY');
  }

  const controller = new AbortController();
  const timeoutMs = 90000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestBody = {
      model: model || env.openRouterModel,
      stream: true,
      messages
    };

    const safeTemperature = normalizeTemperature(temperature);
    if (safeTemperature !== null) {
      requestBody.temperature = safeTemperature;
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolvedApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost',
        'X-Title': appTitle || 'AI Friendly'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      const text = await response.text();
      const providerMessage = extractProviderMessage(text) || response.statusText;
      throw new AppError(502, `Ошибка OpenRouter: ${providerMessage}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

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

          try {
            const parsed = JSON.parse(payload);
            const token = parsed.choices?.[0]?.delta?.content || '';
            if (token) {
              onToken(token);
            }
          } catch (_error) {
            // Игнорируем некорректные частичные чанки.
          }
        }
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new AppError(504, 'OpenRouter не ответил вовремя, попробуйте еще раз');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  buildAiUnavailableMessage,
  streamOpenRouterCompletion
};

/**
 * Zero-dependency HTTP clients for OpenRouter (OpenAI-compatible) and Google Gemini
 * designed for Telegram Serverless `sdk/fetch` (no setTimeout, no Node APIs).
 */

function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, '');
}

async function readErrorSummary(res) {
  try {
    const body = await res.text();
    return body.length > 300 ? `${body.slice(0, 300)}...` : body;
  } catch {
    return res.statusText || 'unknown error';
  }
}

function extractOpenRouterText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

/**
 * Creates an OpenRouter chat completions client.
 */
export function createOpenRouterClient({ apiKey, baseUrl, model, fetchFn }) {
  return {
    async ask(messages) {
      if (!apiKey) {
        throw new Error('OpenRouter API key is not configured');
      }

      const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
        }),
      });

      if (!res.ok) {
        const detail = await readErrorSummary(res);
        throw new Error(`OpenRouter HTTP ${res.status}: ${detail}`);
      }

      const data = await res.json();
      return extractOpenRouterText(data);
    },
  };
}

/**
 * Converts normalized `{ role: 'system' | 'user' | 'assistant', content }` messages
 * to the Google Gemini `generateContent` payload, merging consecutive same-role turns.
 * Optionally attaches Google Search Grounding (`tools: [{ google_search: {} }]`).
 */
export function buildGeminiRequestBody(messages, { enableGoogleSearch = false } = {}) {
  const systemTexts = [];
  const contents = [];

  for (const msg of messages) {
    if (!msg || typeof msg.content !== 'string') {
      continue;
    }
    if (msg.role === 'system') {
      if (msg.content.trim().length > 0) {
        systemTexts.push(msg.content);
      }
      continue;
    }

    const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
    const prev = contents.length > 0 ? contents[contents.length - 1] : null;
    if (prev && prev.role === geminiRole) {
      prev.parts.push({ text: msg.content });
    } else {
      contents.push({ role: geminiRole, parts: [{ text: msg.content }] });
    }
  }

  const body = { contents };
  if (systemTexts.length > 0) {
    body.system_instruction = {
      parts: [{ text: systemTexts.join('\n\n') }],
    };
  }
  if (enableGoogleSearch) {
    body.tools = [{ google_search: {} }];
  }
  return body;
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return '';
  }
  return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

/**
 * Extracts up to `maxSources` deduplicated web grounding sources from a Gemini response.
 */
export function extractGeminiGroundingSources(data, maxSources = 3) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks) || maxSources <= 0) {
    return [];
  }

  const seenUris = new Set();
  const sources = [];
  for (const chunk of chunks) {
    const uri = typeof chunk?.web?.uri === 'string' ? chunk.web.uri.trim() : '';
    if (!uri || !/^https?:\/\//i.test(uri) || seenUris.has(uri)) {
      continue;
    }
    seenUris.add(uri);
    const title = typeof chunk?.web?.title === 'string' ? chunk.web.title.trim() : '';
    sources.push({ title, uri });
    if (sources.length >= maxSources) {
      break;
    }
  }
  return sources;
}

function appendGroundingSources(text, sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return text;
  }
  const lines = sources.map((source) =>
    source.title ? `• ${source.title} — ${source.uri}` : `• ${source.uri}`
  );
  return `${text}\n\nИсточники:\n${lines.join('\n')}`;
}

/**
 * Creates a Google Gemini REST API (`generateContent`) client.
 * Pass `enableGoogleSearch: true` to ground responses with Google Search.
 */
export function createGeminiClient({
  apiKey,
  baseUrl,
  model,
  fetchFn,
  enableGoogleSearch = false,
  maxGroundingSources = 3,
}) {
  return {
    async ask(messages) {
      if (!apiKey) {
        throw new Error('Gemini API key is not configured');
      }

      const url = `${normalizeBaseUrl(baseUrl)}/models/${encodeURIComponent(model)}:generateContent`;
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(buildGeminiRequestBody(messages, { enableGoogleSearch })),
      });

      if (!res.ok) {
        const detail = await readErrorSummary(res);
        throw new Error(`Gemini HTTP ${res.status}: ${detail}`);
      }

      const data = await res.json();
      const text = extractGeminiText(data);
      if (!enableGoogleSearch) {
        return text;
      }

      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return '';
      }

      const sources = extractGeminiGroundingSources(data, maxGroundingSources);
      return appendGroundingSources(trimmed, sources);
    },
  };
}

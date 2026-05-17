import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { settings } from '../db/schema';
import { buildAiReferencePrompt } from '../../shared/api-reference';
import type { AppDatabase } from '../db/index';

let _cachedSystemPrompt: string | undefined;

function getSystemPrompt(): string {
  if (!_cachedSystemPrompt) {
    _cachedSystemPrompt =
      'You are a code completion engine for TypeScript automation scripts that control Android devices via a DeviceAPI. ' +
      'You receive code context with a `<CURSOR>` marker. Return ONLY the code that should be inserted at the cursor position. ' +
      'No explanations, no markdown fences, no repeating existing code.' +
      buildAiReferencePrompt();
  }
  return _cachedSystemPrompt;
}

const SYSTEM_PROMPT = getSystemPrompt();

function getSetting(db: AppDatabase, key: string): string | undefined {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .all()[0];
  return row?.value || undefined;
}

async function callAnthropic(apiKey: string, prefix: string, suffix: string): Promise<string> {
  const userMessage = `${prefix}<CURSOR>${suffix}`;
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      temperature: 0,
      stop_sequences: ['\n\n\n'],
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errorBody}`);
  }

  const data: any = await response.json();
  return data.content?.[0]?.text || '';
}

async function callGemini(apiKey: string, prefix: string, suffix: string): Promise<string> {
  const userMessage = `${prefix}<CURSOR>${suffix}`;
  const model = 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: 256, temperature: 0 },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorBody}`);
  }

  const data: any = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callOllama(baseUrl: string, model: string, prefix: string, suffix: string): Promise<string> {
  const userMessage = `${prefix}<CURSOR>${suffix}`;
  const url = `${baseUrl}/api/chat`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Ollama API error (${response.status}): ${errorBody}`);
  }

  const data: any = await response.json();
  return data.message?.content || '';
}

async function callOpenRouter(apiKey: string, model: string, prefix: string, suffix: string): Promise<string> {
  const userMessage = `${prefix}<CURSOR>${suffix}`;
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 256,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${errorBody}`);
  }

  const data: any = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callCodestral(apiKey: string, prefix: string, suffix: string): Promise<string> {
  const response = await fetch('https://codestral.mistral.ai/v1/fim/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'codestral-latest',
      prompt: prefix,
      suffix,
      max_tokens: 256,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Codestral API error (${response.status}): ${errorBody}`);
  }

  const data: any = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

export function registerAiCompleteEndpoints(db: AppDatabase): void {
  registerEndpoint('POST', '/v1/ai/complete', async (req, res) => {
    const { prefix, suffix, language } = req.body || {};

    if (!prefix && !suffix) {
      res.status(400).json({ success: false, error: 'prefix or suffix is required' });
      return;
    }

    const provider = getSetting(db, 'ai_provider') || '';
    if (!provider) {
      res.status(400).json({ success: false, error: 'No AI provider configured' });
      return;
    }

    try {
      let completion: string;
      const p = prefix || '';
      const s = suffix || '';

      switch (provider) {
        case 'anthropic': {
          const apiKey = getSetting(db, 'anthropic_api_key');
          if (!apiKey) {
            res.status(400).json({ success: false, error: 'Anthropic API key not configured' });
            return;
          }
          completion = await callAnthropic(apiKey, p, s);
          break;
        }
        case 'gemini': {
          const apiKey = getSetting(db, 'gemini_api_key');
          if (!apiKey) {
            res.status(400).json({ success: false, error: 'Gemini API key not configured' });
            return;
          }
          completion = await callGemini(apiKey, p, s);
          break;
        }
        case 'ollama': {
          const baseUrl = getSetting(db, 'ollama_base_url') || 'http://localhost:11434';
          const model = getSetting(db, 'ollama_model') || 'qwen2.5-coder:1.5b';
          completion = await callOllama(baseUrl, model, p, s);
          break;
        }
        case 'openrouter': {
          const apiKey = getSetting(db, 'openrouter_api_key');
          if (!apiKey) {
            res.status(400).json({ success: false, error: 'OpenRouter API key not configured' });
            return;
          }
          const model = getSetting(db, 'openrouter_model') || 'google/gemini-2.0-flash-001';
          completion = await callOpenRouter(apiKey, model, p, s);
          break;
        }
        case 'codestral': {
          const apiKey = getSetting(db, 'codestral_api_key');
          if (!apiKey) {
            res.status(400).json({ success: false, error: 'Codestral API key not configured' });
            return;
          }
          completion = await callCodestral(apiKey, p, s);
          break;
        }
        default:
          res.status(400).json({ success: false, error: `Unknown AI provider: ${provider}` });
          return;
      }

      res.json({ success: true, data: { completion } });
    } catch (err: any) {
      const message = err.message || String(err);
      if (message.includes('API error')) {
        res.status(502).json({ success: false, error: message });
      } else {
        res.status(500).json({ success: false, error: `Failed to reach AI provider: ${message}` });
      }
    }
  });
}

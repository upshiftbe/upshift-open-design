import type { AppConfig, ChatMessage } from '../types';
import type { StreamHandlers } from './anthropic';

/** POST body for `/api/openai-chat` — same shape the daemon proxy expects. */
function buildOpenAiChatPayload(
  cfg: Pick<AppConfig, 'baseUrl' | 'apiKey' | 'model'>,
  system: string,
  history: ChatMessage[],
): Record<string, unknown> {
  const messages: { role: string; content: string }[] = [];
  if (system.trim()) {
    messages.push({ role: 'system', content: system.trim() });
  }
  for (const m of history) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    messages.push({ role: m.role, content: m.content });
  }
  return {
    baseUrl: cfg.baseUrl.trim(),
    apiKey: cfg.apiKey.trim(),
    model: cfg.model.trim(),
    messages,
  };
}

/**
 * Stream chat via the daemon's OpenAI-compatible proxy (avoids browser CORS
 * to localhost LLM servers).
 */
export async function streamOpenAiCompatible(
  cfg: AppConfig,
  system: string,
  history: ChatMessage[],
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  if (!cfg.model.trim() || !cfg.baseUrl.trim()) {
    handlers.onError(new Error('Set model and base URL in Settings.'));
    return;
  }

  const body = JSON.stringify(buildOpenAiChatPayload(cfg, system, history));
  let acc = '';

  try {
    const resp = await fetch('/api/openai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal,
    });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      let msg = `Local LLM proxy ${resp.status}`;
      try {
        const j = JSON.parse(text) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        if (text) msg = text.slice(0, 500);
      }
      handlers.onError(new Error(msg));
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trimEnd();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trimStart();
        if (payload === '[DONE]') continue;
        let json: unknown;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const chunk = extractOpenAiDeltaText(json);
        if (chunk) {
          acc += chunk;
          handlers.onDelta(chunk);
        }
      }
    }

    const tail = lineBuf.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trimStart();
      if (payload && payload !== '[DONE]') {
        try {
          const json = JSON.parse(payload);
          const chunk = extractOpenAiDeltaText(json);
          if (chunk) {
            acc += chunk;
            handlers.onDelta(chunk);
          }
        } catch {
          /* ignore */
        }
      }
    }

    handlers.onDone(acc);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    handlers.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

function extractOpenAiDeltaText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const delta = (choices[0] as { delta?: unknown })?.delta;
  if (!delta || typeof delta !== 'object') return '';
  const content = (delta as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

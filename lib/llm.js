// lib/llm.js — клиент к LM Studio (OpenAI-совместимый API)
// LM Studio поднимает локальный сервер на /v1/chat/completions.
// Доступ к машине с GPU идёт через Tailscale-туннель по её tailnet-IP.

const BASE_URL = process.env.LLM_BASE_URL || 'http://127.0.0.1:1234/v1';
const MODEL = process.env.LLM_MODEL || 'qwen3-8b';
const TEMPERATURE = Number(process.env.LLM_TEMPERATURE || 0.3);

export function getModelName() {
  return MODEL;
}

// Потоковый фильтр блоков <think>...</think> (рассуждения Qwen3).
// Работает на лету: скрывает содержимое think-блоков, корректно
// обрабатывает теги, разорванные между чанками стрима.
export function createThinkStripper(onText) {
  const OPEN = '<think>', CLOSE = '</think>';
  let buf = '', inThink = false, started = false;

  function emit(text) {
    if (!started) {
      text = text.replace(/^\s+/, ''); // убираем пустые строки после </think>
      if (!text) return;
      started = true;
    }
    onText(text);
  }

  function process(final) {
    while (true) {
      if (inThink) {
        const i = buf.indexOf(CLOSE);
        if (i === -1) {
          // ждём закрывающий тег; храним только хвост на случай разрыва тега
          buf = final ? '' : buf.slice(-(CLOSE.length - 1));
          return;
        }
        buf = buf.slice(i + CLOSE.length);
        inThink = false;
      } else {
        const i = buf.indexOf(OPEN);
        if (i !== -1) {
          if (i > 0) emit(buf.slice(0, i));
          buf = buf.slice(i + OPEN.length);
          inThink = true;
          continue;
        }
        // придерживаем возможное начало разорванного тега "<thi..."
        let hold = 0;
        if (!final) {
          for (let k = Math.min(OPEN.length - 1, buf.length); k > 0; k--) {
            if (buf.endsWith(OPEN.slice(0, k))) { hold = k; break; }
          }
        }
        const out = buf.slice(0, buf.length - hold);
        if (out) emit(out);
        buf = buf.slice(buf.length - hold);
        return;
      }
    }
  }

  return {
    push(delta) { buf += delta; process(false); },
    flush() { process(true); }
  };
}

// Потоковая генерация. onToken вызывается на каждый фрагмент текста.
// Возвращает полный текст ответа.
export async function streamChat(messages, onToken) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: TEMPERATURE,
      max_tokens: 1024,
      stream: true
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LM Studio вернул ${res.status}: ${body.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE-формат: строки "data: {...}\n\n"
    const lines = buffer.split('\n');
    buffer = lines.pop(); // незавершённая строка остаётся в буфере

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onToken(delta);
        }
      } catch {
        // неполный JSON — пропускаем
      }
    }
  }
  return full;
}

// Проверка доступности LLM-сервера (для страницы статуса)
export async function healthCheck() {
  try {
    const res = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, models: (data.data || []).map(m => m.id) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

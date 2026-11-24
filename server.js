// server.js — точка входа
// Клиент-серверная архитектура:
//   Браузер (public/) → этот сервер → LM Studio (через Tailscale)
//
// Сервер выполняет обогащение запроса (RAG): ищет релевантные фрагменты
// в базе знаний и подставляет их в системный промт локальной LLM.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Простая загрузка .env без сторонних пакетов
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
    if (m && !line.trim().startsWith('#')) process.env[m[1]] = m[2];
  }
}

const { db, listDocuments, getDocument, insertDocument, deleteDocument,
        allChunks, logRequest, listLogs, logStats } =
  await import('./lib/db.js');
const { chunkDocument, searchChunks, buildSystemPrompt } =
  await import('./lib/rag.js');
const { streamChat, healthCheck, getModelName, createThinkStripper } =
  await import('./lib/llm.js');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const TOP_K = Number(process.env.RAG_TOP_K || 4);

// ---------- Чат (SSE-стриминг) ----------
app.post('/api/chat', async (req, res) => {
  const { question, history = [] } = req.body || {};
  if (!question?.trim()) {
    return res.status(400).json({ error: 'Пустой вопрос' });
  }

  // 1. Retrieval: ищем релевантные фрагменты базы знаний
  const chunks = allChunks();
  const relevant = searchChunks(question, chunks, TOP_K);
  const systemPrompt = buildSystemPrompt(relevant);

  // 2. Собираем сообщения: система + короткая история + вопрос
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6), // последние 3 пары реплик
    { role: 'user', content: question }
  ];

  // 3. SSE-ответ клиенту
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sources = [];
  for (const c of relevant) {
    if (!sources.some(s => s.title === c.title)) {
      sources.push({ title: c.title, category: c.category, score: Number(c.score.toFixed(2)) });
    }
  }
  res.write(`event: sources\ndata: ${JSON.stringify(sources)}\n\n`);

  const t0 = Date.now();
  let answer = ''; // чистый ответ без <think>-блоков
  const stripper = createThinkStripper(text => {
    answer += text;
    res.write(`event: token\ndata: ${JSON.stringify(text)}\n\n`);
  });
  try {
    await streamChat(messages, delta => stripper.push(delta));
    stripper.flush();
    const latency = Date.now() - t0;
    logRequest({ question, answer, sources, latency_ms: latency, model: getModelName() });
    res.write(`event: done\ndata: ${JSON.stringify({ latency_ms: latency })}\n\n`);
  } catch (e) {
    logRequest({ question, answer: answer ? answer + ` [ОШИБКА] ${e.message}` : `[ОШИБКА] ${e.message}`,
                 sources, latency_ms: Date.now() - t0, model: getModelName() });
    res.write(`event: error\ndata: ${JSON.stringify(e.message)}\n\n`);
  }
  res.end();
});

// ---------- База знаний ----------
app.get('/api/documents', (req, res) => res.json(listDocuments()));

app.get('/api/documents/:id', (req, res) => {
  const doc = getDocument(Number(req.params.id));
  if (!doc) return res.status(404).json({ error: 'Документ не найден' });
  res.json(doc);
});

app.post('/api/documents', (req, res) => {
  const { title, category = 'Общее', content } = req.body || {};
  if (!title?.trim() || !content?.trim()) {
    return res.status(400).json({ error: 'Нужны заголовок и текст документа' });
  }
  const chunks = chunkDocument(content);
  const id = insertDocument(title.trim(), category.trim(), content, chunks);
  res.json({ id, chunks: chunks.length });
});

app.delete('/api/documents/:id', (req, res) => {
  deleteDocument(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Журнал и статус ----------
app.get('/api/logs', (req, res) => res.json(listLogs(200)));
app.get('/api/stats', (req, res) => res.json(logStats()));
app.get('/api/health', async (req, res) => {
  const llm = await healthCheck();
  res.json({
    server: 'ok',
    model: getModelName(),
    llm,
    documents: listDocuments().length
  });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`\n  Ассистент IT-поддержки запущен: http://localhost:${PORT}`);
  console.log(`  Админ-панель базы знаний:      http://localhost:${PORT}/admin.html`);
  console.log(`  LLM-сервер: ${process.env.LLM_BASE_URL || 'http://127.0.0.1:1234/v1'} (${getModelName()})\n`);
});

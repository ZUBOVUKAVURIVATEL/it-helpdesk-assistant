// scripts/mock-llm.js — имитация LM Studio для отладки без GPU.
// Эмулирует OpenAI-совместимый API со стримингом.
// Запуск: node scripts/mock-llm.js  (порт 1234)

import http from 'http';

http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-qwen3-8b' }] }));
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { messages } = JSON.parse(body);
      const sys = messages.find(m => m.role === 'system')?.content || '';
      const hasKB = sys.includes('Фрагмент 1');
      const reply = hasKB
        ? '<think>рассуждаю про принтер</think>\n\n[MOCK] Отвечаю по базе знаний. Первый найденный документ: ' +
          (sys.match(/документ: «([^»]+)»/)?.[1] || '?') + '. Шаги: 1. … 2. …'
        : '[MOCK] В базе знаний нет ответа. Создайте заявку в IT-отдел (вн. 1024).';

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const words = reply.split(' ');
      let i = 0;
      const timer = setInterval(() => {
        if (i < words.length) {
          const chunk = { choices: [{ delta: { content: words[i++] + ' ' } }] };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        } else {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 20);
    });
    return;
  }

  res.writeHead(404); res.end();
}).listen(1234, () => console.log('Mock LM Studio: http://localhost:1234/v1'));

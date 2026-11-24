// scripts/evaluate.js — прогон тестовых вопросов для главы «Тестирование».
//
// Скрипт отправляет набор вопросов на работающий сервер (npm start должен
// быть запущен) и сохраняет результаты в eval-results.csv:
// вопрос | найденные источники | время ответа | ответ модели.
//
// Дальше ответы оцениваются вручную по шкале (например: 2 — решает проблему,
// 1 — частично, 0 — не решает / выдумка) и сводятся в таблицу для диплома.
//
// Запуск: npm run eval

import fs from 'fs';

const SERVER = process.env.EVAL_SERVER || 'http://localhost:3000';

const questions = [
  // --- вопросы, покрытые базой знаний ---
  'Принтер не печатает, что делать?',
  'Документы зависли в очереди печати',
  'Как подключиться к VPN из дома?',
  'VPN пишет неверные учётные данные',
  'Как настроить рабочую почту на айфоне?',
  'Какие параметры IMAP сервера для почты?',
  'Забыл пароль от компьютера',
  'Учётная запись заблокировалась, что делать?',
  'Как подключиться к вайфаю в офисе?',
  'Wi-Fi подключён но интернета нет',
  'Как установить программу на рабочий компьютер?',
  'Мне нужны права администратора',
  'Компьютер очень медленно работает',
  'Диск C переполнен, что удалить?',
  'Как подключить второй монитор к ноутбуку?',
  'Изображение на мониторе размытое',
  // --- переформулировки (проверка устойчивости поиска) ---
  'Ничего не распечатывается((',
  'Хочу работать из дома, как попасть во внутреннюю сеть?',
  'Винда просит сменить пароль, какие требования?',
  'Ноут не видит второй экран',
  // --- вопросы ВНЕ базы знаний (модель должна честно отказаться) ---
  'Как настроить видеонаблюдение в серверной?',
  'Какая зарплата у сисадмина?',
  'Напиши стихотворение про принтер',
  'Как починить кофемашину на кухне?'
];

function csvEscape(s) {
  return '"' + String(s).replace(/"/g, '""').replace(/\r?\n/g, ' \\n ') + '"';
}

const rows = [['№', 'Вопрос', 'Источники', 'Время, с', 'Ответ', 'Оценка (заполнить вручную)']];

console.log(`Тестирование против ${SERVER}, вопросов: ${questions.length}\n`);

for (let i = 0; i < questions.length; i++) {
  const q = questions[i];
  process.stdout.write(`[${i + 1}/${questions.length}] ${q.slice(0, 50)}... `);

  try {
    const res = await fetch(`${SERVER}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q })
    });

    const text = await res.text();
    // разбор SSE-ответа
    let answer = '', sources = [], latency = null;
    for (const ev of text.split('\n\n')) {
      const type = ev.match(/^event: (\w+)/m)?.[1];
      const data = ev.match(/^data: (.*)$/m)?.[1];
      if (!type || data === undefined) continue;
      if (type === 'token') answer += JSON.parse(data);
      if (type === 'sources') sources = JSON.parse(data).map(s => s.title);
      if (type === 'done') latency = JSON.parse(data).latency_ms;
    }

    rows.push([i + 1, q, sources.join('; ') || '—',
               latency ? (latency / 1000).toFixed(1) : '—', answer, '']);
    console.log(`ok (${latency ? (latency/1000).toFixed(1) + ' c' : '—'})`);
  } catch (e) {
    rows.push([i + 1, q, 'ОШИБКА', '—', e.message, '']);
    console.log('ошибка: ' + e.message);
  }
}

const csv = '\uFEFF' + rows.map(r => r.map(csvEscape).join(';')).join('\n');
fs.writeFileSync('eval-results.csv', csv);
console.log('\nРезультаты сохранены в eval-results.csv (открывается в Excel).');
console.log('Заполните колонку «Оценка» вручную: 2 — решает, 1 — частично, 0 — нет.');

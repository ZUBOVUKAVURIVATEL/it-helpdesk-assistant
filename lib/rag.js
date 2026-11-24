// lib/rag.js — упрощённый RAG (Retrieval-Augmented Generation)
//
// Идея: документы режутся на чанки (фрагменты), текст нормализуется
// (нижний регистр, отсечение окончаний), а при запросе пользователя
// чанки ранжируются по совпадению термов + бонус за совпадение с заголовком.
// Топ-K чанков подставляются в системный промт модели.
//
// Это лексический (keyword) поиск, а не векторный. Для базы из десятков
// инструкций он работает надёжно, не требует эмбеддингов и полностью
// объясним на защите.

const STOP_WORDS = new Set([
  'и','в','во','не','что','он','на','я','с','со','как','а','то','все','она',
  'так','его','но','да','ты','к','у','же','вы','за','бы','по','ее','мне',
  'было','вот','от','меня','еще','нет','о','из','ему','мой','мне','быть',
  'для','это','или','если','при','чтобы','можно','нужно','надо','есть',
  'the','a','an','of','to','in','is','it','my','how','what','do','i'
]);

// Грубый стемминг русского: отсекаем типовые окончания.
// Не Snowball, но для сопоставления "принтера/принтером/принтеру" хватает.
const RU_ENDINGS = [
  'иями','ями','ами','ией','иях','ях','ах','ов','ев','ей','ой','ою','ый',
  'ий','ая','яя','ое','ее','ым','им','ом','ем','ах','ую','юю','ых','их',
  'ет','ут','ют','ит','ат','ят','ла','ло','ли','ть','ся','сь',
  'а','я','о','е','ы','и','у','ю','ь'
];

export function normalizeToken(word) {
  let w = word.toLowerCase().replace(/ё/g, 'е');
  if (w.length <= 3) return w;
  for (const end of RU_ENDINGS) {
    if (w.length - end.length >= 3 && w.endsWith(end)) {
      w = w.slice(0, -end.length);
      break;
    }
  }
  return w;
}

// Разговорные варианты → термины из документации (после нормализации)
const SYNONYMS = {
  'вайфа': ['wi', 'fi'], 'вайфай': ['wi', 'fi'], 'вифи': ['wi', 'fi'], 'wifi': ['wi', 'fi'],
  'ноут': ['ноутбук'], 'комп': ['компьютер'], 'пк': ['компьютер'],
  'винд': ['windows'], 'виндовс': ['windows'],
  'инет': ['интернет'], 'нет': ['интернет'],
  'экран': ['монитор'], 'печат': ['принтер'],
  'учетк': ['учетн', 'запис'], 'аккаунт': ['учетн', 'запис'],
  'мыл': ['почт'], 'email': ['почт'], 'мейл': ['почт']
};

export function tokenize(text) {
  const base = (text.toLowerCase().match(/[a-zа-яё0-9]+/gi) || [])
    .filter(t => !STOP_WORDS.has(t) && t.length > 1)
    .map(normalizeToken);
  const expanded = [];
  for (const t of base) {
    expanded.push(t);
    if (SYNONYMS[t]) expanded.push(...SYNONYMS[t]);
  }
  return expanded;
}

// Разбивка документа на чанки по абзацам, склеивая мелкие до ~maxLen символов.
export function chunkDocument(content, maxLen = 900) {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean);

  const chunks = [];
  let buf = '';
  for (const p of paragraphs) {
    if ((buf + '\n\n' + p).length > maxLen && buf) {
      chunks.push(buf.trim());
      buf = p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());

  return chunks.map(text => ({ text, tokens: tokenize(text) }));
}

// Ранжирование: TF-совпадение термов запроса с чанком + бонус за заголовок.
export function searchChunks(query, chunks, topK = 4) {
  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0) return [];

  const scored = chunks.map(ch => {
    const chunkTokens = ch.tokens.split(' ');
    const tokenSet = new Set(chunkTokens);
    const titleTokens = new Set(tokenize(ch.title));

    let score = 0;
    for (const qt of qTokens) {
      if (tokenSet.has(qt)) {
        // частота терма в чанке, с насыщением
        const tf = chunkTokens.filter(t => t === qt).length;
        score += 1 + Math.min(tf, 3) * 0.25;
      }
      if (titleTokens.has(qt)) score += 2; // заголовок весит больше
    }
    // нормализация на длину запроса
    return { ...ch, score: score / qTokens.length };
  });

  return scored
    .filter(c => c.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// Сборка системного промта с контекстом из базы знаний
export function buildSystemPrompt(relevantChunks) {
  const header = `Ты — корпоративный ассистент IT-поддержки первой линии. Отвечай на русском языке, кратко и по шагам. Твоя задача — помочь сотруднику решить типовую проблему с рабочим местом.

Правила:
1. Отвечай ТОЛЬКО на основе базы знаний ниже. Не придумывай шаги, которых там нет.
2. Если в базе знаний нет ответа на вопрос — честно скажи об этом и посоветуй создать заявку в IT-отдел (внутренний номер 1024 или helpdesk@company.local).
3. Формулируй шаги нумерованным списком, коротко.
4. Не запрашивай и не обсуждай пароли и другие секретные данные.
5. Если вопрос не связан с IT-поддержкой — вежливо откажись и напомни своё назначение.`;

  if (relevantChunks.length === 0) {
    return header + '\n\n=== БАЗА ЗНАНИЙ ===\n(по запросу ничего не найдено)';
  }

  const kb = relevantChunks
    .map((c, i) => `--- Фрагмент ${i + 1} (документ: «${c.title}», раздел: ${c.category}) ---\n${c.text}`)
    .join('\n\n');

  return `${header}\n\n=== БАЗА ЗНАНИЙ ===\n${kb}`;
}

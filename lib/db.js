// lib/db.js — слой данных на SQLite
// Хранит: документы базы знаний, их чанки (фрагменты) и журнал обращений.

import { DatabaseSync } from "node:sqlite";
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'helpdesk.db');

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Общее',
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    tokens TEXT NOT NULL -- нормализованные термы через пробел (для поиска)
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    question TEXT NOT NULL,
    answer TEXT,
    sources TEXT,          -- JSON: какие документы попали в контекст
    latency_ms INTEGER,
    model TEXT
  );
`);

// --- Документы ---

export function listDocuments() {
  return db.prepare(
    `SELECT d.id, d.title, d.category, d.created_at,
            length(d.content) AS size,
            (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) AS chunk_count
     FROM documents d ORDER BY d.category, d.title`
  ).all();
}

export function getDocument(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

export function insertDocument(title, category, content, chunks) {
  db.exec('BEGIN');
  try {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO documents (title, category, content) VALUES (?, ?, ?)')
      .run(title, category, content);
    const ins = db.prepare(
      'INSERT INTO chunks (document_id, text, tokens) VALUES (?, ?, ?)'
    );
    for (const ch of chunks) ins.run(lastInsertRowid, ch.text, ch.tokens.join(' '));
    db.exec('COMMIT');
    return lastInsertRowid;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function deleteDocument(id) {
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
}

export function allChunks() {
  return db.prepare(
    `SELECT c.id, c.document_id, c.text, c.tokens, d.title, d.category
     FROM chunks c JOIN documents d ON d.id = c.document_id`
  ).all();
}

// --- Журнал обращений ---

export function logRequest({ question, answer, sources, latency_ms, model }) {
  db.prepare(
    `INSERT INTO logs (question, answer, sources, latency_ms, model)
     VALUES (?, ?, ?, ?, ?)`
  ).run(question, answer, JSON.stringify(sources), latency_ms, model);
}

export function listLogs(limit = 100) {
  return db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
}

export function logStats() {
  return db.prepare(
    `SELECT count(*) AS total,
            round(avg(latency_ms)) AS avg_latency,
            min(latency_ms) AS min_latency,
            max(latency_ms) AS max_latency
     FROM logs WHERE latency_ms IS NOT NULL`
  ).get();
}

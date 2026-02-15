const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let db;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function getDb() {
  if (db) return db;

  const dbPath = requireEnv('DB_PATH');
  ensureDir(path.dirname(dbPath));

  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  return db;
}

async function run(sql, params = []) {
  const stmt = getDb().prepare(sql);
  const result = stmt.run(...params);
  return {
    lastID: Number(result.lastInsertRowid),
    changes: result.changes,
  };
}

async function get(sql, params = []) {
  const stmt = getDb().prepare(sql);
  return stmt.get(...params);
}

async function all(sql, params = []) {
  const stmt = getDb().prepare(sql);
  return stmt.all(...params);
}

function closeDb() {
  if (!db) return;
  db.close();
  db = undefined;
}

module.exports = { getDb, run, get, all, closeDb };

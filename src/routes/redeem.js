const express = require('express');
const { getDb } = require('../db');

const router = express.Router();
const db = getDb();

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function tableExists(name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1")
    .get(name);
  return Boolean(row);
}

function getColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all();
}

function ensureColumn(tableName, columnName, definitionSql) {
  const columns = new Set(getColumns(tableName).map((column) => column.name));
  if (columns.has(columnName)) return;
  db.exec(`ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${definitionSql}`);
}

function pickColumn(tableName, candidates) {
  const columns = new Set(getColumns(tableName).map((column) => column.name));
  return candidates.find((name) => columns.has(name)) || null;
}

function getBatchOpenStatus() {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='redeem_batches' LIMIT 1")
    .get();
  const ddl = String(row?.sql || '').toUpperCase();
  if (ddl.includes("'OPEN'")) return 'OPEN';
  return 'ACTIVE';
}

function ensureRedeemSchema() {
  if (!tableExists('redeem_batches')) {
    db.exec(`
      CREATE TABLE redeem_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        codes_json TEXT NOT NULL,
        claimed_code TEXT,
        status TEXT NOT NULL DEFAULT 'OPEN',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  ensureColumn('redeem_batches', 'codes_json', "codes_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('redeem_batches', 'claimed_code', 'claimed_code TEXT');

  if (!tableExists('redeem_credits')) {
    db.exec(`
      CREATE TABLE redeem_credits (
        user_id INTEGER PRIMARY KEY,
        credits INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  ensureColumn('redeem_credits', 'created_at', "created_at TEXT NOT NULL DEFAULT (datetime('now'))");
  db.exec("UPDATE redeem_credits SET created_at = COALESCE(created_at, datetime('now'))");
}

ensureRedeemSchema();

const BATCH_OPEN_STATUS = getBatchOpenStatus();
const TAG_CODE_COLUMN = pickColumn('tags', ['unique_code']);
const TAG_NAME_COLUMN = pickColumn('tags', ['tag_name']);
const TAG_ACTIVE_COLUMN = pickColumn('tags', ['is_active']);
const TAG_ENABLED_COLUMN = pickColumn('tags', ['enabled']);

function getSessionUserId(req) {
  return req.session?.userId || req.session?.user_id || null;
}

function requireLogin(req, res, next) {
  if (!getSessionUserId(req)) {
    return res.status(401).json({ ok: false, error: 'Not logged in' });
  }
  return next();
}

function toDisplay444(code12) {
  return `${code12.slice(0, 4)}-${code12.slice(4, 8)}-${code12.slice(8, 12)}`;
}

function parseCodesJson(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item));
  } catch (error) {
    return [];
  }
}

function randomCode12() {
  const n = Math.floor(Math.random() * 1000000000000);
  return String(n).padStart(12, '0');
}

function isCodeUsedInTags(code12) {
  if (!TAG_CODE_COLUMN) return false;
  const row = db
    .prepare(`SELECT 1 FROM tags WHERE ${quoteIdent(TAG_CODE_COLUMN)} = ? LIMIT 1`)
    .get(code12);
  return Boolean(row);
}

function getReservedOpenCodes() {
  const rows = db
    .prepare('SELECT codes_json FROM redeem_batches WHERE status = ?')
    .all(BATCH_OPEN_STATUS);

  const reserved = new Set();
  for (const row of rows) {
    const codes = parseCodesJson(row.codes_json);
    for (const code of codes) {
      if (/^\d{12}$/.test(code)) reserved.add(code);
    }
  }

  return reserved;
}

function generateCodes() {
  const result = [];
  const inBatch = new Set();
  const reserved = getReservedOpenCodes();

  for (let i = 0; i < 5; i += 1) {
    let generated = null;

    for (let tries = 0; tries < 500; tries += 1) {
      const candidate = randomCode12();
      if (inBatch.has(candidate)) continue;
      if (reserved.has(candidate)) continue;
      if (isCodeUsedInTags(candidate)) continue;
      generated = candidate;
      break;
    }

    if (!generated) {
      const error = new Error('Gagal generate redeem code unik.');
      error.statusCode = 500;
      throw error;
    }

    inBatch.add(generated);
    result.push(generated);
  }

  return result;
}

function getOrCreateCredits(userId) {
  const user = db.prepare('SELECT id FROM users WHERE id = ? LIMIT 1').get(userId);
  if (!user) {
    const error = new Error('User tidak ditemukan.');
    error.statusCode = 404;
    throw error;
  }

  let credit = db
    .prepare('SELECT user_id, credits FROM redeem_credits WHERE user_id = ? LIMIT 1')
    .get(userId);

  if (!credit) {
    db.prepare(
      "INSERT INTO redeem_credits (user_id, credits, created_at, updated_at) VALUES (?, 1, datetime('now'), datetime('now'))"
    ).run(userId);
    credit = { user_id: userId, credits: 1 };
  }

  return credit;
}

function getOpenBatch(userId) {
  return db
    .prepare(
      `SELECT id, user_id, codes_json, claimed_code, status
       FROM redeem_batches
       WHERE user_id = ? AND status = ?
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(userId, BATCH_OPEN_STATUS);
}

function formatBatch(batchRow) {
  const codes = parseCodesJson(batchRow.codes_json).map((code12) => ({
    code12,
    display: toDisplay444(code12),
  }));

  return {
    id: batchRow.id,
    codes,
  };
}

const createBatchTx = db.transaction((userId) => {
  const existing = getOpenBatch(userId);
  if (existing) return formatBatch(existing);

  const credit = getOrCreateCredits(userId);
  if (Number(credit.credits || 0) <= 0) {
    const error = new Error('Tidak ada redeem code tersedia.');
    error.statusCode = 404;
    throw error;
  }

  const codes = generateCodes();
  const inserted = db
    .prepare(
      `INSERT INTO redeem_batches (user_id, codes_json, claimed_code, status, created_at, updated_at)
       VALUES (?, ?, NULL, ?, datetime('now'), datetime('now'))`
    )
    .run(userId, JSON.stringify(codes), BATCH_OPEN_STATUS);

  return {
    id: Number(inserted.lastInsertRowid),
    codes: codes.map((code12) => ({ code12, display: toDisplay444(code12) })),
  };
});

const claimTx = db.transaction((userId, code12) => {
  const batch = getOpenBatch(userId);
  if (!batch) {
    const error = new Error('Batch redeem OPEN tidak ditemukan.');
    error.statusCode = 404;
    throw error;
  }

  const codes = parseCodesJson(batch.codes_json);
  if (!codes.includes(code12)) {
    const error = new Error('Code tidak ada di batch aktif.');
    error.statusCode = 404;
    throw error;
  }

  if (isCodeUsedInTags(code12)) {
    const error = new Error('Code sudah dipakai.');
    error.statusCode = 404;
    throw error;
  }

  if (!TAG_CODE_COLUMN) {
    const error = new Error('Kolom unique_code pada tabel tags tidak ditemukan.');
    error.statusCode = 500;
    throw error;
  }

  if (!TAG_NAME_COLUMN) {
    const error = new Error('Kolom tag_name pada tabel tags tidak ditemukan.');
    error.statusCode = 500;
    throw error;
  }

  const insertColumns = ['user_id', TAG_NAME_COLUMN, TAG_CODE_COLUMN];
  const insertValues = [userId, 'Bandul', code12];

  if (TAG_ACTIVE_COLUMN) {
    insertColumns.push(TAG_ACTIVE_COLUMN);
    insertValues.push(0);
  }

  if (TAG_ENABLED_COLUMN) {
    insertColumns.push(TAG_ENABLED_COLUMN);
    insertValues.push(0);
  }

  const tagsColumns = new Set(getColumns('tags').map((column) => column.name));
  if (tagsColumns.has('created_at')) {
    insertColumns.push('created_at');
    insertValues.push(new Date().toISOString());
  }

  if (tagsColumns.has('updated_at')) {
    insertColumns.push('updated_at');
    insertValues.push(new Date().toISOString());
  }

  const placeholders = insertColumns.map(() => '?').join(', ');
  db.prepare(
    `INSERT INTO tags (${insertColumns.map(quoteIdent).join(', ')}) VALUES (${placeholders})`
  ).run(...insertValues);

  db.prepare(
    "UPDATE redeem_batches SET claimed_code = ?, status = 'CLAIMED', updated_at = datetime('now') WHERE id = ?"
  ).run(code12, batch.id);

  const credit = getOrCreateCredits(userId);
  const nextCredits = Math.max(0, Number(credit.credits || 0) - 1);
  db.prepare("UPDATE redeem_credits SET credits = ?, updated_at = datetime('now') WHERE user_id = ?").run(
    nextCredits,
    userId
  );
});

router.get('/batch', requireLogin, (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const batch = createBatchTx(userId);
    return res.json({ ok: true, batch });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 404) {
      return res.status(404).json({ ok: false, error: error.message || 'Tidak ada redeem code tersedia.' });
    }
    if (statusCode === 400) {
      return res.status(400).json({ ok: false, error: error.message || 'Request tidak valid.' });
    }
    return res.status(500).json({ ok: false, error: error.message || 'Terjadi kesalahan server.' });
  }
});

router.post('/claim', requireLogin, (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const code12 = String(req.body?.code12 || '').trim();

    if (!/^\d{12}$/.test(code12)) {
      return res.status(400).json({ ok: false, error: 'Format code12 tidak valid.' });
    }

    claimTx(userId, code12);
    return res.json({ ok: true });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 404) {
      return res.status(404).json({ ok: false, error: error.message || 'Data tidak ditemukan.' });
    }
    if (statusCode === 400) {
      return res.status(400).json({ ok: false, error: error.message || 'Request tidak valid.' });
    }
    return res.status(500).json({ ok: false, error: error.message || 'Terjadi kesalahan server.' });
  }
});

module.exports = router;

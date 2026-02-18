const TagService = require('./tagService');

class RedeemService {
  constructor(db) {
    this.db = db;
    this.tagService = new TagService(db);

    this.createBatchTx = db.transaction((userId, isFree) => this.createBatchInTx(userId, isFree));

    this.claimTx = db.transaction((userId, code12) => {
      const batch = db
        .prepare(`SELECT id FROM redeem_batches WHERE user_id = ? AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1`)
        .get(userId);
      if (!batch) {
        const error = new Error('Batch aktif tidak ditemukan.');
        error.statusCode = 404;
        throw error;
      }

      const redeemCode = db
        .prepare(
          `SELECT id, code12 FROM redeem_codes
           WHERE batch_id = ? AND user_id = ? AND status = 'OFFERED' AND code12 = ?
           LIMIT 1`
        )
        .get(batch.id, userId, code12);
      if (!redeemCode) {
        const error = new Error('Code tidak tersedia untuk di-claim.');
        error.statusCode = 404;
        throw error;
      }

      const tag = this.tagService.create(userId, { code12 });

      db.prepare("UPDATE redeem_codes SET status = 'CLAIMED', updated_at = datetime('now') WHERE id = ?").run(redeemCode.id);
      db.prepare("UPDATE redeem_batches SET status = 'CLAIMED', updated_at = datetime('now') WHERE id = ?").run(batch.id);

      return {
        id: tag.id,
        code12: tag.code12,
        label: tag.label || tag.name || '',
        enabled: Boolean(tag.enabled ?? tag.is_active),
      };
    });

    this.overwriteTx = db.transaction((userId) => {
      const user = db
        .prepare('SELECT id, redeem_credits FROM users WHERE id = ? LIMIT 1')
        .get(userId);
      if (!user) {
        const error = new Error('User tidak ditemukan.');
        error.statusCode = 404;
        throw error;
      }

      if (Number(user.redeem_credits || 0) <= 0) {
        const error = new Error('Redeem credits tidak cukup.');
        error.statusCode = 403;
        throw error;
      }

      db.prepare("UPDATE users SET redeem_credits = redeem_credits - 1, updated_at = datetime('now') WHERE id = ?").run(userId);

      const activeBatch = db
        .prepare(`SELECT id FROM redeem_batches WHERE user_id = ? AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1`)
        .get(userId);

      if (activeBatch) {
        db.prepare("UPDATE redeem_batches SET status = 'OVERWRITTEN', updated_at = datetime('now') WHERE id = ?").run(activeBatch.id);
        db.prepare(
          "UPDATE redeem_codes SET status = 'RELEASED', updated_at = datetime('now') WHERE batch_id = ? AND status = 'OFFERED'"
        ).run(activeBatch.id);
      }

      return this.createBatchInTx(userId, false);
    });
  }

  createBatchInTx(userId, isFree) {
    const user = this.db
      .prepare('SELECT id, free_redeem_used, redeem_credits FROM users WHERE id = ? LIMIT 1')
      .get(userId);
    if (!user) {
      const error = new Error('User tidak ditemukan.');
      error.statusCode = 404;
      throw error;
    }

    if (isFree) {
      if (Number(user.free_redeem_used || 0) !== 0) {
        const error = new Error('Redeem gratis sudah digunakan.');
        error.statusCode = 403;
        throw error;
      }
      this.db.prepare("UPDATE users SET free_redeem_used = 1, updated_at = datetime('now') WHERE id = ?").run(userId);
    }

    const created = this.db
      .prepare(`INSERT INTO redeem_batches (user_id, status, is_free, created_at, updated_at)
                VALUES (?, 'ACTIVE', ?, datetime('now'), datetime('now'))`)
      .run(userId, isFree ? 1 : 0);
    const batchId = Number(created.lastInsertRowid);

    const codes = [];
    const takenInBatch = new Set();
    for (let i = 0; i < 5; i += 1) {
      const code12 = this.generateUniqueCode12(takenInBatch);
      takenInBatch.add(code12);
      this.db.prepare(
        `INSERT INTO redeem_codes (batch_id, user_id, code12, status, created_at, updated_at)
         VALUES (?, ?, ?, 'OFFERED', datetime('now'), datetime('now'))`
      ).run(batchId, userId, code12);
      codes.push({ code12, status: 'OFFERED', display: this.toDisplay444(code12) });
    }

    return {
      id: batchId,
      status: 'ACTIVE',
      is_free: Boolean(isFree),
      created_at: this.db.prepare('SELECT created_at FROM redeem_batches WHERE id = ?').get(batchId).created_at,
      codes,
    };
  }

  generateCode12() {
    const n = Math.floor(Math.random() * 1000000000000);
    return String(n).padStart(12, '0');
  }

  toDisplay444(code12) {
    const value = String(code12 || '').replace(/\D/g, '');
    if (value.length !== 12) return value;
    return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
  }

  checkAvailable(code12) {
    const inTags = this.db.prepare('SELECT 1 FROM tags WHERE code12 = ? LIMIT 1').get(code12);
    if (inTags) return false;

    const reserved = this.db
      .prepare(
        `SELECT 1 FROM redeem_codes
         WHERE code12 = ?
           AND status IN ('OFFERED', 'CLAIMED')
         LIMIT 1`
      )
      .get(code12);
    return !reserved;
  }

  generateUniqueCode12(excludeSet = new Set()) {
    for (let i = 0; i < 300; i += 1) {
      const code12 = this.generateCode12();
      if (excludeSet.has(code12)) continue;
      if (this.checkAvailable(code12)) return code12;
    }

    throw new Error('Gagal generate code12 unik.');
  }

  mapBatch(batchRow) {
    if (!batchRow) return null;

    const codes = this.db
      .prepare(
        `SELECT code12, status
         FROM redeem_codes
         WHERE batch_id = ?
         ORDER BY id ASC`
      )
      .all(batchRow.id)
      .map((item) => ({
        code12: item.code12,
        status: item.status,
        display: this.toDisplay444(item.code12),
      }));

    return {
      id: batchRow.id,
      status: batchRow.status,
      is_free: Boolean(batchRow.is_free),
      created_at: batchRow.created_at,
      codes,
    };
  }

  getActiveBatch(userId) {
    const row = this.db
      .prepare(
        `SELECT id, user_id, status, is_free, created_at
         FROM redeem_batches
         WHERE user_id = ? AND status = 'ACTIVE'
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(userId);

    return this.mapBatch(row);
  }

  createBatch(userId, isFree) {
    return this.createBatchTx(userId, Boolean(isFree));
  }

  claimCode(userId, code12) {
    return this.claimTx(userId, code12);
  }

  overwriteBatch(userId) {
    return this.overwriteTx(userId);
  }
}

module.exports = RedeemService;

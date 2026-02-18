const express = require('express');
const { getDb } = require('../db');
const RedeemService = require('../services/redeemService');

const router = express.Router();
const db = getDb();
const service = new RedeemService(db);

function getSessionUserId(req) {
  return req.session?.userId || req.session?.user_id || null;
}

function requireLogin(req, res, next) {
  if (!getSessionUserId(req)) {
    return res.status(401).json({ ok: false, error: 'Not logged in' });
  }
  return next();
}

router.get('/batch', requireLogin, (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const active = service.getActiveBatch(userId);
    if (active) {
      return res.json({ ok: true, batch: active });
    }

    const user = db
      .prepare('SELECT free_redeem_used FROM users WHERE id = ? LIMIT 1')
      .get(userId);
    if (!user) return res.status(404).json({ ok: false, error: 'User tidak ditemukan.' });

    if (Number(user.free_redeem_used || 0) !== 0) {
      return res.status(404).json({ ok: false, batch: null });
    }

    const created = service.createBatch(userId, true);
    return res.json({ ok: true, batch: created });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({ ok: false, error: error.message || 'Gagal mengambil redeem batch.' });
  }
});

router.post('/claim', requireLogin, (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const code12 = String(req.body?.code12 || '').trim();

    if (!/^\d{12}$/.test(code12)) {
      return res.status(400).json({ ok: false, error: 'Format code12 tidak valid.' });
    }

    const tag = service.claimCode(userId, code12);
    return res.json({ ok: true, tag });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({ ok: false, error: error.message || 'Gagal claim code.' });
  }
});

router.post('/overwrite', requireLogin, (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const batch = service.overwriteBatch(userId);
    return res.json({ ok: true, batch });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({ ok: false, error: error.message || 'Gagal overwrite batch.' });
  }
});

module.exports = router;

const express = require('express');
const { getDb } = require('../db');
const TagService = require('../services/tagService');
const { isValidCode12, isValidDirectLink } = require('../utils/validators');

function requireLogin(req, res, next) {
  if (!getSessionUserId(req)) {
    return res.status(401).json({ ok: false, error: 'Not logged in' });
  }
  return next();
}

function toTagId(param) {
  const id = Number(param);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

const router = express.Router();
const db = getDb();
const service = new TagService(db);

function formatCode12(raw) {
  const v = String(raw || '').trim().toUpperCase();
  if (v.length !== 12) return v;
  return `${v.slice(0, 4)}-${v.slice(4, 8)}-${v.slice(8, 12)}`;
}

function getSessionUserId(req) {
  return req.session?.userId || req.session?.user_id || null;
}

router.get('/', (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const data = service.listByUser(userId).map((tag) => ({
      id: tag.id,
      tag_name: tag.label || tag.name || '',
      unique_code: tag.code12 || '',
      owner_name: null,
      location_note: tag.meet_location_text || tag.notes || '',
      direct_link: tag.direct_link_override || tag.contact_link_override || '',
      is_active: Boolean(tag.is_active ?? tag.enabled),
      created_at: tag.created_at || null,
      updated_at: tag.updated_at || null,
    }));
    return res.json(data);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ ok: false, error: 'Gagal mengambil data tags.' });
    }
  });

router.post('/', requireLogin, (req, res) => {
    try {
      const payload = req.body || {};
      if (payload.code12 && !isValidCode12(String(payload.code12).toUpperCase())) {
        return res.status(400).json({ ok: false, error: 'code12 harus 12 karakter huruf/angka tanpa O dan 0.' });
      }

      const created = service.create(getSessionUserId(req), payload);
      return res.status(201).json({ ok: true, data: created });
    } catch (error) {
      const status = error.message?.includes('code12') ? 400 : 500;
      return res.status(status).json({ ok: false, error: error.message || 'Gagal membuat tag.' });
    }
  });


router.get('/redeem/options', requireLogin, (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const user = db
      .prepare('SELECT free_redeem_used FROM users WHERE id = ? LIMIT 1')
      .get(userId);

    if (!user) return res.status(404).json({ ok: false, error: 'User tidak ditemukan.' });
    if (Number(user.free_redeem_used || 0) === 1) {
      return res.status(403).json({ ok: false, error: 'Redeem gratis sudah digunakan.' });
    }

    const options = [];
    const chosen = new Set();
    for (let i = 0; i < 5; i += 1) {
      const raw = service.generateUniqueCode12(chosen);
      chosen.add(raw);
      options.push({ raw, display: formatCode12(raw) });
    }

    return res.json({ ok: true, data: { options } });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Gagal menyiapkan opsi redeem.' });
  }
});

router.post('/redeem/claim', requireLogin, (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const code12 = String(req.body?.code12 || '').trim().toUpperCase();

    if (!isValidCode12(code12)) {
      return res.status(400).json({ ok: false, error: 'Format code12 tidak valid.' });
    }

    const user = db
      .prepare('SELECT free_redeem_used FROM users WHERE id = ? LIMIT 1')
      .get(userId);

    if (!user) return res.status(404).json({ ok: false, error: 'User tidak ditemukan.' });
    if (Number(user.free_redeem_used || 0) === 1) {
      return res.status(403).json({ ok: false, error: 'Redeem gratis sudah digunakan.' });
    }

    const tx = db.transaction(() => {
      let createdTag;
      try {
        createdTag = service.create(userId, { code12 });
      } catch (error) {
        if (String(error.message || '').includes('sudah digunakan')) {
          const e = new Error('Kode sudah tidak tersedia. Silakan redeem ulang.');
          e.statusCode = 409;
          throw e;
        }
        throw error;
      }

      db.prepare("UPDATE users SET free_redeem_used = 1, updated_at = datetime('now') WHERE id = ?").run(userId);

      const reserveSet = new Set([code12]);
      const reserved = [];
      for (let i = 0; i < 4; i += 1) {
        const next = service.generateUniqueCode12(reserveSet);
        reserveSet.add(next);
        reserved.push(next);
      }

      db.prepare(`
        INSERT INTO redeem_archive (user_id, codes_json, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET
          codes_json = excluded.codes_json,
          updated_at = datetime('now')
      `).run(userId, JSON.stringify(reserved));

      return { createdTag, archiveCount: reserved.length };
    });

    const result = tx();
    return res.json({ ok: true, data: { tag: result.createdTag, archive_count: result.archiveCount } });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ ok: false, error: error.message });
    }
    return res.status(500).json({ ok: false, error: 'Gagal redeem kode.' });
  }
});

router.get('/redeem/archive', requireLogin, (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const row = db.prepare('SELECT codes_json FROM redeem_archive WHERE user_id = ? LIMIT 1').get(userId);

    let parsed = [];
    if (row?.codes_json) {
      try {
        const arr = JSON.parse(row.codes_json);
        if (Array.isArray(arr)) parsed = arr;
      } catch (error) {
        parsed = [];
      }
    }

    const codes = parsed
      .map((raw) => String(raw || '').trim().toUpperCase())
      .filter((raw) => isValidCode12(raw))
      .map((raw) => ({ raw, display: formatCode12(raw) }));

    return res.json({ ok: true, data: { codes } });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Gagal mengambil arsip redeem.' });
  }
});

router.get('/:id', requireLogin, (req, res) => {
    try {
      const id = toTagId(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: 'ID tag tidak valid.' });

      const data = service.getById(getSessionUserId(req), id);
      if (!data) return res.status(404).json({ ok: false, error: 'Tag tidak ditemukan.' });

      return res.json({ ok: true, data });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ ok: false, error: 'Gagal mengambil detail tag.' });
    }
  });

function handlePatch(req, res) {
    try {
      const id = toTagId(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: 'ID tag tidak valid.' });

      const payload = req.body || {};
      if (Object.prototype.hasOwnProperty.call(payload, 'contact_link_override')) {
        const value = payload.contact_link_override;
        if (value !== null && value !== '' && !isValidDirectLink(String(value))) {
          return res.status(400).json({ ok: false, error: 'Direct link override tidak valid.' });
        }
      }

      const data = service.patch(getSessionUserId(req), id, payload);
      if (!data) return res.status(404).json({ ok: false, error: 'Tag tidak ditemukan.' });

      return res.json({ ok: true, data });
    } catch (error) {
      const status = error.message?.includes('tidak bisa diubah') ? 400 : 500;
      return res.status(status).json({ ok: false, error: error.message || 'Gagal memperbarui tag.' });
    }
  }

router.patch('/:id', requireLogin, handlePatch);
router.put('/:id', requireLogin, handlePatch);

function handleToggle(req, res) {
    try {
      const id = toTagId(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: 'ID tag tidak valid.' });

      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'enabled harus boolean.' });
      }

      const result = service.toggle(getSessionUserId(req), id, enabled);
      if (!result) return res.status(404).json({ ok: false, error: 'Tag tidak ditemukan.' });

      return res.json({ ok: true, enabled: result.enabled });
    } catch (error) {
      const status = error.statusCode || 500;
      return res.status(status).json({ ok: false, error: error.message || 'Gagal toggle tag.' });
    }
  }

router.patch('/:id/toggle', requireLogin, handleToggle);
router.patch('/:id/active', requireLogin, handleToggle);

module.exports = router;

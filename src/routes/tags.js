const express = require('express');
const TagService = require('../services/tagService');
const { isValidCode12, isValidDirectLink } = require('../utils/validators');

function requireLogin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ ok: false, error: 'Not logged in' });
  }
  return next();
}

function toTagId(param) {
  const id = Number(param);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

module.exports = function tagsRouter(db) {
  const router = express.Router();
  const service = new TagService(db);

  router.get('/', requireLogin, (req, res) => {
    try {
      const data = service.listByUser(req.session.userId);
      return res.json({ ok: true, data });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ ok: false, error: 'Gagal mengambil data tags.' });
    }
  });

  router.post('/', requireLogin, (req, res) => {
    try {
      const payload = req.body || {};
      if (payload.code12 && !isValidCode12(payload.code12)) {
        return res.status(400).json({ ok: false, error: 'code12 harus 12 digit numeric.' });
      }

      const created = service.create(req.session.userId, payload);
      return res.status(201).json({ ok: true, data: created });
    } catch (error) {
      const status = error.message?.includes('code12') ? 400 : 500;
      return res.status(status).json({ ok: false, error: error.message || 'Gagal membuat tag.' });
    }
  });

  router.get('/:id', requireLogin, (req, res) => {
    try {
      const id = toTagId(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: 'ID tag tidak valid.' });

      const data = service.getById(req.session.userId, id);
      if (!data) return res.status(404).json({ ok: false, error: 'Tag tidak ditemukan.' });

      return res.json({ ok: true, data });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ ok: false, error: 'Gagal mengambil detail tag.' });
    }
  });

  router.patch('/:id', requireLogin, (req, res) => {
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

      const data = service.patch(req.session.userId, id, payload);
      if (!data) return res.status(404).json({ ok: false, error: 'Tag tidak ditemukan.' });

      return res.json({ ok: true, data });
    } catch (error) {
      const status = error.message?.includes('tidak bisa diubah') ? 400 : 500;
      return res.status(status).json({ ok: false, error: error.message || 'Gagal memperbarui tag.' });
    }
  });

  router.patch('/:id/toggle', requireLogin, (req, res) => {
    try {
      const id = toTagId(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: 'ID tag tidak valid.' });

      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'enabled harus boolean.' });
      }

      const result = service.toggle(req.session.userId, id, enabled);
      if (!result) return res.status(404).json({ ok: false, error: 'Tag tidak ditemukan.' });

      return res.json({ ok: true, enabled: result.enabled });
    } catch (error) {
      const status = error.statusCode || 500;
      return res.status(status).json({ ok: false, error: error.message || 'Gagal toggle tag.' });
    }
  });

  return router;
};

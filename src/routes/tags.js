const { getDb } = require('../db');
const express = require('express');
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

function normalizeTagOutput(tag) {
  const name = String(tag.name ?? tag.tag_name ?? tag.label ?? '').trim() || 'Bandul';
  const code12 = String(tag.code12 ?? tag.unique_code ?? '').trim();
  const meetLocation = String(tag.meet_location_text ?? tag.location_note ?? tag.notes ?? '');
  const contactLink = String(tag.contact_link_override ?? tag.direct_link ?? tag.direct_link_override ?? '');
  const enabled = Boolean(tag.enabled ?? tag.is_active ?? tag.is_enabled ?? tag.active);

  return {
    id: tag.id,
    name,
    code12,
    meet_location_text: meetLocation,
    contact_link_override: contactLink,
    enabled,
  };
}

const router = express.Router();
const db = getDb();
const service = new TagService(db);

function getSessionUserId(req) {
  return req.session?.userId || req.session?.user_id || null;
}

router.get('/', (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const data = service.listByUser(userId).map(normalizeTagOutput);
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
      return res.status(400).json({ ok: false, error: 'code12 harus 12 digit angka.' });
    }

    const created = service.create(getSessionUserId(req), payload);
    return res.status(201).json({ ok: true, data: normalizeTagOutput(created) });
  } catch (error) {
    const status = error.message?.includes('code12') ? 400 : 500;
    return res.status(status).json({ ok: false, error: error.message || 'Gagal membuat tag.' });
  }
});

router.get('/:id', requireLogin, (req, res) => {
  try {
    const id = toTagId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'ID tag tidak valid.' });

    const data = service.getById(getSessionUserId(req), id);
    if (!data) return res.status(404).json({ ok: false, error: 'Tag tidak ditemukan.' });

    return res.json({ ok: true, data: normalizeTagOutput(data) });
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

    return res.json({ ok: true, data: normalizeTagOutput(data) });
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

/*
Manual test 1 (claim -> GET /api/tags modern output):
1) curl -c /tmp/c.jar -b /tmp/c.jar -X POST http://localhost:3000/login -H 'Content-Type: application/json' -d '{"username":"<user>","password":"<pass>","otp":"<otp>"}'
2) curl -c /tmp/c.jar -b /tmp/c.jar http://localhost:3000/api/redeem/batch
3) curl -c /tmp/c.jar -b /tmp/c.jar -X POST http://localhost:3000/api/redeem/claim -H 'Content-Type: application/json' -d '{"code12":"<12digit_from_batch>"}'
4) curl -c /tmp/c.jar -b /tmp/c.jar http://localhost:3000/api/tags
Expected: item has {name:"Bandul" (if not edited), code12:"<12digit>", enabled:false}.

Manual test 2 (toggle):
curl -c /tmp/c.jar -b /tmp/c.jar -X PATCH http://localhost:3000/api/tags/<id>/toggle -H 'Content-Type: application/json' -d '{"enabled":true}'
Then GET /api/tags and verify enabled berubah sesuai schema (enabled/is_active backend).
*/

module.exports = router;

const express = require('express');
const speakeasy = require('speakeasy');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const { hashPassword } = require('../utils/hash');
const { generateRecoveryCodes } = require('../utils/recoveryCodes');
const { validateUsername, validatePassword } = require('../utils/validate');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    const uErr = validateUsername(username);
    if (uErr) return res.status(400).json({ ok: false, error: uErr });

    const pErr = validatePassword(password);
    if (pErr) return res.status(400).json({ ok: false, error: pErr });

    const db = getDb();
    const totp = speakeasy.generateSecret({
      name: `Kuhyakuya Account (${username})`,
      length: 20,
    });

    const passwordHash = await hashPassword(password);

    const tx = db.transaction(() => {
      const insertUser = db
        .prepare(
          `INSERT INTO users (username, password_hash, totp_secret, totp_enabled)
           VALUES (?, ?, ?, 0)`
        )
        .run(username, passwordHash, totp.base32);

      const userId = insertUser.lastInsertRowid;
      const plainCodes = generateRecoveryCodes(10);

      const insertRC = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');

      for (const c of plainCodes) {
        const cHash = bcrypt.hashSync(c, 12);
        insertRC.run(userId, cHash);
      }

      return { userId: Number(userId), plainCodes };
    });

    const { userId, plainCodes } = tx();

    if (req.session) {
      req.session.userId = userId;
    }

    return res.status(201).json({
      ok: true,
      user: { id: userId, username, totpEnabled: false },
      totp: { secret: totp.base32, otpauthUrl: totp.otpauth_url },
      recoveryCodes: plainCodes,
      note: 'Simpan TOTP secret & recovery codes sekarang. Recovery codes cuma muncul sekali.',
    });
  } catch (err) {
    if (
      String(err && err.message).includes('UNIQUE') ||
      String(err && err.code).includes('SQLITE_CONSTRAINT')
    ) {
      return res.status(409).json({ ok: false, error: 'Username sudah dipakai' });
    }
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;

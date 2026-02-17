const express = require('express');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const { hashPassword, verifyPassword } = require('../utils/hash');
const { generateRecoveryCodes } = require('../utils/recoveryCodes');
const { validateUsername, validatePassword } = require('../utils/validate');

const router = express.Router();

function requireLogin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ ok: false, error: 'Not logged in' });
  }
  return next();
}

router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const normalizedUsername = String(username || '').toLowerCase();

    const uErr = validateUsername(normalizedUsername);
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
        .run(normalizedUsername, passwordHash, totp.base32);

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
      user: { id: userId, username: normalizedUsername, totpEnabled: false },
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

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const normalizedUsername = String(username || '').trim().toLowerCase();

    if (!normalizedUsername || !password) {
      return res.status(400).json({ ok: false, error: 'Username & password wajib' });
    }

    const db = getDb();
    const user = db
      .prepare('SELECT id, username, password_hash, totp_enabled FROM users WHERE username=?')
      .get(normalizedUsername);

    if (!user) return res.status(401).json({ ok: false, error: 'Username atau password salah' });

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: 'Username atau password salah' });

    req.session.userId = user.id;

    return res.json({
      ok: true,
      user: { id: user.id, username: user.username, totpEnabled: !!user.totp_enabled },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ ok: false, error: 'Not logged in' });

  const db = getDb();
  const user = db.prepare('SELECT id, username, totp_enabled FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.status(401).json({ ok: false, error: 'Session invalid' });

  return res.json({
    ok: true,
    user: { id: user.id, username: user.username, totpEnabled: !!user.totp_enabled },
  });
});

router.get('/otp/setup', requireLogin, async (req, res) => {
  try {
    const db = getDb();
    const user = db
      .prepare('SELECT username, totp_secret, totp_enabled FROM users WHERE id=?')
      .get(req.session.userId);

    if (!user) {
      return res.status(401).json({ ok: false, error: 'Session invalid' });
    }

    if (!user.totp_secret) {
      const secret = speakeasy.generateSecret({
        name: `Kuhyakuya Account (${user.username})`,
        length: 20,
      });

      db.prepare('UPDATE users SET totp_secret=? WHERE id=?').run(secret.base32, req.session.userId);

      const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url, {
        margin: 2,
        color: {
          dark: '#8A4EFF',
          light: '#00000000',
        },
      });

      return res.json({
        ok: true,
        secret: secret.base32,
        otpauthUrl: secret.otpauth_url,
        qrDataUrl,
      });
    }

    const otpauthUrl = speakeasy.otpauthURL({
      secret: user.totp_secret,
      label: `Kuhyakuya Account (${user.username})`,
      issuer: 'Kuhyakuya',
      encoding: 'base32',
    });

    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
      margin: 2,
      color: {
        dark: '#8A4EFF',
        light: '#00000000',
      },
    });

    return res.json({
      ok: true,
      secret: user.totp_secret,
      otpauthUrl,
      qrDataUrl,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: 'Failed to generate QR code.' });
  }
});

router.post('/otp/enable', requireLogin, (req, res) => {
  try {
    const token = String(req.body?.token || req.body?.otp || '').trim();
    if (!token) return res.status(400).json({ ok: false, error: 'OTP token wajib' });

    const db = getDb();
    const user = db
      .prepare('SELECT totp_secret, totp_enabled FROM users WHERE id=?')
      .get(req.session.userId);

    if (!user?.totp_secret) {
      return res.status(400).json({ ok: false, error: 'TOTP secret belum ada' });
    }

    const verified = speakeasy.totp.verify({
      secret: user.totp_secret,
      encoding: 'base32',
      token,
      window: 1,
    });

    if (!verified) return res.status(400).json({ ok: false, error: 'OTP salah' });

    db.prepare("UPDATE users SET totp_enabled=1, updated_at=datetime('now') WHERE id=?").run(
      req.session.userId
    );

    return res.json({ ok: true, alreadyEnabled: !!user.totp_enabled });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/logout', (req, res) => {
  req.session?.destroy(() => {
    res.json({ ok: true });
  });
});

module.exports = router;

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { run, get, all } = require('./src/db');
const {
  hashPassword,
  verifyPassword,
  encryptText,
  decryptText,
  hashRecoveryCode,
  generateRecoveryCodes,
} = require('./src/security');
const { canAttempt, registerFailure, clearAttempts } = require('./src/rateLimit');
const authRoutes = require('./src/routes/auth');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required.');
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', authRoutes);

const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;

function validateUsername(username) {
  return USERNAME_REGEX.test(username || '');
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  return next();
}

async function requireActiveUser(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  const user = await get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!user || user.status !== 'active') {
    req.session.destroy(() => res.redirect('/login'));
    return;
  }
  req.user = user;
  next();
}

async function saveRecoveryCodes(userId, codes) {
  await run('DELETE FROM recovery_codes WHERE user_id = ?', [userId]);
  for (const code of codes) {
    await run(
      'INSERT INTO recovery_codes (user_id, code_hash, is_used, created_at) VALUES (?, ?, 0, CURRENT_TIMESTAMP)',
      [userId, hashRecoveryCode(code)]
    );
  }
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.redirect('/login.html');
});

app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/setup-authenticator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup-authenticator.html')));
app.get('/forgot-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'forgot-password.html')));
app.get('/reset-authenticator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-authenticator.html')));
app.get('/settings/username', requireActiveUser, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'settings-username.html'))
);
app.get('/dashboard', requireActiveUser, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.post('/register', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';

    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const existing = await get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return res.status(409).json({ error: 'Username already exists.' });

    const { hash, salt } = hashPassword(password);
    const totpSecret = speakeasy.generateSecret({ length: 20 });
    const encryptedSecret = encryptText(totpSecret.base32);

    const created = await run(
      `INSERT INTO users (username, password_hash, salt, totp_secret_encrypted, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`,
      [username, hash, salt, encryptedSecret]
    );

    req.session.pendingSetupUserId = created.lastID;
    res.json({ redirectTo: '/setup-authenticator' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to register account.' });
  }
});

app.get('/api/setup-authenticator', async (req, res) => {
  try {
    const userId = req.session.pendingSetupUserId || (req.session.resetAuth && req.session.resetAuth.userId);
    if (!userId) return res.status(401).json({ error: 'No pending authenticator setup.' });
    const user = await get('SELECT id, username, totp_secret_encrypted FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const secret = req.session.resetAuth ? req.session.resetAuth.secret : decryptText(user.totp_secret_encrypted);
    const otpauthUrl = speakeasy.otpauthURL({
      secret,
      label: `kuhyakuya.com:${user.username}`,
      issuer: 'kuhyakuya.com',
      encoding: 'base32',
    });
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
      margin: 2,
      color: {
        dark: "#8A4EFF",
        light: "#00000000",
      },
    });
    res.json({ qrDataUrl, manualKey: secret, username: user.username, resetMode: Boolean(req.session.resetAuth) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load authenticator data.' });
  }
});

app.post('/setup-authenticator/verify', async (req, res) => {
  try {
    const otp = (req.body.otp || '').trim();
    const userId = req.session.pendingSetupUserId;
    if (!userId) return res.status(401).json({ error: 'No pending setup session.' });

    const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const secret = decryptText(user.totp_secret_encrypted);
    const verified = speakeasy.totp.verify({ secret, encoding: 'base32', token: otp, window: 1 });
    if (!verified) return res.status(400).json({ error: 'Invalid OTP code.' });

    const codes = generateRecoveryCodes(10);
    await saveRecoveryCodes(userId, codes);
    await run('UPDATE users SET status = ? WHERE id = ?', ['active', userId]);

    req.session.userId = userId;
    req.session.pendingSetupUserId = null;
    req.session.recoveryCodesOnce = codes;
    res.json({ redirectTo: '/setup-authenticator?done=1' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to verify authenticator setup.' });
  }
});

app.get('/api/recovery-codes', (req, res) => {
  const codes = req.session.recoveryCodesOnce;
  if (!codes) return res.status(404).json({ error: 'No recovery codes available.' });
  req.session.recoveryCodesOnce = null;
  res.json({ codes });
});

app.post('/login', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';

    const limit = canAttempt(req, username);
    if (!limit.allowed) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }

    const user = await get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || user.status !== 'active' || !verifyPassword(password, user.password_hash, user.salt)) {
      registerFailure(req, username);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    clearAttempts(req, username);
    req.session.userId = user.id;
    res.json({ redirectTo: '/dashboard' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to log in.' });
  }
});

app.post('/forgot-password', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const otp = (req.body.otp || '').trim();
    const newPassword = req.body.newPassword || '';

    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const user = await get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || user.status !== 'active') return res.status(400).json({ error: 'Invalid reset request.' });

    const secret = decryptText(user.totp_secret_encrypted);
    const verified = speakeasy.totp.verify({ secret, encoding: 'base32', token: otp, window: 1 });
    if (!verified) return res.status(400).json({ error: 'Invalid OTP code.' });

    const { hash, salt } = hashPassword(newPassword);
    await run('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', [hash, salt, user.id]);

    res.json({ message: 'Password has been reset successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

app.post('/reset-authenticator', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const recoveryCode = (req.body.recoveryCode || '').trim();

    const user = await get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || user.status !== 'active') return res.status(400).json({ error: 'Invalid reset request.' });

    const codeHash = hashRecoveryCode(recoveryCode);
    const found = await get(
      'SELECT * FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND is_used = 0',
      [user.id, codeHash]
    );
    if (!found) return res.status(400).json({ error: 'Invalid or already used recovery code.' });

    await run('UPDATE recovery_codes SET is_used = 1, used_at = CURRENT_TIMESTAMP WHERE id = ?', [found.id]);
    const newSecret = speakeasy.generateSecret({ length: 20 }).base32;
    req.session.resetAuth = { userId: user.id, secret: newSecret };

    res.json({ message: 'Recovery code accepted.', redirectTo: '/reset-authenticator?step=verify' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to begin authenticator reset.' });
  }
});

app.post('/reset-authenticator/verify', async (req, res) => {
  try {
    const otp = (req.body.otp || '').trim();
    if (!req.session.resetAuth) return res.status(401).json({ error: 'No pending authenticator reset.' });

    const { userId, secret } = req.session.resetAuth;
    const verified = speakeasy.totp.verify({ secret, encoding: 'base32', token: otp, window: 1 });
    if (!verified) return res.status(400).json({ error: 'Invalid OTP code.' });

    await run('UPDATE users SET totp_secret_encrypted = ? WHERE id = ?', [encryptText(secret), userId]);

    const codes = generateRecoveryCodes(10);
    await saveRecoveryCodes(userId, codes);

    req.session.resetAuth = null;
    req.session.recoveryCodesOnce = codes;
    res.json({ message: 'Authenticator reset complete.', redirectTo: '/reset-authenticator?done=1' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to complete authenticator reset.' });
  }
});

app.post('/settings/username', requireActiveUser, async (req, res) => {
  try {
    const currentPassword = req.body.currentPassword || '';
    const otp = (req.body.otp || '').trim();
    const newUsername = (req.body.newUsername || '').trim();

    if (!validateUsername(newUsername)) {
      return res.status(400).json({ error: 'Invalid new username format.' });
    }

    if (!verifyPassword(currentPassword, req.user.password_hash, req.user.salt)) {
      return res.status(401).json({ error: 'Invalid current password.' });
    }

    const secret = decryptText(req.user.totp_secret_encrypted);
    const verified = speakeasy.totp.verify({ secret, encoding: 'base32', token: otp, window: 1 });
    if (!verified) return res.status(400).json({ error: 'Invalid OTP code.' });

    const exists = await get('SELECT id FROM users WHERE username = ? AND id != ?', [newUsername, req.user.id]);
    if (exists) return res.status(409).json({ error: 'Username is already taken.' });

    await run('UPDATE users SET username = ? WHERE id = ?', [newUsername, req.user.id]);
    res.json({ message: 'Username changed successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to change username.' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ redirectTo: '/login' });
  });
});

app.listen(PORT, () => {
  console.log(`account-service running on http://localhost:${PORT}`);
});

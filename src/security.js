const crypto = require('crypto');

const PBKDF2_ITERATIONS = 120000;
const KEY_LENGTH = 64;
const DIGEST = 'sha512';

function normalizeEncKey() {
  const keyHex = process.env.TOTP_ENC_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('TOTP_ENC_KEY must be 64 hex characters (32 bytes).');
  }
  return Buffer.from(keyHex, 'hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const input = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
  const saved = Buffer.from(hash, 'hex');
  if (input.length !== saved.length) return false;
  return crypto.timingSafeEqual(input, saved);
}

function encryptText(plain) {
  const key = normalizeEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptText(payload) {
  const key = normalizeEncKey();
  const [ivHex, tagHex, dataHex] = payload.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }).map(() => {
    const numeric = String(crypto.randomInt(0, 100000000)).padStart(8, '0');
    return `${numeric.slice(0, 4)}-${numeric.slice(4)}`;
  });
}

module.exports = {
  hashPassword,
  verifyPassword,
  encryptText,
  decryptText,
  hashRecoveryCode,
  generateRecoveryCodes,
};

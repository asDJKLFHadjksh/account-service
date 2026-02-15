const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

const attempts = new Map();

function keyFrom(req, username) {
  return `${(username || '').toLowerCase()}|${req.ip}`;
}

function canAttempt(req, username) {
  const key = keyFrom(req, username);
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || now > record.resetAt) {
    attempts.set(key, { count: 0, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: MAX_ATTEMPTS };
  }
  if (record.count >= MAX_ATTEMPTS) {
    return { allowed: false, remaining: 0, retryAfterMs: record.resetAt - now };
  }
  return { allowed: true, remaining: MAX_ATTEMPTS - record.count };
}

function registerFailure(req, username) {
  const key = keyFrom(req, username);
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || now > record.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  record.count += 1;
}

function clearAttempts(req, username) {
  attempts.delete(keyFrom(req, username));
}

module.exports = { canAttempt, registerFailure, clearAttempts };

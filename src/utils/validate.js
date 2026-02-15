function validateUsername(username) {
  if (typeof username !== 'string') return 'Username harus string';
  if (username !== username.toLowerCase()) return 'Username harus lowercase semua';
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return 'Username hanya boleh a-z 0-9 _ (3-20 karakter)';
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string') return 'Password harus string';
  if (password.length < 6) return 'Password minimal 6 karakter';
  return null;
}

module.exports = { validateUsername, validatePassword };

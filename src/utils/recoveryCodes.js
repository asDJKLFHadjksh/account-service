function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateRecoveryCodes(count = 10) {
  const set = new Set();
  while (set.size < count) {
    const code = String(randomInt(10_000_000, 99_999_999));
    set.add(code);
  }
  return Array.from(set);
}

module.exports = { generateRecoveryCodes };

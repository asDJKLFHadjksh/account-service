const CODE12_REGEX = /^[A-NP-Z1-9]{12}$/;

const ALLOWED_PREFIXES = [
  'https://wa.me/',
  'https://api.whatsapp.com/',
  'https://t.me/',
  'https://m.me/',
  'https://instagram.com/',
  'https://www.instagram.com/',
];

function isValidCode12(value) {
  return CODE12_REGEX.test(String(value || '').trim().toUpperCase());
}

function isValidDirectLink(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return ALLOWED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

module.exports = {
  CODE12_REGEX,
  ALLOWED_PREFIXES,
  isValidCode12,
  isValidDirectLink,
};

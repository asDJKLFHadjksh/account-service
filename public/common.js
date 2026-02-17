async function postJson(url, data) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    credentials: 'include',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Request failed');
  return payload;
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (response.status === 401) {
    window.location.href = '/login.html?msg=Sesi%20habis,%20silakan%20masuk%20lagi';
    throw new Error('Sesi habis. Silakan masuk lagi.');
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Permintaan gagal.');
  }
  return payload;
}

function maskCode(code) {
  const raw = String(code || '').replace(/\D/g, '');
  if (!raw) return '**** **** ****';
  const last4 = raw.slice(-4).padStart(4, '*');
  return `**** **** ${last4}`;
}

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', 'readonly');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  document.body.removeChild(area);
}

function showToast(message, type = 'success') {
  const root = document.getElementById('toastRoot');
  if (!root) return;

  const toast = document.createElement('div');
  toast.className = `k-toast ${type}`;
  toast.textContent = message;
  root.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('is-hidden');
    setTimeout(() => toast.remove(), 200);
  }, 1800);
}

function showMessage(id, text, type = 'error') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `message ${type}`;
}

function bindRegisterForm() {
  const form = document.getElementById('registerForm');
  const msg = document.getElementById('msg');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (msg) showMessage('msg', 'Loading...', 'info');

    const username = form.username.value.trim().toLowerCase();
    const password = form.password.value;

    try {
      const payload = await postJson('/api/register', { username, password });
      const recoveryCodes = Array.isArray(payload.recoveryCodes)
        ? payload.recoveryCodes
            .map((code) => String(code || '').replace(/-/g, '').trim())
            .filter(Boolean)
            .slice(0, 10)
        : [];
      if (recoveryCodes.length) {
        sessionStorage.setItem('recoveryCodes', JSON.stringify(recoveryCodes));
      }

      if (msg) {
        showMessage('msg', 'Register sukses! Lanjut simpan recovery codes.', 'success');
      }

      window.location.href = '/recovery.html';
    } catch (err) {
      showMessage('msg', err.message || 'Gagal register', 'error');
    }
  });
}

function bindLoginForm() {
  const form = document.getElementById('loginForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = form.username.value.trim().toLowerCase();
    const password = form.password.value;

    try {
      await postJson('/api/login', { username, password });
      window.location.href = '/dashboard.html';
    } catch (err) {
      showMessage('msg', err.message || 'Login gagal', 'error');
    }
  });
}

async function requireSession() {
  const response = await fetch('/api/me', {
    credentials: 'include',
    cache: 'no-store',
  });

  if (response.status === 401) {
    window.location.href = '/login.html?msg=Sesi%20habis,%20silakan%20masuk%20lagi';
    return null;
  }

  if (response.status === 304) {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  return data.user || null;
}

function bindPasswordToggles() {
  const toggles = document.querySelectorAll('[data-password-toggle]');
  if (!toggles.length) return;

  toggles.forEach((toggle) => {
    const targetId = toggle.getAttribute('data-target');
    if (!targetId) return;

    const input = document.getElementById(targetId);
    if (!input) return;

    toggle.addEventListener('click', () => {
      const isHidden = input.type === 'password';
      input.type = isHidden ? 'text' : 'password';
      toggle.setAttribute(
        'aria-label',
        isHidden ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi',
      );
      toggle.classList.toggle('is-on', isHidden);
    });
  });
}

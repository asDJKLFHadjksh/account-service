(function initShell() {
  const shell = document.querySelector('.k-shell');
  if (!shell) return;

  const sidebar = document.querySelector('[data-shell-sidebar]');
  const toggleBtn = document.querySelector('[data-drawer-toggle]');
  const backdrop = document.querySelector('[data-drawer-backdrop]');
  const pageTitle = shell.getAttribute('data-page-title') || 'Dashboard';
  const titleEl = document.querySelector('.k-shell-page-title');
  const usernameEl = document.querySelector('[data-username]');
  const avatarEl = document.querySelector('.k-profile-avatar');

  function setDrawer(isOpen) {
    if (!sidebar || !backdrop) return;

    sidebar.classList.toggle('is-open', isOpen);
    backdrop.classList.toggle('is-visible', isOpen);
    document.body.classList.toggle('k-lock-scroll', isOpen);
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const isOpen = sidebar?.classList.contains('is-open');
      setDrawer(!isOpen);
    });
  }

  if (backdrop) {
    backdrop.addEventListener('click', () => setDrawer(false));
  }

  window.addEventListener('resize', () => {
    if (window.innerWidth > 940) {
      setDrawer(false);
    }
  });

  if (titleEl) {
    titleEl.textContent = pageTitle;
  }

  const currentPath = window.location.pathname;
  const links = document.querySelectorAll('[data-nav-link]');
  links.forEach((link) => {
    const href = link.getAttribute('href');
    if (href === currentPath) {
      link.classList.add('is-active');
    }
  });

  async function loadUsername() {
    if (!usernameEl || !avatarEl) return;

    try {
      const response = await fetch('/api/me', {
        credentials: 'include',
        cache: 'no-store',
      });

      if (!response.ok) {
        return;
      }

      const data = await response.json();
      const username = String(data?.user?.username || '').trim();
      if (!username) return;

      usernameEl.textContent = username;
      avatarEl.textContent = username.slice(0, 1).toUpperCase();
    } catch (_error) {
      // fallback tetap gunakan placeholder
    }
  }

  loadUsername();
})();

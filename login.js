// Login page logic (kept in its own file so the page's Content-Security-Policy
// can forbid inline scripts).
(async () => {
  const msg = document.getElementById('msg');
  const reason = new URLSearchParams(window.location.search).get('reason');
  if (reason === 'disabled') msg.innerHTML = '<div class="msg error">Your account is disabled. Please contact an administrator.</div>';
  if (reason === 'expired') msg.innerHTML = '<div class="msg error">Your session expired. Please log in again.</div>';

  // Already logged in? Go straight to the dashboard.
  if (!reason) {
    const { data } = await sb.auth.getSession();
    if (data && data.session) { window.location.replace('index.html'); return; }
  }

  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    msg.innerHTML = '';
    btn.disabled = true;
    try {
      if (!username || !password) throw new Error('Username and password required');
      const { error } = await sb.auth.signInWithPassword({ email: usernameToEmail(username), password });
      if (error) {
        if (/rate|too many/i.test(error.message)) throw new Error('Too many attempts. Please wait a few minutes and try again.');
        throw new Error('Invalid username or password');
      }
      // Remembered so the Daily Report can list the delays of the 30 hours
      // before this login, and to enforce the 12-hour session limit.
      storageSet(LOGIN_AT_KEY, String(Date.now()));
      window.location.href = 'index.html';
    } catch (err) {
      msg.innerHTML = `<div class="msg error">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
    }
  });
})();

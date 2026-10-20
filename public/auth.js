const $ = (id) => document.getElementById(id);

const formEl = $('auth-form');
const titleEl = $('auth-title');
const subEl = $('auth-sub');
const emailEl = $('auth-email');
const passwordEl = $('auth-password');
const rememberEl = $('auth-remember');
const errorEl = $('auth-error');
const submitEl = $('auth-submit');
const switchTextEl = $('auth-switch-text');
const switchBtnEl = $('auth-switch-btn');

let mode = 'signin'; // or 'signup'

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

function setMode(next) {
  mode = next;
  const signin = mode === 'signin';
  titleEl.textContent = signin ? 'Sign in' : 'Create account';
  subEl.textContent = signin ? 'Welcome back. Sign in to see your expenses.' : 'Use at least 8 characters for the password.';
  submitEl.textContent = signin ? 'Sign in' : 'Create account';
  switchTextEl.textContent = signin ? 'No account yet?' : 'Already have an account?';
  switchBtnEl.textContent = signin ? 'Create account' : 'Sign in';
  passwordEl.autocomplete = signin ? 'current-password' : 'new-password';
  showError('');
}

switchBtnEl.addEventListener('click', () => setMode(mode === 'signin' ? 'signup' : 'signin'));

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = emailEl.value.trim();
  const password = passwordEl.value;
  if (!email) return showError('Enter your email.');
  if (mode === 'signup' && password.length < 8) return showError('Use at least 8 characters for the password.');
  if (!password) return showError('Enter your password.');
  showError('');

  submitEl.disabled = true;
  try {
    const res = await fetch(`/api/auth/${mode === 'signin' ? 'login' : 'signup'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, remember: rememberEl.checked }),
    });
    if (res.ok) {
      window.location.href = '/';
      return;
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 400) showError('Enter a valid email and a password of at least 8 characters.');
    else showError(body.error ?? 'Something went wrong. Try again.');
  } catch (err) {
    console.error(err);
    showError('Cannot reach the server. Try again.');
  } finally {
    submitEl.disabled = false;
  }
});

// Already signed in? Go straight to the dashboard.
fetch('/api/auth/me')
  .then((res) => {
    if (res.ok) window.location.href = '/';
  })
  .catch(() => {});

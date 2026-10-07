(function () {
  document.addEventListener('DOMContentLoaded', init);
  function authenticationMode(config) {
    if (!config || !['password', 'employee-code'].includes(config.mode)) throw new Error('The sign-in configuration is unavailable. Please retry.');
    return config.mode;
  }
  function employeeLoginBody(code, remember) {
    const employeeCode = typeof code === 'string' ? code.trim() : '';
    if (!/^[A-Za-z0-9._-]{1,10}$/.test(employeeCode)) throw new Error('Enter a valid employee code (up to 10 characters).');
    return { employeeCode, remember: remember === true };
  }
  async function init() {
    const loginForm = document.getElementById('loginForm');
    const changeForm = document.getElementById('passwordChangeForm');
    const message = document.getElementById('authMessage');
    const employeeForm = document.getElementById('employeeLoginForm');
    const retryButton = document.getElementById('authRetryButton');
    let mode = null;
    const returnTo = window.PCN_SESSION.safeReturnTo(new URLSearchParams(window.location.search).get('returnTo'));
    const showMessage = (text) => { message.textContent = text; };
    function showChangePassword() {
      loginForm.hidden = true;
      employeeForm.hidden = true;
      changeForm.hidden = false;
      document.getElementById('authTitle').textContent = 'Change your password';
      document.getElementById('authDescription').textContent = 'Change your temporary password before using the PCN portal.';
      document.getElementById('currentPassword').focus();
    }
    async function submit(form, action) {
      const buttons = [...form.querySelectorAll('button')];
      buttons.forEach((button) => { button.disabled = true; });
      showMessage('');
      try { await action(); } catch (error) { showMessage(error.message); }
      finally { buttons.forEach((button) => { button.disabled = false; }); }
    }
    loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (mode !== 'password') return;
      submit(loginForm, async () => {
        const session = await window.PCN_SESSION.fetch('/api/auth/login', {
          method: 'POST', body: JSON.stringify({ username: document.getElementById('username').value.trim(), password: document.getElementById('password').value, remember: document.getElementById('remember').checked })
        });
        document.getElementById('password').value = '';
        if (session.user?.mustChangePassword) showChangePassword();
        else window.location.assign(returnTo);
      });
    });
    employeeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (mode !== 'employee-code') return;
      submit(employeeForm, async () => {
        const body = employeeLoginBody(document.getElementById('employeeCode').value, document.getElementById('employeeRemember').checked);
        const session = await window.PCN_SESSION.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
        if (!session.authenticated) throw new Error('Employee sign-in did not complete. Please try again.');
        window.location.assign(returnTo);
      });
    });
    changeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submit(changeForm, async () => {
        const newPassword = document.getElementById('newPassword').value;
        if (newPassword !== document.getElementById('confirmPassword').value) throw new Error('The new passwords do not match.');
        await window.PCN_SESSION.fetch('/api/auth/change-password', {
          method: 'POST', body: JSON.stringify({ currentPassword: document.getElementById('currentPassword').value, newPassword })
        });
        changeForm.reset();
        changeForm.hidden = true;
        loginForm.hidden = false;
        document.getElementById('authTitle').textContent = 'Sign in';
        document.getElementById('authDescription').textContent = 'Your password has changed. Sign in with your new password.';
        showMessage('Password changed. Sign in again to continue.');
        document.getElementById('password').focus();
      });
    });
    document.getElementById('signOutButton').addEventListener('click', () => submit(changeForm, () => window.PCN_SESSION.logout()));
    async function configure() {
      mode = null;
      loginForm.hidden = true;
      employeeForm.hidden = true;
      changeForm.hidden = true;
      retryButton.hidden = true;
      showMessage('Loading sign-in options...');
      try {
        mode = authenticationMode(await window.PCN_SESSION.fetch('/api/auth/config'));
        const session = await window.PCN_SESSION.load();
        showMessage('');
        if (session.authenticated && session.user?.mustChangePassword && mode === 'password') showChangePassword();
        else if (session.authenticated) window.location.assign(returnTo);
        else {
          loginForm.hidden = mode !== 'password';
          employeeForm.hidden = mode !== 'employee-code';
          document.getElementById('authDescription').textContent = mode === 'employee-code'
            ? 'Enter your employee code to use the PCN portal.'
            : 'Sign in to create and review product change notifications.';
          document.getElementById(mode === 'employee-code' ? 'employeeCode' : 'username').focus();
        }
      } catch (error) { mode = null; showMessage(error.message); retryButton.hidden = false; retryButton.focus(); }
    }
    retryButton.addEventListener('click', () => configure());
    await configure();
  }
})();

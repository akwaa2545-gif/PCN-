(function () {
  document.addEventListener('DOMContentLoaded', init);
  async function init() {
    const loginForm = document.getElementById('loginForm');
    const changeForm = document.getElementById('passwordChangeForm');
    const message = document.getElementById('authMessage');
    const returnTo = window.PCN_SESSION.safeReturnTo(new URLSearchParams(window.location.search).get('returnTo'));
    const showMessage = (text) => { message.textContent = text; };
    function showChangePassword() {
      loginForm.hidden = true;
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
      submit(loginForm, async () => {
        const session = await window.PCN_SESSION.fetch('/api/auth/login', {
          method: 'POST', body: JSON.stringify({ username: document.getElementById('username').value.trim(), password: document.getElementById('password').value, remember: document.getElementById('remember').checked })
        });
        document.getElementById('password').value = '';
        if (session.user?.mustChangePassword) showChangePassword();
        else window.location.assign(returnTo);
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
    try {
      const session = await window.PCN_SESSION.load();
      if (session.authenticated && session.user?.mustChangePassword) showChangePassword();
      else if (session.authenticated) window.location.assign(returnTo);
      else document.getElementById('username').focus();
    } catch (error) { showMessage(error.message); }
  }
})();

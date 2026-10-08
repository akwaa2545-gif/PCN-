(function () {
  document.addEventListener('DOMContentLoaded', init);
  function authenticationMode(config) {
    if (!config || !['password', 'employee-code'].includes(config.mode)) throw new Error('The sign-in configuration is unavailable. Please retry.');
    return config.mode;
  }
  function employeeLoginBody(code) {
    const employeeCode = typeof code === 'string' ? code.trim() : '';
    if (!/^[0-9]{7}$/.test(employeeCode)) throw new Error('Enter your 7-digit Employee ID.');
    return { employeeCode };
  }
  async function init() {
    const loginForm = document.getElementById('loginForm');
    const changeForm = document.getElementById('passwordChangeForm');
    const message = document.getElementById('authMessage');
    const employeeForm = document.getElementById('employeeLoginForm');
    const employeeMessage = document.getElementById('employeeAuthMessage');
    const authIntro = document.getElementById('authIntro');
    const retryButton = document.getElementById('authRetryButton');
    const employeeCodeInput = document.getElementById('employeeCode');
    const employeeDigits = Array.from({ length: 7 }, (_, index) => document.getElementById(`employeeDigit${index + 1}`));
    let employeeCodeFocused = false;
    let mode = null;
    const returnTo = window.PCN_SESSION.safeReturnTo(new URLSearchParams(window.location.search).get('returnTo'));
    const destinationFor = (user) => Array.isArray(user?.roles) && user.roles.length ? returnTo : '/records';
    const showMessage = (text) => {
      const inEmployeeForm = mode === 'employee-code' && !employeeForm.hidden;
      message.textContent = inEmployeeForm ? '' : text;
      employeeMessage.textContent = inEmployeeForm ? text : '';
    };
    function renderEmployeeCode() {
      const digits = employeeCodeInput.value.replace(/[^0-9]/g, '').slice(0, 7);
      employeeCodeInput.value = digits;
      employeeDigits.forEach((slot, index) => {
        slot.textContent = digits[index] || '';
        slot.classList.toggle('is-active', employeeCodeFocused && index === digits.length && digits.length < 7);
      });
    }
    employeeCodeInput.addEventListener('input', () => { renderEmployeeCode(); showMessage(''); });
    employeeCodeInput.addEventListener('change', () => { renderEmployeeCode(); showMessage(''); });
    employeeCodeInput.addEventListener('focus', () => { employeeCodeFocused = true; renderEmployeeCode(); });
    employeeCodeInput.addEventListener('blur', () => { employeeCodeFocused = false; renderEmployeeCode(); });
    function showChangePassword() {
      authIntro.hidden = false;
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
          method: 'POST', body: JSON.stringify({ username: document.getElementById('username').value.trim(), password: document.getElementById('password').value })
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
        const body = employeeLoginBody(employeeCodeInput.value);
        const session = await window.PCN_SESSION.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
        if (!session.authenticated) throw new Error('Employee sign-in did not complete. Please try again.');
        window.location.assign(destinationFor(session.user));
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
        document.getElementById('authTitle').textContent = 'Welcome';
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
      authIntro.hidden = true;
      retryButton.hidden = true;
      showMessage('Loading sign-in options...');
      try {
        mode = authenticationMode(await window.PCN_SESSION.fetch('/api/auth/config'));
        const session = await window.PCN_SESSION.load();
        showMessage('');
        if (session.authenticated && session.user?.mustChangePassword && mode === 'password') showChangePassword();
        else if (session.authenticated) window.location.assign(destinationFor(session.user));
        else {
          loginForm.hidden = mode !== 'password';
          employeeForm.hidden = mode !== 'employee-code';
          authIntro.hidden = mode !== 'password';
          document.getElementById('authDescription').textContent = 'Enter your credentials to continue to the PCN portal.';
          if (mode === 'employee-code') {
            renderEmployeeCode();
          } else document.getElementById('username').focus();
        }
      } catch (error) { mode = null; authIntro.hidden = false; showMessage(error.message); retryButton.hidden = false; retryButton.focus(); }
    }
    retryButton.addEventListener('click', () => configure());
    await configure();
  }
})();

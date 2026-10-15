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
  function explicitLoginReturnTo(value) {
    const destination = window.PCN_SESSION.safeReturnTo(value);
    if (destination !== '/create') return destination;
    // The shared validator uses /create for rejection as well as a valid explicit /create link.
    try {
      if (typeof value !== 'string' || !value.startsWith('/')) return null;
      const decoded = decodeURIComponent(value);
      if (/^[/\\]{2}/.test(decoded) || decoded.includes('\\') || /[\x00-\x1f]/.test(decoded)) return null;
      const url = new URL(value, window.location.origin);
      return url.origin === window.location.origin && url.pathname === '/create' ? destination : null;
    } catch (_) { return null; }
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
    const employeeChallenge = document.getElementById('employeeDeveloperChallenge');
    const employeePassword = document.getElementById('employeeDeveloperPassword');
    const passwordChallenge = document.getElementById('passwordDeveloperChallenge');
    const developerPassword = document.getElementById('passwordDeveloperPassword');
    let employeeChallengeCode = null;
    let passwordChallengeUsername = null;
    const employeeDigits = Array.from({ length: 7 }, (_, index) => document.getElementById(`employeeDigit${index + 1}`));
    let employeeCodeFocused = false;
    let employeePreviousValue = employeeCodeInput.value;
    let employeeSigningIn = false;
    let passwordSigningIn = false;
    let passwordLoginGeneration = 0;
    let mode = null;
    const returnTo = explicitLoginReturnTo(new URLSearchParams(window.location.search).get('returnTo'));
    const destinationFor = (user) => {
      const roles = Array.isArray(user?.roles) ? user.roles : [];
      if (!roles.length) return '/records';
      return returnTo || '/admin';
    };
    const showMessage = (text) => {
      const inEmployeeForm = mode === 'employee-code' && !employeeForm.hidden;
      message.textContent = inEmployeeForm ? '' : text;
      employeeMessage.textContent = inEmployeeForm ? text : '';
    };
    function resetDeveloperChallenges() {
      employeeChallengeCode = null;
      passwordChallengeUsername = null;
      employeeChallenge.hidden = true;
      passwordChallenge.hidden = true;
      employeePassword.required = false;
      developerPassword.required = false;
      employeePassword.value = '';
      developerPassword.value = '';
    }
    window.addEventListener?.('pagehide', () => { passwordLoginGeneration++; resetDeveloperChallenges(); });
    function challengeValue(input) {
      if (!input.value || input.value.length > 128) throw new Error('Enter the Developer password.');
      return input.value;
    }
    document.getElementById('employeeDeveloperCancel').addEventListener('click', () => {
      if (employeeSigningIn) return;
      resetDeveloperChallenges();
      employeeCodeInput.value = '';
      employeePreviousValue = '';
      renderEmployeeCode();
      showMessage('');
      employeeCodeInput.focus();
    });
    document.getElementById('passwordDeveloperCancel').addEventListener('click', () => {
      if (passwordSigningIn) return;
      passwordLoginGeneration++;
      resetDeveloperChallenges();
      document.getElementById('password').value = '';
      showMessage('');
      document.getElementById('username').focus();
    });
    document.getElementById('username').addEventListener('input', () => {
      passwordLoginGeneration++;
      if (passwordChallengeUsername !== null) { resetDeveloperChallenges(); showMessage(''); }
    });
    function renderEmployeeCode() {
      const digits = employeeCodeInput.value.replace(/[^0-9]/g, '').slice(0, 7);
      employeeCodeInput.value = digits;
      employeeDigits.forEach((slot, index) => {
        slot.textContent = digits[index] || '';
        slot.classList.toggle('is-active', employeeCodeFocused && index === digits.length && digits.length < 7);
      });
    }
    function employeeCodeChanged() {
      if (employeeSigningIn) return;
      const enteredValue = employeeCodeInput.value;
      renderEmployeeCode();
      if (employeePreviousValue === employeeCodeInput.value) return;
      employeePreviousValue = employeeCodeInput.value;
      resetDeveloperChallenges();
      showMessage('');
      if (/^[0-9]{7}$/.test(enteredValue)) signInEmployee();
    }
    employeeCodeInput.addEventListener('input', employeeCodeChanged);
    employeeCodeInput.addEventListener('change', employeeCodeChanged);
    employeeCodeInput.addEventListener('paste', (event) => {
      const clipboardText = event.clipboardData?.getData('text');
      if (typeof clipboardText !== 'string') return;
      const currentValue = employeeCodeInput.value;
      const start = employeeCodeInput.selectionStart ?? currentValue.length;
      const end = employeeCodeInput.selectionEnd ?? start;
      const proposedValue = currentValue.slice(0, start) + clipboardText + currentValue.slice(end);
      if (!/^[0-9]{1,7}$/.test(clipboardText) || !/^[0-9]{1,7}$/.test(proposedValue)) {
        event.preventDefault();
        showMessage('Enter your 7-digit Employee ID.');
      }
    });
    employeeCodeInput.addEventListener('focus', () => { employeeCodeFocused = true; renderEmployeeCode(); });
    employeeCodeInput.addEventListener('blur', () => { employeeCodeFocused = false; renderEmployeeCode(); });
    function showChangePassword() {
      resetDeveloperChallenges();
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
      if (mode !== 'password' || passwordSigningIn) return;
      passwordSigningIn = true;
      document.getElementById('username').disabled = true;
      submit(loginForm, async () => {
        const username = document.getElementById('username').value.trim();
        const generation = ++passwordLoginGeneration;
        const currentAttempt = () => generation === passwordLoginGeneration
          && document.getElementById('username').value.trim() === username;
        try {
          const body = { username, password: document.getElementById('password').value };
          if (passwordChallengeUsername === username) body.developerPassword = challengeValue(developerPassword);
          const session = await window.PCN_SESSION.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
          if (!currentAttempt()) {
            if (session.authenticated) {
              try { await window.PCN_SESSION.logout(); } catch (error) { showMessage(error.message); }
            }
            return;
          }
          resetDeveloperChallenges();
          if (session.user?.mustChangePassword) showChangePassword();
          else window.location.assign(destinationFor(session.user));
        } catch (error) {
          if (!currentAttempt()) return;
          if (error.code === 'DEVELOPER_PASSWORD_REQUIRED') {
            passwordChallengeUsername = username;
            passwordChallenge.hidden = false;
            developerPassword.required = true;
            developerPassword.focus();
          }
          throw error;
        } finally {
          developerPassword.value = '';
          document.getElementById('password').value = '';
          document.getElementById('username').disabled = false;
          passwordSigningIn = false;
        }
      });
    });
    async function signInEmployee() {
      if (mode !== 'employee-code' || employeeForm.hidden || employeeSigningIn) return;
      const buttons = [...employeeForm.querySelectorAll('button')];
      const buttonLabels = buttons.map((button) => button.textContent);
      try {
        const body = employeeLoginBody(employeeCodeInput.value);
        if (employeeChallengeCode === body.employeeCode) body.developerPassword = challengeValue(employeePassword);
        employeeSigningIn = true;
        employeeCodeInput.disabled = true;
        employeeForm.setAttribute('aria-busy', 'true');
        buttons.forEach((button) => { button.disabled = true; button.textContent = 'Signing in…'; });
        showMessage('');
        const session = await window.PCN_SESSION.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
        if (!session.authenticated) throw new Error('Employee sign-in did not complete. Please try again.');
        resetDeveloperChallenges();
        window.location.assign(destinationFor(session.user));
      } catch (error) {
        employeeSigningIn = false;
        employeeCodeInput.disabled = false;
        employeeForm.setAttribute('aria-busy', 'false');
        buttons.forEach((button, index) => { button.disabled = false; button.textContent = buttonLabels[index]; });
        if (error.code === 'DEVELOPER_PASSWORD_REQUIRED') {
          employeeChallengeCode = employeeCodeInput.value;
          employeeChallenge.hidden = false;
          employeePassword.required = true;
          employeePassword.focus();
        }
        showMessage(error.message);
      } finally { employeePassword.value = ''; }
    }
    employeeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      signInEmployee();
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
    document.getElementById('signOutButton').addEventListener('click', () => {
      resetDeveloperChallenges();
      submit(changeForm, () => window.PCN_SESSION.logout());
    });
    async function configure() {
      passwordLoginGeneration++;
      resetDeveloperChallenges();
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
            employeePreviousValue = employeeCodeInput.value;
          } else document.getElementById('username').focus();
        }
      } catch (error) { mode = null; authIntro.hidden = false; showMessage(error.message); retryButton.hidden = false; retryButton.focus(); }
    }
    retryButton.addEventListener('click', () => configure());
    await configure();
  }
})();

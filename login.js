(function () {
  document.addEventListener('DOMContentLoaded', init);
  function authenticationMode(config) {
    if (!config || !['password', 'employee-code', 'employee-password'].includes(config.mode)) throw new Error('The sign-in configuration is unavailable. Please retry.');
    return config.mode;
  }
  function employeeLoginBody(code, password, remember = false) {
    const employeeCode = typeof code === 'string' ? code.trim() : '';
    if (!/^[0-9]{7}$/.test(employeeCode)) throw new Error('Enter your 7-digit Employee ID.');
    return { employeeCode, ...(typeof password === 'string' && password !== '' ? { password } : {}), ...(remember === true ? { remember:true } : {}) };
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
    const employeePasswordField = document.getElementById('employeePasswordField');
    const employeePassword = document.getElementById('employeePassword');
    const employeeRemember = document.getElementById('employeeRemember');
    const setupForm = document.getElementById('passwordSetupForm');
    const setupEmployeeCode = document.getElementById('setupEmployeeCode');
    const setupPassword = document.getElementById('setupPassword');
    const setupConfirmation = document.getElementById('setupConfirmPassword');
    const employeeDigits = Array.from({ length: 7 }, (_, index) => document.getElementById(`employeeDigit${index + 1}`));
    let employeeCodeFocused = false;
    let employeePreviousValue = employeeCodeInput.value;
    let employeeSigningIn = false;
    let identifiedEmployeeCode = null;
    let employeeRequestVersion = 0;
    let pageActive = true;
    let initialConfiguration = true;
    let mode = null;
    const employeePasswordControl = passwordCircleControl('employeePassword', 'password', () => mode === 'employee-password' && !employeeForm.hidden);
    const setupPasswordControls = [
      passwordCircleControl('setupPassword', 'new password', () => mode === 'employee-password' && !setupForm.hidden),
      passwordCircleControl('setupConfirmPassword', 'confirm password', () => mode === 'employee-password' && !setupForm.hidden)
    ];
    const returnTo = explicitLoginReturnTo(new URLSearchParams(window.location.search).get('returnTo'));
    const destinationFor = (user) => {
      const roles = Array.isArray(user?.roles) ? user.roles : [];
      if (!roles.length) return '/records';
      return returnTo || '/admin';
    };
    const showMessage = (text, tone = 'error') => {
      const inEmployeeForm = ['employee-code', 'employee-password'].includes(mode) && !employeeForm.hidden;
      message.classList.toggle('is-success', Boolean(text) && !inEmployeeForm && tone === 'success');
      employeeMessage.classList.toggle('is-success', Boolean(text) && inEmployeeForm && tone === 'success');
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
    function employeeCodeChanged() {
      if (employeeSigningIn) return;
      const enteredValue = employeeCodeInput.value;
      renderEmployeeCode();
      if (employeePreviousValue === employeeCodeInput.value) return;
      const previousCode = employeePreviousValue;
      employeePreviousValue = employeeCodeInput.value;
      showMessage('');
      if (mode === 'employee-password') {
        identifiedEmployeeCode = null;
        if (previousCode !== '' || !/^[0-9]{7}$/.test(enteredValue)) employeePasswordControl.clear();
        if (previousCode.length === 7) employeeRemember.checked = false;
        employeeBusy(false);
      }
      if (['employee-code', 'employee-password'].includes(mode) && /^[0-9]{7}$/.test(enteredValue)) {
        signInEmployee({ identifyOnly: mode === 'employee-password' });
      }
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
    employeePassword.addEventListener('paste', event => {
      if (!passwordEntryAvailable() || employeePassword.disabled) return;
      const text = event.clipboardData?.getData('text');
      if (typeof text !== 'string') return;
      const value = employeePassword.value;
      const start = employeePassword.selectionStart ?? value.length;
      const end = employeePassword.selectionEnd ?? start;
      const proposed = value.slice(0, start) + text + value.slice(end);
      if (!/^[A-Za-z0-9]{1,8}$/.test(text) || !/^[A-Za-z0-9]{1,8}$/.test(proposed)) {
        event.preventDefault();
        showMessage('Use exactly 8 letters or numbers for your password.');
      }
    });
    function showChangePassword() {
      authIntro.hidden = false;
      loginForm.hidden = true;
      employeeForm.hidden = true;
      changeForm.hidden = false;
      setupForm.hidden = true;
      document.getElementById('authTitle').textContent = 'Change your password';
      document.getElementById('authDescription').textContent = 'Change your temporary password before using the PCN portal.';
      document.getElementById('currentPassword').focus();
    }
    function clearSetupPasswords() { setupPasswordControls.forEach(control => control.clear()); }
    function passwordCircleControl(id, label, isAvailable, onEdit) {
      const input = document.getElementById(id);
      const toggle = document.getElementById(`${id}Toggle`);
      const toggleText = document.getElementById(`${id}ToggleText`);
      const circles = Array.from({ length: 8 }, (_, index) => document.getElementById(`${id}Digit${index + 1}`));
      let focused = false;
      function render() {
        const value = input.value;
        const revealed = input.type === 'text';
        const activeIndex = Math.min(input.selectionEnd ?? value.length, 7);
        circles.forEach((slot, index) => {
          const filled = index < value.length;
          slot.textContent = revealed ? value[index] || '' : '';
          slot.classList.toggle('is-filled', filled);
          slot.classList.toggle('is-revealed', revealed && filled);
          slot.classList.toggle('is-active', focused && !input.disabled && index === activeIndex);
          slot.classList.toggle('is-disabled', input.disabled);
        });
      }
      function setVisible(visible) {
        input.type = visible ? 'text' : 'password';
        toggle.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} ${label}`);
        toggle.setAttribute('aria-pressed', String(visible));
        toggleText.textContent = visible ? 'Hide' : 'Show';
        render();
      }
      for (const event of ['input', 'change']) input.addEventListener(event, () => { render(); onEdit?.(); });
      for (const event of ['keyup', 'select']) input.addEventListener(event, render);
      input.addEventListener('focus', () => { focused = true; render(); });
      input.addEventListener('blur', () => { focused = false; render(); });
      toggle.addEventListener('click', () => {
        if (!input.disabled && isAvailable()) setVisible(input.type === 'password');
      });
      setVisible(false);
      return {
        mask() { setVisible(false); },
        clear() { input.value = ''; setVisible(false); onEdit?.(); },
        setDisabled(value) { input.disabled = value; toggle.disabled = value; render(); }
      };
    }
    function maskEmployeePassword() { employeePasswordControl.mask(); }
    function passwordEntryAvailable() {
      return mode === 'employee-password';
    }
    function renderEmployeeEntry() {
      const passwordReady = passwordEntryAvailable();
      employeePasswordField.hidden = !passwordReady;
      employeePassword.required = false;
      employeeForm.classList.toggle('employee-password-mode', mode === 'employee-password');
      document.getElementById('employeeEntryTitle').textContent = passwordReady ? 'Sign in' : 'Enter your Employee ID';
      document.getElementById('employeeEntryHelp').textContent = passwordReady
        ? 'Your Employee Number'
        : 'Enter your 7-digit Employee ID to sign in automatically.';
    }
    function employeeBusy(value, identifying = false) {
      employeeSigningIn = value;
      employeeCodeInput.readOnly = value && identifying;
      employeeCodeInput.disabled = value && !identifying;
      renderEmployeeEntry();
      employeeForm.setAttribute('aria-busy', String(value));
      employeeForm.querySelectorAll('button').forEach(button => { button.disabled = value; });
      employeeForm.querySelectorAll('button[type="submit"]').forEach(button => {
        button.textContent = value ? (identifying ? 'Checking…' : 'Signing in…') : 'Sign in';
      });
      employeePasswordControl.setDisabled((value && !identifying) || !passwordEntryAvailable());
      employeeRemember.disabled=(value && !identifying) || !passwordEntryAvailable();
      if(value)maskEmployeePassword();
    }
    function showEmployeeSignIn(text = '', tone = 'error', preserveCredentials = false) {
      authIntro.hidden = true; loginForm.hidden = true; changeForm.hidden = true; setupForm.hidden = true;
      employeeForm.hidden = false;
      identifiedEmployeeCode = null;
      if (!preserveCredentials) { employeePasswordControl.clear(); employeeRemember.checked = false; }
      employeeBusy(false); renderEmployeeCode(); employeePreviousValue = employeeCodeInput.value;
      showMessage(text, tone);
    }
    function showPasswordSetup() {
      authIntro.hidden = false; loginForm.hidden = true; employeeForm.hidden = true; changeForm.hidden = true;
      setupForm.hidden = false; employeePasswordControl.clear(); clearSetupPasswords(); showMessage('');
      setupEmployeeCode.value = /^[0-9]{7}$/.test(employeeCodeInput.value) ? employeeCodeInput.value : '';
      document.getElementById('authTitle').textContent = 'Set your password';
      document.getElementById('authDescription').textContent = 'Create your password before opening the PCN portal.';
      setupPassword.focus();
    }
    async function submit(form, action) {
      const buttons = [...form.querySelectorAll('button')];
      buttons.forEach((button) => { button.disabled = true; });
      if (form === setupForm) setupPasswordControls.forEach(control => { control.setDisabled(true); control.mask(); });
      showMessage('');
      try { await action(); } catch (error) { showMessage(error.message); }
      finally {
        buttons.forEach((button) => { button.disabled = false; });
        if (form === setupForm) setupPasswordControls.forEach(control => control.setDisabled(false));
      }
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
        else window.location.assign(destinationFor(session.user));
      });
    });
    async function signInEmployee({ identifyOnly = false } = {}) {
      if (!pageActive || !['employee-code', 'employee-password'].includes(mode) || employeeForm.hidden || employeeSigningIn) return;
      const requestVersion = ++employeeRequestVersion;
      const requestMode = mode;
      const code = employeeCodeInput.value;
      const identifying = mode === 'employee-password' && (identifyOnly || !employeePassword.value);
      let preservePassword = false;
      try {
        const credentials = employeeLoginBody(code, !identifying && mode === 'employee-password' ? employeePassword.value : undefined,
          !identifying && mode === 'employee-password' && employeeRemember.checked);
        if (!identifying && mode === 'employee-password' && !/^[A-Za-z0-9]{8}$/.test(employeePassword.value)) throw new Error('Use exactly 8 letters or numbers for your password.');
        const body = identifying ? {employeeCode:credentials.employeeCode, identifyOnly:true} : credentials;
        employeePreviousValue = code;
        employeeBusy(true, identifying);
        showMessage('');
        const session = await window.PCN_SESSION.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
        if (!pageActive || requestVersion !== employeeRequestVersion || mode !== requestMode) return;
        if (code !== employeeCodeInput.value) {
          identifiedEmployeeCode = null; employeeRemember.checked = false; employeeBusy(false);
          showMessage('Employee ID changed. Continue to check it again.'); return;
        }
        if (identifying && session?.authenticated === false && session.passwordRequired === true
          && Object.keys(session).every(key => ['authenticated', 'passwordRequired'].includes(key))) {
          identifiedEmployeeCode = code; preservePassword = true; employeeBusy(false);
          if (!identifyOnly || document.activeElement === employeeCodeInput) employeePassword.focus();
          if (!identifyOnly && !employeePassword.value) showMessage('Enter your password to sign in.');
          return;
        }
        if (mode === 'employee-password' && session?.authenticated === true && session.user?.passwordSetupRequired === true) {
          if (session.user.employeeCode && session.user.employeeCode !== code) throw new Error('Employee sign-in did not complete. Please try again.');
          employeeBusy(false); showPasswordSetup(); return;
        }
        if (identifying || session?.authenticated !== true) throw new Error('Employee sign-in did not complete. Please try again.');
        if (mode === 'employee-password') {
          employeeCodeInput.disabled = false;
          employeePassword.disabled = false;
        }
        window.location.assign(destinationFor(session.user));
        preservePassword = true;
      } catch (error) {
        if (!pageActive || requestVersion !== employeeRequestVersion || mode !== requestMode) return;
        employeeBusy(false);
        showMessage(error.message);
      } finally {
        if (pageActive && requestVersion === employeeRequestVersion && !preservePassword) employeePasswordControl.clear();
      }
    }
    employeeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      signInEmployee();
    });
    setupForm.addEventListener('submit', event => {
      event.preventDefault();
      if (mode !== 'employee-password' || setupForm.hidden) return;
      submit(setupForm, async () => {
        try {
          const newPassword = setupPassword.value, confirmPassword = setupConfirmation.value;
          if (!/^[A-Za-z0-9]{8}$/.test(newPassword)) throw new Error('Use exactly 8 letters or numbers. You may use all letters, all numbers or a mix.');
          if (newPassword !== confirmPassword) throw new Error('The new passwords do not match.');
          const result = await window.PCN_SESSION.fetch('/api/auth/setup-password', {
            method: 'POST', body: JSON.stringify({ newPassword, confirmPassword })
          });
          if (result.authenticated !== false || result.passwordSet !== true) throw new Error('Password setup did not complete. Sign in again to check your account.');
          showEmployeeSignIn('Password set. Sign in with your Employee ID and password.', 'success');
          if (passwordEntryAvailable()) employeePassword.focus(); else employeeCodeInput.focus();
        } finally { clearSetupPasswords(); }
      });
    });
    document.getElementById('setupSignOutButton').addEventListener('click', () => submit(setupForm, async () => {
      clearSetupPasswords(); await window.PCN_SESSION.logout();
    }));
    window.addEventListener?.('pagehide', () => {
      pageActive = false; employeeRequestVersion++; identifiedEmployeeCode = null; employeeRemember.checked = false;
      employeePasswordControl.clear(); clearSetupPasswords();
      setupEmployeeCode.value = '';
      for (const id of ['password', 'currentPassword', 'newPassword', 'confirmPassword']) document.getElementById(id).value = '';
    });
    window.addEventListener?.('pageshow', event => { if (event.persisted) configure(); });
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
        showMessage('Password changed. Sign in again to continue.', 'success');
        document.getElementById('password').focus();
      });
    });
    document.getElementById('signOutButton').addEventListener('click', () => submit(changeForm, () => window.PCN_SESSION.logout()));
    async function configure() {
      const preserveAutofill = initialConfiguration;
      initialConfiguration = false;
      pageActive = true; employeeRequestVersion++; identifiedEmployeeCode = null; employeeSigningIn = false;
      mode = null;
      loginForm.hidden = true;
      employeeForm.hidden = true;
      changeForm.hidden = true;
      setupForm.hidden = true;
      employeePasswordField.hidden = true;
      employeePassword.disabled = !preserveAutofill;
      if (!preserveAutofill) employeePasswordControl.clear();
      clearSetupPasswords();
      setupEmployeeCode.value = '';
      authIntro.hidden = true;
      retryButton.hidden = true;
      showMessage('Loading sign-in options...');
      try {
        mode = authenticationMode(await window.PCN_SESSION.fetch('/api/auth/config'));
        const session = await window.PCN_SESSION.load();
        showMessage('');
        if (session.authenticated && session.user?.passwordSetupRequired && mode === 'employee-password') {
          if (/^[0-9]{7}$/.test(session.user.employeeCode || '')) employeeCodeInput.value = session.user.employeeCode;
          showPasswordSetup();
        }
        else if (session.authenticated && session.user?.mustChangePassword && mode === 'password') showChangePassword();
        else if (session.authenticated) window.location.assign(destinationFor(session.user));
        else {
          loginForm.hidden = mode !== 'password';
          employeeForm.hidden = !['employee-code', 'employee-password'].includes(mode);
          authIntro.hidden = mode !== 'password';
          document.getElementById('authDescription').textContent = 'Enter your credentials to continue to the PCN portal.';
          if (['employee-code', 'employee-password'].includes(mode)) {
            const enteredCode = employeeCodeInput.value;
            const changed = mode === 'employee-password' && new URLSearchParams(window.location.search).get('passwordChanged') === '1';
            showEmployeeSignIn(changed ? 'Password changed. Sign in with your new password.' : '', changed ? 'success' : 'error', mode === 'employee-password' && preserveAutofill && !changed);
            if (mode === 'employee-password' && /^[0-9]{7}$/.test(enteredCode) && enteredCode === employeeCodeInput.value) {
              signInEmployee({ identifyOnly: true });
            }
          } else document.getElementById('username').focus();
        }
      } catch (error) { mode = null; employeePasswordControl.clear(); clearSetupPasswords(); authIntro.hidden = false; showMessage(error.message); retryButton.hidden = false; retryButton.focus(); }
    }
    retryButton.addEventListener('click', () => configure());
    await configure();
  }
})();

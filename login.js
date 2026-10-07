(function () {
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    const loginForm = document.getElementById('loginForm');
    const employeeIdInput = document.getElementById('employeeId');
    const message = document.getElementById('authMessage');
    const returnTo = window.PCN_SESSION.safeReturnTo(new URLSearchParams(window.location.search).get('returnTo'));
    const showMessage = (text) => { message.textContent = text; };

    employeeIdInput.addEventListener('input', () => {
      employeeIdInput.value = employeeIdInput.value.replace(/[^0-9]/g, '').slice(0, 7);
      showMessage('');
    });

    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = loginForm.querySelector('button[type="submit"]');
      button.disabled = true;
      showMessage('');
      try {
        await window.PCN_SESSION.fetch('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ employeeId: employeeIdInput.value })
        });
        window.location.assign(returnTo);
      } catch (error) {
        showMessage(error.message);
      } finally {
        button.disabled = false;
      }
    });

    try {
      const session = await window.PCN_SESSION.load();
      if (session.authenticated) window.location.assign(returnTo);
      else employeeIdInput.focus();
    } catch (error) {
      showMessage(error.message);
    }
  }
})();

(function () {
  const roles = ['admin', 'reviewer', 'supplier', 'gsc', 'productionengineering', 'qa', 'tapbu'];
  const departments = ['gscTet', 'prodEngTet', 'qaTet', 'gscTapbu', 'qaTapbu', 'it', 'other'];
  document.addEventListener('DOMContentLoaded', init);

  function directoryBody(employee) {
    if (!employee || typeof employee.directoryId !== 'string' || !employee.directoryId.trim()
      || typeof employee.employeeCode !== 'string' || !employee.employeeCode.trim()) {
      throw new Error('Select an employee from the AD search results.');
    }
    return { directoryId: employee.directoryId };
  }
  function provisioningBody(employee, role, department) {
    const identity = directoryBody(employee);
    if (!roles.includes(role)) throw new Error('Select a PCN role.');
    if (!departments.includes(department)) throw new Error('Select a PCN department.');
    return { ...identity, roles: [role], department };
  }

  async function init() {
    const ids = ['employeeUserForm', 'employeeFormTitle', 'employeeSearch', 'employeeSearchStatus', 'employeeResults',
      'employeeSelected', 'employeeCode', 'employeeProfile', 'employeeAssignments', 'employeeRole', 'employeeDepartment',
      'employeeLinkHelp', 'employeeCancelButton', 'employeeCreateButton', 'usersMessage', 'adminUsersRows', 'usersRefreshButton'];
    const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    let state = { authorized: false, loaded: false, configured: false, mode: 'password', busy: false, users: [], selected: null, linkUser: null };
    let timer;
    let controller;
    const message = (text) => { els.usersMessage.textContent = text; };
    function cancelLookup() {
      clearTimeout(timer);
      if (controller) controller.abort();
      controller = null;
    }
    function hideResults() {
      els.employeeResults.replaceChildren();
      els.employeeResults.hidden = true;
    }
    function updateControls() {
      els.employeeSearch.disabled = !state.configured || state.busy;
      els.employeeRole.disabled = state.busy;
      els.employeeDepartment.disabled = state.busy;
      els.employeeCancelButton.disabled = state.busy;
      els.usersRefreshButton.disabled = state.busy;
      els.employeeCreateButton.disabled = state.busy || !state.configured || !state.selected
        || (!state.linkUser && (!roles.includes(els.employeeRole.value) || !departments.includes(els.employeeDepartment.value)));
      els.employeeUserForm.setAttribute('aria-busy', String(state.busy));
    }
    function clearSelection(focus = true) {
      cancelLookup();
      state = { ...state, selected: null, linkUser: null };
      els.employeeUserForm.reset();
      els.employeeSelected.hidden = true;
      els.employeeAssignments.hidden = false;
      els.employeeLinkHelp.hidden = true;
      els.employeeRole.required = true;
      els.employeeDepartment.required = true;
      els.employeeFormTitle.textContent = 'Create employee user';
      els.employeeCreateButton.textContent = 'Create user';
      els.employeeSearchStatus.textContent = '';
      hideResults();
      updateControls();
      if (focus && !els.employeeSearch.disabled && window.location.hash === '#users') els.employeeSearch.focus();
    }
    function selectEmployee(employee) {
      if (!state.configured || state.busy) return;
      try { directoryBody(employee); } catch (error) { els.employeeSearchStatus.textContent = error.message; return; }
      cancelLookup();
      state = { ...state, selected: { ...employee } };
      els.employeeSearch.value = employee.displayName || employee.employeeCode;
      els.employeeCode.value = employee.employeeCode;
      els.employeeProfile.textContent = [employee.displayName, employee.email, employee.adDepartment && `AD department: ${employee.adDepartment}`].filter(Boolean).join(' · ');
      els.employeeSelected.hidden = false;
      els.employeeSearchStatus.textContent = `Selected ${employee.employeeCode}.`;
      hideResults();
      updateControls();
      (state.linkUser ? els.employeeCreateButton : els.employeeRole).focus();
    }
    async function searchEmployees(query) {
      const request = new AbortController();
      controller = request;
      els.employeeSearchStatus.textContent = 'Searching Active Directory...';
      try {
        const results = await window.PCN_SESSION.fetch(`/api/admin/employees?query=${encodeURIComponent(query)}`, { signal: request.signal });
        if (controller !== request || request.signal.aborted || !state.configured || state.busy
          || els.employeeSearch.value.trim() !== query || window.location.hash !== '#users') return;
        if (!Array.isArray(results)) throw new Error('The AD search returned an invalid response.');
        hideResults();
        results.forEach((employee) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'employee-result';
          button.textContent = [employee.displayName, employee.employeeCode, employee.email, employee.adDepartment].filter(Boolean).join(' · ');
          button.addEventListener('click', () => selectEmployee(employee));
          els.employeeResults.appendChild(button);
        });
        els.employeeResults.hidden = results.length === 0;
        els.employeeSearchStatus.textContent = results.length ? `${results.length} AD employees found. Select a result.` : 'No AD employee found. Try another name or employee code.';
      } catch (error) {
        if (controller === request && !request.signal.aborted) {
          hideResults();
          els.employeeSearchStatus.textContent = error.message || 'AD search is unavailable. Please try again.';
        }
      } finally { if (controller === request) controller = null; }
    }
    function beginLink(user) {
      if (state.mode !== 'windows' && (user.roles || []).includes('admin')) {
        message('To protect administrator access, create a separate Windows administrator, enable Windows SSO, then link existing administrators.');
        return;
      }
      clearSelection(false);
      state = { ...state, linkUser: user };
      els.employeeFormTitle.textContent = `Link AD employee to ${user.displayName || user.username}`;
      els.employeeAssignments.hidden = true;
      els.employeeLinkHelp.hidden = false;
      els.employeeRole.required = false;
      els.employeeDepartment.required = false;
      els.employeeCreateButton.textContent = 'Link employee';
      updateControls();
      els.employeeSearch.focus();
    }
    function optionLabel(select, value) {
      return [...select.options].find((option) => option.value === value)?.textContent || value || 'Unassigned';
    }
    function renderUsers() {
      els.adminUsersRows.replaceChildren();
      state.users.forEach((user) => {
        const row = document.createElement('tr');
        const values = [user.employeeCode || user.username, [user.displayName, user.email].filter(Boolean).join(' · '),
          (user.roles || []).map((role) => optionLabel(els.employeeRole, role)).join(', '),
          optionLabel(els.employeeDepartment, user.department), user.isActive ? 'Active' : 'Inactive', user.directoryId ? 'Windows' : 'Local'];
        values.forEach((value) => { const cell = document.createElement('td'); cell.textContent = value || '—'; row.appendChild(cell); });
        if (!user.directoryId) {
          const link = document.createElement('button');
          link.type = 'button'; link.className = 'ghost-button'; link.textContent = 'Link AD employee';
          link.setAttribute('aria-label', `Link AD employee to ${user.username}`);
          link.disabled = !state.configured || state.busy || (state.mode !== 'windows' && (user.roles || []).includes('admin'));
          if (state.mode !== 'windows' && (user.roles || []).includes('admin')) link.title = 'Enable Windows SSO before linking an existing administrator.';
          link.addEventListener('click', () => beginLink(user));
          row.lastElementChild.appendChild(link);
        }
        els.adminUsersRows.appendChild(row);
      });
    }
    async function loadUsers() {
      if (!state.authorized || state.busy || window.location.hash !== '#users') return;
      state = { ...state, busy: true };
      updateControls(); message('Loading users and AD provisioning status...');
      try {
        const [config, users] = await Promise.all([window.PCN_SESSION.fetch('/api/auth/config'), window.PCN_SESSION.fetch('/api/admin/users')]);
        if (!Array.isArray(users)) throw new Error('The user list returned an invalid response.');
        state = { ...state, configured: config.employeeProvisioningConfigured === true, mode: config.mode, users, loaded: true };
        message(state.configured ? `${users.length} assigned users. Select an AD employee to create or link access.${state.mode !== 'windows' ? ' Before linking existing administrators, create a separate Windows administrator and enable Windows SSO.' : ''}` : 'AD employee provisioning is not configured on the server. Existing users are shown below.');
      } catch (error) { message(error.message); }
      finally { state = { ...state, busy: false }; updateControls(); renderUsers(); }
    }
    els.employeeSearch.addEventListener('input', () => {
      cancelLookup(); hideResults();
      state = { ...state, selected: null };
      els.employeeSelected.hidden = true; els.employeeCode.value = ''; els.employeeProfile.textContent = '';
      updateControls();
      const query = els.employeeSearch.value.trim();
      els.employeeSearchStatus.textContent = query.length < 2 ? 'Type at least two characters to search AD.' : '';
      if (state.configured && !state.busy && query.length >= 2) timer = setTimeout(() => searchEmployees(query), 280);
    });
    els.employeeSearch.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' && !els.employeeResults.hidden) { event.preventDefault(); els.employeeResults.firstElementChild?.focus(); }
      if (event.key === 'Escape') { cancelLookup(); hideResults(); els.employeeSearchStatus.textContent = 'AD search results dismissed.'; }
    });
    els.employeeResults.addEventListener('keydown', (event) => {
      const buttons = [...els.employeeResults.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); cancelLookup(); hideResults(); els.employeeSearch.focus(); }
    });
    [els.employeeRole, els.employeeDepartment].forEach((select) => select.addEventListener('change', updateControls));
    els.employeeCancelButton.addEventListener('click', () => clearSelection());
    els.usersRefreshButton.addEventListener('click', () => loadUsers());
    els.employeeUserForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.busy) return;
      try {
        if (!state.configured) throw new Error('AD employee provisioning is not configured on the server.');
        const linkedUser = state.linkUser;
        if (linkedUser && state.mode !== 'windows' && (linkedUser.roles || []).includes('admin')) throw new Error('Enable Windows SSO before linking an existing administrator.');
        const body = linkedUser ? directoryBody(state.selected) : provisioningBody(state.selected, els.employeeRole.value, els.employeeDepartment.value);
        if (linkedUser && !window.confirm(`Link ${linkedUser.username} to ${state.selected.employeeCode}? This account's PCN password will stop working and existing sessions will be signed out. Its permissions and records will be preserved.`)) return;
        state = { ...state, busy: true }; cancelLookup(); updateControls(); renderUsers(); message('Saving employee access...');
        const user = await window.PCN_SESSION.fetch(linkedUser ? `/api/admin/users/${encodeURIComponent(linkedUser.id)}/directory` : '/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
        state = { ...state, users: linkedUser ? state.users.map((existing) => existing.id === linkedUser.id ? user : existing) : [...state.users, user], busy: false };
        clearSelection(); renderUsers(); message(linkedUser ? 'AD employee linked. Existing permissions and records were preserved.' : 'Employee user created. Windows sign-in is available when server SSO is enabled.');
      } catch (error) { state = { ...state, busy: false }; updateControls(); renderUsers(); message(error.message); }
    });
    window.addEventListener('hashchange', () => {
      cancelLookup(); hideResults();
      if (window.location.hash === '#users' && !state.loaded) loadUsers();
    });
    try {
      const session = await window.PCN_SESSION.require('admin');
      if (!session) return;
      state = { ...state, authorized: true };
      await loadUsers();
    } catch (error) { message(error.message); }
  }
})();

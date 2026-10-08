(function () {
  const departmentRoles = { gscTet: 'gsc', prodEngTet: 'productionengineering', qaTet: 'qa', gscTapbu: 'tapbu', qaTapbu: 'tapbu' };
  const accessLabels = { admin: 'Administrator', reviewer: 'Reviewer', supplier: 'Requester', gsc: 'GSC', productionengineering: 'Production engineering', qa: 'QA', tapbu: 'TaPBU' };
  const departments = ['gscTet', 'prodEngTet', 'qaTet', 'gscTapbu', 'qaTapbu', 'it', 'other'];
  const signingDepartments = ['gscTet', 'prodEngTet', 'qaTet', 'gscTapbu', 'qaTapbu'];
  const signingSteps = ['approved', 'checked', 'prepared'];
  document.addEventListener('DOMContentLoaded', init);

  function validMailProfile(mail) {
    return mail && typeof mail.id === 'string' && Boolean(mail.id.trim()) && mail.id.length <= 200
      && typeof mail.email === 'string' && mail.email.length <= 100 && /^[^\s@;,]+@[^\s@;,]+\.[^\s@;,]+$/.test(mail.email);
  }
  function directoryBody(employee) {
    if (!employee || typeof employee.employeeCode !== 'string' || !/^[A-Za-z0-9._-]{1,10}$/.test(employee.employeeCode)
      || typeof employee.displayName !== 'string' || !employee.displayName.trim()) {
      throw new Error('Select an employee from the employee search results.');
    }
    return { employeeCode: employee.employeeCode };
  }
  function mailFields(step, mail, retainedMail) {
    if (mail && !validMailProfile(mail)) throw new Error('Select a mail recipient from directory results.');
    if (step && !mail && !retainedMail?.email) throw new Error('Select a mail recipient for this PCN role.');
    return mail ? { mailSelection: { id: mail.id, email: mail.email } } : {};
  }
  function assignmentBody(role, department, mail = null, retainedMail = null) {
    if (role !== 'admin' && !signingSteps.includes(role)) throw new Error('Select a PCN role.');
    if (!departments.includes(department)) throw new Error('Select a PCN department.');
    const step = role === 'admin' ? null : role;
    if (step && !signingDepartments.includes(department)) throw new Error('Select a signing department.');
    return { roles: [step ? departmentRoles[department] : 'admin'], department, signingStep: step, ...mailFields(step, mail, retainedMail) };
  }
  function provisioningBody(employee, role, department, mail) {
    return { ...directoryBody(employee), ...assignmentBody(role, department, mail) };
  }
  function editBody(user, role, department, mail, active, assignmentChanged, retainMail = true) {
    if (!/^[a-f0-9]{16}$/.test(user.version || '')) throw new Error('Reload users before editing this account.');
    // Unrelated edits retain exact existing authority, including legacy and multiple roles.
    const assignment = assignmentChanged ? assignmentBody(role, department, mail, retainMail ? user.mailProfile : null)
      : { roles: [...user.roles], department: user.department, signingStep: user.signingStep || null,
        ...mailFields(user.signingStep, mail, retainMail ? user.mailProfile : null) };
    return { ...assignment, ...(!retainMail && !mail ? { mailSelection: null } : {}), isActive: active === true, version: user.version };
  }
  function pcnRole(user) { return user.roles.includes('admin') ? 'admin' : signingSteps.includes(user.signingStep) ? user.signingStep : ''; }

  function userIdentity(user) {
    const identity = document.createElement('div'); identity.className = 'employee-user-identity';
    const name = user.displayName || user.mailProfile?.displayName || user.username || user.employeeCode || '';
    const avatar = document.createElement('span'); avatar.className = 'notification-person-avatar'; avatar.setAttribute('aria-hidden', 'true');
    const fallback = () => { avatar.replaceChildren(); avatar.textContent = name.trim().charAt(0).toUpperCase() || '?'; };
    const photo = typeof user.mailProfile?.photo === 'string' ? user.mailProfile.photo.trim() : '';
    const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(photo);
    if (photo.length <= 100 * 1024 && match && match[1].length % 4 === 0) {
      const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', fallback, { once: true }); image.src = photo; avatar.appendChild(image);
    } else fallback();
    const body = document.createElement('div'); body.className = 'notification-person-body';
    const title = document.createElement('span'); title.className = 'notification-person-identity'; title.textContent = name;
    const email = document.createElement('span'); email.className = 'notification-person-email'; email.textContent = user.mailProfile?.email || user.email || '';
    const meta = document.createElement('div'); meta.className = 'notification-person-meta';
    meta.textContent = [user.mailProfile?.jobTitle, user.mailProfile?.department].filter(Boolean).join(' - '); meta.hidden = !meta.textContent;
    [title, email, meta].forEach((element) => body.appendChild(element));
    identity.appendChild(avatar); identity.appendChild(body);
    return identity;
  }

  async function init() {
    const ids = ['employeeUserForm', 'employeeFormTitle', 'employeeSearch', 'employeeSearchStatus', 'employeeResults',
      'employeeSelected', 'employeeCode', 'employeeProfile', 'employeeAssignments', 'employeeRole', 'employeeDepartment',
      'employeeLinkHelp', 'employeeCancelButton', 'employeeCreateButton', 'usersMessage', 'adminUsersRows', 'usersRefreshButton',
      'employeeActive', 'employeeActiveLabel', 'employeeMailSearch', 'employeeMailResults',
      'employeeMailStatus', 'employeeMailSelected', 'employeeRoutePreview', 'employeeRoleHelp'];
    const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    let state = { authorized: false, loaded: false, configured: false, busy: false, users: [], selected: null, linkUser: null, editUser: null, mail: null, retainMail: true, assignmentChanged: false };
    let timer;
    let controller;
    let mailTimer;
    let mailController;
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
    function cancelMailLookup() {
      clearTimeout(mailTimer);
      if (mailController) mailController.abort();
      mailController = null;
      els.employeeMailResults.replaceChildren();
      els.employeeMailResults.hidden = true;
    }
    function bodyForSelection() {
      if (state.linkUser) return directoryBody(state.selected);
      if (state.editUser) return editBody(state.editUser, els.employeeRole.value, els.employeeDepartment.value, state.mail, els.employeeActive.checked, state.assignmentChanged, state.retainMail);
      return provisioningBody(state.selected, els.employeeRole.value, els.employeeDepartment.value, state.mail);
    }
    function previewRoute(validationError = '') {
      if (validationError) { els.employeeRoutePreview.textContent = validationError; return; }
      if (state.linkUser) { els.employeeRoutePreview.textContent = 'Existing permissions and mail routing are preserved when linking an employee.'; return; }
      const assignment = bodyForSelection();
      const step = assignment.signingStep;
      const email = state.mail?.email || (state.retainMail ? state.editUser?.mailProfile?.email : '');
      const scope = `${optionLabel(els.employeeDepartment, assignment.department)} / ${step ? optionLabel(els.employeeRole, step) : assignment.roles.includes('admin') ? 'Administrator' : 'No signing assignment'}`;
      const authority = state.editUser && !state.assignmentChanged ? 'Existing permissions are preserved.' : `Access: ${assignment.roles.map(role => accessLabels[role] || role).join(', ')}.`;
      els.employeeRoutePreview.textContent = `${scope}. ${authority} ${!step ? 'This account is not added to a signing mail list.' : `${email || 'Confirm an email recipient.'}${state.editUser && !els.employeeActive.checked ? ' Inactive users receive no automatic mail.' : ' Mail routing is managed from this user assignment.'}`}`;
    }
    function updateRoleHelp() {
      const user = state.editUser;
      if (!user) { els.employeeRoleHelp.textContent = ''; return; }
      const current = `Current access: ${user.roles.map(role => accessLabels[role] || role).join(', ')}.`;
      const detail = state.assignmentChanged ? 'The selected PCN role and department will replace the current assignment when saved.'
        : `Existing permissions are preserved${user.signingStep ? `, including ${optionLabel(els.employeeDepartment, user.department)} / ${optionLabel(els.employeeRole, user.signingStep)}` : ' with no signing assignment'}. Changing PCN role or department replaces this assignment.`;
      els.employeeRoleHelp.textContent = `${current} ${detail}`;
    }
    function updateControls() {
      els.employeeSearch.disabled = !state.configured || state.busy || Boolean(state.editUser);
      els.employeeRole.disabled = state.busy;
      els.employeeDepartment.disabled = state.busy;
      els.employeeRole.required = !state.linkUser && (!state.editUser || state.assignmentChanged);
      els.employeeActive.disabled = state.busy;
      els.employeeMailSearch.disabled = state.busy || (!state.selected && !state.editUser);
      els.employeeCancelButton.disabled = state.busy;
      els.usersRefreshButton.disabled = state.busy;
      let validationError = '';
      try { bodyForSelection(); } catch (error) { validationError = error.message; }
      els.employeeCreateButton.disabled = state.busy || (!state.configured && !state.editUser) || Boolean(validationError);
      els.employeeUserForm.setAttribute('aria-busy', String(state.busy));
      updateRoleHelp();
      previewRoute(validationError);
    }
    function clearSelection(focus = true) {
      cancelLookup();
      cancelMailLookup();
      state = { ...state, selected: null, linkUser: null, editUser: null, mail: null, retainMail: true, assignmentChanged: false };
      els.employeeUserForm.reset();
      els.employeeSelected.hidden = true;
      els.employeeAssignments.hidden = false;
      els.employeeLinkHelp.hidden = true;
      els.employeeActiveLabel.hidden = true;
      els.employeeMailSelected.textContent = '';
      els.employeeMailStatus.textContent = '';
      els.employeeRoleHelp.textContent = '';
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
      const existingUser = !state.linkUser && state.users.find((user) =>
        String(user.employeeCode || '').toLowerCase() === employee.employeeCode.toLowerCase());
      if (existingUser) {
        beginEdit(existingUser);
        els.employeeSearchStatus.textContent = `${employee.employeeCode} already has an account. Edit its PCN access below.`;
        return;
      }
      cancelLookup();
      state = { ...state, selected: { ...employee } };
      els.employeeSearch.value = employee.displayName || employee.employeeCode;
      els.employeeCode.value = employee.employeeCode;
      els.employeeProfile.textContent = [employee.displayName, employee.jobTitle, employee.sourceDepartment && `Organization: ${employee.sourceDepartment}`].filter(Boolean).join(' · ');
      els.employeeSelected.hidden = false;
      els.employeeSearchStatus.textContent = `Selected ${employee.employeeCode}.`;
      hideResults();
      updateControls();
      if (!state.linkUser) {
        state = { ...state, mail: null, retainMail: false };
        els.employeeMailSelected.textContent = '';
        const englishName = typeof employee.englishName === 'string' ? employee.englishName.trim() : employee.displayName;
        els.employeeMailSearch.value = englishName;
        updateControls();
        if (englishName) lookupMail(englishName);
        else els.employeeMailStatus.textContent = 'No English name is available. Search and confirm the employee’s mail recipient.';
      }
      (state.linkUser ? els.employeeCreateButton : els.employeeRole).focus();
    }
    async function lookupMail(query) {
      cancelMailLookup();
      if (query.length < 2) { els.employeeMailStatus.textContent = 'Type at least two characters to search mail recipients.'; return; }
      const request = new AbortController();
      mailController = request;
      els.employeeMailStatus.textContent = 'Searching mail directory. Confirm the matching person below.';
      try {
        const body = await window.PCN_SESSION.fetch(`/api/admin/directory-users?query=${encodeURIComponent(query)}`, { signal: request.signal });
        if (mailController !== request || request.signal.aborted || els.employeeMailSearch.value.trim() !== query || window.location.hash !== '#users') return;
        const profiles = Array.isArray(body?.users) ? body.users : Array.isArray(body) ? body : null;
        if (!profiles) throw new Error('The mail directory returned an invalid response.');
        const matches = profiles.filter((person) => person && typeof person === 'object')
          .map((person) => ({ ...person, email: person.email || person.mail })).filter(validMailProfile).slice(0, 20);
        matches.forEach((profile) => {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'employee-result';
          button.textContent = [profile.displayName, profile.email, profile.jobTitle, profile.department].filter(Boolean).join(' · ');
          button.addEventListener('click', () => {
            if (state.busy || (!state.selected && !state.editUser) || !validMailProfile(profile)) return;
            cancelMailLookup();
            state = { ...state, mail: profile, retainMail: false };
            els.employeeMailSearch.value = profile.email;
            els.employeeMailSelected.textContent = `Confirmed: ${profile.displayName || profile.email} — ${profile.email}`;
            els.employeeMailStatus.textContent = 'Mail recipient selected. The server verifies this selection when saving.';
            updateControls();
          });
          els.employeeMailResults.appendChild(button);
        });
        els.employeeMailResults.hidden = !matches.length;
        els.employeeMailStatus.textContent = matches.length ? `${matches.length} matching mail recipients. Confirm the employee's identity; matching names may belong to different people.`
          : profiles.length ? 'The mail directory returned no recipient with a valid directory identity and email. Try another search or contact your administrator.'
          : 'No matching mail recipient found. Try another name.';
      } catch (error) {
        if (mailController === request && !request.signal.aborted) els.employeeMailStatus.textContent = error.message || 'Mail lookup is unavailable.';
      } finally { if (mailController === request) mailController = null; }
    }
    async function searchEmployees(query) {
      const request = new AbortController();
      controller = request;
      els.employeeSearchStatus.textContent = 'Searching employee directory...';
      try {
        const results = await window.PCN_SESSION.fetch(`/api/admin/employees?query=${encodeURIComponent(query)}`, { signal: request.signal });
        if (controller !== request || request.signal.aborted || !state.configured || state.busy
          || els.employeeSearch.value.trim() !== query || window.location.hash !== '#users') return;
        if (!Array.isArray(results)) throw new Error('The employee search returned an invalid response.');
        hideResults();
        results.forEach((employee) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'employee-result';
          button.textContent = [employee.displayName, employee.employeeCode, employee.jobTitle, employee.sourceDepartment].filter(Boolean).join(' · ');
          button.addEventListener('click', () => selectEmployee(employee));
          els.employeeResults.appendChild(button);
        });
        els.employeeResults.hidden = results.length === 0;
        els.employeeSearchStatus.textContent = results.length ? `${results.length} employees found. Select a result.` : 'No employee found. Try another name or employee code.';
      } catch (error) {
        if (controller === request && !request.signal.aborted) {
          hideResults();
          els.employeeSearchStatus.textContent = error.message || 'Employee search is unavailable. Please try again.';
        }
      } finally { if (controller === request) controller = null; }
    }
    function beginLink(user) {
      clearSelection(false);
      state = { ...state, linkUser: user };
      els.employeeFormTitle.textContent = `Link employee to ${user.displayName || user.username}`;
      els.employeeAssignments.hidden = true;
      els.employeeLinkHelp.hidden = false;
      els.employeeRole.required = false;
      els.employeeDepartment.required = false;
      els.employeeCreateButton.textContent = 'Link employee';
      updateControls();
      els.employeeSearch.focus();
    }
    function beginEdit(user) {
      clearSelection(false);
      state = { ...state, editUser: user };
      els.employeeFormTitle.textContent = 'Edit employee access';
      els.employeeSearch.value = user.displayName || user.employeeCode || user.username;
      els.employeeCode.value = user.employeeCode || user.username;
      els.employeeProfile.textContent = user.displayName || user.username;
      els.employeeSelected.hidden = false;
      els.employeeRole.value = pcnRole(user);
      els.employeeDepartment.value = user.department || '';
      els.employeeActive.checked = user.isActive === true;
      els.employeeActiveLabel.hidden = false;
      els.employeeMailSearch.value = user.mailProfile?.email || user.displayName || '';
      els.employeeMailSelected.textContent = user.mailProfile?.email ? `Confirmed: ${user.mailProfile.displayName || user.displayName} — ${user.mailProfile.email}` : '';
      els.employeeCreateButton.textContent = 'Save changes';
      updateControls();
      if (!user.mailProfile?.email) lookupMail(els.employeeMailSearch.value.trim());
      els.employeeRole.focus();
    }
    function optionLabel(select, value) {
      return [...select.options].find((option) => option.value === value)?.textContent || value || 'Unassigned';
    }
    function renderUsers() {
      els.adminUsersRows.replaceChildren();
      state.users.forEach((user) => {
        const row = document.createElement('tr');
        const signIn = user.identityProvider === 'employee-code' ? 'Employee code'
          : user.identityProvider === 'retired-windows' ? 'Employee link required' : 'Password maintenance';
        const values = [user.employeeCode || user.username, [user.displayName, user.email].filter(Boolean).join(' · '),
          pcnRole(user) ? optionLabel(els.employeeRole, pcnRole(user)) : user.roles.length ? 'No signing assignment' : 'Not assigned',
          optionLabel(els.employeeDepartment, user.department), user.mailProfile?.email || 'No verified email', user.isActive ? 'Active' : 'Inactive', signIn];
        values.forEach((value, index) => {
          const cell = document.createElement('td');
          if (index === 1) cell.appendChild(userIdentity(user));
          else cell.textContent = value || '—';
          row.appendChild(cell);
        });
        const actions = document.createElement('td'); row.appendChild(actions);
        if (user.identityProvider !== 'employee-code') {
          const link = document.createElement('button');
          link.type = 'button'; link.className = 'ghost-button'; link.textContent = 'Link employee';
          link.setAttribute('aria-label', `Link employee to ${user.displayName || user.username}`);
          link.disabled = !state.configured || state.busy;
          link.addEventListener('click', () => beginLink(user));
          actions.appendChild(link);
        }
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'ghost-button'; edit.textContent = 'Edit';
        edit.setAttribute('aria-label', `Edit user ${user.displayName || user.username}`);
        edit.disabled = state.busy; edit.addEventListener('click', () => beginEdit(user)); actions.appendChild(edit);
        els.adminUsersRows.appendChild(row);
      });
    }
    async function loadUsers() {
      if (!state.authorized || state.busy || window.location.hash !== '#users') return;
      state = { ...state, busy: true };
      updateControls(); message('Loading users and employee directory status...');
      try {
        const [config, users] = await Promise.all([window.PCN_SESSION.fetch('/api/auth/config'), window.PCN_SESSION.fetch('/api/admin/users')]);
        if (!Array.isArray(users)) throw new Error('The user list returned an invalid response.');
        state = { ...state, configured: config.employeeProvisioningConfigured === true, users, loaded: true };
        message(state.configured ? `${users.length} user account${users.length === 1 ? '' : 's'}. Edit an unassigned account to assign its PCN role.` : 'The employee directory is not configured on the server. Existing users are shown below.');
      } catch (error) { message(error.message); }
      finally { state = { ...state, busy: false }; updateControls(); renderUsers(); }
    }
    els.employeeSearch.addEventListener('input', () => {
      cancelLookup(); hideResults();
      cancelMailLookup();
      state = { ...state, selected: null, mail: null, retainMail: false };
      els.employeeSelected.hidden = true; els.employeeCode.value = ''; els.employeeProfile.textContent = '';
      els.employeeMailSearch.value = ''; els.employeeMailSelected.textContent = ''; els.employeeMailStatus.textContent = '';
      updateControls();
      const query = els.employeeSearch.value.trim();
      els.employeeSearchStatus.textContent = query.length < 2 ? 'Type at least two characters to search employees.' : '';
      if (state.configured && !state.busy && query.length >= 2) timer = setTimeout(() => searchEmployees(query), 280);
    });
    els.employeeSearch.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' && !els.employeeResults.hidden) { event.preventDefault(); els.employeeResults.firstElementChild?.focus(); }
      if (event.key === 'Escape') { cancelLookup(); hideResults(); els.employeeSearchStatus.textContent = 'Employee search results dismissed.'; }
    });
    els.employeeResults.addEventListener('keydown', (event) => {
      const buttons = [...els.employeeResults.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); cancelLookup(); hideResults(); els.employeeSearch.focus(); }
    });
    [els.employeeRole, els.employeeDepartment].forEach((input) => input.addEventListener('change', () => { state = { ...state, assignmentChanged: true }; updateControls(); }));
    els.employeeActive.addEventListener('change', updateControls);
    els.employeeMailSearch.addEventListener('input', () => {
      cancelMailLookup(); state = { ...state, mail: null, retainMail: false };
      els.employeeMailSelected.textContent = ''; updateControls();
      const query = els.employeeMailSearch.value.trim();
      els.employeeMailStatus.textContent = query.length < 2 ? 'Type at least two characters to search mail recipients.' : 'Select a mail recipient from search results.';
      if (query.length >= 2 && !state.busy && (state.selected || state.editUser)) mailTimer = setTimeout(() => lookupMail(query), 280);
    });
    els.employeeMailSearch.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' && !els.employeeMailResults.hidden) { event.preventDefault(); els.employeeMailResults.firstElementChild?.focus(); }
      if (event.key === 'Escape') cancelMailLookup();
    });
    els.employeeMailResults.addEventListener('keydown', (event) => {
      const buttons = [...els.employeeMailResults.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && buttons.length) {
        event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
      } else if (event.key === 'Escape') { event.preventDefault(); cancelMailLookup(); els.employeeMailSearch.focus(); }
    });
    els.employeeCancelButton.addEventListener('click', () => clearSelection());
    els.usersRefreshButton.addEventListener('click', () => {
      if (state.editUser && !window.confirm('Discard this user edit and reload the latest users?')) return;
      if (state.editUser) clearSelection(false);
      loadUsers();
    });
    els.employeeUserForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.busy) return;
      try {
        if (!state.configured && !state.editUser) throw new Error('The employee directory is not configured on the server.');
        const linkedUser = state.linkUser;
        const editedUser = state.editUser;
        const body = bodyForSelection();
        if (editedUser?.roles.includes('admin') && !body.roles.includes('admin')
          && !window.confirm('Remove Administrator access from this user and replace it with the selected PCN role and department?')) return;
        if (linkedUser && !window.confirm(`Link ${linkedUser.username} to ${state.selected.employeeCode}? The employee code becomes this account's sign-in code and existing sessions will be signed out. Its permissions and records will be preserved.`)) return;
        state = { ...state, busy: true }; cancelLookup(); cancelMailLookup(); updateControls(); renderUsers(); message('Saving employee access...');
        const target = linkedUser || editedUser;
        const url = editedUser ? `/api/admin/users/${encodeURIComponent(editedUser.id)}` : linkedUser ? `/api/admin/users/${encodeURIComponent(linkedUser.id)}/employee` : '/api/admin/users';
        const user = await window.PCN_SESSION.fetch(url, { method: editedUser ? 'PATCH' : 'POST', body: JSON.stringify(body) });
        state = { ...state, users: target ? state.users.map((existing) => existing.id === target.id ? user : existing) : [...state.users, user], busy: false };
        clearSelection(); renderUsers(); message(editedUser ? 'Employee access updated. Mail routing follows the saved assignment.' : linkedUser ? 'Employee linked. Existing permissions and records were preserved.' : 'Employee user created. Sign in using the selected employee code.');
        if (typeof window.dispatchEvent === 'function') window.dispatchEvent(new CustomEvent('pcn-users-changed'));
      } catch (error) { state = { ...state, busy: false }; updateControls(); renderUsers(); message(error.status === 409 ? 'This user changed on the server. Your edit is kept. Refresh users to discard this draft and load the latest version.' : error.message); }
    });
    window.addEventListener('hashchange', () => {
      cancelLookup(); hideResults();
      cancelMailLookup();
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

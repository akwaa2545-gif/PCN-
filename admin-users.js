(function () {
  const departmentRoles = { gscTet: 'gsc', prodEngTet: 'productionengineering', qaTet: 'qa', gscTapbu: 'tapbu', qaTapbu: 'tapbu' };
  const accessLabels = { admin: 'Administrator', developer: 'Developer', reviewer: 'Reviewer', supplier: 'Requester', gsc: 'GSC', productionengineering: 'Production engineering', qa: 'QA', tapbu: 'TaPBU' };
  const departments = ['gscTet', 'prodEngTet', 'qaTet', 'gscTapbu', 'qaTapbu', 'it', 'other', 'developer'];
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
    if (!['admin', 'developer'].includes(role) && !signingSteps.includes(role)) throw new Error('Select a PCN role.');
    if (!departments.includes(department)) throw new Error('Select a PCN department.');
    if ((role === 'developer') !== (department === 'developer')) throw new Error('Developer access requires the Developer role and department.');
    const step = ['admin', 'developer'].includes(role) ? null : role;
    if (step && !signingDepartments.includes(department)) throw new Error('Select a signing department.');
    return { roles: [step ? departmentRoles[department] : role], department, signingStep: step, ...mailFields(step, mail, retainedMail) };
  }
  function provisioningBody(employee, role, department, mail) {
    return { ...directoryBody(employee), ...assignmentBody(role, department, mail) };
  }
  function localIdentity(code, name) {
    const employeeCode = String(code || '').trim();
    const displayName = String(name || '').trim();
    if (!/^[0-9]{7}$/.test(employeeCode)) throw new Error('Enter a seven-digit employee code.');
    if (!displayName || displayName.length > 200) throw new Error('Enter the employee’s full name.');
    return { employeeCode, displayName };
  }
  function editBody(user, role, department, mail, active, assignmentChanged, retainMail = true) {
    if (!/^[a-f0-9]{16}$/.test(user.version || '')) throw new Error('Reload users before editing this account.');
    if (!validMailProfile(mail) && !(retainMail && validMailProfile(user.mailProfile))) {
      throw new Error('Select a verified work email from the search results before saving access.');
    }
    if (!assignmentChanged && !user.roles.length) throw new Error('Select a PCN role.');
    if (!assignmentChanged && !departments.includes(user.department)) throw new Error('Select a PCN department.');
    // Unrelated edits retain exact existing authority, including legacy and multiple roles.
    const assignment = assignmentChanged ? assignmentBody(role, department, mail, retainMail ? user.mailProfile : null)
      : { roles: [...user.roles], department: user.department, signingStep: user.signingStep || null,
        ...mailFields(user.signingStep, mail, retainMail ? user.mailProfile : null) };
    return { ...assignment, isActive: active === true, version: user.version };
  }
  function pcnRole(user) { return user.roles.includes('developer') ? 'developer' : user.roles.includes('admin') ? 'admin' : signingSteps.includes(user.signingStep) ? user.signingStep : ''; }

  function userIdentity(user) {
    const identity = document.createElement('div'); identity.className = 'employee-user-identity';
    const name = String(user.displayName || user.mailProfile?.displayName || user.username || user.employeeCode || '').trim();
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
      'employeeMailStatus', 'employeeMailSelected', 'employeeRoutePreview', 'employeeRoleHelp',
      'usersCreateButton', 'employeeUserDialog', 'employeeDialogCloseButton', 'employeeDialogMessage', 'employeeProvisioningHelp',
      'employeeMailLoading', 'employeeMailLoadingText', 'usersAddRoleButton', 'employeeManualFields',
      'employeeManualCode', 'employeeManualName', 'employeeDirectoryFields',
      'pendingUsersRows', 'pendingUsersCount', 'assignedUsersCount', 'pendingUsersEmpty', 'assignedUsersEmpty',
      'usersSearchFilter', 'usersRoleFilter', 'usersDepartmentFilter', 'usersStatusFilter', 'usersClearFiltersButton', 'usersFilterSummary'];
    const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    let state = { authorized: false, loaded: false, configured: false, busy: false, manual: false, users: [], selected: null, linkUser: null, editUser: null, mail: null, retainMail: true, assignmentChanged: false };
    let viewGeneration = 0;
    let timer;
    let controller;
    let mailTimer;
    let mailController;
    let dialogOpener = null;
    let dialogRowAction = null;
    const message = (text, isError = false) => {
      els.usersMessage.textContent = text;
      if (els.employeeUserDialog.open) {
        els.employeeDialogMessage.setAttribute('role', isError ? 'alert' : 'status');
        els.employeeDialogMessage.setAttribute('data-tone', isError ? 'error' : 'status');
        els.employeeDialogMessage.textContent = text;
        els.employeeDialogMessage.hidden = !text;
      }
    };
    function openUserDialog(focusTarget, opener) {
      if (!state.authorized || state.busy || window.location.hash !== '#users') return;
      viewGeneration++;
      if (!els.employeeUserDialog.open) {
        dialogOpener = opener || document.activeElement || els.usersCreateButton;
        dialogRowAction = dialogOpener.getAttribute?.('data-user-id') ? {
          userId: dialogOpener.getAttribute('data-user-id'), action: dialogOpener.getAttribute('data-user-action')
        } : null;
        els.employeeUserDialog.showModal();
        document.body?.classList.add('employee-dialog-open');
      }
      focusTarget.focus();
    }
    function finishClosingDialog() {
      if (!dialogOpener) return;
      const opener = dialogOpener;
      const rowAction = dialogRowAction;
      dialogOpener = null;
      dialogRowAction = null;
      clearSelection(false);
      document.body?.classList.remove('employee-dialog-open');
      if (window.location.hash !== '#users') return;
      const buttons = rowAction ? userActionButtons()
        .filter(button => button.getAttribute('data-user-id') === rowAction.userId) : [];
      const replacement = buttons.find(button => button.getAttribute('data-user-action') === rowAction?.action)
        || buttons.find(button => button.getAttribute('data-user-action') === 'edit');
      (opener.isConnected !== false ? opener : replacement || (rowAction ? els.usersMessage : els.usersCreateButton)).focus();
    }
    function closeUserDialog() {
      if (state.busy) return;
      if (els.employeeUserDialog.open) els.employeeUserDialog.close();
      finishClosingDialog();
    }
    function beginAddRole() {
      if (!state.authorized || !canSearchEmployees() || state.busy) return;
      clearSelection(false);
      openUserDialog(els.employeeSearch, els.usersAddRoleButton);
    }
    function beginCreate() {
      if (!state.authorized || !state.configured || state.busy) return;
      clearSelection(false);
      state = { ...state, manual: true };
      els.employeeManualFields.hidden = false;
      els.employeeDirectoryFields.hidden = true;
      els.employeeManualCode.required = true;
      els.employeeManualName.required = true;
      els.employeeFormTitle.textContent = 'Create user';
      els.employeeCreateButton.textContent = 'Create user';
      els.employeeProvisioningHelp.textContent = 'Enter employee details and set their PCN access.';
      updateControls();
      openUserDialog(els.employeeManualCode, els.usersCreateButton);
    }
    function cancelLookup() {
      clearTimeout(timer);
      if (controller) controller.abort();
      controller = null;
    }
    function hideResults() {
      els.employeeResults.replaceChildren();
      els.employeeResults.hidden = true;
    }
    function setMailLoading(loading, query = '') {
      els.employeeMailLoading.hidden = !loading;
      els.employeeMailLoadingText.textContent = loading ? query ? `Searching for ${query}` : 'Searching mail directory...' : '';
      els.employeeMailResults.setAttribute('aria-busy', String(loading));
    }
    function cancelMailLookup() {
      clearTimeout(mailTimer);
      if (mailController) mailController.abort();
      mailController = null;
      els.employeeMailResults.replaceChildren();
      els.employeeMailResults.hidden = true;
      setMailLoading(false);
    }
    function bodyForSelection() {
      if (state.linkUser) return directoryBody(state.selected);
      if (state.editUser) return editBody(state.editUser, els.employeeRole.value, els.employeeDepartment.value, state.mail, els.employeeActive.checked, state.assignmentChanged, state.retainMail);
      if (state.manual) return { ...localIdentity(els.employeeManualCode.value, els.employeeManualName.value), ...assignmentBody(els.employeeRole.value, els.employeeDepartment.value, state.mail) };
      return provisioningBody(state.selected, els.employeeRole.value, els.employeeDepartment.value, state.mail);
    }
    function previewRoute(validationError = '') {
      if (validationError) { els.employeeRoutePreview.textContent = validationError; return; }
      if (state.linkUser) { els.employeeRoutePreview.textContent = 'Existing permissions and mail routing are preserved when linking an employee.'; return; }
      const assignment = bodyForSelection();
      const step = assignment.signingStep;
      const email = state.mail?.email || (state.retainMail ? state.editUser?.mailProfile?.email : '');
      const scope = `${optionLabel(els.employeeDepartment, assignment.department)} / ${step ? optionLabel(els.employeeRole, step) : assignment.roles.includes('developer') ? 'Developer' : assignment.roles.includes('admin') ? 'Administrator' : 'No signing assignment'}`;
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
      els.employeeSearch.disabled = !canSearchEmployees() || state.busy || state.manual || Boolean(state.editUser);
      els.employeeManualCode.disabled = state.busy || !state.manual;
      els.employeeManualName.disabled = state.busy || !state.manual;
      els.employeeRole.disabled = state.busy;
      els.employeeDepartment.disabled = state.busy || els.employeeRole.value === 'developer';
      [...els.employeeDepartment.options].forEach(option => { if (option.value === 'developer') option.disabled = els.employeeRole.value !== 'developer'; });
      els.employeeRole.required = !state.linkUser && (!state.editUser || !state.editUser.roles.length || state.assignmentChanged);
      els.employeeActive.disabled = state.busy;
      els.employeeMailSearch.disabled = state.busy || !hasMailIdentity();
      els.employeeCancelButton.disabled = state.busy;
      els.employeeDialogCloseButton.disabled = state.busy;
      els.usersCreateButton.disabled = !state.authorized || !state.configured || state.busy;
      els.usersAddRoleButton.disabled = !state.authorized || !canSearchEmployees() || state.busy;
      els.usersRefreshButton.disabled = state.busy;
      [els.usersSearchFilter, els.usersRoleFilter, els.usersDepartmentFilter, els.usersStatusFilter, els.usersClearFiltersButton]
        .forEach(control => { control.disabled = state.busy || !state.authorized; });
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
      state = { ...state, manual: false, selected: null, linkUser: null, editUser: null, mail: null, retainMail: true, assignmentChanged: false };
      els.employeeUserForm.reset();
      els.employeeManualFields.hidden = true;
      els.employeeDirectoryFields.hidden = false;
      els.employeeManualCode.required = false;
      els.employeeManualName.required = false;
      els.employeeSelected.hidden = true;
      els.employeeAssignments.hidden = false;
      els.employeeLinkHelp.hidden = true;
      els.employeeActiveLabel.hidden = true;
      els.employeeMailSelected.textContent = '';
      els.employeeMailStatus.textContent = '';
      els.employeeRoleHelp.textContent = '';
      els.employeeRole.required = true;
      els.employeeDepartment.required = true;
      els.employeeFormTitle.textContent = 'Add role';
      els.employeeProvisioningHelp.textContent = 'Select an employee, then set their PCN access.';
      els.employeeCreateButton.textContent = 'Add role';
      els.employeeSearchStatus.textContent = '';
      els.employeeDialogMessage.textContent = '';
      els.employeeDialogMessage.hidden = true;
      hideResults();
      updateControls();
      if (focus && els.employeeUserDialog.open && !els.employeeSearch.disabled && window.location.hash === '#users') els.employeeSearch.focus();
    }
    function hasMailIdentity() {
      if (state.selected || state.editUser) return true;
      if (!state.manual) return false;
      try { localIdentity(els.employeeManualCode.value, els.employeeManualName.value); return true; } catch { return false; }
    }
    function canSearchEmployees() {
      return state.configured || (!state.linkUser && state.users.some(user => ['employee-code', 'pcn-local'].includes(user.identityProvider)));
    }
    function selectEmployee(employee) {
      if (!els.employeeUserDialog.open || state.busy) return;
      try { directoryBody(employee); } catch (error) { els.employeeSearchStatus.textContent = error.message; return; }
      const existingUser = !state.linkUser && state.users.find((user) =>
        String(user.employeeCode || '').toLowerCase() === employee.employeeCode.toLowerCase());
      if (existingUser) {
        beginEdit(existingUser);
        els.employeeSearchStatus.textContent = `${employee.employeeCode} already has an account. Edit its PCN access in this form.`;
        return;
      }
      if (!state.configured) return;
      cancelLookup();
      cancelMailLookup();
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
      if (!els.employeeUserDialog.open || state.busy || !state.authorized || !hasMailIdentity()) return;
      cancelMailLookup();
      if (query.length < 2) { els.employeeMailStatus.textContent = 'Type at least two characters to search mail recipients.'; return; }
      const request = new AbortController();
      mailController = request;
      setMailLoading(true, query);
      els.employeeMailStatus.textContent = 'Searching mail directory. Confirm the matching person below.';
      try {
        const body = await window.PCN_SESSION.fetch(`/api/admin/directory-users?query=${encodeURIComponent(query)}`, { signal: request.signal });
        if (mailController !== request || request.signal.aborted || !els.employeeUserDialog.open || els.employeeMailSearch.value.trim() !== query || window.location.hash !== '#users') return;
        const profiles = Array.isArray(body?.users) ? body.users : Array.isArray(body) ? body : null;
        if (!profiles) throw new Error('The mail directory returned an invalid response.');
        const matches = profiles.filter((person) => person && typeof person === 'object')
          .map((person) => ({ ...person, email: person.email || person.mail })).filter(validMailProfile).slice(0, 20);
        matches.forEach((profile) => {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'employee-result employee-mail-result';
          button.appendChild(userIdentity({ ...profile, mailProfile: profile }));
          button.addEventListener('click', () => {
            if (state.busy || !hasMailIdentity() || !validMailProfile(profile)) return;
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
      } finally {
        if (mailController === request) { mailController = null; setMailLoading(false); }
      }
    }
    async function searchEmployees(query) {
      if (!els.employeeUserDialog.open || state.busy || !state.authorized) return;
      const request = new AbortController();
      controller = request;
      els.employeeSearchStatus.textContent = 'Searching employee directory...';
      try {
        const results = state.configured ? await window.PCN_SESSION.fetch(`/api/admin/employees?query=${encodeURIComponent(query)}`, { signal: request.signal }) : [];
        if (controller !== request || request.signal.aborted || !els.employeeUserDialog.open || !canSearchEmployees() || state.busy
          || els.employeeSearch.value.trim() !== query || window.location.hash !== '#users') return;
        if (!Array.isArray(results)) throw new Error('The employee search returned an invalid response.');
        hideResults();
        const cached = state.linkUser ? [] : state.users.filter(user => ['employee-code', 'pcn-local'].includes(user.identityProvider)
          && [user.employeeCode, user.displayName].some(value => String(value || '').toLowerCase().includes(query.toLowerCase())));
        const matches = [...cached, ...results].filter((employee, index, all) =>
          all.findIndex(other => String(other.employeeCode || '').toLowerCase() === String(employee.employeeCode || '').toLowerCase()) === index);
        matches.forEach((employee) => {
          try { directoryBody(employee); } catch { return; }
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'employee-result';
          button.textContent = [employee.displayName, employee.employeeCode, employee.jobTitle, employee.sourceDepartment].filter(Boolean).join(' · ');
          button.addEventListener('click', () => selectEmployee(employee));
          els.employeeResults.appendChild(button);
        });
        const count = els.employeeResults.children.length;
        els.employeeResults.hidden = count === 0;
        els.employeeSearchStatus.textContent = count ? `${count} employees found. Select a result.` : 'No employee found. Try another name or employee code.';
      } catch (error) {
        if (controller === request && !request.signal.aborted) {
          hideResults();
          els.employeeSearchStatus.textContent = error.message || 'Employee search is unavailable. Please try again.';
        }
      } finally { if (controller === request) controller = null; }
    }
    function beginLink(user, opener) {
      if (!state.authorized || !state.configured || state.busy) return;
      clearSelection(false);
      state = { ...state, linkUser: user };
      els.employeeFormTitle.textContent = `Link employee to ${user.displayName || user.username}`;
      els.employeeProvisioningHelp.textContent = 'Choose an employee to link this account. Existing access and records are preserved.';
      els.employeeAssignments.hidden = true;
      els.employeeLinkHelp.hidden = false;
      els.employeeRole.required = false;
      els.employeeDepartment.required = false;
      els.employeeCreateButton.textContent = 'Link employee';
      updateControls();
      openUserDialog(els.employeeSearch, opener);
    }
    function beginEdit(user, opener) {
      if (!state.authorized || state.busy) return;
      clearSelection(false);
      state = { ...state, editUser: user };
      els.employeeFormTitle.textContent = 'Edit access';
      els.employeeProvisioningHelp.textContent = 'Review the employee account, permissions and verified work email.';
      els.employeeSearch.value = user.displayName || user.employeeCode || user.username;
      els.employeeCode.value = user.employeeCode || user.username;
      els.employeeProfile.textContent = user.displayName || user.username;
      els.employeeSelected.hidden = false;
      els.employeeRole.value = pcnRole(user);
      els.employeeDepartment.value = user.department || '';
      els.employeeActive.checked = user.isActive === true;
      els.employeeActiveLabel.hidden = false;
      const savedMail = validMailProfile(user.mailProfile) ? user.mailProfile : null;
      els.employeeMailSearch.value = savedMail?.email || user.displayName || '';
      els.employeeMailSelected.textContent = savedMail ? `Confirmed: ${savedMail.displayName || user.displayName} — ${savedMail.email}` : '';
      els.employeeCreateButton.textContent = 'Save changes';
      updateControls();
      openUserDialog(els.employeeRole, opener);
      if (!savedMail) lookupMail(els.employeeMailSearch.value.trim());
    }
    function optionLabel(select, value) {
      return [...select.options].find((option) => option.value === value)?.textContent || value || 'Unassigned';
    }
    function userActionButtons() {
      return [...els.pendingUsersRows.querySelectorAll('[data-user-id]'), ...els.adminUsersRows.querySelectorAll('[data-user-id]')];
    }
    function restoreUserAction(userId, action) {
      if (window.location.hash !== '#users') return;
      const buttons = userActionButtons().filter(button => button.getAttribute('data-user-id') === userId);
      (buttons.find(button => button.getAttribute('data-user-action') === action)
        || buttons.find(button => button.getAttribute('data-user-action') === 'edit') || els.usersMessage).focus();
    }
    function userMatchesFilters(user) {
      const query = els.usersSearchFilter.value.trim().toLowerCase();
      const role = pcnRole(user) || (user.roles.length ? 'legacy' : 'unassigned');
      return (!query || [user.employeeCode, user.username, user.displayName, user.email, user.mailProfile?.email, user.mailProfile?.displayName]
        .some(value => String(value || '').toLowerCase().includes(query)))
        && (!els.usersRoleFilter.value || role === els.usersRoleFilter.value)
        && (!els.usersDepartmentFilter.value || (user.department || 'unassigned') === els.usersDepartmentFilter.value)
        && (!els.usersStatusFilter.value || (user.isActive ? 'active' : 'inactive') === els.usersStatusFilter.value);
    }
    function renderGroupStatus(group, allUsers, visibleUsers) {
      const pending = group === 'pending';
      const count = pending ? els.pendingUsersCount : els.assignedUsersCount;
      const empty = pending ? els.pendingUsersEmpty : els.assignedUsersEmpty;
      count.textContent = `${visibleUsers.length} of ${allUsers.length} user${allUsers.length === 1 ? '' : 's'}`;
      empty.hidden = visibleUsers.length > 0;
      empty.textContent = allUsers.length ? 'No users match the selected filters.'
        : pending ? 'No users are waiting for access.' : 'No users have assigned PCN roles.';
    }
    function renderUsers() {
      els.adminUsersRows.replaceChildren();
      els.pendingUsersRows.replaceChildren();
      const pending = state.users.filter(user => user.roles.length === 0);
      const assigned = state.users.filter(user => user.roles.length > 0);
      const visible = state.users.filter(userMatchesFilters);
      const visiblePending = visible.filter(user => user.roles.length === 0);
      const visibleAssigned = visible.filter(user => user.roles.length > 0);
      renderGroupStatus('pending', pending, visiblePending);
      renderGroupStatus('assigned', assigned, visibleAssigned);
      const summary = `Showing ${visiblePending.length} of ${pending.length} pending users and ${visibleAssigned.length} of ${assigned.length} assigned users.`;
      if (els.usersFilterSummary.textContent !== summary) els.usersFilterSummary.textContent = summary;
      visible.forEach((user) => {
        const row = document.createElement('tr');
        const signIn = ['employee-code', 'pcn-local'].includes(user.identityProvider) ? 'Employee code'
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
        const actionCell = document.createElement('td'); row.appendChild(actionCell);
        const actions = document.createElement('div'); actions.className = 'user-row-actions'; actionCell.appendChild(actions);
        if (user.identityProvider !== 'employee-code') {
          const link = document.createElement('button');
          link.type = 'button'; link.className = 'ghost-button'; link.textContent = 'Link employee';
          link.setAttribute('aria-label', `Link employee to ${user.displayName || user.username}`);
          link.setAttribute('data-user-id', user.id);
          link.setAttribute('data-user-action', 'link');
          link.disabled = !state.configured || state.busy;
          link.addEventListener('click', () => beginLink(user, link));
          actions.appendChild(link);
        }
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'ghost-button'; edit.textContent = user.roles.length ? 'Edit' : 'Add role';
        edit.setAttribute('aria-label', `${user.roles.length ? 'Edit user' : 'Add role for'} ${user.displayName || user.username}, ${user.employeeCode || user.username}`);
        edit.setAttribute('data-user-id', user.id);
        edit.setAttribute('data-user-action', 'edit');
        edit.disabled = state.busy; edit.addEventListener('click', () => beginEdit(user, edit)); actions.appendChild(edit);
        if (user.roles.length) {
          const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'ghost-button remove-user-role'; remove.textContent = 'Remove role';
          remove.setAttribute('aria-label', `Remove role for ${user.displayName || user.username}, ${user.employeeCode || user.username} (all PCN roles)`);
          remove.setAttribute('data-user-id', user.id); remove.setAttribute('data-user-action', 'remove'); remove.disabled = state.busy;
          remove.addEventListener('click', () => removeUserRoles(user)); actions.appendChild(remove);
        }
        (user.roles.length ? els.adminUsersRows : els.pendingUsersRows).appendChild(row);
      });
    }
    async function removeUserRoles(user) {
      if (!state.authorized || state.busy || !user.roles.length || window.location.hash !== '#users') return;
      if (!/^[a-f0-9]{16}$/.test(user.version || '')) { message('Reload users before removing this assignment.', true); return; }
      const identity = `${user.displayName || user.username} (${user.employeeCode || user.username})`;
      const access = !user.isActive ? ' The account remains inactive.' : ['employee-code', 'pcn-local'].includes(user.identityProvider)
        ? ' The user will have read-only Records access.' : '';
      if (!window.confirm(`Remove all PCN roles from ${identity}? This keeps the account and its records.${access} Signing mail routing will be removed.`)) return;
      state = { ...state, busy: true }; updateControls(); renderUsers(); message('Removing PCN roles...');
      try {
        const updated = await window.PCN_SESSION.fetch(`/api/admin/users/${encodeURIComponent(user.id)}/roles`, {
          method: 'DELETE', body: JSON.stringify({ version: user.version })
        });
        state = { ...state, users: state.users.map(existing => existing.id === user.id ? updated : existing), busy: false };
        updateControls(); renderUsers(); message('PCN roles removed. The account is now pending access.');
        restoreUserAction(user.id, 'edit');
        if (typeof window.dispatchEvent === 'function') window.dispatchEvent(new CustomEvent('pcn-users-changed'));
      } catch (error) {
        state = { ...state, busy: false }; updateControls(); renderUsers(); message(error.message || 'Unable to remove this user’s roles.', true);
        restoreUserAction(user.id, 'remove');
      }
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
    function canAutoRefresh() {
      return state.authorized && state.loaded && !state.busy && window.location.hash === '#users'
        && !els.employeeUserDialog.open && !document.querySelector?.('dialog[open]');
    }
    async function refreshUsersQuietly({ isCurrent = () => true } = {}) {
      if (!canAutoRefresh()) return;
      const before = state;
      const generation = viewGeneration;
      try {
        const users = await window.PCN_SESSION.fetch('/api/admin/users');
        if (!Array.isArray(users)) throw new Error('The user list returned an invalid response.');
        if (!isCurrent() || !canAutoRefresh() || before !== state || generation !== viewGeneration) return;
        if (JSON.stringify(users) === JSON.stringify(state.users)) return;
        const focused = document.activeElement;
        const userId = focused?.getAttribute?.('data-user-id');
        const action = focused?.getAttribute?.('data-user-action');
        const scroll = [window.scrollX, window.scrollY];
        state = { ...state, users };
        renderUsers();
        if (userId) {
          const buttons = [...els.adminUsersRows.querySelectorAll('[data-user-id]'), ...els.pendingUsersRows.querySelectorAll('[data-user-id]')];
          const replacement = buttons.find(button => button.getAttribute('data-user-id') === userId && button.getAttribute('data-user-action') === action)
            || buttons.find(button => button.getAttribute('data-user-id') === userId && button.getAttribute('data-user-action') === 'edit');
          (replacement || els.usersSearchFilter).focus({ preventScroll: true });
        }
        if (scroll.every(Number.isFinite)) window.scrollTo?.(...scroll);
      } catch (error) {
        if (error.status === 401 || error.status === 403) {
          state = { ...state, authorized: false, users: [], selected: null, editUser: null, linkUser: null, mail: null };
          closeUserDialog(); updateControls(); renderUsers();
          message('Access unavailable. Reload to check your current permissions.', true);
        }
        throw error;
      }
    }
    els.employeeSearch.addEventListener('input', () => {
      if (state.busy || state.manual || state.editUser) return;
      cancelLookup(); hideResults();
      cancelMailLookup();
      state = { ...state, selected: null, mail: null, retainMail: false };
      els.employeeSelected.hidden = true; els.employeeCode.value = ''; els.employeeProfile.textContent = '';
      els.employeeMailSearch.value = ''; els.employeeMailSelected.textContent = ''; els.employeeMailStatus.textContent = '';
      updateControls();
      const query = els.employeeSearch.value.trim();
      els.employeeSearchStatus.textContent = query.length < 2 ? 'Type at least two characters to search employees.' : '';
      if (canSearchEmployees() && !state.busy && query.length >= 2) timer = setTimeout(() => searchEmployees(query), 280);
    });
    els.employeeSearch.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' && !els.employeeResults.hidden) { event.preventDefault(); els.employeeResults.firstElementChild?.focus(); }
      if (event.key === 'Escape' && !els.employeeResults.hidden) {
        event.preventDefault(); cancelLookup(); hideResults(); els.employeeSearchStatus.textContent = 'Employee search results dismissed.';
      }
    });
    els.employeeResults.addEventListener('keydown', (event) => {
      const buttons = [...els.employeeResults.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); cancelLookup(); hideResults(); els.employeeSearch.focus(); }
    });
    [els.employeeRole, els.employeeDepartment].forEach((input) => input.addEventListener('change', () => {
      if (input === els.employeeRole) {
        if (input.value === 'developer') els.employeeDepartment.value = 'developer';
        else if (els.employeeDepartment.value === 'developer') els.employeeDepartment.value = '';
      }
      state = { ...state, assignmentChanged: true }; updateControls();
    }));
    els.employeeActive.addEventListener('change', updateControls);
    els.employeeMailSearch.addEventListener('input', () => {
      cancelMailLookup(); state = { ...state, mail: null, retainMail: false };
      els.employeeMailSelected.textContent = ''; updateControls();
      const query = els.employeeMailSearch.value.trim();
      els.employeeMailStatus.textContent = query.length < 2 ? 'Type at least two characters to search mail recipients.' : 'Select a mail recipient from search results.';
      if (query.length >= 2 && !state.busy && hasMailIdentity()) {
        setMailLoading(true, query);
        els.employeeMailStatus.textContent = 'Searching mail directory...';
        mailTimer = setTimeout(() => lookupMail(query), 280);
      }
    });
    [els.employeeManualCode, els.employeeManualName].forEach(input => input.addEventListener('input', () => {
      if (!state.manual || state.busy) return;
      cancelMailLookup();
      state = { ...state, mail: null, retainMail: false };
      els.employeeMailSelected.textContent = '';
      els.employeeMailStatus.textContent = '';
      const query = els.employeeManualName.value.trim().slice(0, 100).trim();
      els.employeeMailSearch.value = query;
      updateControls();
      if (hasMailIdentity() && query.length >= 2) {
        setMailLoading(true, query);
        els.employeeMailStatus.textContent = 'Searching mail directory...';
        mailTimer = setTimeout(() => lookupMail(query), 280);
      }
    }));
    els.employeeMailSearch.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' && !els.employeeMailResults.hidden) { event.preventDefault(); els.employeeMailResults.firstElementChild?.focus(); }
      if (event.key === 'Escape' && !els.employeeMailResults.hidden) { event.preventDefault(); cancelMailLookup(); }
    });
    els.employeeMailResults.addEventListener('keydown', (event) => {
      const buttons = [...els.employeeMailResults.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && buttons.length) {
        event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
      } else if (event.key === 'Escape') { event.preventDefault(); cancelMailLookup(); els.employeeMailSearch.focus(); }
    });
    els.usersCreateButton.addEventListener('click', beginCreate);
    els.usersAddRoleButton.addEventListener('click', beginAddRole);
    els.usersSearchFilter.addEventListener('input', () => { if (!state.busy) renderUsers(); });
    [els.usersRoleFilter, els.usersDepartmentFilter, els.usersStatusFilter].forEach(control =>
      control.addEventListener('change', () => { if (!state.busy) renderUsers(); }));
    els.usersClearFiltersButton.addEventListener('click', () => {
      if (state.busy) return;
      [els.usersSearchFilter, els.usersRoleFilter, els.usersDepartmentFilter, els.usersStatusFilter].forEach(control => { control.value = ''; });
      renderUsers(); els.usersSearchFilter.focus();
    });
    els.employeeCancelButton.addEventListener('click', closeUserDialog);
    els.employeeDialogCloseButton.addEventListener('click', closeUserDialog);
    els.employeeUserDialog.addEventListener('close', () => {
      if (!els.employeeUserDialog.open) finishClosingDialog();
    });
    els.employeeUserDialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        cancelUserDialog(event);
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [...els.employeeUserDialog.querySelectorAll('button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
        .filter(control => control.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    function cancelUserDialog(event) {
      event.preventDefault();
      if (state.busy) return;
      if (!els.employeeResults.hidden) { cancelLookup(); hideResults(); els.employeeSearch.focus(); }
      else if (!els.employeeMailResults.hidden) { cancelMailLookup(); els.employeeMailSearch.focus(); }
      else closeUserDialog();
    }
    els.employeeUserDialog.addEventListener('cancel', cancelUserDialog);
    els.employeeUserDialog.addEventListener('click', (event) => {
      if (event.target !== els.employeeUserDialog) return;
      const rect = els.employeeUserDialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeUserDialog();
    });
    els.usersRefreshButton.addEventListener('click', () => {
      if (state.editUser && !window.confirm('Discard this user edit and reload the latest users?')) return;
      if (state.editUser) clearSelection(false);
      loadUsers();
    });
    els.employeeUserForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!state.authorized || !els.employeeUserDialog.open || state.busy) return;
      try {
        if (!state.configured && !state.editUser) throw new Error('The employee directory is not configured on the server.');
        const linkedUser = state.linkUser;
        const editedUser = state.editUser;
        const body = bodyForSelection();
        if (editedUser?.roles.includes('admin') && !body.roles.includes('admin')
          && !window.confirm('Remove Administrator access from this user and replace it with the selected PCN role and department?')) return;
        if (editedUser?.roles.includes('developer') && !body.roles.includes('developer')
          && !window.confirm('Remove Developer access from this user and replace it with the selected PCN role and department?')) return;
        if (linkedUser && !window.confirm(`Link ${linkedUser.username} to ${state.selected.employeeCode}? The employee code becomes this account's sign-in code and existing sessions will be signed out. Its permissions and records will be preserved.`)) return;
        state = { ...state, busy: true }; cancelLookup(); cancelMailLookup(); updateControls(); renderUsers(); message('Saving employee access...');
        const target = linkedUser || editedUser;
        const url = editedUser ? `/api/admin/users/${encodeURIComponent(editedUser.id)}` : linkedUser ? `/api/admin/users/${encodeURIComponent(linkedUser.id)}/employee` : state.manual ? '/api/admin/local-users' : '/api/admin/users';
        const user = await window.PCN_SESSION.fetch(url, { method: editedUser ? 'PATCH' : 'POST', body: JSON.stringify(body) });
        state = { ...state, users: target ? state.users.map((existing) => existing.id === target.id ? user : existing) : [...state.users, user], busy: false };
        renderUsers(); closeUserDialog(); message(editedUser ? 'Employee access updated. Mail routing follows the saved assignment.' : linkedUser ? 'Employee linked. Existing permissions and records were preserved.' : 'Employee user created. Sign in using the selected employee code.');
        if (typeof window.dispatchEvent === 'function') window.dispatchEvent(new CustomEvent('pcn-users-changed'));
      } catch (error) {
        state = { ...state, busy: false }; updateControls(); renderUsers();
        message(error.status === 409 && state.editUser ? 'This user changed on the server. Your edit is kept. Refresh users to discard this draft and load the latest version.' : error.message, true);
        els.employeeDialogMessage.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        els.employeeDialogMessage.focus({ preventScroll: true });
      }
    });
    window.addEventListener('hashchange', () => {
      viewGeneration++;
      cancelLookup(); hideResults();
      cancelMailLookup();
      if (window.location.hash !== '#users') closeUserDialog();
      if (window.location.hash === '#users' && !state.loaded) loadUsers();
    });
    setMailLoading(false);
    updateControls();
    try {
      const session = await window.PCN_SESSION.require('admin');
      if (!session) return;
      state = { ...state, authorized: true };
      await loadUsers();
      window.PCN_AUTO_REFRESH?.start({ refresh: refreshUsersQuietly, canRefresh: canAutoRefresh, intervalMs: 5000 });
    } catch (error) { message(error.message); }
  }
})();

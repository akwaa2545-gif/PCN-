(function () {
  const state = {
    pcns: [],
    selected: null,
    progress: null,
    notificationSettings: { schemaVersion: 2, version: null, flowConfigured: false, directoryConfigured: false, groups: [], legacyGroups: [] },
    filters: { search: "", status: "", risk: "" },
    notificationHealth: null,
    healthLoading: false,
    healthUnavailable: false,
    directoryLookupStatus: "Directory lookup not configured",
    hasMailChanges: false,
    mailDraftRows: null,
    recipientTargetKey: null,
    recipientDepartment: null,
    recipientDepartmentLabel: null,
    mailConflict: false,
    view: getViewFromHash(),
    isLoading: true,
    busyAction: "",
    loadingText: "Loading portal data...",
    routingMessage: "Loading routing...",
    message: "Loading records...",
    pendingRemoveRecord: null
  };

  const els = {};
  const directoryLookupTimers = new WeakMap();
  const directoryLookupControllers = new WeakMap();
  const directorySelections = new WeakMap();
  let refreshGeneration = 0;
  let autoRefreshBlocked = false;
  let portalAccessEpoch = 0;
  let recordsDashboard = null;
  let collapsedRoutingDepartments = new Set();
  let recipientPresentation = 0;
  let timeline = { record: null, tab: 'summary', summary: null, selectedDepartment: null, revisions: [], selectedRevision: null, request: 0, session: 0, opener: null };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    initializeCreateDropdown();
    [
      "adminRefreshButton",
      "adminCount",
      "adminMessage",
      "adminPcnRows",
      "adminDetailStatus",
      "adminDetailPreview",
      "adminCurrentOwner",
      "adminNextAction",
      "adminProgressFill",
      "adminProgressPercent",
      "adminProgressSteps",
      "adminStatusSelect",
      "adminStatusButton",
      "adminStatusControl",
      "notificationGroups",
      "notificationSaveButton",
      "notificationReloadButton",
      "notificationLegacyGroups",
      "notificationRecipientDialog",
      "notificationRecipientTitle",
      "notificationRecipientRoleField", "notificationRecipientRole",
      "notificationRecipientEditor",
      "notificationRecipientList",
      "notificationRecipientValidation",
      "notificationRecipientCancelButton",
      "notificationRecipientConfirmButton",
      "pcnAdminView",
      "mailRoutingView",
      "adminUsersView",
      "adminRecordsButton",
      "adminMailRoutingButton",
      "adminUsersButton",
      "adminDeveloperLink",
      "mailRoutingMessage",
      "notificationHealthPanel",
      "notificationHealthStatus",
      "directoryLookupStatus",
      "notificationHealthRefreshButton",
      "adminSearchInput",
      "adminStatusFilter",
      "adminRiskFilter",
      "adminNotice",
      "adminNoticeTitle",
      "adminNoticeMessage",
      "adminToastStack",
      "adminRemoveDialog",
      "adminRemoveCode",
      "adminRemoveMessage",
      "adminRemoveCancelButton",
      "adminRemoveConfirmButton",
      "adminLoadingBar",
      "adminLoadingText",
      "adminOverviewRecords",
      "adminOverviewSelected",
      "adminOverviewWorkflow",
      "pcnTimelineDialog", "pcnTimelineTitle", "pcnTimelineSubtitle", "pcnTimelineMessage",
      "pcnTimelineTrack", "pcnTimelineDetails", "pcnTimelineCloseButton", "pcnTimelineDoneButton",
      "pcnTimelineRefreshButton", "pcnTimelinePreviousButton", "pcnTimelineNextButton",
      "pcnTimelineSummaryTab", "pcnTimelineHistoryTab", "pcnTimelineTabs"
    ].forEach((id) => {
      els[id] = document.getElementById(id);
    });

    els.adminRemoveCancelButton.addEventListener("click", closeRemoveDialog);
    els.adminRemoveConfirmButton.addEventListener("click", confirmRemovePcn);
    els.adminRemoveDialog.addEventListener("click", (event) => {
      if (event.target === els.adminRemoveDialog) closeRemoveDialog();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !els.adminRemoveDialog.hidden) closeRemoveDialog();
    });
    initializeTimeline();
    checkPortalSession();
  }

  function isAdmin() {
    return (state.user?.roles || []).some(role => ['admin', 'developer'].includes(String(role).toLowerCase()));
  }

  function isDeveloper() {
    const user = state.user;
    return user?.isActive === true && Array.isArray(user.roles) && user.roles.length === 1
      && String(user.roles[0]).toLowerCase() === 'developer' && user.department === 'developer' && user.signingStep == null;
  }

  function initializeCreateDropdown() {
    const container = document.getElementById('createStartDropdown');
    const trigger = document.getElementById('createStartToggle');
    const panel = document.getElementById('createStartOptions');
    const links = [...panel.querySelectorAll('a')];
    let openedByHover = false;
    const setOpen = (open, returnFocus = false) => {
      if (!window.PCN_UI_MOTION?.setVisible?.(panel, open)) {
        panel.hidden = !open;
        panel.inert = !open;
      }
      trigger.setAttribute('aria-expanded', String(open));
      if (!open) openedByHover = false;
      if (returnFocus) trigger.focus();
    };
    container.addEventListener('pointerenter', event => {
      if (event.pointerType === 'mouse' && panel.hidden) { setOpen(true);openedByHover = true; }
    });
    container.addEventListener('pointerleave', event => {
      if (event.pointerType === 'mouse' && !container.contains(document.activeElement)) setOpen(false);
    });
    trigger.addEventListener('click', () => { const open = panel.hidden || openedByHover;openedByHover = false;setOpen(open); });
    trigger.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();setOpen(true);
      (event.key === 'ArrowDown' ? links[0] : links.at(-1)).focus();
    });
    container.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !panel.hidden) { event.preventDefault();setOpen(false, true); }
    });
    container.addEventListener('focusout', event => {
      if (!container.contains(event.relatedTarget)) setOpen(false);
    });
    document.addEventListener('pointerdown', event => {
      if (!container.contains(event.target)) setOpen(false);
    });
  }

  function permittedView(view) {
    return isAdmin() ? view : 'pcns';
  }

  async function checkPortalSession() {
    try {
      const session = await window.PCN_SESSION.require(null, { requireRole: true });
      if (!session) return;
      state.user = session.user;
      els.adminDeveloperLink.hidden = !isDeveloper();
      state.view = permittedView(state.view);
      window.PCN_SESSION.mountProfile(session.user, (error) => showAdminNotice("error", "Sign out failed", error.message));
      initializeRecordsDashboard();
      initializeAdminControls();
      if (isAdmin()) refreshNotificationHealth();
      await loadPcns();
      window.PCN_AUTO_REFRESH?.start({ refresh: refreshQuietly, canRefresh: canAutoRefresh, intervalMs: 5000 });
    } catch (error) {
      stopBusy();
      showAdminNotice("error", "Access unavailable", error.message);
    }
  }

  function canAutoRefresh() {
    return Boolean(state.user) && !autoRefreshBlocked && !state.isLoading && !isAnyBusy()
      && (!recordsDashboard || recordsDashboard.canRefresh())
      && !document.querySelector('dialog[open]') && els.adminRemoveDialog?.hidden !== false
      && (state.view === 'pcns' || (state.view === 'mail' && isAdmin()
        && !state.hasMailChanges && !state.recipientTargetKey && !els.notificationRecipientDialog?.open));
  }

  async function refreshQuietly({ isCurrent = () => true } = {}) {
    if (!canAutoRefresh()) return;
    const generation = refreshGeneration;
    const view = state.view;
    const selectedId = state.selected?.id;
    const stillCurrent = () => isCurrent() && canAutoRefresh() && generation === refreshGeneration
      && view === state.view && selectedId === state.selected?.id;
    try {
      if (view === 'mail') {
        const settings = await apiFetch('/api/notification-settings');
        if (!stillCurrent() || JSON.stringify(settings) === JSON.stringify(state.notificationSettings)) return;
        state.notificationSettings = settings;
        preservePortalPosition(renderNotificationSettings);
        return;
      }
      const pcns = await fetchRecords();
      if (!stillCurrent()) return;
      const selected = selectedId ? pcns.find(record => record.id === selectedId) || null : null;
      const progress = selected ? await apiFetch(`/api/pcns/${encodeURIComponent(selected.id)}/progress`) : null;
      if (!stillCurrent()) return;
      if (JSON.stringify(pcns) === JSON.stringify(state.pcns) && JSON.stringify(progress) === JSON.stringify(state.progress)) return;
      state.pcns = pcns;
      state.selected = selected;
      state.progress = progress;
      preservePortalPosition(() => render({ routing: false }));
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        clearProtectedPortal();
      }
      throw error;
    }
  }

  function initializeRecordsDashboard() {
    if (recordsDashboard || !window.PCN_RECORDS_DASHBOARD?.create) return;
    recordsDashboard = window.PCN_RECORDS_DASHBOARD.create({
      root: els.pcnAdminView, rows: els.adminPcnRows, count: els.adminCount,
      search: els.adminSearchInput, message: els.adminMessage, user: state.user,
      statusFilter: els.adminStatusFilter, riskFilter: els.adminRiskFilter, fetch: apiFetch,
      codeHref: record => `/${encodeURIComponent(record.id)}`,
      selectedId: () => state.selected?.id, onRowSelect: record => loadDetail(record.id),
      actions: dashboardActions, isBusy: isAnyBusy,
      onOpen: () => { refreshGeneration++; }, onClose: () => {},
      onAccessLost: clearProtectedPortal
    });
  }

  async function fetchRecords() {
    const response = await apiFetch(recordsDashboard ? '/api/pcns/overview' : '/api/pcns');
    const records = recordsDashboard ? response?.items : response;
    if (!Array.isArray(records)) throw new Error('The record list returned an invalid response.');
    return records;
  }

  function clearProtectedPortal() {
    autoRefreshBlocked = true;
    portalAccessEpoch++;
    refreshGeneration++;
    recordsDashboard?.clear();
    if (timeline.record) closeTimeline();
    clearTimelinePresentation();
    if (els.notificationRecipientList) els.notificationRecipientList.innerHTML = '';
    state.pcns = []; state.selected = null; state.progress = null;
    state.notificationSettings = { schemaVersion: 2, groups: [], legacyGroups: [] };
    state.mailDraftRows = null; state.hasMailChanges = false;
    state.message = 'Access unavailable. Reload to check your current permissions.';
    state.routingMessage = state.message;
    stopBusy();
    showAdminNotice('error', 'Access unavailable', state.message);
    render();
  }

  function dashboardActions(record) {
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'admin-row-button admin-view-button';
    view.setAttribute('aria-label', `History ${record.id}`);
    view.setAttribute('aria-haspopup', 'dialog');
    view.setAttribute('aria-controls', 'pcnTimelineDialog');
    view.title = 'History';
    view.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 11a9 9 0 1 1 2.6 7"></path><path d="M3 4v7h7M12 7v5l3 2"></path></svg>';
    view.disabled = isAnyBusy() || autoRefreshBlocked;
    view.addEventListener('click', () => openTimeline(record, view));
    if (!isAdmin()) return [view];
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'danger-button'; remove.dataset.rdOverflow = 'true';
    remove.setAttribute('aria-label', `Remove ${record.id}`); remove.title = `Remove ${record.id}`;
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"></path></svg>';
    remove.disabled = isAnyBusy() || autoRefreshBlocked;
    remove.addEventListener('click', () => requestRemovePcn(record));
    return [view, remove];
  }

  function preservePortalPosition(update) {
    const active = document.activeElement;
    const row = active?.closest?.('[data-pcn-id]');
    const position = row ? [row.dataset.pcnId, [...row.querySelectorAll('a, button, summary')].indexOf(active)] : null;
    const card = active?.closest?.('[data-notification-group]');
    const routingPosition = card ? [card.dataset.notificationGroup, [...card.querySelectorAll('button, input')].indexOf(active)] : null;
    const department = !card && active?.closest?.('[data-department]');
    const departmentPosition = department ? [department.dataset.department, active.dataset.routingAction] : null;
    const scroll = [window.scrollX, window.scrollY];
    const status = els.adminStatusSelect?.value;
    update();
    if (active === els.adminStatusSelect && status && state.selected) els.adminStatusSelect.value = status;
    if (position) {
      const replacement = [...els.adminPcnRows.querySelectorAll('[data-pcn-id]')].find(node => node.dataset.pcnId === position[0]);
      (position[1] < 0 ? replacement : replacement?.querySelectorAll('a, button, summary')[position[1]])?.focus({ preventScroll: true });
      if (!replacement) els.adminSearchInput?.focus({ preventScroll: true });
    } else if (routingPosition) {
      const replacement = [...els.notificationGroups.querySelectorAll('[data-notification-group]')].find(node => node.dataset.notificationGroup === routingPosition[0]);
      replacement?.querySelectorAll('button, input')[routingPosition[1]]?.focus({ preventScroll: true });
    } else if (departmentPosition) {
      const replacement = [...els.notificationGroups.querySelectorAll('[data-department]')].find(node => node.dataset.department === departmentPosition[0]);
      [...replacement?.querySelectorAll('button') || []].find(button => button.dataset.routingAction === departmentPosition[1])?.focus({ preventScroll: true });
    } else if (active?.isConnected) active.focus?.({ preventScroll: true });
    if (scroll.every(Number.isFinite)) window.scrollTo?.(...scroll);
  }

  function initializeAdminControls() {
    if (state.controlsInitialized) {
      return;
    }

    state.controlsInitialized = true;
    els.adminRefreshButton.addEventListener("click", () => loadPcns("Records refreshed.", "refresh"));
    els.adminStatusButton.addEventListener("click", updateSelectedStatus);
    els.notificationSaveButton.addEventListener("click", saveNotificationSettings);
    els.notificationReloadButton.addEventListener("click", reloadMailRouting);
    els.notificationRecipientCancelButton.addEventListener("click", closeRecipientDialog);
    els.notificationRecipientConfirmButton.addEventListener("click", confirmRecipientDialog);
    els.notificationRecipientRole.addEventListener("change", changeRecipientRole);
    els.notificationRecipientDialog.addEventListener("close", () => {
      if (!els.notificationRecipientDialog.open && (state.recipientTargetKey || state.recipientDepartment)) finishRecipientDialog();
    });
    els.notificationRecipientDialog.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const controls = [...els.notificationRecipientDialog.querySelectorAll("button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled])")]
        .filter((control) => control.getClientRects().length);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    els.notificationRecipientDialog.addEventListener("cancel", (event) => {
      const row = els.notificationRecipientList.querySelector(".notification-person");
      const suggestions = row?.querySelector(".directory-suggestions");
      if (suggestions && !suggestions.hidden) {
        event.preventDefault();
        dismissDirectoryLookup(row.querySelector("input"), row);
        row.querySelector("input").focus();
      } else {
        event.preventDefault();
        closeRecipientDialog();
      }
    });
    els.notificationHealthRefreshButton.addEventListener("click", refreshNotificationHealth);
    if (!recordsDashboard) {
      els.adminSearchInput.addEventListener("input", updateTableFilters);
      els.adminStatusFilter.addEventListener("change", updateTableFilters);
      els.adminRiskFilter.addEventListener("change", updateTableFilters);
    }
    els.adminRecordsButton.addEventListener("click", () => setAdminView("pcns"));
    els.adminMailRoutingButton.addEventListener("click", () => setAdminView("mail"));
    els.adminUsersButton.addEventListener("click", () => setAdminView("users"));
    window.addEventListener("hashchange", syncViewFromHash);
    window.addEventListener('pcn-users-changed', refreshManagedRecipients);
  }

  async function refreshManagedRecipients() {
    refreshGeneration++;
    if (!isAdmin()) return;
    try {
      const settings = await apiFetch('/api/notification-settings');
      if (state.hasMailChanges || state.recipientTargetKey || state.recipientDepartment || els.notificationRecipientDialog?.open) return;
      state.notificationSettings = settings;
      renderNotificationSettings();
    } catch (error) { state.routingMessage = `User access saved; mail routing could not refresh: ${error.message}`; render(); }
  }

  async function loadPcns(successMessage, action = "load") {
    if (autoRefreshBlocked) return;
    startBusy(action, action === "refresh" ? "Refreshing PCN records..." : "Loading portal data...");
    const accessEpoch = portalAccessEpoch;
    const current = () => !autoRefreshBlocked && accessEpoch === portalAccessEpoch;

    try {
      const [pcns, notificationSettings] = await Promise.all([
        fetchRecords(),
        isAdmin() ? apiFetch("/api/notification-settings") : Promise.resolve(state.notificationSettings)
      ]);
      if (!current()) return;
      const selected = state.selected ? pcns.find((record) => record.id === state.selected.id) || null : null;
      const progress = selected ? await apiFetch(`/api/pcns/${encodeURIComponent(selected.id)}/progress`) : null;
      if (!current()) return;
      state.pcns = pcns;
      if (!state.hasMailChanges) state.notificationSettings = notificationSettings;
      state.directoryLookupStatus = notificationSettings.directoryConfigured ? "Directory lookup ready" : "Directory lookup not configured";
      state.selected = selected;
      state.progress = progress;
      state.message = successMessage || (state.pcns.length ? "Records loaded from database." : "No PCNs saved.");
      if (!state.hasMailChanges) state.routingMessage = notificationSettings.groups.some((group) => String(group.emails || "").trim()) ? "Mail routing loaded." : "Step recipient lists are empty. Assign recipients and save routing.";
      showAdminNotice("success", action === "refresh" ? "Refresh complete" : "Portal ready", state.message);
    } catch (error) {
      if (!current()) return;
      state.message = error.message;
      state.routingMessage = error.message;
      state.pcns = [];
      state.selected = null;
      state.progress = null;
      if (error.status === 401 || error.status === 403) clearProtectedPortal();
      else {
        recordsDashboard?.clear();
        showAdminNotice("error", "Load failed", error.message);
      }
    } finally {
      stopBusy();
    }

    render();
  }

  async function saveNotificationSettings() {
    if (!isAdmin()) return false;
    try {
      if (!validateNotificationGroups()) {
        showAdminNotice("error", "Mail routing needs review", "Fix invalid or duplicate email addresses before saving.");
        return false;
      }

      const payload = getMailRoutingPayload();

      const saved = await persistNotificationSettings(payload);

      return saved;
    } catch (error) {
      state.routingMessage = error.message;
      showAdminNotice("error", "Mail save failed", error.message);
      return false;
    } finally {
      render();
    }
  }

  function getMailRoutingPayload() {
    const groups = [...els.notificationGroups.querySelectorAll("[data-notification-group]")]
      .map((row) => ({
        key: row.dataset.notificationGroup,
        emails: getRecipientInputs(row)
          .map((input) => input.value.trim())
          .filter(Boolean)
          .join("; "),
        recipients: getRecipientInputs(row).map(getRecipientPayload).filter(Boolean)
      }));

    return { schemaVersion: 2, version: state.notificationSettings.version, groups };
  }

  async function persistNotificationSettings(payload) {
    try {
      state.notificationSettings = mergeNotificationSettings(payload);
      startBusy("mail", "Saving mail routing...", false);
      renderLoadingState();
      state.notificationSettings = await apiFetch("/api/notification-settings", {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      state.routingMessage = "Mail routing saved.";
      state.directoryLookupStatus = state.notificationSettings.directoryConfigured ? "Directory lookup saved" : "Directory lookup not configured";
      state.hasMailChanges = false;
      state.mailDraftRows = null;
      state.mailConflict = false;
      showAdminNotice("success", "Mail routing saved", "Workflow notifications and directory lookup will use the updated settings.");
      return true;
    } catch (error) {
      state.mailConflict = error.status === 409;
      state.hasMailChanges = true;
      state.routingMessage = state.mailConflict ? "Another administrator changed routing. Your unsaved draft is kept. Reload saved routing when ready to discard this draft." : error.message;
      showAdminNotice("error", "Mail save failed", error.message);
      return false;
    } finally {
      stopBusy();
    }
  }

  async function reloadMailRouting() {
    if (!isAdmin()) return;
    if (state.hasMailChanges && !window.confirm("Discard your unsaved routing draft and load the latest saved recipient lists?")) return;
    startBusy("routingReload", "Loading saved mail routing...", false);
    renderLoadingState();
    let reloaded = false;
    try {
      const settings = await apiFetch("/api/notification-settings");
      state.notificationSettings = settings;
      state.hasMailChanges = false;
      state.mailDraftRows = null;
      state.mailConflict = false;
      state.routingMessage = "Latest saved routing loaded.";
      reloaded = true;
    } catch (error) {
      showAdminNotice("error", "Routing reload failed", error.message);
    } finally {
      stopBusy();
      render();
      if (reloaded) els.notificationSaveButton.focus();
    }
  }

  function mergeNotificationSettings(payload) {
    const editedGroups = new Map(payload.groups.map((group) => [group.key, group]));

    return {
      ...state.notificationSettings,
      groups: state.notificationSettings.groups.map((group) => ({
        ...group,
        emails: editedGroups.has(group.key) ? editedGroups.get(group.key).emails : group.emails,
        recipients: editedGroups.has(group.key) ? editedGroups.get(group.key).recipients : group.recipients
      }))
    };
  }

  async function refreshNotificationHealth() {
    if (!isAdmin()) return;
    if (state.healthLoading) return;
    state.healthLoading = true;
    renderNotificationHealth();
    try {
      const health = await apiFetch("/api/admin/notifications/health");
      if (!isNotificationHealth(health)) throw new Error("Invalid health response");
      state.notificationHealth = health;
      state.healthUnavailable = false;
    } catch {
      state.healthUnavailable = true;
    } finally {
      state.healthLoading = false;
      renderNotificationHealth();
    }
  }

  function isNotificationHealth(health) {
    return ["configured", "not_configured", "invalid"].includes(health?.configuration?.status)
      && health.worker && [null, "idle", "accepted", "uncertain", "error"].includes(health.worker.lastOutcome)
      && health.queue && ["pending", "sending", "accepted", "uncertain"].every((key) => Number.isSafeInteger(health.queue[key]) && health.queue[key] >= 0)
      && health.deliveryVerified === false;
  }

  function updateTableFilters() {
    state.filters = {
      search: els.adminSearchInput.value.trim(),
      status: els.adminStatusFilter.value,
      risk: els.adminRiskFilter.value
    };
    render();
  }

  function markMailChanged() {
    state.hasMailChanges = true;
    if (els.notificationGroups && els.notificationGroups.querySelector("[data-notification-group]")) {
      state.mailDraftRows = Object.fromEntries([...els.notificationGroups.querySelectorAll("[data-notification-group]")].map((group) => [
        group.dataset.notificationGroup,
        getRecipientInputs(group).map((input) => ({
          ...getRecipientPayload(input),
          inputValue: input.value,
          verifiedEmail: input.dataset.verifiedEmail || ""
        }))
      ]));
    }
    state.routingMessage = state.mailConflict ? "Routing changed on the server. Your unsaved draft is kept; reload saved routing to discard it." : "Unsaved recipient changes.";
    if (els.mailRoutingMessage) els.mailRoutingMessage.textContent = state.routingMessage;

    if (!isAnyBusy() && els.notificationSaveButton) {
      els.notificationSaveButton.textContent = "Save Changes";
    }
  }

  async function loadDetail(id, { preservePosition = false } = {}) {
    if (autoRefreshBlocked) return;
    const focusSession = timeline.session;
    startBusy(`detail:${id}`, `Loading ${id}...`);
    const accessEpoch = portalAccessEpoch;
    const current = () => !autoRefreshBlocked && accessEpoch === portalAccessEpoch;

    try {
      const encodedId = encodeURIComponent(id);
      const [record, progress] = await Promise.all([
        apiFetch(`/api/pcns/${encodedId}`),
        apiFetch(`/api/pcns/${encodedId}/progress`)
      ]);
      if (!current()) return;
      state.selected = record;
      state.progress = progress;
      state.message = `Loaded ${id}.`;
      showAdminNotice("success", "PCN loaded", `${id} is selected for workflow review.`);
    } catch (error) {
      if (!current()) return;
      if (error.status === 401 || error.status === 403) clearProtectedPortal();
      else {
        state.message = error.message;
        state.selected = null;
        state.progress = null;
        showAdminNotice("error", "PCN load failed", error.message);
      }
    } finally {
      stopBusy();
    }

    if (preservePosition) preservePortalPosition(() => render());
    else render();
    // Closing while the selection read is pending leaves a disabled opener unfocusable.
    // Restore it once enabled, unless another dialog or deliberate focus has taken over.
    if (preservePosition && timeline.session === focusSession && !document.querySelector('dialog[open]')
      && els.adminRemoveDialog.hidden !== false
      && document.activeElement === document.body) {
      const row = [...els.adminPcnRows.querySelectorAll('[data-pcn-id]')].find(item => item.dataset.pcnId === id);
      row?.querySelector('.admin-view-button')?.focus({ preventScroll: true });
    }
  }

  function initializeTimeline() {
    els.pcnTimelineCloseButton.addEventListener('click', closeTimeline);
    els.pcnTimelineDoneButton.addEventListener('click', closeTimeline);
    els.pcnTimelineRefreshButton.addEventListener('click', loadTimeline);
    els.pcnTimelineSummaryTab.addEventListener('click', () => switchTimelineTab('summary'));
    els.pcnTimelineHistoryTab.addEventListener('click', () => switchTimelineTab('history'));
    els.pcnTimelineTabs.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const tab = event.key === 'Home' ? 'summary' : event.key === 'End' ? 'history' : timeline.tab === 'summary' ? 'history' : 'summary';
      (tab === 'summary' ? els.pcnTimelineSummaryTab : els.pcnTimelineHistoryTab).focus(); switchTimelineTab(tab);
    });
    els.pcnTimelineDialog.addEventListener('cancel', event => { event.preventDefault(); closeTimeline(); });
    els.pcnTimelineDialog.addEventListener('close', finishTimeline);
    els.pcnTimelineDialog.addEventListener('click', event => {
      if (event.target !== els.pcnTimelineDialog) return;
      const bounds = els.pcnTimelineDialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeTimeline();
    });
    els.pcnTimelinePreviousButton.addEventListener('click', () => scrollTimeline(-1));
    els.pcnTimelineNextButton.addEventListener('click', () => scrollTimeline(1));
    els.pcnTimelineTrack.addEventListener('keydown', event => {
      const items = timeline.tab === 'summary' ? timeline.summary?.stages || [] : timeline.revisions;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !items.length) return;
      event.preventDefault();
      const index = items.findIndex(item => timeline.tab === 'summary' ? item.key === timeline.selectedDepartment : item.revision === timeline.selectedRevision);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)));
      if (timeline.tab === 'summary') selectTimelineDepartment(items[next].key, true); else selectTimelineRevision(items[next].revision, true);
    });
  }

  async function switchTimelineTab(tab) {
    if (!['summary', 'history'].includes(tab) || !timeline.record) return;
    timeline = { ...timeline, tab }; await loadTimeline();
  }

  function updateTimelineTabs() {
    [[els.pcnTimelineSummaryTab, 'summary'], [els.pcnTimelineHistoryTab, 'history']].forEach(([button, tab]) => {
      button.setAttribute('aria-selected', String(timeline.tab === tab)); button.tabIndex = timeline.tab === tab ? 0 : -1;
    });
    els.pcnTimelineTrack.setAttribute('aria-label', timeline.tab === 'summary' ? 'Signing departments' : 'PCN changes, oldest to latest');
  }

  async function openTimeline(record, opener = document.activeElement, initialTab = 'summary') {
    if (autoRefreshBlocked) return;
    refreshGeneration++;
    timeline = { record, tab: initialTab === 'history' ? 'history' : 'summary', summary: null, selectedDepartment: null, revisions: [], selectedRevision: null, request: timeline.request + 1, session: timeline.session + 1, opener };
    els.pcnTimelineTitle.textContent = `${record.id} timeline`;
    els.pcnTimelineSubtitle.textContent = [record.supplierName, record.materialName].filter(Boolean).join(' / ');
    els.pcnTimelineTrack.innerHTML = '';
    els.pcnTimelineDetails.innerHTML = '';
    if (!els.pcnTimelineDialog.open) els.pcnTimelineDialog.showModal();
    document.body.classList.add('pcn-timeline-open');
    els.pcnTimelineCloseButton.focus();
    // Keep the existing workflow sidebar selection while history is read separately.
    loadDetail(record.id, { preservePosition: true });
    await loadTimeline();
  }

  async function loadTimeline() {
    if (autoRefreshBlocked || !timeline.record || !els.pcnTimelineDialog.open) return;
    const accessEpoch = portalAccessEpoch;
    const id = timeline.record.id;
    const request = timeline.request + 1;
    const selectedRevision = timeline.selectedRevision; const selectedDepartment = timeline.selectedDepartment; const tab = timeline.tab;
    timeline = { ...timeline, request, summary: null, revisions: [] };
    updateTimelineTabs();
    els.pcnTimelineTrack.innerHTML = '';
    els.pcnTimelineDetails.innerHTML = '';
    els.pcnTimelineMessage.textContent = tab === 'summary' ? 'Loading signing departments...' : 'Loading change history...';
    els.pcnTimelineTrack.setAttribute('aria-busy', 'true');
    els.pcnTimelineRefreshButton.hidden = false;
    els.pcnTimelineRefreshButton.disabled = true;
    els.pcnTimelineRefreshButton.textContent = tab === 'summary' ? 'Refresh departments' : 'Refresh history';
    updateTimelineNavigation();
    const current = () => timeline.request === request && timeline.record?.id === id && timeline.tab === tab && els.pcnTimelineDialog.open;
    try {
      const response = await apiFetch(`/api/pcns/${encodeURIComponent(id)}/${tab === 'summary' ? 'workflow-summary' : 'revisions'}`);
      if (!current()) return;
      if (tab === 'summary') {
        const summary = window.PCN_RECORDS_DASHBOARD.workflowSummary(response, id);
        const selected = summary.stages.find(stage => stage.key === selectedDepartment) || summary.stages.find(stage => stage.state === 'current')
          || summary.stages.find(stage => stage.state !== 'completed') || summary.stages[0];
        timeline = { ...timeline, summary, selectedDepartment: selected?.key || null };
        els.pcnTimelineMessage.textContent = summary.nextAction.label;
      } else {
        if (!Array.isArray(response?.items)) throw new Error('The change history returned an invalid response.');
        const revisions = chronologicalTimeline(response.items);
        timeline = { ...timeline, revisions, selectedRevision: revisions.some(item => item.revision === selectedRevision)
          ? selectedRevision : revisions[revisions.length - 1]?.revision ?? null };
        els.pcnTimelineMessage.textContent = revisions.length ? `${revisions.length} recorded ${revisions.length === 1 ? 'event' : 'events'}. Select a change to see details.` : 'No recorded changes are available for this PCN.';
      }
      renderTimeline();
    } catch (error) {
      if ((error.status === 401 || error.status === 403) && !autoRefreshBlocked && accessEpoch === portalAccessEpoch) {
        clearProtectedPortal();
        return;
      }
      if (!current()) return;
      timeline = { ...timeline, summary: null, selectedDepartment: null, revisions: [], selectedRevision: null };
      els.pcnTimelineMessage.textContent = `${tab === 'summary' ? 'Department timeline' : 'Change history'} unavailable. ${error.message}`;
      els.pcnTimelineRefreshButton.textContent = 'Retry';
      els.pcnTimelineRefreshButton.hidden = error.status === 401 || error.status === 403;
    } finally {
      if (current()) {
        els.pcnTimelineTrack.setAttribute('aria-busy', 'false');
        els.pcnTimelineRefreshButton.disabled = false;
        updateTimelineNavigation();
      }
    }
  }

  function closeTimeline() {
    if (els.pcnTimelineDialog.open) els.pcnTimelineDialog.close();
    finishTimeline();
  }

  function finishTimeline() {
    if (els.pcnTimelineDialog.open || !timeline.record) return;
    const { opener, record } = timeline;
    timeline = { record: null, tab: 'summary', summary: null, selectedDepartment: null, revisions: [], selectedRevision: null, request: timeline.request + 1, session: timeline.session, opener: null };
    const request = timeline.request;
    const cleanup = () => clearTimelinePresentation();
    if (autoRefreshBlocked || !window.PCN_UI_MOTION?.afterExit(els.pcnTimelineDialog, cleanup, { current: () => !els.pcnTimelineDialog.open && timeline.request === request })) cleanup();
    document.body.classList.remove('pcn-timeline-open');
    const row = [...els.adminPcnRows.querySelectorAll('[data-pcn-id]')].find(item => item.dataset.pcnId === record.id);
    const target = opener?.isConnected ? opener : row?.querySelector('.admin-view-button') || els.adminSearchInput;
    target?.focus({ preventScroll: true });
  }

  function clearTimelinePresentation() {
    if (els.pcnTimelineTrack) els.pcnTimelineTrack.innerHTML = '';
    if (els.pcnTimelineDetails) els.pcnTimelineDetails.innerHTML = '';
    if (els.pcnTimelineMessage) els.pcnTimelineMessage.textContent = '';
  }

  function chronologicalTimeline(items) {
    return [...items].sort((before, after) => Number(before.revision) - Number(after.revision));
  }

  function timelineSummary(item) {
    if (item.isBaseline) return 'History baseline';
    if (item.revision === 1) return 'PCN created';
    const changes = Array.isArray(item.changes) ? item.changes : [];
    if (changes.some(change => change.path === 'status')) return 'Workflow status changed';
    return changes.length ? `${changes.length} ${changes.length === 1 ? 'field' : 'fields'} changed` : 'Revision recorded';
  }

  function timelineValue(value) {
    if (value === null || value === undefined || value === '') return 'Not set';
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }

  function timelineFieldLabel(change) {
    if (change.label) return change.label;
    return String(change.path || 'Field').split('.').map(part => titleCase(part.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))).join(' / ');
  }

  function timelineEntries(item) {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const departments = { 'signoff.gscTet': 'GSC/TET', 'signoff.prodEngTet': 'Prod.Eng/TET',
      'signoff.qaTet': 'QA/TET', 'tapbu.gsc': 'GSC/TaPBU', 'tapbu.qa': 'QA/TaPBU',
      'qateFinal.signoff': 'QA/TET Final Judgment' };
    if (!item.isBaseline) {
      const entries = changes.flatMap(change => {
        const internal = /^internalReview\.(signoff\.(?:gscTet|prodEngTet|qaTet)|tapbu\.(?:gsc|qa)|qateFinal\.signoff)\.(approved|checked|prepared)$/.exec(change.path);
        const supplier = /^internalReview\.supplierSignoff\.(approved|checked|prepared)\.checked$/.exec(change.path);
        const cleared = change.before === true && (change.after === false || change.after === null);
        if ((!internal && !supplier) || (change.after !== true && !cleared)) return [];
        const action = internal ? internal[2] : supplier[1];
        const namePath = internal ? `${change.path}Name` : change.path.replace(/\.checked$/, '.name');
        const name = changes.find(candidate => candidate.path === namePath)?.after;
        const person = !cleared && typeof name === 'string' && name.trim() ? name : item.actor || 'Actor not recorded';
        return [{ label: `${internal ? departments[internal[1]] : 'Supplier'} — ${titleCase(action)}${cleared ? ' cleared' : ''}`, person, cleared }];
      });
      if (entries.length) return entries;
    }
    return [{ label: item.isBaseline ? 'History baseline' : item.revision === 1 ? 'PCN created'
      : titleCase(item.status || 'Status not recorded'), person: item.actor || 'Actor not recorded', cleared: false }];
  }

  function timelineTime(item) {
    const date = item.createdAt ? new Date(item.createdAt) : null;
    return date && Number.isFinite(date.getTime()) ? `<time datetime="${escapeHtml(item.createdAt)}"><span>${escapeHtml(date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span><span>${escapeHtml(date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }))}</span></time>` : '<span class="pcn-timeline-time-unknown">Time not recorded</span>';
  }

  function renderTimeline() {
    if (timeline.tab === 'summary') { renderDepartmentTimeline(); return; }
    els.pcnTimelineTrack.classList?.remove('is-department-summary');
    els.pcnTimelineTrack.innerHTML = timeline.revisions.map(item => {
      const selected = item.revision === timeline.selectedRevision;
      const entries = timelineEntries(item);
      const signing = entries.some(entry => entry.label.includes(' — '));
      const cleared = entries.some(entry => entry.cleared);
      const tone = signing ? cleared ? 'danger' : 'success' : item.status === 'closed' ? 'success' : getStatusTone(item.status);
      const marker = item.isBaseline ? '&#8212;' : cleared || tone === 'danger' ? '!' : tone === 'success' ? '&#10003;' : '&#8226;';
      const people = entries.map(entry => `<span class="pcn-timeline-signoff"><strong>${escapeHtml(entry.label)}</strong><span class="pcn-timeline-actor">${escapeHtml(entry.person)}</span></span>`).join('');
      return `<li class="pcn-timeline-item"><button class="pcn-timeline-event pcn-timeline-${escapeHtml(tone)}${item.isBaseline ? ' is-baseline' : ''}" data-revision="${escapeHtml(item.revision)}" type="button" aria-pressed="${selected}" aria-controls="pcnTimelineDetails" aria-label="Change ${escapeHtml(item.revision)}: ${escapeHtml(entries.map(entry => `${entry.label}, ${entry.person}`).join('; '))}">${timelineTime(item)}<span class="pcn-timeline-marker" aria-hidden="true">${marker}</span>${people}</button></li>`;
    }).join('');
    els.pcnTimelineTrack.querySelectorAll('.pcn-timeline-event').forEach(button => button.addEventListener('click', () => selectTimelineRevision(Number(button.dataset.revision))));
    renderTimelineDetails();
    scrollSelectedTimeline();
  }

  function selectTimelineRevision(revision, focus = false) {
    if (!timeline.revisions.some(item => item.revision === revision)) return;
    timeline = { ...timeline, selectedRevision: revision };
    els.pcnTimelineTrack.querySelectorAll('.pcn-timeline-event').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.revision) === revision)));
    renderTimelineDetails();
    scrollSelectedTimeline(focus);
  }

  function renderTimelineDetails() {
    if (timeline.tab === 'summary') { renderDepartmentDetails(); return; }
    const item = timeline.revisions.find(revision => revision.revision === timeline.selectedRevision);
    if (!item) { els.pcnTimelineDetails.innerHTML = ''; return; }
    const changes = userFacingTimelineChanges(item.changes);
    const rows = changes.map(change => `<tr><th scope="row">${escapeHtml(timelineFieldLabel(change))}</th><td><pre>${escapeHtml(timelineValue(change.before))}</pre></td><td><pre>${escapeHtml(timelineValue(change.after))}</pre></td></tr>`).join('');
    els.pcnTimelineDetails.innerHTML = `<h3>Event ${escapeHtml(item.revision)}: ${escapeHtml(timelineSummary({ ...item, changes }))}</h3><p>${escapeHtml(item.actor || 'Actor not recorded')} &middot; ${escapeHtml(item.createdAt ? formatDate(item.createdAt) : 'Time not recorded')}</p>${rows ? `<div class="pcn-timeline-change-scroll"><table class="pcn-timeline-change-table"><thead><tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="pcn-timeline-empty">${item.isBaseline ? 'Earlier changes were not recorded. This is the first available history baseline.' : 'No form or signing field changes were recorded for this event.'}</p>`}`;
  }

  function renderDepartmentTimeline() {
    els.pcnTimelineTrack.classList?.add('is-department-summary');
    els.pcnTimelineTrack.innerHTML = (timeline.summary?.stages || []).map(stage => {
      const caption = window.PCN_RECORDS_DASHBOARD.workflowStageCaption(stage);
      const marker = stage.state === 'completed' ? '&#10003;' : stage.state === 'current' ? '&#8226;' : '&#9675;';
      return `<li class="pcn-timeline-item"><button class="pcn-timeline-event pcn-department-point pcn-department-${stage.state}" data-workflow-stage="${escapeHtml(stage.key)}" type="button" aria-pressed="${stage.key === timeline.selectedDepartment}" aria-controls="pcnTimelineDetails" aria-label="${escapeHtml(`${stage.label}, ${stage.completed}/${stage.total} signed, ${caption}`)}"><span class="pcn-department-caption">${escapeHtml(caption)}</span><span class="pcn-timeline-marker" aria-hidden="true">${marker}</span><strong>${escapeHtml(stage.label)} \u00b7 ${stage.completed}/${stage.total} signed</strong></button></li>`;
    }).join('');
    els.pcnTimelineTrack.querySelectorAll('[data-workflow-stage]').forEach(button => button.addEventListener('click', () => selectTimelineDepartment(button.dataset.workflowStage)));
    renderDepartmentDetails(); scrollSelectedTimeline();
  }

  function selectTimelineDepartment(key, focus = false) {
    if (!timeline.summary?.stages.some(stage => stage.key === key)) return;
    timeline = { ...timeline, selectedDepartment: key };
    els.pcnTimelineTrack.querySelectorAll('[data-workflow-stage]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.workflowStage === key)));
    renderDepartmentDetails(); scrollSelectedTimeline(focus);
  }

  function renderDepartmentDetails() {
    const stage = timeline.summary?.stages.find(item => item.key === timeline.selectedDepartment);
    if (!stage) { els.pcnTimelineDetails.innerHTML = timeline.summary ? '<p>No signing departments apply to this PCN.</p>' : ''; return; }
    const rows = stage.steps.map(step => {
      const waiting = stage.state === 'current' && !step.completed && step.label === stage.currentStep;
      return `<tr${waiting ? ' class="is-current"' : ''}><th scope="row">${escapeHtml(step.label)}</th><td>${step.completed ? 'Signed' : waiting ? 'Waiting for signature' : 'Not signed'}</td><td>${escapeHtml(step.completed ? step.person || 'Not recorded' : '\u2014')}</td><td>${escapeHtml(step.completed ? step.signedAt || 'Not recorded' : '\u2014')}</td></tr>`;
    }).join('');
    els.pcnTimelineDetails.innerHTML = `<h3>${escapeHtml(stage.label)} \u00b7 ${stage.completed}/${stage.total} signed</h3><p>${escapeHtml(window.PCN_RECORDS_DASHBOARD.workflowStageCaption(stage))}</p><div class="pcn-timeline-change-scroll"><table class="pcn-timeline-change-table pcn-signature-summary"><thead><tr><th scope="col">Step</th><th scope="col">Status</th><th scope="col">Signed by</th><th scope="col">Date</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function userFacingTimelineChanges(changes) {
    const visible = (Array.isArray(changes) ? changes : []).filter(change => {
      if (['id', 'version', 'updatedAt'].includes(change.path)) return false;
      return !String(change.path || '').startsWith('documentControl.')
        || ['documentControl.revisionReason', 'documentControl.revisionStartedBy', 'documentControl.revisionStartedAt'].includes(change.path);
    });
    const priority = change => String(change.path || '').startsWith('internalReview.') ? 0
      : String(change.path || '').startsWith('documentControl.') ? 2 : 1;
    return visible.sort((before, after) => priority(before) - priority(after));
  }

  function scrollSelectedTimeline(focus = false) {
    const track = els.pcnTimelineTrack;
    const button = [...track.querySelectorAll('.pcn-timeline-event')].find(item => timeline.tab === 'summary' ? item.dataset.workflowStage === timeline.selectedDepartment : Number(item.dataset.revision) === timeline.selectedRevision);
    if (!button) return;
    if (focus) button.focus({ preventScroll: true });
    // Scroll only the timeline, so selecting a revision cannot move the page or dialog.
    track.scrollTo({ left: Math.max(0, button.parentElement.offsetLeft - track.offsetLeft - (track.clientWidth - button.clientWidth) / 2), behavior: 'auto' });
  }

  function scrollTimeline(direction) {
    els.pcnTimelineTrack.scrollBy({ left: direction * els.pcnTimelineTrack.clientWidth * 0.8, behavior: 'auto' });
  }

  function updateTimelineNavigation() {
    const disabled = (timeline.tab === 'summary' ? timeline.summary?.stages.length || 0 : timeline.revisions.length) < 2;
    els.pcnTimelinePreviousButton.disabled = disabled;
    els.pcnTimelineNextButton.disabled = disabled;
  }

  async function updateSelectedStatus(forcedStatus) {
    if (!isAdmin() || autoRefreshBlocked) return;
    const requestedStatus = typeof forcedStatus === "string" ? forcedStatus : els.adminStatusSelect.value;

    if (!state.selected || !requestedStatus) {
      return;
    }

    startBusy("status", "Updating workflow status...");
    showAdminToast("info", "Updating workflow", `Moving ${state.selected.id} to ${titleCase(requestedStatus)}.`);

    try {
      const id = state.selected.id;
      state.selected = await apiFetch(`/api/pcns/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: requestedStatus, version: state.selected.version })
      });
      state.progress = await apiFetch(`/api/pcns/${encodeURIComponent(id)}/progress`);
      state.pcns = await fetchRecords();
      state.message = `Moved ${id} to ${titleCase(requestedStatus)}.`;
      showAdminNotice("success", "Workflow updated", state.message);
    } catch (error) {
      state.message = error.message;
      showAdminNotice("error", "Workflow update failed", error.message);
    } finally {
      stopBusy();
    }

    render();
  }

  function requestRemovePcn(record) {
    if (!isAdmin()) return;
    if (isAnyBusy()) {
      return;
    }

    refreshGeneration++;
    state.pendingRemoveRecord = record;
    els.adminRemoveCode.textContent = record.id;
    els.adminRemoveMessage.textContent = `${record.supplierName || "This supplier"} / ${record.materialName || "No material name"} will be removed from PCN records.`;
    els.adminRemoveConfirmButton.disabled = false;
    els.adminRemoveConfirmButton.textContent = "Remove PCN";
    els.adminRemoveDialog.hidden = false;
    els.adminRemoveDialog.inert = false;
    document.body.classList.add("admin-dialog-open");
    els.adminRemoveCancelButton.focus();
  }

  function closeRemoveDialog(force = false) {
    if (!force && isBusy(`remove:${state.pendingRemoveRecord && state.pendingRemoveRecord.id}`)) {
      return;
    }

    state.pendingRemoveRecord = null;
    els.adminRemoveDialog.hidden = true;
    els.adminRemoveDialog.inert = true;
    document.body.classList.remove("admin-dialog-open");
  }

  async function confirmRemovePcn() {
    const record = state.pendingRemoveRecord;

    if (!record) {
      closeRemoveDialog();
      return;
    }

    await removePcn(record);
  }

  async function removePcn(record) {
    if (!isAdmin() || autoRefreshBlocked) return;
    startBusy(`remove:${record.id}`, `Removing ${record.id}...`);
    els.adminRemoveConfirmButton.disabled = true;
    els.adminRemoveConfirmButton.textContent = "Removing...";

    try {
      await apiFetch(`/api/pcns/${encodeURIComponent(record.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ version: record.version })
      });
      state.selected = state.selected && state.selected.id === record.id ? null : state.selected;
      state.progress = state.selected ? state.progress : null;
      closeRemoveDialog(true);
      await loadPcns(`Removed ${record.id}.`);
      showAdminNotice("success", "PCN removed", `${record.id} was removed from the records list.`);
    } catch (error) {
      state.message = error.message;
      showAdminNotice("error", "Remove failed", error.message);
      els.adminRemoveConfirmButton.disabled = false;
      els.adminRemoveConfirmButton.textContent = "Remove PCN";
      render();
    } finally {
      stopBusy();
    }
  }

  function render({ routing = true } = {}) {
    renderAdminView();
    renderLoadingState();
    renderOverview();
    if (!recordsDashboard) renderTableFilters();
    const visiblePcns = getFilteredPcns();
    if (!recordsDashboard) els.adminCount.textContent = String(visiblePcns.length);
    els.adminMessage.textContent = state.message;
    els.mailRoutingMessage.textContent = state.routingMessage;
    if (recordsDashboard) recordsDashboard.setRecords(state.pcns);
    else {
    els.adminPcnRows.innerHTML = "";

    if (state.isLoading && state.pcns.length === 0) {
      renderLoadingRows();
    } else if (state.pcns.length === 0) {
      const row = document.createElement("tr");
      row.innerHTML = '<td colspan="7" class="admin-empty"><strong>No PCNs found</strong><span>Create a PCN to start the workflow.</span></td>';
      els.adminPcnRows.appendChild(row);
    } else if (visiblePcns.length === 0) {
      const row = document.createElement("tr");
      row.innerHTML = '<td colspan="7" class="admin-empty"><strong>No matching PCNs</strong><span>Adjust search or filters to see records.</span></td>';
      els.adminPcnRows.appendChild(row);
    }

    visiblePcns.forEach((record) => {
      const row = document.createElement("tr");
      row.dataset.pcnId = record.id;
      row.className = state.selected && state.selected.id === record.id ? "is-selected" : "";
      row.tabIndex = 0;
      row.setAttribute("aria-selected", state.selected && state.selected.id === record.id ? "true" : "false");
      row.innerHTML = `
        <td><a class="admin-row-link" href="/${encodeURIComponent(record.id)}">${escapeHtml(record.id)}</a></td>
        <td><span class="admin-status-chip admin-status-${escapeHtml(getStatusTone(record.status))}">${escapeHtml(getAdminStatusLabel(record))}</span></td>
        <td><span class="admin-risk-chip admin-risk-${escapeHtml(getRiskTone(record.riskLevel))}">${escapeHtml(record.riskLevel || "-")}</span></td>
        <td>${escapeHtml(record.supplierName || "-")}</td>
        <td>${escapeHtml(record.materialName || "-")}</td>
        <td>${escapeHtml(formatDate(record.updatedAt || record.createdAt))}</td>
        <td>
          <div class="admin-action-row">
            <button class="admin-row-button admin-view-button" type="button" aria-label="View ${escapeHtml(record.id)}">
              ${
                isBusy(`detail:${record.id}`)
                  ? "<span>...</span>"
                  : `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>
                      <circle cx="12" cy="12" r="2.8"></circle>
                    </svg>`
              }
            </button>
            ${isAdmin() ? `<button class="danger-button" type="button">${isBusy(`remove:${record.id}`) ? "Removing..." : "Remove"}</button>` : ''}
          </div>
        </td>
      `;

      const viewButton = row.querySelector(".admin-row-button");
      const removeButton = row.querySelector(".danger-button");
      viewButton.disabled = isAnyBusy();
      if (removeButton) removeButton.disabled = isAnyBusy();
      viewButton.setAttribute('aria-haspopup', 'dialog');
      viewButton.setAttribute('aria-controls', 'pcnTimelineDialog');
      viewButton.addEventListener("click", () => openTimeline(record, viewButton));
      if (removeButton) removeButton.addEventListener("click", () => requestRemovePcn(record));
      row.addEventListener("click", (event) => {
        if (event.target.closest("a, button")) {
          return;
        }

        loadDetail(record.id);
      });
      row.addEventListener("keydown", (event) => {
        if (event.target.closest("a, button")) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          loadDetail(record.id);
        }
      });
      els.adminPcnRows.appendChild(row);
    });
    }

    els.adminDetailStatus.textContent = state.selected ? titleCase(state.selected.status || "draft") : "None";
    els.adminDetailPreview.textContent = state.selected ? JSON.stringify(toDetailPayload(state.selected), null, 2) : "Select a PCN row to view details.";
    renderProgress();
    renderStatusControl();
    if (isAdmin() && routing) {
      renderNotificationSettings();
      renderWebhookSettings();
    }
  }

  function renderWebhookSettings() {
    syncWebhookControls();
  }

  function syncWebhookControls() {
    els.directoryLookupStatus.textContent = state.notificationSettings.directoryConfigured ? state.directoryLookupStatus : "Directory lookup not configured on server";
    renderNotificationHealth();
  }

  function renderNotificationHealth() {
    const health = state.notificationHealth;
    const needsAttention = health?.configuration.status === "invalid"
      || (health?.configuration.status === "configured"
        && (["error", "uncertain"].includes(health.worker.lastOutcome) || health.queue.uncertain > 0));
    els.notificationHealthPanel.setAttribute("aria-busy", String(state.healthLoading));
    els.notificationHealthRefreshButton.disabled = state.healthLoading;
    els.notificationHealthRefreshButton.textContent = "Check status";
    els.notificationHealthStatus.textContent = state.healthLoading ? "Checking..."
      : state.healthUnavailable ? "Unavailable" : !health ? "Not checked"
        : needsAttention ? "Needs attention"
          : health.configuration.status === "configured" ? "Ready" : "Not configured";
    const tone = state.healthLoading ? "is-busy"
      : state.healthUnavailable || needsAttention ? "is-error"
        : health?.configuration.status === "configured" ? "is-success" : "is-muted";
    els.notificationHealthStatus.className = `webhook-status ${tone}`;
  }

  function renderTableFilters() {
    els.adminSearchInput.value = state.filters.search;
    els.adminStatusFilter.innerHTML = '<option value="">All statuses</option>';
    [...new Set(state.pcns.map((record) => record.status || "draft"))]
      .sort()
      .forEach((status) => {
        const option = document.createElement("option");
        option.value = status;
        option.textContent = titleCase(status);
        option.selected = status === state.filters.status;
        els.adminStatusFilter.appendChild(option);
      });
    els.adminRiskFilter.value = state.filters.risk;
  }

  function getFilteredPcns() {
    return state.pcns.filter((record) => {
      const searchText = [
        record.id,
        record.status,
        record.riskLevel,
        record.supplierName,
        record.materialName,
        record.updatedAt,
        record.createdAt
      ].join(" ").toLowerCase();

      if (state.filters.search && !searchText.includes(state.filters.search.toLowerCase())) {
        return false;
      }

      if (state.filters.status && (record.status || "draft") !== state.filters.status) {
        return false;
      }

      if (state.filters.risk && record.riskLevel !== state.filters.risk) {
        return false;
      }

      return true;
    });
  }

  function getStatusTone(status) {
    const value = String(status || "draft").toLowerCase();

    if (value.includes("approved") || value.includes("complete") || value.includes("sent")) {
      return "success";
    }

    if (value.includes("reject") || value.includes("remove") || value.includes("cancel")) {
      return "danger";
    }

    if (value.includes("review") || value.includes("action") || value.includes("pending")) {
      return "warning";
    }

    if (value.includes("submit")) {
      return "info";
    }

    return "neutral";
  }

  function getAdminStatusLabel(record) {
    const status = String(record.status || "draft").toLowerCase();

    if (["draft", "supplier_action", "approved", "rejected", "closed"].includes(status)) {
      return titleCase(status);
    }

    const statusGroupIndex = {
      submitted: 0,
      gsc_review: 0,
      technical_review: 1,
      qa_review: 2,
      tapbu_review: 2,
      qualification: 2
    }[status];

    if (statusGroupIndex === undefined) {
      return titleCase(status);
    }

    return getCurrentSignoffStepLabel(record, statusGroupIndex) || titleCase(status);
  }

  function getCurrentSignoffStepLabel(record, minimumGroupIndex = 0) {
    const signoff = ((record.internalReview || {}).signoff) || {};
    const groups = [
      { key: "gscTet", label: "GSC/TET" },
      { key: "prodEngTet", label: "Prod.Eng/TET" },
      { key: "qaTet", label: "QA/TET" }
    ];
    const actions = ["prepared", "checked", "approved"];

    for (let groupIndex = minimumGroupIndex; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      const values = signoff[group.key] || {};
      const nextAction = actions.find((action) => !values[action]);

      if (nextAction) {
        return `${group.label} ${titleCase(nextAction)}`;
      }
    }

    return "TOKIN Signoff Complete";
  }

  function getRiskTone(riskLevel) {
    const value = String(riskLevel || "").toUpperCase();

    if (value === "RL3") {
      return "danger";
    }

    if (value === "RL2") {
      return "warning";
    }

    if (value === "RL1") {
      return "info";
    }

    return "neutral";
  }

  function renderNotificationSettings() {
    els.notificationGroups.innerHTML = "";

    if (state.isLoading && state.notificationSettings.groups.length === 0) {
      renderNotificationLoadingCards();
      return;
    }

    const departments = [
      ["gscTet", "GSC/TET"], ["prodEngTet", "Prod.Eng/TET"], ["qaTet", "QA/TET"],
      ["gscTapbu", "GSC/TaPBU"], ["qaTapbu", "QA/TaPBU"]
    ];
    departments.forEach(([key, label]) => {
      els.notificationGroups.appendChild(createNotificationDepartment(key, label));
    });
    const supplier = state.notificationSettings.groups.find((group) => group.key === "supplierNotification");
    if (supplier) els.notificationGroups.appendChild(createNotificationGroup(supplier, "Supplier Notification"));
    renderLegacyContacts();
  }

  function createNotificationDepartment(key, label) {
    const card = document.createElement('article'); card.className = 'notification-department'; card.dataset.department = key;
    const header = document.createElement('header'); header.className = 'notification-department-header';
    const heading = document.createElement('h3');
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'notification-department-toggle'; toggle.textContent = label; toggle.dataset.routingAction = 'toggle';
    const body = document.createElement('div'); body.className = 'notification-department-body'; body.id = `notificationDepartmentBody-${key}`; body.hidden = collapsedRoutingDepartments.has(key);
    const updateToggle = () => {
      toggle.setAttribute('aria-expanded', String(!body.hidden)); toggle.setAttribute('aria-controls', body.id);
      toggle.setAttribute('aria-label', `${body.hidden ? 'Expand' : 'Collapse'} ${label}`);
    };
    toggle.addEventListener('click', () => {
      body.hidden = !body.hidden;
      collapsedRoutingDepartments = body.hidden ? new Set([...collapsedRoutingDepartments, key]) : new Set([...collapsedRoutingDepartments].filter(value => value !== key));
      updateToggle();
    });
    updateToggle(); heading.appendChild(toggle);
    const assign = document.createElement('button'); assign.type = 'button'; assign.className = 'ghost-button notification-add-button notification-department-add'; assign.dataset.routingAction = 'assign'; assign.textContent = 'Assign user';
    assign.setAttribute('aria-label', `Assign user to ${label} mail list`); assign.setAttribute('aria-haspopup', 'dialog'); assign.setAttribute('aria-controls', 'notificationRecipientDialog');
    assign.addEventListener('click', () => openDepartmentRecipientDialog(key, label)); header.append(heading, assign); card.append(header, body);
    ['prepared', 'checked', 'approved'].forEach(action => {
      const group = state.notificationSettings.groups.find(entry => entry.key === `department.${key}.${action}`);
      if (group) body.appendChild(createNotificationGroup(group, titleCase(action)));
    });
    return card;
  }

  function createNotificationGroup(group, heading) {
    const card = document.createElement("section");
    card.className = "notification-group notification-step";
    card.dataset.notificationGroup = group.key;
    card.managedRecipients = Array.isArray(group.automaticRecipients) ? group.automaticRecipients.map((recipient) => ({ ...recipient })) : [];
    card.setAttribute("aria-label", group.label);
    const supplier = group.key === 'supplierNotification';
    card.innerHTML = `<div class="notification-group-header"><div><h4>${escapeHtml(heading)}</h4><small data-recipient-count></small></div>${supplier ? `<button class="ghost-button notification-add-button" type="button" aria-label="Add recipient to ${escapeHtml(group.label)}">Add</button>` : ''}</div><div class="notification-person-list"></div><div class="notification-group-warning" aria-live="polite" hidden></div>`;
    const list = card.querySelector(".notification-person-list");
    const recipients = getEditorGroupRecipients(group);
    recipients.forEach((recipient) => appendRecipientRow(list, recipient));
    card.managedRecipients.forEach((recipient) => list.appendChild(createManagedRecipient(recipient)));
    updateRecipientCount(list);
    renderRecipientValidation(list);
    card.querySelector(".notification-add-button")?.addEventListener("click", () => {
      openRecipientDialog(group);
    });
    return card;
  }

  function createManagedRecipient(recipient) {
    const row = document.createElement('div');
    row.className = 'notification-person notification-person-managed';
    row.dataset.managedRecipient = recipient.email || '';
    const avatar = document.createElement('span');
    avatar.className = 'notification-person-avatar'; avatar.setAttribute('aria-hidden', 'true');
    const fallback = recipient.displayName || recipient.email;
    const image = typeof recipient.photo === 'string' ? recipient.photo.trim() : '';
    const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(image);
    renderRecipientAvatar(avatar, image.length <= 100 * 1024 && match && match[1].length % 4 === 0 ? image : '', fallback);
    avatar.querySelector('img')?.addEventListener('error', () => renderRecipientAvatar(avatar, '', fallback), { once: true });
    const body = document.createElement('div'); body.className = 'notification-person-body';
    const name = document.createElement('span'); name.className = 'notification-person-identity';
    name.textContent = [recipient.displayName, recipient.employeeCode].filter(Boolean).join(' · ');
    const email = document.createElement('span'); email.className = 'notification-person-email'; email.textContent = recipient.email || '';
    const meta = document.createElement('div'); meta.className = 'notification-person-meta';
    meta.textContent = [recipient.jobTitle, recipient.department].filter(Boolean).join(' - '); meta.hidden = !meta.textContent;
    const source = document.createElement('span');
    source.className = 'notification-recipient-source';
    source.textContent = 'From Users';
    source.title = 'Edit this assignment in Users.';
    body.append(name, email, meta); row.append(avatar, body, source);
    return row;
  }

  function recipientTargetLabel(group) {
    if (!group.action) return group.label;
    const action = titleCase(group.action);
    return `${group.label.slice(0, -(action.length + 1))} — ${action}`;
  }

  function getRecipientAdditionIssue(email, existingEmails) {
    if (!isValidEmail(email)) return "Select a directory result with a valid email address.";
    if (existingEmails.some((entry) => entry.toLowerCase() === email.toLowerCase())) return "This recipient is already in this list.";
    if (existingEmails.length >= 30) return "Each list can contain at most 30 recipients.";
    if ([...existingEmails, email].join("; ").length > 1000) return "Recipient emails must fit within 1,000 characters per list.";
    return "";
  }

  function getDirectorySelectionIssue(input, selection, configured, targetKey) {
    if (!configured) return "Directory lookup is unavailable. A recipient cannot be added until lookup is configured.";
    if (!selection || selection.targetKey !== targetKey || input.dataset.directoryLookupState !== "verified"
      || input.value.trim() !== selection.email) return "Select a recipient from the directory results. Typed text is only used for searching.";
    return "";
  }

  function findRecipientTargetCard() {
    return [...els.notificationGroups.querySelectorAll("[data-notification-group]")].find((card) => card.dataset.notificationGroup === state.recipientTargetKey);
  }

  function openDepartmentRecipientDialog(key, label) {
    if (!state.notificationSettings.groups.some(group => group.key.startsWith(`department.${key}.`))) return;
    openRecipientDialog(null, { key, label });
  }

  function openRecipientDialog(group, department = null) {
    if (isAnyBusy()) return;
    recipientPresentation++;
    refreshGeneration++;
    state.recipientDepartment = department?.key || null;
    state.recipientDepartmentLabel = department?.label || null;
    state.recipientTargetKey = group?.key || null;
    els.notificationRecipientRoleField.hidden = !department;
    els.notificationRecipientRole.value = ''; els.notificationRecipientRole.required = Boolean(department);
    els.notificationRecipientTitle.textContent = department ? `Assign mail recipient to ${department.label}` : recipientTargetLabel(group);
    buildRecipientDialogInput(group);
    els.notificationRecipientDialog.showModal();
    (department ? els.notificationRecipientRole : els.notificationRecipientList.querySelector('input')).focus();
  }

  function buildRecipientDialogInput(group) {
    const previous = els.notificationRecipientList.querySelector('input');
    if (previous) { directorySelections.delete(previous); window.clearTimeout(directoryLookupTimers.get(previous)); abortDirectoryLookup(previous); }
    const label = group?.label || state.recipientDepartmentLabel;
    els.notificationRecipientEditor.dataset.notificationGroup = group?.key || `department.${state.recipientDepartment}`;
    els.notificationRecipientEditor.setAttribute('aria-label', label);
    els.notificationRecipientList.innerHTML = "";
    const row = appendRecipientRow(els.notificationRecipientList, "");
    row.querySelector(".notification-remove-button").remove();
    const input = row.querySelector("input");
    input.id = "notificationRecipientEmail";
    input.disabled = !group || !isDirectoryLookupConfigured();
    input.setAttribute("aria-label", `Search name or email for ${label}`);
    input.maxLength = 320;
    input.setAttribute("aria-describedby", "notificationRecipientValidation");
    updateRecipientDialog();
  }

  function changeRecipientRole() {
    if (!state.recipientDepartment || !els.notificationRecipientDialog.open) return;
    const action = els.notificationRecipientRole.value;
    const group = ['prepared', 'checked', 'approved'].includes(action)
      ? state.notificationSettings.groups.find(entry => entry.key === `department.${state.recipientDepartment}.${action}`) : null;
    state.recipientTargetKey = group?.key || null;
    buildRecipientDialogInput(group);
  }

  function updateRecipientDialog() {
    const input = els.notificationRecipientList.querySelector("input");
    const target = findRecipientTargetCard();
    if (!input || !target) {
      els.notificationRecipientConfirmButton.disabled = true;
      els.notificationRecipientValidation.hidden = false;
      els.notificationRecipientValidation.textContent = state.recipientDepartment ? 'Select a signing role, then choose a directory user.' : 'This recipient list is unavailable.';
      return;
    }
    const email = input.value.trim();
    const existing = getRecipientInputs(target).map((entry) => entry.value.trim()).filter(Boolean);
    const selection = directorySelections.get(input);
    const issue = getDirectorySelectionIssue(input, selection, isDirectoryLookupConfigured(), state.recipientTargetKey)
      || getRecipientAdditionIssue(email, existing);
    els.notificationRecipientConfirmButton.disabled = Boolean(issue);
    els.notificationRecipientValidation.hidden = false;
    const lookupMessage = {
      queued: "Searching directory...", searching: "Searching directory...", results: state.directoryLookupStatus,
      "no-match": "No directory match.", failed: "Directory lookup is unavailable."
    }[input.dataset.directoryLookupState] || "";
    const entryMessage = email || !isDirectoryLookupConfigured() ? issue || "Selected directory recipient is ready to add." : "Search a name or email, then select a directory result.";
    els.notificationRecipientValidation.textContent = [lookupMessage, entryMessage].filter(Boolean).join(" ");
    input.setAttribute("aria-invalid", String(Boolean(email && issue)));
    input.setCustomValidity(issue);
  }

  function notifyRecipientEdit(row) {
    if (row.closest("#notificationRecipientDialog")) updateRecipientDialog();
    else markMailChanged();
  }

  function confirmRecipientDialog() {
    const target = findRecipientTargetCard();
    const input = els.notificationRecipientList.querySelector("input");
    if (!els.notificationRecipientDialog.open || !target || !input) return;
    updateRecipientDialog();
    if (els.notificationRecipientConfirmButton.disabled) return;
    const recipient = directorySelections.get(input).recipient;
    appendRecipientRow(target.querySelector(".notification-person-list"), recipient, false, Boolean(input.dataset.verifiedEmail));
    expandRecipientDepartment(target);
    markMailChanged();
    const group = state.notificationSettings.groups.find(entry => entry.key === state.recipientTargetKey);
    const label = group ? recipientTargetLabel(group) : target.getAttribute('aria-label');
    closeRecipientDialog();
    showAdminNotice("success", "Recipient added", `${recipient.email} added to ${label}. Save Mail to save routing.`);
  }

  function expandRecipientDepartment(target) {
    const department = target.closest('.notification-department');
    const body = department?.querySelector('.notification-department-body');
    if (!body?.hidden) return;
    body.hidden = false;
    collapsedRoutingDepartments = new Set([...collapsedRoutingDepartments].filter(key => key !== department.dataset.department));
    const toggle = department.querySelector('.notification-department-toggle');
    toggle.setAttribute('aria-expanded', 'true'); toggle.setAttribute('aria-label', `Collapse ${toggle.textContent}`);
  }

  function closeRecipientDialog() {
    els.notificationRecipientDialog.close();
    finishRecipientDialog();
  }

  function finishRecipientDialog() {
    if (els.notificationRecipientDialog.open) return;
    const input = els.notificationRecipientList.querySelector("input");
    if (input) {
      directorySelections.delete(input);
      window.clearTimeout(directoryLookupTimers.get(input));
      abortDirectoryLookup(input);
    }
    const target = findRecipientTargetCard();
    const department = [...els.notificationGroups.querySelectorAll('[data-department]')].find(card => card.dataset.department === state.recipientDepartment);
    const focusTarget = department?.querySelector('.notification-department-add') || getRoutingAssignmentButton(target);
    const presentation = ++recipientPresentation;
    const cleanup = () => { els.notificationRecipientList.innerHTML = ''; };
    if (autoRefreshBlocked || !window.PCN_UI_MOTION?.afterExit(els.notificationRecipientDialog, cleanup, { current: () => !els.notificationRecipientDialog.open && recipientPresentation === presentation })) cleanup();
    els.notificationRecipientEditor.removeAttribute("data-notification-group");
    state.recipientTargetKey = null;
    state.recipientDepartment = null; state.recipientDepartmentLabel = null;
    els.notificationRecipientRole.value = ''; els.notificationRecipientConfirmButton.disabled = true;
    focusTarget?.focus();
  }

  function getRoutingAssignmentButton(card) {
    return card?.closest('.notification-department')?.querySelector('.notification-department-add') || card?.querySelector('.notification-add-button');
  }

  function renderLegacyContacts() {
    const container = els.notificationLegacyGroups;
    container.innerHTML = "";
    const sources = (state.notificationSettings.legacyGroups || []).filter((group) => getNotificationGroupRecipients(group).length);
    container.hidden = sources.length === 0;
    if (!sources.length) return;
    container.innerHTML = '<h3>Contacts from previous routing</h3><p>These saved contacts remain unchanged. Choose a recipient list and copy contacts to it before saving. No contacts are assigned automatically.</p>';
    sources.forEach((source) => {
      const row = document.createElement("div");
      row.className = "notification-legacy-source";
      row.dataset.legacySource = source.key;
      const label = document.createElement("strong");
      label.textContent = source.label;
      const contacts = document.createElement("p");
      contacts.textContent = getNotificationGroupRecipients(source).map(getRecipientEmail).join("; ");
      const target = document.createElement("select");
      target.setAttribute("aria-label", `Recipient list for contacts from ${source.label}`);
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose recipient list";
      target.appendChild(placeholder);
      state.notificationSettings.groups.forEach((group) => {
        const option = document.createElement("option");
        option.value = group.key;
        option.textContent = group.label;
        target.appendChild(option);
      });
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ghost-button";
      copy.textContent = "Copy contacts to list";
      copy.setAttribute("aria-label", `Copy contacts to list from ${source.label}`);
      copy.disabled = true;
      target.addEventListener("change", () => { copy.disabled = !target.value || isAnyBusy(); });
      copy.addEventListener("click", () => copyLegacyContacts(source, target.value));
      row.append(label, contacts, target, copy);
      container.appendChild(row);
    });
  }

  function mergeLegacyRecipients(target, source) {
    const seen = new Set(target.map((recipient) => getRecipientEmail(recipient).toLowerCase()));
    return [...target, ...source.filter((recipient) => {
      const email = getRecipientEmail(recipient).toLowerCase();
      if (!email || seen.has(email)) return false;
      seen.add(email);
      return true;
    })];
  }

  function copyLegacyContacts(source, targetKey) {
    const group = state.notificationSettings.groups.find((entry) => entry.key === targetKey);
    if (!group) return;
    const card = [...els.notificationGroups.querySelectorAll("[data-notification-group]")].find((entry) => entry.dataset.notificationGroup === targetKey);
    const current = getRecipientInputs(card).map(getRecipientPayload).filter(Boolean);
    const merged = mergeLegacyRecipients(current, getNotificationGroupRecipients(source));
    if (!window.confirm(`Copy ${merged.length - current.length} new contact(s) from ${source.label} to ${group.label}? Existing contacts stay in place; this draft still needs to be saved.`)) return;
    const list = card.querySelector(".notification-person-list");
    list.innerHTML = "";
    merged.forEach((recipient) => appendRecipientRow(list, recipient));
    card.managedRecipients.forEach((recipient) => list.appendChild(createManagedRecipient(recipient)));
    markMailChanged();
    list.querySelector(".notification-remove-button")?.focus();
  }

  function appendRecipientRow(list, recipient, shouldFocus = false, isVerified = Boolean(getRecipientEmail(recipient))) {
    const email = getRecipientEmail(recipient);
    const row = document.createElement("div");
    row.className = "notification-person";
    row.addEventListener("focusout", () => {
      window.setTimeout(() => { if (!row.contains(document.activeElement)) closeDirectorySuggestions(row); }, 140);
    });

    const avatar = document.createElement("span");
    avatar.className = "notification-person-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = getRecipientInitial(email);

    const input = document.createElement("input");
    const inDialog = Boolean(list.closest("#notificationRecipientDialog"));
    input.type = inDialog ? "text" : "hidden";
    input.dataset.recipientEmail = "true";
    input.placeholder = isDirectoryLookupConfigured() ? "Search name or email" : "Directory lookup unavailable";
    input.value = recipient && typeof recipient === "object" && Object.hasOwn(recipient, "inputValue") ? recipient.inputValue : email;
    input.dataset.verifiedEmail = recipient && typeof recipient === "object" && Object.hasOwn(recipient, "verifiedEmail")
      ? recipient.verifiedEmail : email && isVerified ? email.toLowerCase() : "";
    input.disabled = isAnyBusy();
    input.setAttribute("aria-label", `Recipient email for ${list.closest("[data-notification-group]").getAttribute("aria-label")}`);
    input.setAttribute("autocomplete", "off");
    input.addEventListener("input", () => {
      if (inDialog) {
        directorySelections.delete(input);
        input.dataset.verifiedEmail = "";
      }
      renderRecipientAvatar(avatar, null, input.value);
      syncRecipientVerificationState(input);
      renderSelectedRecipientMeta(input, null);
      updateRecipientCount(list);
      renderRecipientValidation(list);
      notifyRecipientEdit(row);
      scheduleDirectoryLookup(input);
    });
    input.addEventListener("blur", () => {
      window.setTimeout(() => { if (!row.contains(document.activeElement)) closeDirectorySuggestions(row); }, 140);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        const first = row.querySelector(".directory-suggestion:not(.is-message)");
        if (first) { event.preventDefault(); first.focus(); }
      }
      if (event.key === "Escape" && (!row.querySelector(".directory-suggestions").hidden || ["queued", "searching", "results"].includes(input.dataset.directoryLookupState))) {
        event.preventDefault();
        event.stopPropagation();
        dismissDirectoryLookup(input, row);
      }
    });

    const removeButton = document.createElement("button");
    removeButton.className = "danger-button notification-remove-button";
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.setAttribute("aria-label", `Remove ${email} from ${list.closest("[data-notification-group]").getAttribute("aria-label")}`);
    removeButton.disabled = isAnyBusy();
    removeButton.addEventListener("click", () => {
      window.clearTimeout(directoryLookupTimers.get(input));
      abortDirectoryLookup(input);
      row.remove();
      const focusTarget = list.querySelector(".notification-remove-button") || getRoutingAssignmentButton(list.closest("[data-notification-group]"));
      focusTarget?.focus();
      markMailChanged();
      updateRecipientCount(list);
      renderRecipientValidation(list);
      showAdminNotice("info", "Recipient removed", "The recipient was removed from this list.");
    });

    const suggestions = document.createElement("div");
    suggestions.className = "directory-suggestions";
    suggestions.setAttribute("role", "listbox");
    suggestions.setAttribute("aria-label", `Directory results for ${list.closest("[data-notification-group]").getAttribute("aria-label")}`);
    suggestions.hidden = true;

    const body = document.createElement("div");
    body.className = "notification-person-body";

    const meta = document.createElement("div");
    meta.className = "notification-person-meta";
    meta.hidden = true;

    body.append(input, meta);
    if (!inDialog) {
      const contact = document.createElement("span");
      contact.className = "notification-person-email";
      contact.textContent = email;
      body.insertBefore(contact, meta);
    }
    row.append(avatar, body, removeButton, suggestions);
    list.appendChild(row);

    if (typeof recipient === "object" && recipient) {
      renderRecipientAvatar(avatar, recipient.photo, recipient.displayName || email);
      renderSelectedRecipientMeta(input, recipient);
    }

    updateRecipientCount(list);
    renderRecipientValidation(list);

    if (shouldFocus) {
      input.focus();
    }
    return row;
  }

  function getRecipientInitial(value) {
    const trimmed = String(value || "").trim();
    return (trimmed.charAt(0) || "?").toUpperCase();
  }

  function getNotificationGroupRecipients(group) {
    const emails = parseEmailList(group.emails);
    const savedRecipients = Array.isArray(group.recipients) ? group.recipients : [];
    const savedByEmail = new Map(
      savedRecipients
        .filter((recipient) => recipient && recipient.email)
        .map((recipient) => [String(recipient.email).toLowerCase(), recipient])
    );

    return emails.map((email) => ({
      email,
      ...(savedByEmail.get(email.toLowerCase()) || {})
    }));
  }

  function getEditorGroupRecipients(group) {
    // Draft rows are individual user-added fields; never parse their raw values as a saved email list.
    return state.mailDraftRows && Object.hasOwn(state.mailDraftRows, group.key)
      ? state.mailDraftRows[group.key].map((row) => ({ ...row }))
      : getNotificationGroupRecipients(group);
  }

  function getRecipientEmail(recipient) {
    return typeof recipient === "object" && recipient
      ? String(recipient.email || recipient.mail || "").trim()
      : String(recipient || "").trim();
  }

  function getRecipientInputs(row) {
    return [...row.querySelectorAll("[data-recipient-email]")];
  }

  function getRecipientPayload(input) {
    const email = input.value.trim();

    if (!email) {
      return null;
    }

    return {
      email,
      displayName: input.dataset.recipientName || "",
      jobTitle: input.dataset.recipientJobTitle || "",
      department: input.dataset.recipientDepartment || "",
      photo: input.dataset.recipientPhoto || ""
    };
  }

  function syncRecipientVerificationState(input) {
    const email = input.value.trim().toLowerCase();
    if (!email || input.dataset.verifiedEmail !== email) {
      input.dataset.verifiedEmail = "";
      renderSelectedRecipientMeta(input, null);
    }
  }

  function isDirectoryLookupConfigured() {
    return Boolean(state.notificationSettings.directoryConfigured);
  }

  function scheduleDirectoryLookup(input) {
    const row = input.closest(".notification-person");
    const query = input.value.trim();

    window.clearTimeout(directoryLookupTimers.get(input));
    abortDirectoryLookup(input);
    input.dataset.directoryLookupState = "";

    if (!isDirectoryLookupConfigured() || query.length < 2 || query.includes(";") || query.includes(",")) {
      closeDirectorySuggestions(row);
      renderRecipientValidation(input.closest(".notification-person-list"));
      return;
    }

    input.dataset.directoryLookupState = "queued";
    renderRecipientValidation(input.closest(".notification-person-list"));
    const timer = window.setTimeout(() => lookupDirectoryUsers(input, query), 280);
    directoryLookupTimers.set(input, timer);
  }

  function abortDirectoryLookup(input) {
    const controller = directoryLookupControllers.get(input);
    if (controller) {
      controller.abort();
      directoryLookupControllers.delete(input);
    }
  }

  function dismissDirectoryLookup(input, row) {
    window.clearTimeout(directoryLookupTimers.get(input));
    abortDirectoryLookup(input);
    input.dataset.directoryLookupState = "";
    closeDirectorySuggestions(row);
    renderRecipientValidation(input.closest(".notification-person-list"));
  }

  async function lookupDirectoryUsers(input, query) {
    const row = input.closest(".notification-person");

    if (!row || !input.isConnected || !row.contains(document.activeElement) || !isDirectoryLookupConfigured() || input.value.trim() !== query) {
      return;
    }

    const controller = new AbortController();
    directoryLookupControllers.set(input, controller);
    input.dataset.directoryLookupState = "searching";
    renderDirectorySuggestions(row, [{ displayName: "Searching directory...", mail: "", isMessage: true }]);
    state.directoryLookupStatus = "Directory lookup searching";
    renderRecipientValidation(input.closest(".notification-person-list"));
    syncWebhookControls();

    try {
      const body = await apiFetch(`/api/admin/directory-users?query=${encodeURIComponent(query)}`, { signal: controller.signal });
      if (!input.isConnected || !row.contains(document.activeElement) || input.value.trim() !== query || directoryLookupControllers.get(input) !== controller) return;
      const users = normalizeDirectoryUsers(body).slice(0, 6);
      input.dataset.directoryLookupState = users.length ? "results" : "no-match";
      state.directoryLookupStatus = users.length ? `${users.length} directory result${users.length === 1 ? "" : "s"}` : "No directory match";
      renderDirectorySuggestions(
        row,
        users.length ? users : [{ displayName: "No matching user found", mail: "", isMessage: true }]
      );
      renderRecipientValidation(input.closest(".notification-person-list"));
    } catch (error) {
      if (error.name === "AbortError" || !input.isConnected || !row.contains(document.activeElement) || directoryLookupControllers.get(input) !== controller) {
        return;
      }

      state.directoryLookupStatus = "Directory lookup failed";
      input.dataset.directoryLookupState = "failed";
      renderDirectorySuggestions(row, [{ displayName: "Directory lookup failed", mail: error.message, isMessage: true, isError: true }]);
      renderRecipientValidation(input.closest(".notification-person-list"));
    } finally {
      if (directoryLookupControllers.get(input) === controller) {
        directoryLookupControllers.delete(input);
        syncWebhookControls();
      }
    }
  }

  function normalizeDirectoryUsers(body) {
    const source = Array.isArray(body)
      ? body
      : Array.isArray(body && body.users)
        ? body.users
        : Array.isArray(body && body.value)
          ? body.value
          : Array.isArray(body && body.results)
            ? body.results
            : [];

    return source
      .map((entry) => {
        const mail = String(entry.mail || entry.email || entry.userPrincipalName || entry.upn || "").trim();

        return {
          displayName: String(entry.displayName || entry.name || entry.givenName || mail || "Unknown user").trim(),
          mail,
          jobTitle: String(entry.jobTitle || entry.position || entry.title || "").trim(),
          department: String(entry.department || entry.officeLocation || "").trim(),
          photo: sanitizeDirectoryPhoto(entry.photo || entry.photoUrl || entry.picture || entry.avatar || "")
        };
      })
      .filter((entry) => entry.mail && isValidEmail(entry.mail));
  }

  function renderDirectorySuggestions(row, users) {
    const box = row ? row.querySelector(".directory-suggestions") : null;
    if (!box) {
      return;
    }

    box.innerHTML = "";
    users.forEach((user) => {
      const item = document.createElement(user.isMessage ? "div" : "button");
      item.className = `directory-suggestion${user.isMessage ? " is-message" : ""}${user.isError ? " is-error" : ""}`;

      if (!user.isMessage) {
        item.type = "button";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", "false");
        item.addEventListener("click", () => selectDirectoryUser(row, user));
        item.addEventListener("keydown", (event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismissDirectoryLookup(row.querySelector("input"), row); row.querySelector("input").focus(); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const next = event.key === "ArrowDown" ? item.nextElementSibling : item.previousElementSibling;
            if (next && next.tagName === "BUTTON") next.focus();
          }
        });
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          selectDirectoryUser(row, user);
        });
      }

      const avatar = document.createElement("span");
      avatar.className = "directory-suggestion-avatar";
      avatar.setAttribute("aria-hidden", "true");
      renderRecipientAvatar(avatar, user.photo, user.displayName || user.mail);

      const content = document.createElement("span");
      const detailLine = [user.jobTitle, user.department].filter(Boolean).join(" - ");
      content.innerHTML = `
        <strong>${escapeHtml(user.displayName)}</strong>
        <small>${escapeHtml(user.mail)}</small>
        ${detailLine ? `<small class="directory-suggestion-position">${escapeHtml(detailLine)}</small>` : ""}
      `;
      item.append(avatar, content);
      box.appendChild(item);
    });

    box.hidden = false;
  }

  function selectDirectoryUser(row, user) {
    const input = row.querySelector("[data-recipient-email]");
    if (!row.isConnected || !row.closest("#notificationRecipientDialog") || !els.notificationRecipientDialog.open
      || !isDirectoryLookupConfigured() || !findRecipientTargetCard()) return;
    const avatar = row.querySelector(".notification-person-avatar");
    const list = row.closest(".notification-person-list");

    directorySelections.set(input, {
      targetKey: state.recipientTargetKey,
      email: user.mail,
      recipient: { email: user.mail, displayName: user.displayName || "", jobTitle: user.jobTitle || "", department: user.department || "", photo: user.photo || "" }
    });

    input.value = user.mail;
    input.dataset.verifiedEmail = user.mail.toLowerCase();
    input.dataset.directoryLookupState = "verified";
    input.classList.remove("is-invalid", "is-warning", "is-unverified");
    renderRecipientAvatar(avatar, user.photo, user.displayName || user.mail);
    renderSelectedRecipientMeta(input, user);
    closeDirectorySuggestions(row);
    notifyRecipientEdit(row);
    updateRecipientCount(list);
    renderRecipientValidation(list);
    input.focus();
  }

  function renderSelectedRecipientMeta(input, user) {
    const row = input.closest(".notification-person");
    const meta = row ? row.querySelector(".notification-person-meta") : null;

    input.dataset.recipientName = user ? user.displayName || "" : "";
    input.dataset.recipientJobTitle = user ? user.jobTitle || "" : "";
    input.dataset.recipientDepartment = user ? user.department || "" : "";
    input.dataset.recipientPhoto = user ? user.photo || "" : "";

    if (!meta) {
      return;
    }

    const detailLine = user
      ? [user.jobTitle, user.department].filter(Boolean).join(" - ")
      : "";

    meta.textContent = detailLine;
    meta.hidden = !detailLine;
  }

  function renderRecipientAvatar(target, photo, fallbackText) {
    target.innerHTML = "";

    if (photo) {
      const image = document.createElement("img");
      image.src = photo;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      target.appendChild(image);
      return;
    }

    target.textContent = getRecipientInitial(fallbackText);
  }

  function sanitizeDirectoryPhoto(value) {
    const text = String(value || "").trim();

    if (!text) {
      return "";
    }

    if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(text)) {
      return text.replace(/\s/g, "");
    }

    try {
      const parsed = new URL(text);
      return parsed.protocol === "https:" ? text : "";
    } catch (error) {
      return "";
    }
  }

  function closeDirectorySuggestions(row) {
    const box = row ? row.querySelector(".directory-suggestions") : null;
    if (!box) {
      return;
    }

    box.hidden = true;
    box.innerHTML = "";
  }

  function updateRecipientCount(list) {
    const card = list.closest("[data-notification-group]");
    const counter = card ? card.querySelector("[data-recipient-count]") : null;
    const manual = [...list.querySelectorAll("[data-recipient-email]")].map((input) => input.value.trim()).filter(Boolean);
    const managed = (card?.managedRecipients || []).map((recipient) => recipient.email).filter(Boolean);
    const boxCount = new Set([...manual, ...managed].map((email) => email.toLowerCase())).size;

    if (counter) {
      counter.textContent = `${boxCount} recipient${boxCount === 1 ? "" : "s"}`;
    }
  }

  function renderRecipientValidation(list) {
    if (list.closest("#notificationRecipientDialog")) {
      updateRecipientDialog();
      return;
    }
    const card = list.closest("[data-notification-group]");
    const warning = card ? card.querySelector(".notification-group-warning") : null;
    const inputs = [...list.querySelectorAll("[data-recipient-email]")];
    const entries = inputs.map((input) => input.value.trim()).filter(Boolean);
    const emails = entries.filter((entry) => isValidEmail(entry));
    const invalid = entries.find((entry) => !isValidEmail(entry));
    const duplicate = emails.find((email, index) => emails.findIndex((entry) => entry.toLowerCase() === email.toLowerCase()) !== index);
    const needsDirectoryVerification = false;
    const unverified = needsDirectoryVerification
      ? inputs.find((input) => {
          const value = input.value.trim().toLowerCase();
          return value && input.dataset.verifiedEmail !== value;
        })
      : null;

    inputs.forEach((input) => {
      const value = input.value.trim();
      const email = value.toLowerCase();
      const isDuplicate = email && emails.filter((entry) => entry.toLowerCase() === email.toLowerCase()).length > 1;
      const isUnverified = needsDirectoryVerification && email && input.dataset.verifiedEmail !== email;
      input.classList.toggle("is-invalid", Boolean(value && !needsDirectoryVerification && !isValidEmail(value)));
      input.classList.toggle("is-warning", Boolean(isDuplicate));
      input.classList.toggle("is-unverified", Boolean(isUnverified));
      input.setCustomValidity(
        value && !needsDirectoryVerification && !isValidEmail(value)
          ? "Enter a valid email address."
          : isUnverified
            ? "Select this recipient from directory lookup."
            : ""
      );
    });

    if (!warning) {
      return;
    }

    if (invalid) {
      warning.hidden = false;
      warning.className = "notification-group-warning is-error";
      warning.textContent = `Invalid email: ${invalid}`;
      return;
    }

    if (duplicate) {
      warning.hidden = false;
      warning.className = "notification-group-warning is-warning";
      warning.textContent = `Duplicate email: ${duplicate}`;
      return;
    }

    if (unverified) {
      warning.hidden = false;
      warning.className = `notification-group-warning ${getDirectoryWarningClass(unverified)}`;
      warning.textContent = getDirectoryWarningText(unverified);
      return;
    }

    if (emails.length === 0 && !(card?.managedRecipients || []).some((recipient) => isValidEmail(recipient.email))) {
      warning.hidden = false;
      warning.className = "notification-group-warning";
      warning.textContent = "Empty — no email will be sent to this list.";
      return;
    }

    warning.hidden = true;
    warning.textContent = "";
  }

  function validateNotificationGroups() {
    let isValid = true;

    els.notificationGroups
      .querySelectorAll(".notification-person-list")
      .forEach((list) => {
        renderRecipientValidation(list);
        const hasIssue = Boolean(list.closest("[data-notification-group]").querySelector(".notification-group-warning:not([hidden])"));
        const hasBlockingIssue = [...list.querySelectorAll("[data-recipient-email]")]
          .some((input) => input.classList.contains("is-invalid") || input.classList.contains("is-warning") || input.classList.contains("is-unverified"));

        if (hasIssue && hasBlockingIssue) {
          isValid = false;
        }
      });

    return isValid;
  }

  function getDirectoryWarningClass(input) {
    const stateName = input.dataset.directoryLookupState || "";

    if (stateName === "failed" || stateName === "no-match") {
      return "is-error";
    }

    return "is-warning";
  }

  function getDirectoryWarningText(input) {
    const value = input.value.trim();
    const stateName = input.dataset.directoryLookupState || "";

    if (stateName === "queued" || stateName === "searching") {
      return `Searching directory for: ${value}`;
    }

    if (stateName === "no-match") {
      return `No directory user found for: ${value}`;
    }

    if (stateName === "failed") {
      return `Directory lookup failed. Check the Power Automate URL/authentication.`;
    }

    return `Select a directory user for: ${value}`;
  }

  function renderRecipientValidationForAllGroups() {
    els.notificationGroups
      .querySelectorAll(".notification-person-list")
      .forEach((list) => renderRecipientValidation(list));
  }

  function isValidEmail(value) {
    return /^[^\s@;,]+@[^\s@;,]+\.[^\s@;,]+$/.test(value);
  }

  function renderLoadingRows() {
    for (let index = 0; index < 4; index += 1) {
      const row = document.createElement("tr");
      row.className = "admin-skeleton-row";
      row.innerHTML = `
        <td><span></span></td>
        <td><span></span></td>
        <td><span></span></td>
        <td><span></span></td>
        <td><span></span></td>
        <td><span></span></td>
        <td><span></span></td>
      `;
      els.adminPcnRows.appendChild(row);
    }
  }

  function renderNotificationLoadingCards() {
    for (let index = 0; index < 6; index += 1) {
      const card = document.createElement("article");
      card.className = "notification-group notification-group-loading";
      card.innerHTML = `
        <div class="admin-skeleton-line is-short"></div>
        <div class="admin-skeleton-line"></div>
        <div class="admin-skeleton-line"></div>
      `;
      els.notificationGroups.appendChild(card);
    }
  }

  function renderLoadingState() {
    const busy = isAnyBusy();
    els.adminLoadingBar.hidden = !busy;
    els.adminLoadingText.textContent = state.loadingText;
    els.adminRefreshButton.disabled = busy;
    els.adminRefreshButton.textContent = isBusy("refresh") ? "Refreshing..." : "Refresh";
    els.notificationSaveButton.disabled = busy;
    els.notificationSaveButton.textContent = isBusy("mail") ? "Saving..." : state.hasMailChanges ? "Save Changes" : "Save Mail";
    els.notificationReloadButton.hidden = !state.mailConflict;
    els.notificationReloadButton.disabled = busy;
    setMailControlsDisabled(busy);
  }

  function setMailControlsDisabled(disabled) {
    els.notificationGroups
      .querySelectorAll("input, button, select")
      .forEach((control) => {
        control.disabled = disabled;
      });
    els.notificationLegacyGroups.querySelectorAll("select, button").forEach((control) => {
      control.disabled = disabled || (control.tagName === "BUTTON" && !control.parentElement.querySelector("select").value);
    });
  }

  function renderOverview() {
    els.adminOverviewRecords.textContent = `${state.pcns.length} PCN${state.pcns.length === 1 ? "" : "s"}`;
    els.adminOverviewSelected.textContent = state.selected ? state.selected.id : "None";
    els.adminOverviewWorkflow.textContent = state.progress ? titleCase(state.progress.status) : "Waiting";
  }

  function startBusy(action, loadingText, shouldRender = true) {
    refreshGeneration++;
    state.busyAction = action;
    state.loadingText = loadingText;
    state.isLoading = true;

    if (shouldRender) {
      render();
    }
  }

  function stopBusy() {
    state.busyAction = "";
    state.isLoading = false;
    state.loadingText = "";
  }

  function isBusy(action) {
    return state.busyAction === action;
  }

  function isAnyBusy() {
    return Boolean(state.busyAction);
  }

  function showAdminNotice(type, title, message) {
    if (!els.adminNotice || !els.adminNoticeTitle || !els.adminNoticeMessage) {
      return;
    }

    els.adminNotice.hidden = false;
    els.adminNotice.className = `app-notice admin-notice app-notice-${type}`;
    els.adminNoticeTitle.textContent = title;
    els.adminNoticeMessage.textContent = message;
    showAdminToast(type, title, message);
  }

  function showAdminToast(type, title, message) {
    if (!els.adminToastStack) {
      return;
    }

    const toast = document.createElement("div");
    toast.className = `admin-toast admin-toast-${type}`;
    toast.innerHTML = `
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(message)}</span>
    `;
    els.adminToastStack.appendChild(toast);

    window.setTimeout(() => {
      toast.classList.add("is-hiding");
      window.setTimeout(() => toast.remove(), 220);
    }, type === "error" ? 9000 : type === "warning" ? 7000 : 3200);
  }

  function renderProgress() {
    if (!state.selected || !state.progress) {
      els.adminCurrentOwner.textContent = "Select a PCN";
      els.adminNextAction.textContent = "Click a PCN code to see workflow progress.";
      els.adminProgressFill.style.width = "0%";
      els.adminProgressPercent.textContent = "0%";
      els.adminProgressSteps.innerHTML = '<div class="empty-state">No PCN selected.</div>';
      return;
    }

    els.adminCurrentOwner.textContent = state.progress.currentOwner;
    els.adminNextAction.textContent = state.progress.nextAction;
    els.adminProgressFill.style.width = `${state.progress.progressPercent}%`;
    els.adminProgressPercent.textContent = `${state.progress.progressPercent}%`;
    els.adminProgressSteps.innerHTML = "";

    state.progress.steps.forEach((step, index) => {
      const item = document.createElement("article");
      const canAdvance = isAdmin() && step.state === "active" && Boolean(state.progress.nextStatus);
      item.className = `progress-step is-${step.state}${canAdvance ? " is-checkable" : ""}`;
      item.innerHTML = `
        <label class="progress-step-check" aria-label="${escapeHtml(step.title)}">
          <input type="checkbox" ${step.state === "completed" ? "checked" : ""} ${canAdvance ? "" : "disabled"} />
          <span class="progress-step-index">${step.state === "completed" ? "&#10003;" : index + 1}</span>
        </label>
        <div>
          <div class="progress-step-title">${escapeHtml(step.title)}</div>
          <div class="progress-step-copy">${escapeHtml(step.copy)}</div>
        </div>
        <div class="progress-step-owner">
          <span>${escapeHtml(step.owner)}</span>
          <strong>${escapeHtml(titleCase(step.state))}</strong>
        </div>
      `;
      const check = item.querySelector("input[type='checkbox']");

      if (canAdvance) {
        check.addEventListener("change", () => {
          check.checked = false;
          updateSelectedStatus(state.progress.nextStatus);
        });
      }

      els.adminProgressSteps.appendChild(item);
    });
  }

  function renderStatusControl() {
    els.adminStatusControl.hidden = !isAdmin();
    if (!isAdmin()) return;
    els.adminStatusSelect.innerHTML = "";
    els.adminStatusButton.disabled = !state.selected || !state.progress || isAnyBusy();
    els.adminStatusButton.textContent = isBusy("status") ? "Updating..." : "Update Status";
    els.adminStatusSelect.disabled = isAnyBusy();

    if (!state.progress) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Select a PCN first";
      els.adminStatusSelect.appendChild(option);
      return;
    }

    state.progress.availableStatuses.forEach((status) => {
      const option = document.createElement("option");
      option.value = status.value;
      option.textContent = status.label;
      option.selected = status.value === state.progress.status;
      els.adminStatusSelect.appendChild(option);
    });
  }

  function renderAdminView() {
    state.view = permittedView(state.view);
    els.adminMailRoutingButton.hidden = !isAdmin();
    els.adminUsersButton.hidden = !isAdmin();
    els.mailRoutingView.hidden = !isAdmin();
    els.adminUsersView.hidden = !isAdmin();
    const isMailView = state.view === "mail";
    const isRecordsView = state.view === "pcns";
    const isUsersView = state.view === "users";
    els.pcnAdminView.classList.toggle("is-active", isRecordsView);
    els.mailRoutingView.classList.toggle("is-active", isMailView);
    els.adminUsersView.classList.toggle("is-active", isUsersView);
    els.adminRecordsButton.classList.toggle("is-active", isRecordsView);
    els.adminMailRoutingButton.classList.toggle("is-active", isMailView);
    els.adminUsersButton.classList.toggle("is-active", isUsersView);
    setCurrentButton(els.adminRecordsButton, isRecordsView);
    setCurrentButton(els.adminMailRoutingButton, isMailView);
    setCurrentButton(els.adminUsersButton, isUsersView);
    els.adminRefreshButton.hidden = !isRecordsView;
  }

  function setCurrentButton(button, isCurrent) {
    if (isCurrent) {
      button.setAttribute("aria-current", "page");
      return;
    }

    button.removeAttribute("aria-current");
  }

  function setAdminView(view) {
    refreshGeneration++;
    view = permittedView(view);
    const nextHash = view === "mail" ? "#mail-routing" : view === "users" ? "#users" : "#records";

    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
      return;
    }

    state.view = view;
    render();
  }

  function syncViewFromHash() {
    refreshGeneration++;
    const nextView = permittedView(getViewFromHash());

    if (state.view === nextView) {
      return;
    }

    state.view = nextView;
    render();
  }

  function toDetailPayload(record) {
    return {
      id: record.id,
      status: record.status,
      currentOwner: state.progress ? state.progress.currentOwner : undefined,
      nextAction: state.progress ? state.progress.nextAction : undefined,
      riskLevel: record.riskLevel,
      supplierName: record.supplierName,
      manufacturerName: record.manufacturerName,
      materialName: record.materialName,
      selectedChange: record.selectedChange,
      reason: record.reason,
      currentCondition: record.currentCondition,
      newCondition: record.newCondition,
      updatedAt: record.updatedAt,
      internalReview: record.internalReview || {}
    };
  }

  async function apiFetch(path, options = {}) {
    return window.PCN_SESSION.fetch(path, options);
  }

  function formatDate(value) {
    if (!value) {
      return "-";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return date.toLocaleString();
  }

  function titleCase(value) {
    return String(value)
      .split(/[-_ ]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function getViewFromHash() {
    return window.location.hash === "#mail-routing" ? "mail" : window.location.hash === "#users" ? "users" : "pcns";
  }

  function parseEmailList(value) {
    return String(value || "")
      .split(/[;,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();

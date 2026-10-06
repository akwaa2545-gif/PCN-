(function () {
  const state = {
    pcns: [],
    selected: null,
    progress: null,
    notificationSettings: { flowConfigured: false, directoryConfigured: false, groups: [] },
    filters: { search: "", status: "", risk: "" },
    notificationHealth: null,
    healthLoading: false,
    healthUnavailable: false,
    directoryLookupStatus: "Directory lookup not configured",
    hasMailChanges: false,
    view: getViewFromHash(),
    isLoading: true,
    busyAction: "",
    loadingText: "Loading admin data...",
    routingMessage: "Loading routing...",
    message: "Loading records...",
    pendingRemoveRecord: null
  };

  const els = {};
  const directoryLookupTimers = new WeakMap();
  const directoryLookupControllers = new WeakMap();

  document.addEventListener("DOMContentLoaded", init);

  function init() {
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
      "notificationGroups",
      "notificationSaveButton",
      "pcnAdminView",
      "mailRoutingView",
      "adminRecordsButton",
      "adminMailRoutingButton",
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
      "adminOverviewWorkflow"
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
    document.getElementById("signOutButton")?.addEventListener("click", () => window.PCN_SESSION.logout().catch((error) => showAdminNotice("error", "Sign out failed", error.message)));
    checkAdminSession();
  }

  async function checkAdminSession() {
    try {
      const session = await window.PCN_SESSION.require("admin");
      if (!session) return;
      state.user = session.user;
      initializeAdminControls();
      refreshNotificationHealth();
      await loadPcns();
    } catch (error) {
      stopBusy();
      showAdminNotice("error", "Access unavailable", error.message);
    }
  }

  function initializeAdminControls() {
    if (state.controlsInitialized) {
      return;
    }

    state.controlsInitialized = true;
    els.adminRefreshButton.addEventListener("click", () => loadPcns("Records refreshed.", "refresh"));
    els.adminStatusButton.addEventListener("click", updateSelectedStatus);
    els.notificationSaveButton.addEventListener("click", saveNotificationSettings);
    els.notificationHealthRefreshButton.addEventListener("click", refreshNotificationHealth);
    els.adminSearchInput.addEventListener("input", updateTableFilters);
    els.adminStatusFilter.addEventListener("change", updateTableFilters);
    els.adminRiskFilter.addEventListener("change", updateTableFilters);
    els.adminRecordsButton.addEventListener("click", () => setAdminView("pcns"));
    els.adminMailRoutingButton.addEventListener("click", () => setAdminView("mail"));
    window.addEventListener("hashchange", syncViewFromHash);
  }

  async function loadPcns(successMessage, action = "load") {
    startBusy(action, action === "refresh" ? "Refreshing PCN records..." : "Loading admin data...");

    try {
      const [pcns, notificationSettings] = await Promise.all([
        apiFetch("/api/pcns"),
        apiFetch("/api/notification-settings")
      ]);
      state.pcns = pcns;
      state.notificationSettings = notificationSettings;
      state.directoryLookupStatus = notificationSettings.directoryConfigured ? "Directory lookup ready" : "Directory lookup not configured";
      state.selected = state.selected ? state.pcns.find((record) => record.id === state.selected.id) || null : null;
      state.progress = state.selected ? await apiFetch(`/api/pcns/${encodeURIComponent(state.selected.id)}/progress`) : null;
      state.message = successMessage || (state.pcns.length ? "Records loaded from database." : "No PCNs saved.");
      state.routingMessage = notificationSettings.groups.some((group) => String(group.emails || "").trim()) ? "Mail routing loaded." : "Email mapping is empty. Add recipients to enable workflow email.";
      showAdminNotice("success", action === "refresh" ? "Refresh complete" : "Admin ready", state.message);
    } catch (error) {
      state.message = error.message;
      state.routingMessage = error.message;
      state.pcns = [];
      state.selected = null;
      state.progress = null;
      showAdminNotice("error", "Load failed", error.message);
    } finally {
      stopBusy();
    }

    render();
  }

  async function saveNotificationSettings() {
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

    return { groups };
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
      showAdminNotice("success", "Mail routing saved", "Workflow notifications and directory lookup will use the updated settings.");
      return true;
    } catch (error) {
      state.routingMessage = error.message;
      showAdminNotice("error", "Mail save failed", error.message);
      return false;
    } finally {
      stopBusy();
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

    if (!isAnyBusy() && els.notificationSaveButton) {
      els.notificationSaveButton.textContent = "Save Changes";
    }
  }

  async function loadDetail(id) {
    startBusy(`detail:${id}`, `Loading ${id}...`);

    try {
      const encodedId = encodeURIComponent(id);
      const [record, progress] = await Promise.all([
        apiFetch(`/api/pcns/${encodedId}`),
        apiFetch(`/api/pcns/${encodedId}/progress`)
      ]);
      state.selected = record;
      state.progress = progress;
      state.message = `Loaded ${id}.`;
      showAdminNotice("success", "PCN loaded", `${id} is selected for workflow review.`);
    } catch (error) {
      state.message = error.message;
      state.selected = null;
      state.progress = null;
      showAdminNotice("error", "PCN load failed", error.message);
    } finally {
      stopBusy();
    }

    render();
  }

  async function updateSelectedStatus(forcedStatus) {
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
      state.pcns = await apiFetch("/api/pcns");
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
    if (isAnyBusy()) {
      return;
    }

    state.pendingRemoveRecord = record;
    els.adminRemoveCode.textContent = record.id;
    els.adminRemoveMessage.textContent = `${record.supplierName || "This supplier"} / ${record.materialName || "No material name"} will be removed from PCN records.`;
    els.adminRemoveConfirmButton.disabled = false;
    els.adminRemoveConfirmButton.textContent = "Remove PCN";
    els.adminRemoveDialog.hidden = false;
    document.body.classList.add("admin-dialog-open");
    els.adminRemoveCancelButton.focus();
  }

  function closeRemoveDialog(force = false) {
    if (!force && isBusy(`remove:${state.pendingRemoveRecord && state.pendingRemoveRecord.id}`)) {
      return;
    }

    state.pendingRemoveRecord = null;
    els.adminRemoveDialog.hidden = true;
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

  function render() {
    renderAdminView();
    renderLoadingState();
    renderOverview();
    renderTableFilters();
    const visiblePcns = getFilteredPcns();
    els.adminCount.textContent = String(visiblePcns.length);
    els.adminMessage.textContent = state.message;
    els.mailRoutingMessage.textContent = state.routingMessage;
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
            <button class="danger-button" type="button">${isBusy(`remove:${record.id}`) ? "Removing..." : "Remove"}</button>
          </div>
        </td>
      `;

      const viewButton = row.querySelector(".admin-row-button");
      const removeButton = row.querySelector(".danger-button");
      viewButton.disabled = isAnyBusy();
      removeButton.disabled = isAnyBusy();
      viewButton.addEventListener("click", () => loadDetail(record.id));
      removeButton.addEventListener("click", () => requestRemovePcn(record));
      row.addEventListener("click", (event) => {
        if (event.target.closest("a, button")) {
          return;
        }

        loadDetail(record.id);
      });
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          loadDetail(record.id);
        }
      });
      els.adminPcnRows.appendChild(row);
    });

    els.adminDetailStatus.textContent = state.selected ? titleCase(state.selected.status || "draft") : "None";
    els.adminDetailPreview.textContent = state.selected ? JSON.stringify(toDetailPayload(state.selected), null, 2) : "Select a PCN row to view details.";
    renderProgress();
    renderStatusControl();
    renderNotificationSettings();
    renderWebhookSettings();
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
    const actions = ["approved", "checked", "prepared"];

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

    state.notificationSettings.groups.forEach((group) => {
      const card = document.createElement("article");
      const recipients = getNotificationGroupRecipients(group);
      const boxCount = Math.max(recipients.length, 1);
      card.className = "notification-group";
      card.dataset.notificationGroup = group.key;
      card.innerHTML = `
        <div class="notification-group-header">
          <div>
            <span>${escapeHtml(group.label)}</span>
            <small data-recipient-count>${boxCount} email box${boxCount === 1 ? "" : "es"}</small>
          </div>
          <button class="ghost-button notification-add-button" type="button">Add</button>
        </div>
        <div class="notification-person-heading">
          <span>Email address</span>
          <span>Action</span>
        </div>
        <div class="notification-person-list"></div>
        <div class="notification-group-warning" aria-live="polite" hidden></div>
      `;

      const list = card.querySelector(".notification-person-list");
      const editableRecipients = recipients.length ? recipients : [""];
      editableRecipients.forEach((recipient) => appendRecipientRow(list, recipient));
      const addButton = card.querySelector(".notification-add-button");
      addButton.disabled = isAnyBusy();
      addButton.addEventListener("click", () => {
        appendRecipientRow(list, "", true);
        markMailChanged();
        showAdminNotice("info", "Recipient box added", `${group.label} has a new email box.`);
      });
      els.notificationGroups.appendChild(card);
    });
  }

  function appendRecipientRow(list, recipient, shouldFocus = false, isVerified = Boolean(getRecipientEmail(recipient))) {
    const email = getRecipientEmail(recipient);
    const row = document.createElement("div");
    row.className = "notification-person";

    const avatar = document.createElement("span");
    avatar.className = "notification-person-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = getRecipientInitial(email);

    const input = document.createElement("input");
    input.type = "text";
    input.dataset.recipientEmail = "true";
    input.placeholder = isDirectoryLookupConfigured() ? "Search name or email" : "person@example.com";
    input.value = email;
    input.dataset.verifiedEmail = email && isVerified ? email.toLowerCase() : "";
    input.disabled = isAnyBusy();
    input.setAttribute("aria-label", "Recipient email");
    input.setAttribute("autocomplete", "off");
    input.addEventListener("input", () => {
      renderRecipientAvatar(avatar, null, input.value);
      syncRecipientVerificationState(input);
      renderSelectedRecipientMeta(input, null);
      markMailChanged();
      splitRecipientInput(list, input);
      updateRecipientCount(list);
      renderRecipientValidation(list);
      scheduleDirectoryLookup(input);
    });
    input.addEventListener("paste", () => {
      window.setTimeout(() => {
        splitRecipientInput(list, input);
        syncRecipientVerificationState(input);
        scheduleDirectoryLookup(input);
      }, 0);
    });
    input.addEventListener("blur", () => {
      window.setTimeout(() => closeDirectorySuggestions(row), 140);
    });

    const removeButton = document.createElement("button");
    removeButton.className = "danger-button notification-remove-button";
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.disabled = isAnyBusy();
    removeButton.addEventListener("click", () => {
      if (list.querySelectorAll(".notification-person").length === 1) {
        input.value = "";
        input.dataset.verifiedEmail = "";
        renderSelectedRecipientMeta(input, null);
        input.focus();
        markMailChanged();
        updateRecipientCount(list);
        renderRecipientValidation(list);
        showAdminNotice("info", "Recipient cleared", "The last box stays available for a new email.");
        return;
      }

      row.remove();
      markMailChanged();
      updateRecipientCount(list);
      showAdminNotice("info", "Recipient removed", "The email box was removed from this routing group.");
    });

    const suggestions = document.createElement("div");
    suggestions.className = "directory-suggestions";
    suggestions.setAttribute("role", "listbox");
    suggestions.hidden = true;

    const body = document.createElement("div");
    body.className = "notification-person-body";

    const meta = document.createElement("div");
    meta.className = "notification-person-meta";
    meta.hidden = true;

    body.append(input, meta);
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

  async function lookupDirectoryUsers(input, query) {
    const row = input.closest(".notification-person");

    if (!row || !isDirectoryLookupConfigured() || input.value.trim() !== query) {
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
      if (input.value.trim() !== query) return;
      const users = normalizeDirectoryUsers(body).slice(0, 6);
      input.dataset.directoryLookupState = users.length ? "results" : "no-match";
      state.directoryLookupStatus = users.length ? `${users.length} directory result${users.length === 1 ? "" : "s"}` : "No directory match";
      renderDirectorySuggestions(
        row,
        users.length ? users : [{ displayName: "No matching user found", mail: "", isMessage: true }]
      );
      renderRecipientValidation(input.closest(".notification-person-list"));
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }

      state.directoryLookupStatus = "Directory lookup failed";
      input.dataset.directoryLookupState = "failed";
      renderDirectorySuggestions(row, [{ displayName: "Directory lookup failed", mail: error.message, isMessage: true, isError: true }]);
      renderRecipientValidation(input.closest(".notification-person-list"));
    } finally {
      directoryLookupControllers.delete(input);
      syncWebhookControls();
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
    const avatar = row.querySelector(".notification-person-avatar");
    const list = row.closest(".notification-person-list");

    input.value = user.mail;
    input.dataset.verifiedEmail = user.mail.toLowerCase();
    input.dataset.directoryLookupState = "verified";
    input.classList.remove("is-invalid", "is-warning", "is-unverified");
    renderRecipientAvatar(avatar, user.photo, user.displayName || user.mail);
    renderSelectedRecipientMeta(input, user);
    closeDirectorySuggestions(row);
    markMailChanged();
    updateRecipientCount(list);
    renderRecipientValidation(list);
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
    const boxCount = [...list.querySelectorAll("[data-recipient-email]")]
      .filter((input) => input.value.trim())
      .length;

    if (counter) {
      counter.textContent = `${boxCount} recipient${boxCount === 1 ? "" : "s"}`;
    }
  }

  function splitRecipientInput(list, input) {
    const recipients = parseEmailList(input.value);

    if (recipients.length <= 1) {
      renderRecipientValidation(list);
      return;
    }

    input.value = recipients[0];
    syncRecipientVerificationState(input);
    recipients.slice(1).forEach((recipient) => appendRecipientRow(list, recipient, false, false));
    updateRecipientCount(list);
    renderRecipientValidation(list);
  }

  function renderRecipientValidation(list) {
    const card = list.closest("[data-notification-group]");
    const warning = card ? card.querySelector(".notification-group-warning") : null;
    const inputs = [...list.querySelectorAll("[data-recipient-email]")];
    const entries = inputs.map((input) => input.value.trim()).filter(Boolean);
    const emails = entries.filter((entry) => isValidEmail(entry));
    const invalid = entries.find((entry) => !isDirectoryLookupConfigured() && !isValidEmail(entry));
    const duplicate = emails.find((email, index) => emails.findIndex((entry) => entry.toLowerCase() === email.toLowerCase()) !== index);
    const needsDirectoryVerification = isDirectoryLookupConfigured();
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

    if (emails.length === 0) {
      warning.hidden = false;
      warning.className = "notification-group-warning";
      warning.textContent = "No recipients configured for this group.";
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
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
    setMailControlsDisabled(busy);
  }

  function setMailControlsDisabled(disabled) {
    els.notificationGroups
      .querySelectorAll("input, button")
      .forEach((control) => {
        control.disabled = disabled;
      });
  }

  function renderOverview() {
    els.adminOverviewRecords.textContent = `${state.pcns.length} PCN${state.pcns.length === 1 ? "" : "s"}`;
    els.adminOverviewSelected.textContent = state.selected ? state.selected.id : "None";
    els.adminOverviewWorkflow.textContent = state.progress ? titleCase(state.progress.status) : "Waiting";
  }

  function startBusy(action, loadingText, shouldRender = true) {
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
    }, type === "error" ? 5200 : 3200);
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
      const canAdvance = step.state === "active" && Boolean(state.progress.nextStatus);
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
    const isMailView = state.view === "mail";
    els.pcnAdminView.classList.toggle("is-active", !isMailView);
    els.mailRoutingView.classList.toggle("is-active", isMailView);
    els.adminRecordsButton.classList.toggle("is-active", !isMailView);
    els.adminMailRoutingButton.classList.toggle("is-active", isMailView);
    setCurrentButton(els.adminRecordsButton, !isMailView);
    setCurrentButton(els.adminMailRoutingButton, isMailView);
    els.adminRefreshButton.hidden = isMailView;
  }

  function setCurrentButton(button, isCurrent) {
    if (isCurrent) {
      button.setAttribute("aria-current", "page");
      return;
    }

    button.removeAttribute("aria-current");
  }

  function setAdminView(view) {
    const nextHash = view === "mail" ? "#mail-routing" : "#records";

    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
      return;
    }

    state.view = view;
    render();
  }

  function syncViewFromHash() {
    const nextView = getViewFromHash();

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
    return window.location.hash === "#mail-routing" ? "mail" : "pcns";
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

(function () {
  const demoRequest = {
    status: "submitted",
    changeForm: "rawMaterial",
    riskLevel: "RL2",
    selectedChange: "Change of specification for a raw material that is outside of the current M-Spec",
    supplierName: "Demo Supplier Co., Ltd.",
    manufacturerName: "A.C.O. / Zhenjiang KAWACHO",
    materialName: "Copper alloy strip CA-204",
    desiredStart: "Lot 26A-0715",
    sampleSubmitted: "yes",
    currentCondition: "Current material follows existing M-Spec revision and approved supplier production location.",
    newCondition: "Supplier proposes tightened material tolerance and revised inspection certificate format.",
    reason: "Stabilize incoming quality and reduce lot-to-lot variation before mass production transfer.",
    identification: "Supplier will mark first three changed lots with revised certificate revision and lot suffix -N.",
    sampleLocation: "Chonburi pilot line",
    priceLevel: "no-change",
    internalReview: {
      materialCodeDescription: "",
      pcnCode: "",
      supplierSignoff: {
        approved: { checked: false, date: "" },
        checked: { checked: false, date: "" },
        prepared: { checked: false, date: "" }
      },
      docs: {
        hazardousReport: false,
        greenProcurement: false,
        qmsEmsCertificate: false,
        supplierDocument: false,
        supplierDocumentNote: "",
        otherRequirement: false,
        otherRequirementNote: ""
      },
      decision: {
        agreed: false,
        agreedAfterQualification: false,
        qualificationDue: "",
        rejected: false,
        rejectReason: ""
      },
      signoff: {
        gscTet: defaultSignoff(),
        prodEngTet: defaultSignoff(),
        qaTet: defaultSignoff()
      },
      tapbu: {
        need: false,
        noNeed: false,
        gsc: defaultSignoff(),
        qa: defaultSignoff(),
        comment: ""
      }
    },
    changeRows: [
      {
        risk: "RL2",
        text: "Change of specification for a raw material that is outside of the current M-Spec",
        currentCondition: "Current material follows existing M-Spec revision and approved supplier production location.",
        newCondition: "Supplier proposes tightened material tolerance and revised inspection certificate format."
      }
    ]
  };

  const state = {
    formDefinitions: {},
    commonDocuments: [],
    workflowBase: [],
    statusDefinitions: [],
    adminItems: [],
    pcns: [],
    activeRequest: { ...demoRequest },
    pendingWorkflowNotifications: new Set(),
    viewOnly: false,
    apiReady: false,
    message: "Connecting to backend..."
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheElements();
    bindEvents();
    try {
      const session = await window.PCN_SESSION.require();
      if (!session) return;
      state.user = session.user;
      state.viewOnly = session.user?.identityProvider === 'employee-code' && !session.user?.roles?.length;
      if (state.viewOnly) {
        window.location.assign('/records');
        return;
      }
      window.PCN_SESSION.mountProfile(session.user, (error) => showNotice("error", "Sign out failed", error.message));
      await loadFromApi();
      renderAll();
    } catch (error) {
      showNotice("error", "Unable to load portal", error.message);
    } finally {
      document.body.classList.remove("is-loading");
    }
  }

  function cacheElements() {
    [
      "changeForm",
      "riskLevel",
      "supplierName",
      "manufacturerName",
      "materialName",
      "desiredStart",
      "sampleSubmitted",
      "reason",
      "identification",
      "sampleLocation",
      "priceLevel",
      "changeOptions",
      "sourcePill",
      "summaryList",
      "documentList",
      "payloadPreview",
      "statusBadge",
      "queueList",
      "queueCount",
      "workflowSteps",
      "adminGrid",
      "loadDemoButton",
      "submitButton",
      "appNotice",
      "appNoticeTitle",
      "appNoticeMessage",
      "appToastStack",
      "pcnSaveOverlay"
    ].forEach((id) => {
      els[id] = document.getElementById(id);
    });
  }

  function bindEvents() {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => switchView(tab.dataset.view));
    });

    [
      "changeForm",
      "riskLevel",
      "supplierName",
      "manufacturerName",
      "materialName",
      "desiredStart",
      "sampleSubmitted",
      "reason",
      "identification",
      "sampleLocation",
      "priceLevel"
    ].forEach((id) => {
      els[id].addEventListener("input", () => {
        updateStateFromForm();
        renderAll();
      });
    });

    els.loadDemoButton.addEventListener("click", () => {
      state.activeRequest = createNewRequest();
      loadRequestToForm(state.activeRequest);
      state.message = "Demo values loaded. Submit to create a new PCN id.";
      showNotice("info", "Demo loaded", "Review the values, then submit to generate a new PCN code.");
      renderAll();
    });

    els.submitButton.addEventListener("click", submitActiveRequest);

    document.querySelectorAll('input[name="sampleSubmittedChoice"]').forEach((control) => {
      control.addEventListener("change", () => {
        els.sampleSubmitted.value = control.value;
        updateStateFromForm();
        renderAll();
      });
    });

    document.querySelectorAll('input[name="sampleSubmittedChoice"]').forEach((control) => {
      const label = control.closest("label");

      if (!label) {
        return;
      }

      label.addEventListener("click", () => {
        control.checked = true;
        control.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });

    document.querySelectorAll('input[name="priceLevelChoice"]').forEach((control) => {
      control.addEventListener("change", () => {
        els.priceLevel.value = control.value;
        updateStateFromForm();
        renderAll();
      });
    });

    document.querySelectorAll('input[name="priceLevelChoice"]').forEach((control) => {
      const label = control.closest("label");

      if (!label) {
        return;
      }

      label.addEventListener("click", () => {
        control.checked = true;
        control.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });

    document.querySelectorAll(".internal-field, .internal-check").forEach((control) => {
      control.addEventListener("input", () => {
        updateInternalReviewFromForm();
        renderSummary();
        renderPayload();
      });
      control.addEventListener("change", () => {
        if (!guardApprovalCheck(control)) {
          return;
        }
        syncExclusiveChecks(control);
        updateInternalReviewFromForm();
        updateApprovalCheckLocks();
        queueWorkflowNotification(control);
        renderSummary();
        renderPayload();
      });

      if (control.classList.contains("internal-check")) {
        const label = control.closest("label");

        if (label) {
          label.addEventListener("click", (event) => {
            if (!control.disabled) {
              return;
            }

            const rule = getApprovalLockRule(control.dataset.internalField);
            showNotice("warning", "Approval step locked", rule.reason || "Complete the previous approval step first.");
            event.preventDefault();
          });
        }
      }
    });
  }

  async function loadFromApi() {
    try {
      const master = await apiFetch("/api/master-data");
      state.formDefinitions = master.formDefinitions;
      state.commonDocuments = master.commonDocuments;
      state.workflowBase = master.workflowBase;
      state.statusDefinitions = master.statusDefinitions || [];
      state.adminItems = master.adminItems || [];
      populateSelectors();
      state.pcns = await apiFetch("/api/pcns");
      const routePcnId = getPcnIdFromPath();
      if (routePcnId) {
        state.activeRequest = await apiFetch(`/api/pcns/${encodeURIComponent(routePcnId)}`);
        state.message = state.viewOnly ? `Viewing ${routePcnId}. This account has read-only access.` : `Loaded ${routePcnId}. Changes will update this PCN.`;
        showNotice("success", "PCN loaded", state.message);
      } else {
        state.activeRequest = createNewRequest();
        state.message = "Database is ready. Submit to create a new PCN.";
        showNotice("info", "Create PCN", "Fill the form and submit to generate a PCN code.");
      }
      state.apiReady = true;
      loadRequestToForm(state.activeRequest);
    } catch (error) {
      state.apiReady = false;
      state.message = error.message;
      els.submitButton.disabled = true;
      showNotice("error", "Unable to load PCN data", error.message);
    }
  }

  function createNewRequest() {
    const request = structuredCloneSafe(demoRequest);
    return {
      ...request,
      supplierName: '', manufacturerName: '', materialName: '', desiredStart: '',
      sampleSubmitted: 'pending', currentCondition: '', newCondition: '', reason: '',
      identification: '', sampleLocation: '',
      changeRows: request.changeRows.map(row => ({...row,currentCondition:'',newCondition:''})),
      internalReview: {...request.internalReview,pcnCode:''}
    };
  }

  function getPcnIdFromPath() {
    const queryId = new URLSearchParams(window.location.search).get("id");
    const raw = String(queryId || decodeURIComponent(window.location.pathname)).replace(/^\/+/, "").trim();
    const match = raw.match(/^P(?:CN|NC)-(\d{4})-(\d{3,4})$/i);

    if (!match) {
      return "";
    }

    return `PCN-${match[1]}-${match[2].padStart(4, "0")}`;
  }

  async function apiFetch(path, options = {}) {
    if (state.viewOnly && !['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase())) {
      throw new Error('A PCN role is required to change records.');
    }
    return window.PCN_SESSION.fetch(path, options);
  }

  function populateSelectors() {
    const currentForm = els.changeForm.value;
    const currentRisk = els.riskLevel.value;
    els.changeForm.innerHTML = "";
    els.riskLevel.innerHTML = "";

    Object.values(state.formDefinitions).forEach((definition) => {
      const option = document.createElement("option");
      option.value = definition.id;
      option.textContent = definition.label;
      els.changeForm.appendChild(option);
    });

    ["RL3", "RL2", "RL1", "RL0"].forEach((risk) => {
      const option = document.createElement("option");
      option.value = risk;
      option.textContent = risk;
      els.riskLevel.appendChild(option);
    });

    if (currentForm) {
      els.changeForm.value = currentForm;
    }

    if (currentRisk) {
      els.riskLevel.value = currentRisk;
    }
  }

  function switchView(viewName) {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab.dataset.view === viewName);
    });
    document.querySelectorAll(".view").forEach((view) => {
      view.classList.toggle("is-active", view.id === `${viewName}View`);
    });
  }

  function loadRequestToForm(request) {
    Object.entries(request).forEach(([key, value]) => {
      if (els[key]) {
        els[key].value = value || "";
      }
    });

    if (!els.changeForm.value) {
      els.changeForm.value = Object.keys(state.formDefinitions)[0] || "";
    }

    renderChangeOptions();
    syncSupplierDetailControls(request);
    applyInternalReviewToForm(request.internalReview || {});
  }

  function updateStateFromForm() {
    syncHiddenDetailValues();
    const selectedInput = document.querySelector("input[name='changeOption']:checked");
    const selectedChange = getSelectedChangeText(selectedInput);
    const selectedRow = selectedInput ? getSelectedChangeRow() : {
      currentCondition: "",
      newCondition: ""
    };
    state.activeRequest = {
      ...state.activeRequest,
      changeForm: els.changeForm.value,
      riskLevel: els.riskLevel.value,
      selectedChange,
      supplierName: els.supplierName.value.trim(),
      manufacturerName: els.manufacturerName.value.trim(),
      materialName: els.materialName.value.trim(),
      desiredStart: els.desiredStart.value.trim(),
      sampleSubmitted: els.sampleSubmitted.value,
      changeRows: getVisibleChangeRowsFromState(),
      currentCondition: selectedRow.currentCondition,
      newCondition: selectedRow.newCondition,
      reason: els.reason.value.trim(),
      identification: els.identification.value.trim(),
      sampleLocation: els.sampleLocation.value.trim(),
      priceLevel: els.priceLevel.value,
      internalReview: collectInternalReviewFromForm(),
      status: state.activeRequest.status || "submitted"
    };
  }

  async function submitActiveRequest() {
    updateStateFromForm();

    if (!state.apiReady) {
      state.message = "Cannot save until the PCN data has loaded from the server. Refresh the page and try again.";
      showNotice("error", "Save failed", state.message);
      renderAll();
      return;
    }

    try {
      els.submitButton.disabled = true;
      document.body.classList.add("is-saving");
      setSaveOverlayVisible(true);
      els.submitButton.textContent = "Saving...";
      showNotice("info", "Saving PCN", "Please wait while the record is saved.");
      const hasDatabaseId = /^PCN-\d{4}-\d{4}$/.test(String(state.activeRequest.id || ""));
      const path = hasDatabaseId ? `/api/pcns/${state.activeRequest.id}` : "/api/pcns";
      const method = hasDatabaseId ? "PATCH" : "POST";
      const saved = await apiFetch(path, {
        method,
        body: JSON.stringify(toApiPayload(state.activeRequest))
      });

      let mailMessage = "";
      let mailWarning = "";

      try {
        mailMessage = await sendPendingWorkflowNotifications(saved) || "";
      } catch (mailError) {
        mailWarning = getWorkflowNotificationWarning(mailError);
      }

      await refreshPcns(saved.id);
      state.message = `${hasDatabaseId ? `Updated ${saved.id}.` : `Auto-generated PCN code ${saved.id}.`}${mailMessage}`;
      showNotice("success", hasDatabaseId ? "PCN updated" : "PCN created", state.message);

      if (mailWarning) {
        showToast("warning", "Workflow email not sent", mailWarning);
      }
    } catch (error) {
      state.message = error.message;
      showNotice("error", "Save failed", error.message);
    } finally {
      els.submitButton.disabled = false;
      document.body.classList.remove("is-saving");
      setSaveOverlayVisible(false);
    }

    renderAll();
  }

  function setSaveOverlayVisible(isVisible) {
    if (!els.pcnSaveOverlay) {
      return;
    }

    els.pcnSaveOverlay.hidden = !isVisible;
  }

  function getWorkflowNotificationWarning(error) {
    const message = error && error.message ? error.message : "Email service is unavailable.";

    return `PCN was saved. Workflow email was not sent: ${message}`;
  }

  function toApiPayload(request) {
    const internalReview = {
      ...(request.internalReview || {}),
      pcnCode: request.id || ""
    };

    return {
      ...(request.version ? { version: request.version } : {}),
      status: request.status || "submitted",
      changeForm: request.changeForm,
      riskLevel: request.riskLevel,
      selectedChange: request.selectedChange,
      supplierName: request.supplierName,
      manufacturerName: request.manufacturerName,
      materialName: request.materialName,
      desiredStart: request.desiredStart,
      sampleSubmitted: request.sampleSubmitted,
      currentCondition: request.currentCondition,
      newCondition: request.newCondition,
      changeRows: request.changeRows || [],
      reason: request.reason,
      identification: request.identification,
      sampleLocation: request.sampleLocation,
      priceLevel: request.priceLevel,
      internalReview
    };
  }

  async function refreshPcns(activeId) {
    state.pcns = await apiFetch("/api/pcns");
    state.activeRequest = state.pcns.find((record) => record.id === activeId) || state.pcns[0] || { ...demoRequest };
    loadRequestToForm(state.activeRequest);
  }

  function renderAll() {
    renderChangeOptions();
    renderSummary();
    renderDocuments();
    renderPayload();
    if (els.queueList && els.queueCount) {
      renderQueue();
    }
    renderWorkflow();
    if (els.adminGrid) {
      renderAdmin();
    }
    updateApprovalCheckLocks();
    if (state.viewOnly) applyViewOnly();
  }

  function applyViewOnly() {
    document.body.classList.add('is-view-only');
    els.loadDemoButton.hidden = true;
    els.submitButton.hidden = true;
    const adminLink = document.getElementById('formAdminLink');
    if (adminLink) adminLink.hidden = true;
    document.querySelectorAll('main input, main select, main textarea').forEach((control) => { control.disabled = true; });
  }

  function getActiveDefinition() {
    return state.formDefinitions[els.changeForm.value] || Object.values(state.formDefinitions)[0];
  }

  function renderChangeOptions() {
    const definition = getActiveDefinition();

    if (!definition) {
      return;
    }

    els.sourcePill.textContent = definition.sheet;
    const options = definition.riskOptions;
    els.changeOptions.innerHTML = "";

    if (options.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No change item is listed for this risk level in the selected Excel form.";
      els.changeOptions.appendChild(empty);
      state.activeRequest.selectedChange = "";
      return;
    }

    state.activeRequest.changeRows = buildVisibleChangeRows(options);
    let selectedOptionKey = getSelectedOptionKey();
    const selectedOption = options.find((option) => option.text === selectedOptionKey);
    const selectedRisk = els.riskLevel.value;

    if (selectedOptionKey && (!selectedOption || selectedOption.risk !== selectedRisk)) {
      const firstForRisk = options.find((option) => option.risk === selectedRisk) || options[0];
      const firstRow = state.activeRequest.changeRows.find((row) => row.optionText === firstForRisk.text);
      state.activeRequest.selectedChange = firstRow ? firstRow.text : firstForRisk.text;
      els.riskLevel.value = firstForRisk.risk;
      selectedOptionKey = firstForRisk.text;
    }

    const hasSelectedOption = options.some((option) => option.text === selectedOptionKey);
    const header = document.createElement("div");
    header.className = "option-header";
    header.innerHTML = `
      <span>Risk level</span>
      <span>Content of Changes <em>${escapeHtml(getFormSubject(definition))}</em></span>
      <span>Current condition</span>
      <span>New condition</span>
    `;
    els.changeOptions.appendChild(header);

    let previousRisk = "";

    options.forEach((option, index) => {
      const rowState = state.activeRequest.changeRows.find((item) => item.optionText === option.text) || {
        text: option.text,
        currentCondition: "",
        newCondition: ""
      };
      const row = document.createElement("div");
      const isFirstInRisk = option.risk !== previousRisk;
      const isLastInRisk = options[index + 1] ? options[index + 1].risk !== option.risk : true;
      row.className = [
        "option-row",
        isFirstInRisk ? "is-risk-start" : "",
        isLastInRisk ? "is-risk-end" : ""
      ]
        .filter(Boolean)
        .join(" ");

      const risk = document.createElement("span");
      risk.className = `risk-chip risk-${option.risk.toLowerCase()}`;
      risk.textContent = isFirstInRisk ? option.risk : "";

      const check = document.createElement("input");
      check.type = "checkbox";
      check.name = "changeOption";
      check.value = option.text;
      check.checked = hasSelectedOption && selectedOptionKey === option.text;
      check.addEventListener("change", () => {
        if (check.checked) {
          selectChangeOption(check, option);
        } else {
          clearChangeSelection();
        }

        renderAll();
      });

      const copy = document.createElement("textarea");
      copy.className = `${getOptionCopyClass(definition, option, index)} option-change-textarea`;
      copy.value = rowState.text || option.text;
      copy.rows = 2;
      copy.setAttribute("aria-label", `Content of changes for ${option.risk}`);
      copy.addEventListener("input", () => {
        updateChangeRow(option, "text", copy.value);
      });
      copy.addEventListener("focus", () => {
        if (!check.checked) {
          selectChangeOption(check, option);
        }
      });

      const contentCell = document.createElement("div");
      contentCell.className = "option-content-cell";
      contentCell.append(check, copy);

      const currentCell = createConditionCell(option, "currentCondition", rowState.currentCondition, "Current condition");
      const newCell = createConditionCell(option, "newCondition", rowState.newCondition, "New condition");

      row.append(risk, contentCell, currentCell, newCell);
      els.changeOptions.appendChild(row);
      previousRisk = option.risk;
    });

    const checked = document.querySelector("input[name='changeOption']:checked");
    const checkedRow = checked ? state.activeRequest.changeRows.find((row) => row.optionText === checked.value) : null;
    state.activeRequest.selectedChange = checkedRow ? checkedRow.text : "";
    const selectedRow = getSelectedChangeRow();
    state.activeRequest.currentCondition = selectedRow.currentCondition;
    state.activeRequest.newCondition = selectedRow.newCondition;
  }

  function selectChangeOption(input, option) {
    document.querySelectorAll("input[name='changeOption']").forEach((control) => {
      control.checked = control === input;
    });
    els.riskLevel.value = option.risk;
    updateStateFromForm();
  }

  function clearChangeSelection() {
    document.querySelectorAll("input[name='changeOption']").forEach((control) => {
      control.checked = false;
    });
    state.activeRequest = {
      ...state.activeRequest,
      selectedChange: "",
      currentCondition: "",
      newCondition: ""
    };
    renderSummary();
    renderPayload();
  }

  function createConditionCell(option, field, value, label) {
    const cell = document.createElement("label");
    cell.className = "option-condition-cell";

    const caption = document.createElement("span");
    caption.className = "option-condition-label";
    caption.textContent = label;

    const textarea = document.createElement("textarea");
    textarea.value = value || "";
    textarea.rows = 2;
    textarea.addEventListener("input", () => {
      updateChangeRow(option, field, textarea.value);
    });
    textarea.addEventListener("focus", () => {
      const check = document.querySelector(`input[name='changeOption'][value="${cssEscape(option.text)}"]`);

      if (check && !check.checked) {
        selectChangeOption(check, option);
      }
    });

    cell.append(caption, textarea);
    return cell;
  }

  function buildVisibleChangeRows(options) {
    const existingRows = Array.isArray(state.activeRequest.changeRows) ? state.activeRequest.changeRows : [];

    return options.map((option) => {
      const existing = existingRows.find((row) => getChangeRowOptionText(row) === option.text);
      const isSelected = getSelectedOptionKey() === option.text;

      return {
        risk: option.risk,
        optionText: option.text,
        text: existing ? existing.text || option.text : option.text,
        currentCondition: existing ? existing.currentCondition || "" : isSelected ? state.activeRequest.currentCondition || "" : "",
        newCondition: existing ? existing.newCondition || "" : isSelected ? state.activeRequest.newCondition || "" : ""
      };
    });
  }

  function updateChangeRow(option, field, value) {
    const rows = getVisibleChangeRowsFromState().map((row) => {
      if (row.optionText !== option.text) {
        return row;
      }

      return {
        ...row,
        [field]: value
      };
    });

    state.activeRequest = {
      ...state.activeRequest,
      changeRows: rows
    };

    const selectedRadio = document.querySelector("input[name='changeOption']:checked");

    if (selectedRadio && selectedRadio.value === option.text) {
      const selectedRow = rows.find((row) => row.optionText === option.text);
      state.activeRequest.selectedChange = selectedRow.text;
      state.activeRequest.currentCondition = selectedRow.currentCondition;
      state.activeRequest.newCondition = selectedRow.newCondition;
    }

    renderSummary();
    renderPayload();
  }

  function getVisibleChangeRowsFromState() {
    const definition = getActiveDefinition();

    if (!definition) {
      return [];
    }

    return buildVisibleChangeRows(definition.riskOptions);
  }

  function getSelectedChangeRow() {
    const rows = getVisibleChangeRowsFromState();
    const checked = document.querySelector("input[name='changeOption']:checked");

    if (checked) {
      return rows.find((row) => row.optionText === checked.value) || {
        currentCondition: "",
        newCondition: ""
      };
    }

    return rows.find((row) => row.text === state.activeRequest.selectedChange) || {
      currentCondition: "",
      newCondition: ""
    };
  }

  function getSelectedChangeText(selectedInput) {
    if (!selectedInput) {
      return "";
    }

    const row = getVisibleChangeRowsFromState().find((item) => item.optionText === selectedInput.value);
    return row ? row.text : selectedInput.value;
  }

  function getSelectedOptionKey() {
    const rows = Array.isArray(state.activeRequest.changeRows) ? state.activeRequest.changeRows : [];
    const selectedRow = rows.find((row) => row.text === state.activeRequest.selectedChange);

    if (selectedRow) {
      return getChangeRowOptionText(selectedRow);
    }

    return state.activeRequest.selectedChange;
  }

  function getChangeRowOptionText(row) {
    return row.optionText || row.originalText || row.text;
  }

  function getFormSubject(definition) {
    return definition.id === "packaging" ? "for Packaging" : "for Raw Material";
  }

  function getOptionCopyClass(definition, option, index) {
    const isBlueException = definition.id === "rawMaterial" && option.risk === "RL3" && index < 2;
    return `option-copy${isBlueException ? " option-copy-blue" : ""}`;
  }

  function formatChangeText(definition, text) {
    if (text === "Other") {
      return 'Other (&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;)';
    }

    if (definition.id !== "rawMaterial") {
      return escapeHtml(text);
    }

    return escapeHtml(text)
      .replace(/product/g, '<span class="red-text">product</span>')
      .replace(/cobalt/g, '<span class="red-text">cobalt</span>')
      .replace(/mica/g, '<span class="red-text">mica</span>')
      .replace(/tantalum, tin, tungsten, or gold/g, "tantalum, tin, tungsten, or gold");
  }

  function renderSummary() {
    const request = state.activeRequest;
    const definition = state.formDefinitions[request.changeForm] || getActiveDefinition() || {};
    const rows = [
      ["PCN ID", request.id || "New record"],
      ["Database", state.apiReady ? "Connected" : "Offline"],
      ["Form", definition.label || "-"],
      ["Risk", request.riskLevel || "-"],
      ["Supplier", request.supplierName || "-"],
      ["Manufacturer", request.manufacturerName || "-"],
      ["Material", request.materialName || "-"],
      ["Change", request.selectedChange || "-"],
      ["Current condition", request.currentCondition || "-"],
      ["New condition", request.newCondition || "-"],
      ["Target", request.desiredStart || "-"],
      ["Sample", titleCase(request.sampleSubmitted || "-")],
      ["Message", state.message]
    ];

    els.submitButton.textContent = request.id ? "Update PCN" : "Submit PCN";
    els.submitButton.classList.toggle("is-important-update", Boolean(request.id));
    els.statusBadge.textContent = titleCase(request.status || "draft");
    els.summaryList.innerHTML = "";

    rows.forEach(([term, description]) => {
      const wrap = document.createElement("div");
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = term;
      dd.textContent = description;
      wrap.append(dt, dd);
      els.summaryList.appendChild(wrap);
    });
  }

  function renderDocuments() {
    const documents = state.activeRequest.documents || state.commonDocuments.map((name) => ({ name, uploaded: false }));
    els.documentList.innerHTML = "";

    documents.forEach((documentRecord) => {
      const item = document.createElement("li");
      item.textContent = `${documentRecord.name}${documentRecord.uploaded ? " - uploaded" : ""}`;
      els.documentList.appendChild(item);
    });
  }

  function renderPayload() {
    const request = state.activeRequest;
    const definition = state.formDefinitions[request.changeForm] || getActiveDefinition() || {};
    const payload = {
      id: request.id || null,
      status: request.status || "submitted",
      sourceTemplate: definition.sheet,
      changeType: definition.changeHeading,
      riskLevel: request.riskLevel,
      selectedChange: request.selectedChange,
      supplier: {
        name: request.supplierName,
        manufacturerName: request.manufacturerName,
        materialName: request.materialName
      },
      changeDetails: {
        currentCondition: request.currentCondition,
        newCondition: request.newCondition,
        changeRows: request.changeRows || [],
        reason: request.reason,
        desiredStart: request.desiredStart,
        identification: request.identification,
        sampleSubmitted: request.sampleSubmitted,
        sampleLocation: request.sampleLocation,
        priceLevel: request.priceLevel
      },
      internalReview: request.internalReview || {},
      databasePath: request.id ? `pcnRequests.${request.id}` : "new pcnRequests entry"
    };
    els.payloadPreview.textContent = JSON.stringify(payload, null, 2);
  }

  function renderQueue() {
    if (!els.queueList || !els.queueCount) {
      return;
    }

    els.queueCount.textContent = String(state.pcns.length);
    els.queueList.innerHTML = "";

    if (state.pcns.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No PCNs saved yet.";
      els.queueList.appendChild(empty);
      return;
    }

    state.pcns.forEach((record) => {
      const button = document.createElement("button");
      button.className = `queue-item${record.id === state.activeRequest.id ? " is-active" : ""}`;
      button.type = "button";
      button.innerHTML = `
        <div class="queue-title">
          <span>${escapeHtml(record.id)}</span>
          <span>${escapeHtml(record.riskLevel)}</span>
        </div>
        <div class="queue-meta">${escapeHtml(record.supplierName || "Unassigned supplier")}</div>
        <div class="queue-meta">${escapeHtml(record.materialName || "No material entered")}</div>
      `;
      button.addEventListener("click", async () => {
        try {
          state.activeRequest = await apiFetch(`/api/pcns/${record.id}`);
          state.message = `Loaded ${record.id} from database.`;
          loadRequestToForm(state.activeRequest);
          showNotice("success", "PCN loaded", state.viewOnly ? `${record.id} is available to view.` : `${record.id} is ready for editing.`);
        } catch (error) {
          state.message = error.message;
          showNotice("error", "Load failed", error.message);
        }
        renderAll();
      });
      els.queueList.appendChild(button);
    });
  }

  function renderWorkflow() {
    const progress = buildWorkflowProgressClient(state.activeRequest);
    const steps = progress.steps;
    els.workflowSteps.innerHTML = "";

    steps.forEach((step, index) => {
      const item = document.createElement("article");
      const isCompleted = step.state === "completed";
      const isActive = step.state === "active";
      const canAdvance = Boolean(state.activeRequest.id && progress.nextStatus && isActive);
      const lockedText = state.activeRequest.id
        ? "Complete previous step first"
        : "Save PCN before tracking";
      item.className = `workflow-step is-${step.state}${canAdvance ? " is-checkable" : ""}`;
      item.innerHTML = `
        <label class="workflow-check" aria-label="${escapeHtml(step.title)}">
          <input type="checkbox" ${isCompleted ? "checked" : ""} ${canAdvance ? "" : "disabled"} />
          <span>${isCompleted ? "&#10003;" : index + 1}</span>
        </label>
        <div>
          <div class="step-title">${escapeHtml(step.title)}</div>
          <div class="step-copy">${escapeHtml(step.copy)}</div>
        </div>
        <div class="step-owner">
          <span>${escapeHtml(step.owner)}</span>
          <strong>${escapeHtml(isActive ? "Current" : titleCase(step.state))}</strong>
        </div>
      `;
      const check = item.querySelector("input[type='checkbox']");

      if (canAdvance) {
        check.addEventListener("change", () => {
          check.checked = false;
          advanceWorkflowStep(progress.nextStatus);
        });
      } else if (!isCompleted) {
        item.title = lockedText;
        item.addEventListener("click", () => {
          showNotice("warning", "Step locked", lockedText);
        });
      }

      els.workflowSteps.appendChild(item);
    });
  }

  async function advanceWorkflowStep(nextStatus) {
    if (!state.activeRequest.id || !nextStatus) {
      showNotice("warning", "Tracking unavailable", "Save the PCN before marking workflow steps complete.");
      return;
    }

    try {
      showNotice("info", "Updating workflow", `Moving PCN to ${titleCase(nextStatus)}.`);
      state.activeRequest = await apiFetch(`/api/pcns/${encodeURIComponent(state.activeRequest.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus, version: state.activeRequest.version })
      });
      const notificationStatus = state.activeRequest.notification ? await sendPendingWorkflowNotifications(state.activeRequest) : "";
      await refreshPcns(state.activeRequest.id);
      showNotice("success", "Workflow updated", `Current status is ${titleCase(state.activeRequest.status)}.${notificationStatus}`);
    } catch (error) {
      showNotice("error", "Workflow update failed", error.message);
    }

    renderAll();
  }

  function buildWorkflowProgressClient(request) {
    const status = request.status || "draft";
    const definition = getStatusDefinition(status);
    const steps = buildWorkflow(request.riskLevel);
    const activeKey = resolveActiveStepKey(definition.activeStep, steps);
    const activeIndex = Math.max(
      steps.findIndex((step) => step.key === activeKey),
      0
    );
    const isTerminal = Boolean(definition.terminal);
    const progressSteps = steps.map((step, index) => ({
      ...step,
      state: getWorkflowStepState(index, activeIndex, isTerminal)
    }));

    return {
      steps: progressSteps,
      nextStatus: getPrimaryNextStatus(request, steps, activeIndex, isTerminal)
    };
  }

  function getStatusDefinition(status) {
    return (state.statusDefinitions || []).find((definition) => definition.status === status) || {
      status: "draft",
      label: "Draft",
      activeStep: "supplier_submission"
    };
  }

  function resolveActiveStepKey(activeStep, steps) {
    if (steps.some((step) => step.key === activeStep)) {
      return activeStep;
    }

    if (activeStep === "tapbu_approval") {
      return "qualification";
    }

    return activeStep;
  }

  function getWorkflowStepState(index, activeIndex, isTerminal) {
    if (isTerminal || index < activeIndex) {
      return "completed";
    }

    if (index === activeIndex) {
      return "active";
    }

    return "pending";
  }

  function getPrimaryNextStatus(request, steps, activeIndex, isTerminal) {
    if (isTerminal) {
      return "";
    }

    const status = request.status || "draft";
    const nextStep = steps[activeIndex + 1];

    if (status === "draft" || status === "supplier_action") {
      return "submitted";
    }

    if (status === "submitted") {
      return "gsc_review";
    }

    if (status === "gsc_review") {
      return "technical_review";
    }

    if (!nextStep || nextStep.key === "final_judgment") {
      return "approved";
    }

    return getStatusesForStep(nextStep.key)[0] || "";
  }

  function getStatusesForStep(stepKey) {
    return (state.statusDefinitions || [])
      .filter((definition) => definition.activeStep === stepKey && !definition.terminal)
      .map((definition) => definition.status);
  }

  function buildWorkflow(riskLevel) {
    const steps = state.workflowBase || [];

    if (riskLevel === "RL0") {
      return steps.filter((step) => step.title !== "TaPBU approval gate");
    }

    return steps;
  }

  function renderAdmin() {
    if (!els.adminGrid) {
      return;
    }

    els.adminGrid.innerHTML = "";
    state.adminItems.forEach((item) => {
      const card = document.createElement("article");
      card.className = "admin-item";
      card.innerHTML = `
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.copy)}</p>
        <span class="admin-status">${escapeHtml(item.status)}</span>
      `;
      els.adminGrid.appendChild(card);
    });
  }

  function titleCase(value) {
    return String(value)
      .split(/[-_ ]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }

    return String(value).replace(/["\\]/g, "\\$&");
  }

  function defaultSignoff() {
    return {
      approved: false,
      checked: false,
      prepared: false,
      date: "",
      comment: ""
    };
  }

  function collectInternalReviewFromForm() {
    const review = structuredCloneSafe(state.activeRequest.internalReview || {});

    document.querySelectorAll(".internal-field").forEach((control) => {
      setByPath(review, control.dataset.internalField, control.value.trim());
    });

    document.querySelectorAll(".internal-check").forEach((control) => {
      setByPath(review, control.dataset.internalField, control.checked);
    });

    review.pcnCode = state.activeRequest.id || "";

    return review;
  }

  function updateInternalReviewFromForm() {
    state.activeRequest = {
      ...state.activeRequest,
      internalReview: collectInternalReviewFromForm()
    };
  }

  function applyInternalReviewToForm(review) {
    document.querySelectorAll(".internal-field").forEach((control) => {
      const value =
        control.dataset.internalField === "pcnCode"
          ? state.activeRequest.id || "Auto generate on submit"
          : getByPath(review, control.dataset.internalField);
      control.value = value === undefined || value === null ? "" : String(value);
    });

    document.querySelectorAll(".internal-check").forEach((control) => {
      control.checked = Boolean(getByPath(review, control.dataset.internalField));
    });

    updateApprovalCheckLocks();
  }

  function syncExclusiveChecks(control) {
    const field = control.dataset.internalField;

    if (field === "tapbu.need" && control.checked) {
      setControlChecked("tapbu.noNeed", false);
      return;
    }

    if (field === "tapbu.noNeed" && control.checked) {
      setControlChecked("tapbu.need", false);
      return;
    }

    if (field === "qateFinal.approve" && control.checked) {
      setControlChecked("qateFinal.reject", false);
      return;
    }

    if (field === "qateFinal.reject" && control.checked) {
      setControlChecked("qateFinal.approve", false);
    }
  }

  function guardApprovalCheck(control) {
    if (!control.classList.contains("internal-check") || !control.checked) {
      updateApprovalCheckLocks();
      return true;
    }

    const rule = getApprovalLockRule(control.dataset.internalField);

    if (!rule.locked) {
      return true;
    }

    control.checked = false;
    showNotice("warning", "Approval step locked", rule.reason);
    updateApprovalCheckLocks();
    return false;
  }

  function updateApprovalCheckLocks() {
    getApprovalRouteControls().forEach((control) => {
      const rule = getApprovalLockRule(control.dataset.internalField);
      control.disabled = rule.unauthorized || (rule.locked && !control.checked);
      const label = control.closest(".excel-check, .qate-signoff-check");

      if (label) {
        label.classList.toggle("is-locked", control.disabled);
        label.title = control.disabled ? rule.reason : "";
      }
    });
    document.querySelectorAll('[data-internal-field]').forEach(control => {
      const field = control.dataset.internalField;
      if (/^(signoff\.(gscTet|prodEngTet|qaTet)|tapbu\.(gsc|qa)|qateFinal\.signoff)\.(approved|checked|prepared)(Name|Date)$/.test(field)) {
        control.disabled = true;
        control.title = 'Signer name and date are recorded when signing.';
      } else if (/^(signoff\.(gscTet|prodEngTet|qaTet)|tapbu\.(gsc|qa)|qateFinal\.signoff)\./.test(field) && !parseApprovalField(field) && !field.endsWith('.comment')) {
        control.disabled = true;
        control.title = 'Historical signoff information is read-only.';
      } else if (/^qateFinal\./.test(field) && !field.startsWith('qateFinal.signoff.')) {
        control.disabled = !canSignStep('qateFinal.signoff', 'prepared');
        control.title = control.disabled ? 'Requires the QA/TET Prepared assignment.' : '';
      }
    });
  }

  function canSignStep(group, action) {
    const departments = { 'signoff.gscTet': 'gscTet', 'signoff.prodEngTet': 'prodEngTet', 'signoff.qaTet': 'qaTet',
      'tapbu.gsc': 'gscTapbu', 'tapbu.qa': 'qaTapbu', 'qateFinal.signoff': 'qaTet' };
    const roles = (state.user?.roles || []).map(role => String(role).replace(/[^a-z]/gi, '').toLowerCase());
    const departmentRoles = { gscTet: 'gsc', prodEngTet: 'productionengineering', qaTet: 'qa', gscTapbu: 'tapbu', qaTapbu: 'tapbu' };
    const department = departments[group];
    return Boolean(department && state.user?.isActive !== false && state.user?.department === department && state.user?.signingStep === action &&
      !roles.includes('supplier') && ['admin', 'reviewer', departmentRoles[department]].some(role => roles.includes(role)));
  }

  function getApprovalRouteControls() {
    return approvalSignoffFields()
      .map((field) => document.querySelector(`.internal-check[data-internal-field="${field}"]`))
      .filter(Boolean);
  }

  function getApprovalLockRule(field) {
    const current = parseApprovalField(field);

    if (!current) {
      return { locked: false, reason: "" };
    }

    if (!canSignStep(current.group, current.action)) {
      return { locked: true, unauthorized: true, reason: 'Your assigned department and signing step do not permit this signature.' };
    }

    if (current.group.startsWith("tapbu.") && !isControlChecked("tapbu.need")) {
      return {
        locked: true,
        reason: "Select Need (RL3,2,1) before completing TaPBU signoff."
      };
    }

    const priorFieldInGroup = getPriorSignoffField(current.group, current.action);

    if (priorFieldInGroup && !isControlChecked(priorFieldInGroup)) {
      return {
        locked: true,
        reason: `Complete ${formatApprovalField(priorFieldInGroup)} before ${formatApprovalField(field)}.`
      };
    }

    const priorGroup = getPriorApprovalGroup(current.group);

    if (priorGroup) {
      if (!isApprovalGroupComplete(priorGroup)) {
        return {
          locked: true,
          reason: `Complete all ${formatApprovalGroup(priorGroup)} signoff checks before ${formatApprovalGroup(current.group)}.`
        };
      }
    }

    return { locked: false, reason: "" };
  }

  function getPriorSignoffField(group, action) {
    const actionOrder = ["approved", "checked", "prepared"];
    const actionIndex = actionOrder.indexOf(action);

    if (actionIndex <= 0) {
      return "";
    }

    return `${group}.${actionOrder[actionIndex - 1]}`;
  }

  function isApprovalGroupComplete(group) {
    return ["approved", "checked", "prepared"].every((action) => isControlChecked(`${group}.${action}`));
  }

  function getPriorApprovalGroup(group) {
    const groups = approvalRouteGroups();
    const groupIndex = groups.indexOf(group);

    if (groupIndex <= 0) {
      return "";
    }

    return groups[groupIndex - 1];
  }

  function approvalRouteGroups() {
    const groups = ["signoff.gscTet", "signoff.prodEngTet", "signoff.qaTet"];

    if (isControlChecked("tapbu.need")) {
      return [...groups, "tapbu.gsc", "tapbu.qa", "qateFinal.signoff"];
    }

    return [...groups, "qateFinal.signoff"];
  }

  function approvalSignoffFields() {
    return [
      "signoff.gscTet.approved",
      "signoff.gscTet.checked",
      "signoff.gscTet.prepared",
      "signoff.prodEngTet.approved",
      "signoff.prodEngTet.checked",
      "signoff.prodEngTet.prepared",
      "signoff.qaTet.approved",
      "signoff.qaTet.checked",
      "signoff.qaTet.prepared",
      "tapbu.gsc.approved",
      "tapbu.gsc.checked",
      "tapbu.gsc.prepared",
      "tapbu.qa.approved",
      "tapbu.qa.checked",
      "tapbu.qa.prepared",
      "qateFinal.signoff.approved",
      "qateFinal.signoff.checked",
      "qateFinal.signoff.prepared"
    ];
  }

  function parseApprovalField(field) {
    const match = String(field || "").match(/^(signoff\.(?:gscTet|prodEngTet|qaTet)|tapbu\.(?:gsc|qa)|qateFinal\.signoff)\.(prepared|checked|approved)$/);

    if (!match) {
      return null;
    }

    return {
      group: match[1],
      action: match[2]
    };
  }

  function isControlChecked(field) {
    const control = document.querySelector(`.internal-check[data-internal-field="${field}"]`);
    return Boolean(control && control.checked);
  }

  function formatApprovalField(field) {
    const parsed = parseApprovalField(field);

    if (!parsed) {
      return "the previous step";
    }

    return `${formatApprovalGroup(parsed.group)} ${titleCase(parsed.action)}`;
  }

  function formatApprovalGroup(group) {
    const labels = {
      "signoff.gscTet": "GSC/TET",
      "signoff.prodEngTet": "Prod.Eng/TET",
      "signoff.qaTet": "QA/TET",
      "tapbu.gsc": "GSC/TaPBU",
      "tapbu.qa": "QA/TaPBU",
      "qateFinal.signoff": "QA/TET Final Judgment"
    };

    return labels[group] || group;
  }

  function queueWorkflowNotification(control) {
    const parsed = parseApprovalField(control.dataset.internalField);

    if (!parsed) {
      return;
    }

    if (!control.checked) {
      state.pendingWorkflowNotifications.delete(control.dataset.internalField);
      return;
    }

    state.pendingWorkflowNotifications.add(control.dataset.internalField);
  }

  function splitNotificationStatus(outcome) {
    const issues = {
      recipient_not_configured: 'next-step recipients are not configured.',
      no_verified_recipients: 'no verified recipients have access to this PCN.',
      mail_not_configured: 'mail service is not configured.',
      tapbu_requirement_not_selected: 'select the required TaPBU approval choice.',
      notification_configuration_invalid: 'notification configuration needs review.'
    };
    const messages = [['PCN update emails', outcome.update], ['Action-required email', outcome.actionRequired]]
      .flatMap(([label, result]) => {
        if (!result) return [];
        if (result.queued) return [`${label} queued${label === 'Action-required email' ? ` for ${result.nextLabel || 'the next step'}` : ''}.`];
        return issues[result.reason] ? [`${label} not queued: ${issues[result.reason]}`] : [];
      });
    return messages.length ? ` ${messages.join(' ')}` : '';
  }

  async function sendPendingWorkflowNotifications(record) {
    if (record.notification) {
      state.pendingWorkflowNotifications.clear();
      const outcome = record.notification;
      if (outcome.actionRequired || outcome.update) return splitNotificationStatus(outcome);
      if (outcome.queued) return ` Workflow email queued for ${outcome.nextLabel || "the next step"}.`;
      if (outcome.reason === "recipient_not_configured") return " Workflow email not queued: next-step recipients are not configured.";
      if (outcome.reason === "mail_not_configured") return " Workflow email not queued: mail service is not configured.";
      if (outcome.reason === "tapbu_requirement_not_selected") return " Workflow email not queued: select the required TaPBU approval choice.";
      if (outcome.reason === "notification_configuration_invalid") return " Workflow email not queued: notification configuration needs review.";
      return "";
    }
    const pendingFields = [...state.pendingWorkflowNotifications];
    const pendingGroups = [...new Set(pendingFields.map((field) => parseApprovalField(field)?.group).filter(Boolean))];
    let queued = 0;
    let noRecipients = 0;
    let noService = 0;
    for (const group of pendingGroups) {
      const signoff = getByPath(record.internalReview || {}, group);
      if (signoff && ["approved", "checked", "prepared"].every((action) => signoff[action] === true)) {
        const result = await apiFetch(`/api/pcns/${encodeURIComponent(record.id)}/notifications/workflow`, {
          method: "POST", body: JSON.stringify({ completedGroupKey: group })
        });
        if (result.queued) queued += 1;
        else if (result.reason === "recipient_not_configured") noRecipients += 1;
        else if (result.reason === "mail_not_configured") noService += 1;
      }
      pendingFields.filter((field) => parseApprovalField(field)?.group === group).forEach((field) => state.pendingWorkflowNotifications.delete(field));
    }
    const messages = [];
    if (queued) messages.push(`${queued} workflow notification${queued === 1 ? "" : "s"} queued for delivery.`);
    if (noRecipients) messages.push("No email recipient configured for the next workflow group; email mapping is empty.");
    if (noService) messages.push("Email service is not configured on the server.");
    return messages.length ? ` ${messages.join(" ")}` : "";
  }

  function setControlChecked(field, checked) {
    const control = document.querySelector(`.internal-check[data-internal-field="${field}"]`);

    if (control) {
      control.checked = checked;
    }
  }

  function getByPath(object, path) {
    return path.split(".").reduce((value, key) => {
      if (value && Object.prototype.hasOwnProperty.call(value, key)) {
        return value[key];
      }

      return undefined;
    }, object);
  }

  function setByPath(object, path, value) {
    const keys = path.split(".");
    let target = object;

    keys.slice(0, -1).forEach((key) => {
      if (!target[key] || typeof target[key] !== "object") {
        target[key] = {};
      }

      target = target[key];
    });

    target[keys[keys.length - 1]] = value;
  }

  function structuredCloneSafe(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function showNotice(type, title, message) {
    if (!els.appNotice || !els.appNoticeTitle || !els.appNoticeMessage) {
      return;
    }

    els.appNotice.hidden = false;
    els.appNotice.className = `app-notice app-notice-${type}`;
    els.appNoticeTitle.textContent = title;
    els.appNoticeMessage.textContent = message;
    els.appNotice.setAttribute("role", type === "error" ? "alert" : "status");
    if (typeof els.appNotice.animate === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      els.appNotice.getAnimations?.().forEach((animation) => animation.cancel());
      els.appNotice.animate([
        { opacity: 0, transform: "translateY(10px)" },
        { opacity: 1, transform: "translateY(0)" }
      ], { duration: 250, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    }
  }

  function showToast(type, title, message) {
    if (!els.appToastStack) {
      return;
    }

    const toast = document.createElement("div");
    toast.className = `app-toast app-toast-${type}`;
    toast.innerHTML = `
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(message)}</span>
    `;
    els.appToastStack.appendChild(toast);

    window.setTimeout(() => {
      toast.classList.add("is-hiding");
      window.setTimeout(() => toast.remove(), 220);
    }, type === "error" ? 9000 : type === "warning" ? 7000 : 3200);
  }

  function syncSupplierDetailControls(request) {
    document.querySelectorAll('input[name="sampleSubmittedChoice"]').forEach((control) => {
      control.checked = control.value === request.sampleSubmitted;
    });

    document.querySelectorAll('input[name="priceLevelChoice"]').forEach((control) => {
      control.checked = control.value === request.priceLevel;
    });

    if (!Array.from(document.querySelectorAll('input[name="priceLevelChoice"]')).some((control) => control.checked)) {
      const noChange = document.querySelector('input[name="priceLevelChoice"][value="no-change"]');

      if (noChange) {
        noChange.checked = true;
        els.priceLevel.value = "no-change";
      }
    }
  }

  function syncHiddenDetailValues() {
    const sampleChoice = document.querySelector('input[name="sampleSubmittedChoice"]:checked');
    const priceChoice = document.querySelector('input[name="priceLevelChoice"]:checked');

    if (sampleChoice) {
      els.sampleSubmitted.value = sampleChoice.value;
    }

    if (priceChoice) {
      els.priceLevel.value = priceChoice.value;
    }
  }
})();

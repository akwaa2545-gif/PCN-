const commonDocuments = [
  "Supplier hazardous substance tested report",
  "Green Procurement declaration",
  "Certificate of QMS / EMS",
  "Supplier document, if specified",
  "Other requirement, if specified by TOKIN"
];

const formDefinitions = {
  rawMaterial: {
    id: "rawMaterial",
    sheet: "Form-1",
    label: "Form-1: Raw Material",
    changeHeading: "Content of Changes for Raw Material",
    riskOptions: [
      {
        risk: "RL3",
        text: "Change affecting product content of any legislative or industry restricted substance"
      },
      {
        risk: "RL3",
        text: "Change involving any conflict mineral (tantalum, tin, tungsten, or gold), cobalt or mica"
      },
      {
        risk: "RL3",
        text: "Change in materials that may affect form / fit / function of product or will change the final product material composition"
      },
      {
        risk: "RL3",
        text: "New raw material that may change form / fit / function of product"
      },
      {
        risk: "RL2",
        text: "Change of specification for a raw material that is outside of the current M-Spec"
      },
      {
        risk: "RL2",
        text: "New raw material or new supplier that will not impact form / fit / function of product (Commodity: Major, Extreme)"
      },
      {
        risk: "RL2",
        text: "Change in existing supplier location"
      },
      {
        risk: "RL1",
        text: "A change to raw materials within the established M-Spec"
      },
      {
        risk: "RL1",
        text: "Change in M-Spec by tightening requirements for current raw material that requires supplier process change"
      },
      {
        risk: "RL1",
        text: "New raw material or new supplier that will not impact form / fit / function of product (Commodity: Minor, Moderate)"
      },
      {
        risk: "RL0",
        text: "Documentation of raw material lot change qualifications if a project is required by customer (e.g., medical products)"
      },
      {
        risk: "RL0",
        text: "Supplier formal name modification"
      },
      {
        risk: "RL0",
        text: "Activate approved part number in a different Business Group / plant location"
      },
      {
        risk: "RL0",
        text: "Other"
      }
    ]
  },
  packaging: {
    id: "packaging",
    sheet: "Form-2",
    label: "Form-2: Packaging",
    changeHeading: "Content of Changes for Packaging",
    riskOptions: [
      {
        risk: "RL3",
        text: "New packaging material that will change form / fit / function of product"
      },
      {
        risk: "RL3",
        text: "Change to dry pack materials"
      },
      {
        risk: "RL3",
        text: "Change to packaging or labeling which would impact customer process (receiving or assembly)"
      },
      {
        risk: "RL3",
        text: "Change to configuration of packaging"
      },
      {
        risk: "RL3",
        text: "KEMET initiated change to customer label"
      },
      {
        risk: "RL2",
        text: "Change of specification for packaging material that is outside of the current M-Spec"
      },
      {
        risk: "RL2",
        text: "Change to packaging or labeling which would not impact customer process but may be visible"
      },
      {
        risk: "RL2",
        text: "A change to raw materials within the established M-Spec"
      },
      {
        risk: "RL1",
        text: "Change in printed information included on packaging (logo changes)"
      },
      {
        risk: "RL1",
        text: "Change to WIP label"
      }
    ]
  }
};

const workflowBase = [
  {
    key: "supplier_submission",
    title: "Supplier submission",
    owner: "Supplier",
    copy: "Create PCN, select change form, risk level, change condition, reason, target start, sample status, and document set."
  },
  {
    key: "completeness_review",
    title: "Completeness review",
    owner: "GSC/TET",
    copy: "Check supplier input and request additional information when required."
  },
  {
    key: "technical_review",
    title: "Technical review",
    owner: "Prod.Eng/TET",
    copy: "Review product, process, material, packaging, and customer-impact details."
  },
  {
    key: "quality_approval",
    title: "Quality approval",
    owner: "QA/TET",
    copy: "Confirm quality impact, qualification requirement, and TOKIN decision."
  },
  {
    key: "tapbu_approval",
    title: "TaPBU approval gate",
    owner: "GSC and QA/TaPBU",
    copy: "Required for RL3, RL2, and RL1 according to the Excel route; not normally required for RL0."
  },
  {
    key: "qualification",
    title: "QOD-206 qualification or verification",
    owner: "QA/TET",
    copy: "Run qualification change review, or verification review for RL0."
  },
  {
    key: "final_judgment",
    title: "Final judgment and supplier notification",
    owner: "QA/TET and GSC/TET",
    copy: "Record approval or rejection, delivery requirements, completed date, and supplier notification."
  }
];

const statusDefinitions = [
  {
    status: "draft",
    label: "Draft",
    activeStep: "supplier_submission",
    nextAction: "Supplier prepares the PCN before formal submission."
  },
  {
    status: "submitted",
    label: "Submitted",
    activeStep: "completeness_review",
    nextAction: "GSC checks completeness and routes the PCN."
  },
  {
    status: "supplier_action",
    label: "Supplier Action",
    activeStep: "supplier_submission",
    nextAction: "Supplier updates the PCN after an information request."
  },
  {
    status: "gsc_review",
    label: "GSC Review",
    activeStep: "completeness_review",
    nextAction: "GSC confirms required data and documents."
  },
  {
    status: "technical_review",
    label: "Technical Review",
    activeStep: "technical_review",
    nextAction: "Production Engineering reviews product and process impact."
  },
  {
    status: "qa_review",
    label: "QA Review",
    activeStep: "quality_approval",
    nextAction: "QA reviews quality impact and qualification needs."
  },
  {
    status: "tapbu_review",
    label: "TaPBU Review",
    activeStep: "tapbu_approval",
    nextAction: "TaPBU reviews the configured approval gate."
  },
  {
    status: "qualification",
    label: "Qualification",
    activeStep: "qualification",
    nextAction: "QA completes QOD-206 qualification or verification."
  },
  {
    status: "approved",
    label: "Approved",
    activeStep: "final_judgment",
    terminal: true,
    nextAction: "PCN is approved and ready for supplier notification or closure."
  },
  {
    status: "rejected",
    label: "Rejected",
    activeStep: "final_judgment",
    terminal: true,
    nextAction: "PCN is rejected. Supplier should receive the reason and next instruction."
  },
  {
    status: "closed",
    label: "Closed",
    activeStep: "final_judgment",
    terminal: true,
    nextAction: "PCN workflow is closed."
  }
];

const adminItems = [
  {
    title: "Database collections",
    copy: "pcn_requests, pcn_approvals, pcn_comments, pcn_documents, pcn_notifications, audit_logs, master_change_types, master_risk_levels, workflow_rules",
    status: "Backend ready"
  },
  {
    title: "Role access",
    copy: "Supplier sees own PCNs; GSC routes and checks completeness; Prod.Eng and QA review; TaPBU approves configured gates; Admin manages setup.",
    status: "Next: auth"
  },
  {
    title: "Notification events",
    copy: "New PCN, GSC review, info request, Prod.Eng review, QA review, TaPBU approval, approved, rejected, final judgment, status changed.",
    status: "Next: Power Automate"
  },
  {
    title: "Security controls",
    copy: "Local API validation is active. Firebase Authentication, Firestore rules, Storage rules, and backend-only webhook secrets remain production tasks.",
    status: "Partial"
  }
];

function buildWorkflow(riskLevel) {
  if (riskLevel === "RL0") {
    return workflowBase.filter((step) => step.title !== "TaPBU approval gate");
  }

  return [...workflowBase];
}

function buildWorkflowProgress(record) {
  const status = record.status || "draft";
  const definition = getStatusDefinition(status);
  const steps = buildWorkflow(record.riskLevel);
  const activeKey = resolveActiveStepKey(definition.activeStep, steps);
  const activeIndex = Math.max(
    steps.findIndex((step) => step.key === activeKey),
    0
  );
  const isTerminal = Boolean(definition.terminal);
  const progressSteps = steps.map((step, index) => ({
    ...step,
    state: getStepState(index, activeIndex, isTerminal)
  }));
  const completedCount = progressSteps.filter((step) => step.state === "completed").length;
  const currentStep = progressSteps[activeIndex] || progressSteps[progressSteps.length - 1] || null;

  return {
    status,
    statusLabel: definition.label,
    currentOwner: currentStep ? currentStep.owner : "Unassigned",
    currentStepKey: currentStep ? currentStep.key : "",
    currentStepTitle: currentStep ? currentStep.title : "No workflow step",
    nextAction: definition.nextAction,
    progressPercent: progressSteps.length === 0 ? 0 : Math.round((completedCount / progressSteps.length) * 100),
    terminal: isTerminal,
    availableStatuses: getAvailableStatuses(record).map(({ status: value, label }) => ({ value, label })),
    nextStatus: getPrimaryNextStatus(record),
    steps: progressSteps
  };
}

function getStatusDefinition(status) {
  return statusDefinitions.find((definition) => definition.status === status) || statusDefinitions[0];
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

function getStepState(index, activeIndex, isTerminal) {
  if (isTerminal || index < activeIndex) {
    return "completed";
  }

  if (index === activeIndex) {
    return "active";
  }

  return "pending";
}

function getAvailableStatuses(record) {
  const currentStatus = record.status || "draft";
  const available = new Map();

  [currentStatus, ...getAllowedNextStatuses(record)].forEach((status) => {
    const definition = getStatusDefinition(status);
    available.set(definition.status, definition);
  });

  return [...available.values()];
}

function getAllowedNextStatuses(record) {
  const status = record.status || "draft";
  const definition = getStatusDefinition(status);

  if (definition.terminal) {
    return [];
  }

  const steps = buildWorkflow(record.riskLevel);
  const activeKey = resolveActiveStepKey(definition.activeStep, steps);
  const activeIndex = steps.findIndex((step) => step.key === activeKey);
  const nextStep = steps[activeIndex + 1];
  const allowed = new Set();

  if (status === "draft" || status === "supplier_action") {
    return ["submitted"];
  }

  if (status !== "supplier_action") {
    allowed.add("supplier_action");
  }

  if (status === "submitted") {
    return [...allowed, "gsc_review"];
  }

  if (nextStep && nextStep.key === "final_judgment") {
    ["approved", "rejected", "closed"].forEach((terminalStatus) => allowed.add(terminalStatus));
  } else if (nextStep) {
    getStatusesForStep(nextStep.key).forEach((nextStatus) => allowed.add(nextStatus));
  } else if (activeKey === "final_judgment") {
    ["approved", "rejected", "closed"].forEach((terminalStatus) => allowed.add(terminalStatus));
  }

  return [...allowed].filter((nextStatus) => nextStatus !== status);
}

function getPrimaryNextStatus(record) {
  const currentStatus = record.status || "draft";
  const allowed = getAllowedNextStatuses(record);
  const forwardStatuses = allowed.filter((status) => status !== "supplier_action");

  if (currentStatus === "submitted" && forwardStatuses.includes("gsc_review")) {
    return "gsc_review";
  }

  return forwardStatuses[0] || "";
}

function getStatusesForStep(stepKey) {
  return statusDefinitions
    .filter((definition) => definition.activeStep === stepKey && !definition.terminal)
    .map((definition) => definition.status);
}

function isAllowedStatusTransition(record, nextStatus) {
  const currentStatus = record.status || "draft";

  if (currentStatus === nextStatus) {
    return true;
  }

  return getAllowedNextStatuses(record).includes(nextStatus);
}

module.exports = {
  adminItems,
  commonDocuments,
  formDefinitions,
  workflowBase,
  statusDefinitions,
  buildWorkflow,
  buildWorkflowProgress,
  getAllowedNextStatuses,
  getPrimaryNextStatus,
  isAllowedStatusTransition
};

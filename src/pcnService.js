const { ApiError } = require("./apiError");
const { assertRecordAccess, assertWritablePayload, assertReviewUpdate, assertStatusPermission, applySignatureIdentity, isInternal, isEmployeeViewer, canViewAllRecords } = require('./workflowAccess');
const { isDeepStrictEqual } = require('node:util');
const { mailGroups, normalizeMailRouting, settingsVersion } = require('./mailRouting');
const { emailList } = require('./integrationService');
const {
  buildWorkflow,
  buildWorkflowProgress,
  commonDocuments,
  formDefinitions,
  isAllowedStatusTransition,
  statusDefinitions
} = require("./masterData");

const allowedRiskLevels = new Set(["RL0", "RL1", "RL2", "RL3"]);
const allowedSampleStatuses = new Set(["yes", "no", "pending"]);
const allowedPriceLevels = new Set(["no-change", "decreasing", "increasing"]);
const allowedStatuses = new Set(statusDefinitions.map((definition) => definition.status));
const notificationGroups = [
  { key: "signoff.gscTet", label: "GSC/TET" },
  { key: "signoff.prodEngTet", label: "Prod.Eng/TET" },
  { key: "signoff.qaTet", label: "QA/TET" },
  { key: "tapbu.gsc", label: "GSC/TaPBU" },
  { key: "tapbu.qa", label: "QA/TaPBU" },
  { key: "qateFinal.signoff", label: "QA/TET Final Judgment" },
  { key: "supplierNotification", label: "GSC/TET Supplier Notification" }
];

class PcnService {
  constructor(repository, clock = () => new Date()) {
    this.repository = repository;
    this.clock = clock;
  }

  async list(filters = {}, user) {
    if (isEmployeeViewer(user)) throw new ApiError(403, 'A PCN role is required to view records');
    return this.repository.list({ ...filters, ...(user && !canViewAllRecords(user) ? { ownerUserId: user.id } : {}) });
  }

  async getById(id, user) {
    if (isEmployeeViewer(user)) throw new ApiError(403, 'A PCN role is required to view records');
    assertValidId(id);
    const record = await this.repository.findById(id);

    if (!record) {
      throw new ApiError(404, "PCN not found");
    }
    if (user) assertRecordAccess(record, user);

    return record;
  }

  async getProgress(id) {
    const record = await this.getById(id);
    return buildWorkflowProgress(record);
  }

  async getNotificationSettings() {
    const settings = normalizeMailRouting(await this.repository.getNotificationSettings());
    return { ...settings, flowConfigured: Boolean(process.env.POWER_AUTOMATE_MAIL_URL), directoryConfigured: Boolean(process.env.POWER_AUTOMATE_DIRECTORY_URL) };
  }

  async updateNotificationSettings(input, actor = "web", user) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'Mail routing body must be an object');
    if (input.schemaVersion !== undefined && input.schemaVersion !== 2) throw new ApiError(400, 'Unsupported mail routing schema version');
    const current = await this.repository.getNotificationSettings();
    if (input?.schemaVersion !== 2 && current.schemaVersion === 2) {
      throw new ApiError(409, 'Mail routing changed; reload before saving');
    }
    const settings = input?.schemaVersion === 2 ? sanitizeDepartmentRouting(input, current) : sanitizeNotificationSettings(input);
    await this.repository.saveNotificationSettings(settings, actor, settingsVersion(current), user);
    return this.getNotificationSettings();
  }

  async create(input, actor = "web", user) {
    if (isEmployeeViewer(user)) throw new ApiError(403, 'A PCN role is required to create records');
    const now = this.clock().toISOString();
    assertWritablePayload(input);
    const data = this.normalizeInput(input);
    this.assertAllowedInitialStatus(data.status);
    if (user) assertReviewUpdate({}, data.internalReview, user, data.riskLevel);
    const master = await this.repository.getMasterData();
    const record = {
      ownerUserId: user?.id || null,
      masterDataVersionId: master.versionId,
      status: data.status || "submitted",
      sourceTemplate: formDefinitions[data.changeForm].sheet,
      changeType: formDefinitions[data.changeForm].changeHeading,
      createdAt: now,
      updatedAt: now,
      submittedAt: data.status === "draft" ? null : now,
      route: buildWorkflow(data.riskLevel).map((step) => step.owner),
      documents: commonDocuments.map((name) => ({
        name,
        required: true,
        uploaded: false
      })),
      approvals: [],
      comments: [],
      ...data
    };
    record.internalReview = {
      ...(user ? applySignatureIdentity({}, record.internalReview || {}, user, now) : record.internalReview || {}),
      pcnCode: ''
    };

    return this.repository.create(record, actor, user);
  }

  async update(id, input, actor = "web", user) {
    if (isEmployeeViewer(user)) throw new ApiError(403, 'A PCN role is required to edit records');
    assertValidId(id);
    assertWritablePayload(input);

    const updated = await this.repository.update(
      id,
      (current) => {
        if (user) {
          assertRecordAccess(current, user);
          if (['approved','rejected','closed'].includes(current.status)) throw new ApiError(403, 'Completed PCNs cannot be edited');
          if (!isInternal(user) && !['draft','supplier_action'].includes(current.status)) throw new ApiError(403, 'Supplier edits are allowed in Draft or Supplier Action');
          if (!['draft','supplier_action'].includes(current.status)) {
            for (const key of ['changeForm','riskLevel']) {
              if (input[key] !== undefined && input[key] !== current[key]) throw new ApiError(403, 'Submitted PCN content cannot be changed during review');
            }
          }
        }
        const review = mergeReview(current.internalReview || {}, input.internalReview || {});
        const data = this.normalizeInput({ ...current, ...input, internalReview: review });
        if (user && !['draft','supplier_action'].includes(current.status)) {
          const original = this.normalizeInput(current);
          for (const key of Object.keys(data).filter(key => !['internalReview','status'].includes(key))) {
            if (!isDeepStrictEqual(data[key], original[key])) throw new ApiError(403, 'Submitted PCN content cannot be changed during review');
          }
        }
        const now = this.clock().toISOString();
        const nextStatus = input.status ? data.status : current.status;
        if (user) {
          assertReviewUpdate(current.internalReview || {}, data.internalReview, user, data.riskLevel);
          assertStatusPermission({ ...current, internalReview: data.internalReview }, nextStatus, user);
        }

        if (input.status && !isAllowedStatusTransition(current, nextStatus)) {
          throw new ApiError(400, "Workflow status cannot skip steps");
        }

        return {
          ...current,
          ...data,
          id: current.id,
          createdAt: current.createdAt,
          updatedAt: now,
          status: nextStatus,
          submittedAt: current.submittedAt || (nextStatus !== "draft" ? now : null),
          sourceTemplate: formDefinitions[data.changeForm].sheet,
          changeType: formDefinitions[data.changeForm].changeHeading,
          route: buildWorkflow(data.riskLevel).map((step) => step.owner),
          internalReview: {
            ...(user ? applySignatureIdentity(current.internalReview || {}, data.internalReview || {}, user, now) : data.internalReview || {}),
            pcnCode: current.id
          }
        };
      },
      actor,
      input.version,
      user
    );

    if (!updated) {
      throw new ApiError(404, "PCN not found");
    }

    return updated;
  }

  async remove(id, actor = "web", version, user) {
    if (isEmployeeViewer(user)) throw new ApiError(403, 'A PCN role is required to delete records');
    assertValidId(id);
    const deleted = await this.repository.delete(id, actor, version, user);

    if (!deleted) {
      throw new ApiError(404, "PCN not found");
    }

    return { id };
  }

  async addComment(id, input, actor = "web", user) {
    if (isEmployeeViewer(user)) throw new ApiError(403, 'A PCN role is required to comment on records');
    assertValidId(id);
    const comment = sanitizeString(input && input.comment, "comment", 1, 1200);
    const role = user ? user.roles.join(', ').slice(0,80) : sanitizeString(input && input.role, "role", 1, 80);
    const now = this.clock().toISOString();

    const updated = await this.repository.update(
      id,
      (current) => {
        if (user) assertRecordAccess(current, user);
        return ({
        ...current,
        updatedAt: now,
        comments: [
          ...(current.comments || []),
          {
            id: crypto.randomUUID(),
            role,
            comment,
            createdAt: now
          }
        ]
      }); },
      actor,
      input.version,
      user
    );

    if (!updated) {
      throw new ApiError(404, "PCN not found");
    }

    return updated;
  }

  async addApproval(id, input, actor = "web", user) {
    assertValidId(id);
    if (user && !isInternal(user)) throw new ApiError(403, 'Approval requires an internal reviewer');
    const role = user ? user.roles.join(', ').slice(0,80) : sanitizeString(input && input.role, "role", 1, 80);
    const decision = sanitizeString(input && input.decision, "decision", 1, 40);
    const comment = sanitizeString(input && input.comment, "comment", 0, 1200);
    const allowedDecisions = new Set(["approved", "rejected", "hold", "request_info"]);

    if (!allowedDecisions.has(decision)) {
      throw new ApiError(400, "Invalid approval decision");
    }

    const now = this.clock().toISOString();
    const updated = await this.repository.update(
      id,
      (current) => {
        if (user) {
          assertRecordAccess(current, user);
          if (['draft','supplier_action','approved','rejected','closed'].includes(current.status)) throw new ApiError(400, 'The PCN is not awaiting review');
        }
        return ({
        ...current,
        updatedAt: now,
        approvals: [
          ...(current.approvals || []),
          {
            id: crypto.randomUUID(),
            role,
            decision,
            comment,
            createdAt: now
          }
        ]
      }); },
      actor,
      input.version,
      user
    );

    if (!updated) {
      throw new ApiError(404, "PCN not found");
    }

    return updated;
  }

  normalizeInput(input) {
    const changeForm = sanitizeString(input.changeForm, "changeForm", 1, 40);
    const riskLevel = sanitizeString(input.riskLevel, "riskLevel", 1, 10);
    const selectedChange = sanitizeString(input.selectedChange, "selectedChange", 1, 500);

    if (!formDefinitions[changeForm]) {
      throw new ApiError(400, "Invalid change form");
    }

    if (!allowedRiskLevels.has(riskLevel)) {
      throw new ApiError(400, "Invalid risk level");
    }

    const changeRows = sanitizeChangeRows(input.changeRows, changeForm, riskLevel);
    const validSelectedChange = changeRows.some(
      (row) => row.risk === riskLevel && row.text === selectedChange
    );

    if (!validSelectedChange) {
      throw new ApiError(400, "Selected change does not match the form and risk level");
    }

    const sampleSubmitted = sanitizeString(input.sampleSubmitted || "pending", "sampleSubmitted", 1, 20);
    const priceLevel = sanitizeString(input.priceLevel || "no-change", "priceLevel", 1, 20);
    const status = sanitizeString(input.status || "submitted", "status", 1, 40);

    if (!allowedSampleStatuses.has(sampleSubmitted)) {
      throw new ApiError(400, "Invalid sample submission value");
    }

    if (!allowedPriceLevels.has(priceLevel)) {
      throw new ApiError(400, "Invalid price level");
    }

    if (!allowedStatuses.has(status)) {
      throw new ApiError(400, "Invalid PCN status");
    }

    return {
      changeForm,
      riskLevel,
      selectedChange,
      supplierName: sanitizeString(input.supplierName, "supplierName", 1, 160),
      manufacturerName: sanitizeString(input.manufacturerName, "manufacturerName", 0, 180),
      materialName: sanitizeString(input.materialName, "materialName", 1, 180),
      desiredStart: sanitizeString(input.desiredStart, "desiredStart", 0, 120),
      sampleSubmitted,
      sampleSubmittedDate: sanitizeString(input.sampleSubmittedDate, 'sampleSubmittedDate', 0, 120),
      currentCondition: sanitizeString(input.currentCondition, "currentCondition", 0, 2000),
      newCondition: sanitizeString(input.newCondition, "newCondition", 0, 2000),
      changeRows,
      reason: sanitizeString(input.reason, "reason", 0, 2000),
      identification: sanitizeString(input.identification, "identification", 0, 1200),
      sampleLocation: sanitizeString(input.sampleLocation, "sampleLocation", 0, 180),
      priceLevel,
      internalReview: sanitizeInternalReview(input.internalReview),
      status
    };
  }

  assertAllowedInitialStatus(status) {
    if (!["draft", "submitted"].includes(status)) {
      throw new ApiError(400, "New PCN status must start at Draft or Submitted");
    }
  }
}

function sanitizeNotificationSettings(input = {}) {
  if (input.flowUrl || input.directoryLookupUrl) throw new ApiError(400, 'Integration URLs are configured on the server');
  const groupInput = new Map(
    (Array.isArray(input.groups) ? input.groups : []).map((group) => [String(group.key || ""), group])
  );

  return {
    groups: notificationGroups.map((group) => {
      const configured = groupInput.get(group.key) || {};
      const emails = sanitizeEmailList(configured.emails || "");

      return {
        ...group,
        emails,
        recipients: sanitizeNotificationRecipients(configured.recipients, emails)
      };
    })
  };
}

function sanitizeDepartmentRouting(input, current) {
  if (input.flowUrl || input.directoryLookupUrl) throw new ApiError(400, 'Integration URLs are configured on the server');
  if (typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version)) throw new ApiError(400, 'Mail routing version is required');
  if (input.version !== settingsVersion(current)) throw new ApiError(409, 'Mail routing changed; reload before saving');
  if (!Array.isArray(input.groups) || input.groups.length !== mailGroups.length) throw new ApiError(400, 'All 16 mail recipient groups are required');
  const keys = input.groups.map(group => group?.key);
  if (new Set(keys).size !== mailGroups.length || keys.some(key => !mailGroups.some(group => group.key === key))) {
    throw new ApiError(400, 'Mail recipient groups contain duplicate or unknown keys');
  }
  return { schemaVersion: 2, groups: mailGroups.map(definition => {
    const configured = input.groups.find(group => group.key === definition.key);
    if (configured.emails !== undefined && typeof configured.emails !== 'string') throw new ApiError(400, 'Mail recipient addresses must be text');
    if (configured.recipients !== undefined && (!Array.isArray(configured.recipients) || configured.recipients.some(recipient => !recipient || typeof recipient !== 'object' || Array.isArray(recipient)))) {
      throw new ApiError(400, 'Mail recipient profiles must be objects');
    }
    const emails = sanitizeEmailList(configured.emails || '');
    if (emails) emailList(emails);
    if (parseNotificationEmails(emails).length > 30) throw new ApiError(400, 'A mail recipient group supports at most 30 addresses');
    return { ...definition, emails, recipients: sanitizeNotificationRecipients(configured.recipients, emails) };
  }), legacyGroups: normalizeMailRouting(current).legacyGroups };
}

function normalizeNotificationRecipients(recipients, emails) {
  const emailSet = new Set(parseNotificationEmails(emails).map((email) => email.toLowerCase()));

  return (Array.isArray(recipients) ? recipients : [])
    .filter(recipient => recipient && typeof recipient === 'object' && !Array.isArray(recipient))
    .map((recipient) => ({
      email: String(recipient.email || recipient.mail || "").trim(),
      displayName: String(recipient.displayName || recipient.name || "").trim(),
      jobTitle: String(recipient.jobTitle || recipient.position || recipient.title || "").trim(),
      department: String(recipient.department || "").trim(),
      photo: String(recipient.photo || recipient.photoUrl || recipient.picture || recipient.avatar || "").trim()
    }))
    .filter((recipient) => recipient.email && emailSet.has(recipient.email.toLowerCase()));
}

function sanitizeNotificationRecipients(recipients, emails) {
  const savedByEmail = new Map(
    normalizeNotificationRecipients(recipients, emails)
      .filter((recipient) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email))
      .map((recipient) => [recipient.email.toLowerCase(), recipient])
  );

  return parseNotificationEmails(emails).map((email) => {
    const saved = savedByEmail.get(email.toLowerCase()) || {};

    return {
      email,
      displayName: sanitizeString(saved.displayName || "", "displayName", 0, 120),
      jobTitle: sanitizeString(saved.jobTitle || "", "jobTitle", 0, 120),
      department: sanitizeString(saved.department || "", "department", 0, 120),
      photo: sanitizeDirectoryPhoto(saved.photo || "")
    };
  });
}

function parseNotificationEmails(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sanitizeEmailList(value) {
  const text = sanitizeString(value, "emails", 0, 1000);

  if (!text) {
    return "";
  }

  const parsed = parseNotificationEmails(text);
  const recipients = parsed.filter((email, index) => parsed.findIndex(value => value.toLowerCase() === email.toLowerCase()) === index);

  const invalid = recipients.find((recipient) => recipient.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient));

  if (invalid) {
    throw new ApiError(400, `Invalid notification email: ${invalid}`);
  }

  const normalized = recipients.join("; ");
  if (normalized.length > 1000) throw new ApiError(400, 'emails is too long', { maxLength: 1000 });
  return normalized;
}

function sanitizeDirectoryPhoto(value) {
  const text = sanitizeString(value, 'photo', 0, 150000);
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/= \t\r\n]+)$/i.exec(text);
  if (!match) return '';
  const encoded = match[2].replace(/[ \t\r\n]/g, '');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return '';
  const photo = `data:image/${match[1].toLowerCase()};base64,${encoded}`;
  return photo.length <= 100 * 1024 ? photo : '';
}

function sanitizeString(value, field, minLength, maxLength) {
  const text = value === undefined || value === null ? "" : String(value).trim();

  if (text.length < minLength) {
    throw new ApiError(400, `${field} is required`);
  }

  if (text.length > maxLength) {
    throw new ApiError(400, `${field} is too long`, { maxLength });
  }

  return text;
}

function assertValidId(id) {
  if (!/^PCN-\d{4}-\d{4}$/.test(String(id))) {
    throw new ApiError(400, "Invalid PCN id");
  }
}

function sanitizeChangeRows(value, changeForm, riskLevel) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new ApiError(400, "changeRows must be an array");
  }

  const validOptions = new Map(formDefinitions[changeForm].riskOptions.map((option) => [option.text, option]));

  return value.map((row, index) => {
    const text = sanitizeString(row && row.text, `changeRows[${index}].text`, 1, 500);
    const optionText = sanitizeString(row && (row.optionText || row.originalText || row.text), `changeRows[${index}].optionText`, 1, 500);
    const option = validOptions.get(optionText);

    if (!option) {
      throw new ApiError(400, "changeRows contains an item that does not match the form and risk level");
    }

    return {
      risk: option.risk,
      optionText: option.text,
      text,
      currentCondition: sanitizeString(row.currentCondition, `changeRows[${index}].currentCondition`, 0, 2000),
      newCondition: sanitizeString(row.newCondition, `changeRows[${index}].newCondition`, 0, 2000)
    };
  });
}

function sanitizeInternalReview(value) {
  if (value === undefined || value === null) {
    return {};
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "internalReview must be an object");
  }

  return sanitizeReviewObject(value, "internalReview", 0);
}

function sanitizeReviewObject(value, path, depth) {
  if (depth > 6) {
    throw new ApiError(400, `${path} is too deeply nested`);
  }

  return Object.entries(value).reduce((result, [key, entry]) => {
    if (!/^[A-Za-z0-9_]+$/.test(key) || ['__proto__','constructor','prototype'].includes(key)) {
      throw new ApiError(400, `${path} contains an invalid key`);
    }

    if (typeof entry === "boolean") {
      return {
        ...result,
        [key]: entry
      };
    }

    if (typeof entry === "string" || typeof entry === "number" || entry === null || entry === undefined) {
      return {
        ...result,
        [key]: sanitizeString(entry, `${path}.${key}`, 0, 2000)
      };
    }

    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return {
        ...result,
        [key]: sanitizeReviewObject(entry, `${path}.${key}`, depth + 1)
      };
    }

    throw new ApiError(400, `${path}.${key} has an invalid value`);
  }, {});
}

module.exports = {
  PcnService,
  notificationGroups
};

function mergeReview(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ApiError(400, 'internalReview must be an object');
  return Object.entries(patch).reduce((next, [key,value]) => ({
    ...next,
    [key]: value && typeof value === 'object' && !Array.isArray(value) ? mergeReview(current[key] || {}, value) : value
  }), { ...current });
}

const { ApiError } = require('./apiError');
const { isEmployeeViewer, isInternal } = require('./workflowAccess');
const { hasSignatures } = require('./documentControl');
const { buildChecks, buildAction } = require('./documentChecks');
const { normalizeMailRouting, resolveNextMailTarget } = require('./mailRouting');
const { canSetRequirements, draftContent, templateContent } = require('./pcnTemplates');
const { summarizeNotificationStatus } = require('./notificationStatus');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const validVersion = value => typeof value === 'string' && /^[0-9a-f]{16}$/i.test(value);
function body(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new ApiError(400, 'Invalid creation request');
}
function creator(user) {
  if (!user?.id || user.isActive === false || isEmployeeViewer(user) || !user.roles?.length) throw new ApiError(403, 'An active PCN role is required');
}
function owned(record, user) {
  if (String(record.ownerUserId) !== String(user.id)) throw new ApiError(404, 'PCN draft not found');
  if (record.status !== 'draft' || hasSignatures(record)) throw new ApiError(409, 'This PCN is no longer an unsigned draft');
}

class PcnCreationService {
  constructor({ service, repository, documents, authRepository, mailConfigurationStatus, scannerConfigured = false }) {
    Object.assign(this, { service, repository, documents, authRepository, mailConfigurationStatus, scannerConfigured: Boolean(scannerConfigured) });
  }
  async list(user) {
    creator(user);
    const records = await this.repository.list({ status: 'draft', ownerUserId: user.id });
    return records.filter(record => String(record.ownerUserId) === String(user.id) && record.status === 'draft' && !hasSignatures(record)).map(record =>
      Object.fromEntries(['id','version','supplierName','materialName','riskLevel','changeForm','updatedAt','isTestDocument'].filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]])));
  }
  async get(id, user) {
    creator(user); const record = await this.service.getById(id, user); owned(record, user);
    return { record, editable: true, canSetRequirements: canSetRequirements(user), scannerConfigured: this.scannerConfigured };
  }
  async create(input, actor, user) {
    creator(user); body(input, ['clientDraftKey','document','testDocument']);
    if (typeof input.clientDraftKey !== 'string' || !uuid.test(input.clientDraftKey)) throw new ApiError(400, 'A valid draft identity is required');
    if (input.testDocument !== undefined && typeof input.testDocument !== 'boolean') throw new ApiError(400, 'Test document must be boolean');
    const content = draftContent(input.document, user);
    const saved = await this.service.create({ ...content, status: 'draft' }, actor, user,
      { clientDraftKey: input.clientDraftKey.toLowerCase(), testDocument: input.testDocument === true });
    const { creationReused, ...record } = saved;
    return { record, reused: creationReused === true };
  }
  async update(id, input, actor, user) {
    creator(user); body(input, ['version','document']);
    if (!validVersion(input.version)) throw new ApiError(400, 'Current draft version is required');
    const content = draftContent(input.document, user);
    return { record: await this.service.update(id, { ...content, version: input.version }, actor, user, { draftOnly: true }) };
  }
  async preflight(id, input, user) {
    body(input, ['version']); if (!validVersion(input.version)) throw new ApiError(400, 'Current draft version is required');
    const { record } = await this.get(id, user);
    if (record.version !== input.version.toLowerCase()) throw new ApiError(409, 'Draft changed; review the latest saved version');
    if (typeof this.documents?.listForRecords !== 'function') throw new ApiError(503, 'Document status is unavailable');
    const entry = (await this.documents.listForRecords([id])).get(id);
    if (!entry || entry.parentVersion !== record.version) throw new ApiError(409, 'Draft changed while checking documents; review again');
    const candidate = { ...record, status: 'submitted' };
    const users = isInternal(user) && this.authRepository?.listUsers ? await this.authRepository.listUsers() : [];
    const settings = normalizeMailRouting(await this.repository.getNotificationSettings());
    const target = resolveNextMailTarget(candidate);
    const group = settings.groups.find(item => item.key === target?.groupKey);
    return { id, version: record.version, checks: buildChecks(record, entry.attachments), nextAction: safeAction(buildAction(candidate, user, users)),
      notification: { configurationStatus: this.configurationStatus(), recipientConfigured: Boolean(group?.effectiveEmails) } };
  }
  async template(id, user) {
    creator(user); return templateContent(await this.service.getById(id, user), user);
  }
  async receipt(id, version, user) {
    if (!validVersion(version)) throw new ApiError(400, 'Submission version is required');
    const record = await this.service.getById(id, user);
    const rows = await this.repository.getNotificationStatus(id, version.toLowerCase());
    const users = isInternal(user) && this.authRepository?.listUsers ? await this.authRepository.listUsers() : [];
    return { id, version: version.toLowerCase(), status: record.status, isTestDocument: record.isTestDocument === true,
      nextAction: safeAction(buildAction(record, user, users)), notification: summarizeNotificationStatus(rows,
        { configurationStatus: this.configurationStatus(), currentActionBlocked: rows.length === 0 && record.mailRoutingState?.status === 'blocked' }) };
  }
  configurationStatus() { return this.mailConfigurationStatus ? this.mailConfigurationStatus() : 'not_configured'; }
}
function safeAction(action) { return { ...action, people: action.people.map(person => ({ displayName: person.displayName })) }; }
module.exports = { PcnCreationService };

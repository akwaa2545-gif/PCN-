const { ApiError } = require('./apiError');

function escapeHtml(value) {
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value !== 'string') throw new ApiError(503, 'Notification message is invalid');
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function validateLink(value) {
  if (typeof value !== 'string') throw new ApiError(503, 'Public PCN origin is invalid');
  let url;
  try { url = new URL(value); } catch { throw new ApiError(503, 'Public PCN origin is invalid'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ApiError(503, 'Public PCN origin is invalid');
  return escapeHtml(value);
}

function buildWorkflowNotificationMessage(record, notification) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !notification || typeof notification !== 'object' || Array.isArray(notification)) {
    throw new ApiError(503, 'Notification message is invalid');
  }
  const detailRows = [
    ['PCN Code', record.id], ['Supplier', record.supplierName],
    ['Material', record.materialName], ['Risk Level', record.riskLevel]
  ].map(([label, value]) => `
    <tr>
      <td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;color:#64748b;font-size:12px;font-weight:700;white-space:nowrap;">${escapeHtml(label)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;color:#0f172a;font-size:12px;font-weight:700;">${escapeHtml(value)}</td>
    </tr>`).join('');
  const link = notification.pcnUrl === undefined || notification.pcnUrl === null || notification.pcnUrl === '' ? '' : validateLink(notification.pcnUrl);
  const accessButton = link ? `
    <tr>
      <td style="padding:14px 18px 18px;">
        <a href="${link}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;padding:9px 14px;border-radius:4px;">Open PCN</a>
        <div style="margin-top:9px;color:#64748b;font-size:11px;line-height:1.4;">${link}</div>
      </td>
    </tr>` : '';
  const message = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;border-collapse:collapse;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
      <tr>
        <td style="padding:18px;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #cbd5e1;">
            <tr>
              <td style="padding:14px 18px;background:#001a7a;color:#ffffff;">
                <div style="font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">Supplier PCN Workflow</div>
                <div style="margin-top:4px;font-size:18px;font-weight:800;line-height:1.25;">${escapeHtml(record.id)} requires next action</div>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 18px 10px;">
                <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
                  <tr>
                    <td style="width:50%;padding:0 8px 10px 0;vertical-align:top;">
                      <div style="color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;">Current Status</div>
                      <div style="margin-top:5px;padding:8px 10px;border-left:4px solid #0f766e;background:#ecfdf5;color:#064e3b;font-size:13px;font-weight:800;">${escapeHtml(notification.completedGroup)}</div>
                    </td>
                    <td style="width:50%;padding:0 0 10px 8px;vertical-align:top;">
                      <div style="color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;">Next To Check</div>
                      <div style="margin-top:5px;padding:8px 10px;border-left:4px solid #2563eb;background:#eff6ff;color:#1e3a8a;font-size:13px;font-weight:800;">${escapeHtml(notification.nextGroup)}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 18px 14px;">
                <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border-top:1px solid #e5e7eb;">${detailRows}</table>
              </td>
            </tr>
            ${accessButton}
          </table>
        </td>
      </tr>
    </table>`;
  if (message.length > 20000) throw new ApiError(503, 'Notification message is too large');
  return message;
}

module.exports = { buildWorkflowNotificationMessage };

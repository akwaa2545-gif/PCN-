(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PCN_NOTIFICATION_SETTINGS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const KEYS = Object.freeze(['submitted','actionRequired','updated','completed','dueSoon','overdue']);
  const RULE_FIELDS = ['enabled','includeDefaultRecipients','groupKeys','userIds','excludedUserIds'];
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const strings = value => Array.isArray(value) && value.length <= 2000
    && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 160) && new Set(value).size === value.length;
  function parseSnapshot(value) {
    const invalid = () => { throw new Error('The server returned invalid notification settings. Reload and try again.'); };
    if (value?.schemaVersion !== 1 || typeof value.version !== 'string' || !/^[a-f0-9]{64}$/i.test(value.version) || !exact(value.rules, KEYS)) invalid();
    for (const key of KEYS) {
      const rule = value.rules[key];
      if (!exact(rule, RULE_FIELDS) || typeof rule.enabled !== 'boolean' || typeof rule.includeDefaultRecipients !== 'boolean'
        || !strings(rule.groupKeys) || !strings(rule.userIds) || !strings(rule.excludedUserIds)
        || rule.userIds.some(id => rule.excludedUserIds.includes(id))) invalid();
    }
    const options = value.options;
    if (!options || !Array.isArray(options.types) || options.types.length !== KEYS.length
      || new Set(options.types.map(type => type?.key)).size !== KEYS.length
      || options.types.some(type => !KEYS.includes(type?.key) || typeof type.label !== 'string' || typeof type.description !== 'string')
      || !Array.isArray(options.groups) || options.groups.length > 200
      || options.groups.some(group => typeof group?.key !== 'string' || typeof group.label !== 'string')
      || new Set(options.groups.map(group => group.key)).size !== options.groups.length
      || !Array.isArray(options.users) || options.users.length > 2000
      || options.users.some(user => typeof user?.id !== 'string' || typeof user.displayName !== 'string' || typeof user.email !== 'string')
      || new Set(options.users.map(user => user.id)).size !== options.users.length) invalid();
    return { schemaVersion:1, version:value.version, rules:copyRules(value.rules),
      options:{ types:options.types.map(type => ({ key:type.key, label:type.label, description:type.description })),
        groups:options.groups.map(group => ({key:group.key,label:group.label})),
        users:options.users.map(user => ({id:user.id,displayName:user.displayName,email:user.email,employeeCode:user.employeeCode || '',department:user.department || ''})) },
      updatedAt:typeof value.updatedAt === 'string' ? value.updatedAt : null, updatedBy:typeof value.updatedBy === 'string' ? value.updatedBy : null };
  }
  function copyRules(rules) {
    return Object.fromEntries(KEYS.map(key => [key, { enabled:rules[key].enabled, includeDefaultRecipients:rules[key].includeDefaultRecipients,
      groupKeys:[...rules[key].groupKeys].sort(), userIds:[...rules[key].userIds].sort(), excludedUserIds:[...rules[key].excludedUserIds].sort() }]));
  }
  function create(root, hooks) {
    const el = id => root.document.getElementById(id);
    let active = false, busy = false, epoch = 0, baseline = null, snapshot = null, selected = KEYS[0], view = 'group', selectedGroup = '';
    el('notificationEditor').hidden = true;
    const dirty = () => Boolean(active && snapshot && baseline !== JSON.stringify(snapshot.rules));
    const allowed = () => active && hooks.canUse();
    function controls() {
      el('notificationFields').disabled = busy || !allowed() || !snapshot;
      el('notificationSave').disabled = busy || !allowed() || !dirty();
      const editing = !busy && allowed() && Boolean(snapshot);
      el('notificationAddGroup').disabled = !editing || !el('notificationGroupPicker').value;
      const userId = el('notificationUserPicker').value;
      el('notificationIncludeUser').disabled = !editing || !userId || snapshot.rules[selected].userIds.includes(userId);
      el('notificationExcludeUser').disabled = !editing || !userId || snapshot.rules[selected].excludedUserIds.includes(userId);
      for (const key of KEYS) {
        el(`notificationGroupSelected-${key}`).disabled = !editing || !selectedGroup;
        el(`notificationGroupConfigure-${key}`).disabled = !editing;
      }
      el('notificationEditor').setAttribute('aria-busy', String(busy));
    }
    function changed() { controls(); hooks.onStateChange?.(); }
    function status(text, error = false) { hooks.status?.(text, error); }
    function element(tag, text, className) {
      const item = root.document.createElement(tag);
      if (text !== undefined) item.textContent = text;
      if (className) item.className = className;
      return item;
    }
    function option(value, text) { const item = element('option', text); item.value = value; return item; }
    function userName(id) {
      const user = snapshot.options.users.find(item => item.id === id);
      return user ? `${user.displayName}${user.employeeCode ? ` · ${user.employeeCode}` : ''} · ${user.email}` : `Unavailable user · ${id}`;
    }
    function chips(container, entries, remove, fallbackFocus) {
      const items = entries.map(({id,label,kind}) => {
        const item = element('li', undefined, 'notification-recipient');
        const text = element('span', label); item.append(text);
        if (kind) item.append(element('span', kind, 'notification-recipient-kind'));
        const button = element('button', 'Remove', 'notification-remove'); button.type = 'button';
        button.setAttribute('aria-label', `Remove ${kind ? `${kind.toLowerCase()} override for ` : ''}${label}`);
        button.addEventListener('click', () => {
          if (!allowed() || busy) return;
          remove(id); renderRule(); changed(); status(`${label} removed from this notification rule.`);
          el(fallbackFocus).focus();
        });
        item.append(button); return item;
      });
      el(container).replaceChildren(...items);
    }
    function updateRule(key, patch) {
      if (!allowed() || busy || !snapshot) return;
      snapshot = { ...snapshot, rules:{ ...snapshot.rules, [key]:{...snapshot.rules[key],...patch} } };
    }
    function setRule(patch) { updateRule(selected, patch); }
    function groupDelivery(key, rule, included) {
      if (!rule.enabled) return { label:'Off for everyone', state:'off', detail:'Off for everyone. This email type is disabled.' };
      if (included) return { label:rule.includeDefaultRecipients ? 'Current + group recipients' : 'Group subscription enabled', state:'custom',
        detail:'Explicitly included. Eligible members can receive this email; individual exclusions still apply.' };
      if (rule.includeDefaultRecipients) {
        if (['submitted','updated','completed'].includes(key)) {
          const detail = selectedGroup === 'role.admin' ? 'Administrator delivery follows the department responsible for this PCN event.'
            : selectedGroup === 'role.supplier' ? 'Suppliers receive these updates only for PCNs they own.'
              : 'General PCN updates for eligible internal members; individual exclusions still apply.';
          return { label:'Current recipients enabled', state:'current', detail };
        }
        return { label:'When assigned to this review', state:'current', detail:'Uses current Mail Routing for the active workflow step. Review reminders also follow the configured day limits.' };
      }
      if (rule.groupKeys.length || rule.userIds.length) return { label:'Custom recipients only', state:'custom',
        detail:'Not explicitly included. Members may receive through overlapping groups or individual choices.' };
      return { label:'No recipients selected', state:'off', detail:'No recipients selected. This type sends no email.' };
    }
    function renderGroupView() {
      el('notificationView').value = view;
      el('notificationGroupView').hidden = view !== 'group';
      el('notificationTypeView').hidden = view !== 'type';
      if (!snapshot) return;
      const group = snapshot.options.groups.find(item => item.key === selectedGroup);
      el('notificationOverviewGroup').value = group ? selectedGroup : '';
      el('notificationGroupRules').hidden = !group;
      el('notificationOverviewTitle').textContent = group ? group.label : 'Select a role or group';
      const included = KEYS.filter(key => snapshot.rules[key].groupKeys.includes(selectedGroup)).length;
      const enabled = KEYS.filter(key => snapshot.rules[key].enabled).length;
      const defaults = KEYS.filter(key => snapshot.rules[key].enabled && snapshot.rules[key].includeDefaultRecipients).length;
      el('notificationGroupSummary').textContent = group ? `${enabled} email types enabled system-wide · ${defaults} use current recipients · ${included} additional group selections`
        : 'Choose a role or group to see its six email settings.';
      for (const key of KEYS) {
        const type = snapshot.options.types.find(item => item.key === key), rule = snapshot.rules[key];
        el(`notificationGroupType-${key}`).textContent = type.label;
        el(`notificationGroupDescription-${key}`).textContent = type.description;
        el(`notificationGroupSelected-${key}`).checked = Boolean(group && rule.groupKeys.includes(selectedGroup));
        el(`notificationGroupSelected-${key}`).setAttribute('aria-label', `Include group ${group?.label || ''} for ${type.label}`);
        const delivery = group ? groupDelivery(key, rule, rule.groupKeys.includes(selectedGroup)) : null;
        el(`notificationGroupCurrent-${key}`).textContent = delivery?.label || '';
        el(`notificationGroupCurrent-${key}`).setAttribute('data-state', delivery?.state || 'off');
        el(`notificationGroupStatus-${key}`).textContent = delivery?.detail || '';
        el(`notificationGroupConfigure-${key}`).setAttribute('aria-label', `Edit ${type.label} details`);
      }
    }
    function renderUserPicker() {
      if (!snapshot) return;
      const query = el('notificationUserSearch').value.trim().toLowerCase();
      const users = snapshot.options.users.filter(user => `${user.displayName} ${user.employeeCode} ${user.email} ${user.department}`.toLowerCase().includes(query));
      el('notificationUserPicker').replaceChildren(option('', users.length ? 'Select a verified user' : 'No matching verified users'),
        ...users.map(user => option(user.id, userName(user.id))));
      el('notificationUserPicker').value = '';
      el('notificationSearchCount').textContent = `${users.length} verified ${users.length === 1 ? 'user' : 'users'} available.`;
    }
    function renderRule() {
      if (!snapshot) return;
      const rule = snapshot.rules[selected], type = snapshot.options.types.find(item => item.key === selected);
      el('notificationType').value = selected;
      el('notificationTypeTitle').textContent = type.label;
      el('notificationTypeDescription').textContent = type.description;
      el('notificationEnabled').checked = rule.enabled;
      el('notificationUseDefaults').checked = rule.includeDefaultRecipients;
      const selectedCount = rule.groupKeys.length + rule.userIds.length;
      el('notificationAudienceSummary').textContent = !rule.enabled ? 'Off · No emails of this type will be sent.'
        : !rule.includeDefaultRecipients && selectedCount === 0 ? 'No recipients selected · This type will send no emails.'
          : `${rule.includeDefaultRecipients ? 'Current recipients' : 'Custom recipients'} · ${rule.groupKeys.length} groups · ${rule.userIds.length} individual users · ${rule.excludedUserIds.length} excluded users`;
      el('notificationGroupPicker').replaceChildren(option('', 'Select a department or role'),
        ...snapshot.options.groups.filter(group => !rule.groupKeys.includes(group.key)).map(group => option(group.key, group.label)));
      el('notificationGroupPicker').value = '';
      chips('notificationSelectedGroups', rule.groupKeys.map(id => ({id,label:snapshot.options.groups.find(group => group.key === id)?.label || id})),
        id => setRule({groupKeys:rule.groupKeys.filter(key => key !== id)}), 'notificationGroupPicker');
      chips('notificationSelectedUsers', [...rule.userIds.map(id => ({id,label:userName(id),kind:'Receive'})),
        ...rule.excludedUserIds.map(id => ({id,label:userName(id),kind:'Exclude'}))],
        id => setRule({userIds:rule.userIds.filter(key => key !== id),excludedUserIds:rule.excludedUserIds.filter(key => key !== id)}), 'notificationUserPicker');
      el('notificationTotalEnabled').textContent = `${KEYS.filter(key => snapshot.rules[key].enabled).length} of ${KEYS.length} notification types enabled`;
      renderGroupView();
      changed();
    }
    function apply(value) {
      const next = parseSnapshot(value);
      snapshot = next; baseline = JSON.stringify(next.rules);
      const groups = [...next.options.groups].sort((a,b) => Number(!a.key.startsWith('role.')) - Number(!b.key.startsWith('role.')) || a.label.localeCompare(b.label));
      if (!groups.some(group => group.key === selectedGroup)) selectedGroup = '';
      el('notificationOverviewGroup').replaceChildren(option('', 'Choose a role or group'), ...groups.map(group => option(group.key, group.label)));
      el('notificationType').replaceChildren(...next.options.types.map(type => option(type.key, type.label)));
      el('notificationUserSearch').value = ''; renderUserPicker(); renderRule();
      const time = Date.parse(next.updatedAt);
      el('notificationSaved').textContent = next.updatedAt
        ? `Last saved by ${next.updatedBy || 'Administrator'} · ${Number.isFinite(time) ? new Date(time).toLocaleString() : 'Time unavailable'}`
        : 'Current delivery rules · No notification preferences saved yet';
    }
    function clear() {
      epoch++; active = false; busy = false; baseline = null; snapshot = null; selected = KEYS[0]; view = 'group'; selectedGroup = '';
      el('notificationEditor').hidden = true;
      for (const id of ['notificationType','notificationGroupPicker','notificationUserPicker','notificationSelectedGroups','notificationSelectedUsers','notificationOverviewGroup']) el(id).replaceChildren?.();
      for (const id of ['notificationUserSearch','notificationType','notificationGroupPicker','notificationUserPicker']) el(id).value = '';
      for (const id of ['notificationTypeTitle','notificationTypeDescription','notificationAudienceSummary','notificationSearchCount','notificationSaved','notificationTotalEnabled']) el(id).textContent = '';
      el('notificationEnabled').checked = false; el('notificationUseDefaults').checked = false; changed();
      el('notificationView').value = 'group'; el('notificationOverviewGroup').value = '';
      el('notificationGroupView').hidden = false; el('notificationTypeView').hidden = true; el('notificationGroupRules').hidden = true;
      el('notificationOverviewTitle').textContent = ''; el('notificationGroupSummary').textContent = '';
      for (const key of KEYS) {
        el(`notificationGroupSelected-${key}`).checked = false;
        for (const prefix of ['notificationGroupType-','notificationGroupDescription-','notificationGroupCurrent-','notificationGroupStatus-']) el(`${prefix}${key}`).textContent = '';
        el(`notificationGroupCurrent-${key}`).setAttribute('data-state', 'off');
        el(`notificationGroupSelected-${key}`).setAttribute('aria-label', 'Include group');
        el(`notificationGroupConfigure-${key}`).setAttribute('aria-label', 'Edit notification details');
      }
    }
    async function reload(confirmDiscard = true) {
      if (!allowed() || busy) return;
      if (confirmDiscard && dirty() && !root.confirm('Discard your unsaved notification changes and reload saved settings?')) return;
      const requestEpoch = epoch; busy = true; changed(); status('Loading notification settings…');
      try {
        const value = await root.PCN_SESSION.fetch('/api/admin/notification-preferences');
        if (!allowed() || epoch !== requestEpoch) return;
        apply(value); status('Notification settings loaded.');
      } catch (error) {
        if (!allowed() || epoch !== requestEpoch) return;
        if (error.status === 401 || error.status === 403) hooks.onDenied();
        else status(`${error.message || 'Unable to load notification settings.'} Your edits are preserved. Select Reload to retry.`, true);
      } finally { if (epoch === requestEpoch) { busy = false; changed(); } }
    }
    async function open() {
      if (!hooks.canUse() || busy) return;
      active = true; el('notificationEditor').hidden = false;
      await reload(false);
      if (allowed() && snapshot) el('notificationTitle').focus();
    }
    async function save() {
      if (!allowed() || busy || !dirty()) return;
      const requestEpoch = epoch; busy = true; changed(); status('Saving notification settings…');
      try {
        const value = await root.PCN_SESSION.fetch('/api/admin/notification-preferences', {
          method:'PUT',body:JSON.stringify({schemaVersion:1,version:snapshot.version,rules:copyRules(snapshot.rules)})
        });
        if (!allowed() || epoch !== requestEpoch) return;
        apply(value); status('Notification settings saved.');
      } catch (error) {
        if (!allowed() || epoch !== requestEpoch) return;
        if (error.status === 401 || error.status === 403) hooks.onDenied();
        else status(error.status === 409 ? 'Notification settings changed. Your edits are preserved. Select Reload to review the latest settings before saving again.'
          : `${error.message || 'Unable to save notification settings.'} Your edits are preserved.`, true);
      } finally { if (epoch === requestEpoch) { busy = false; changed(); } }
    }
    el('notificationView').addEventListener('change', () => {
      if (!allowed() || busy || !snapshot || !['group','type'].includes(el('notificationView').value)) return;
      view = el('notificationView').value; renderGroupView(); changed();
    });
    el('notificationOverviewGroup').addEventListener('change', () => {
      if (!allowed() || busy || !snapshot) return;
      const value = el('notificationOverviewGroup').value;
      selectedGroup = snapshot.options.groups.some(group => group.key === value) ? value : '';
      renderGroupView(); changed();
    });
    for (const key of KEYS) {
      el(`notificationGroupSelected-${key}`).addEventListener('change', () => {
        if (!allowed() || busy || !snapshot || !snapshot.options.groups.some(group => group.key === selectedGroup)) return;
        const groupKeys = snapshot.rules[key].groupKeys;
        updateRule(key, { groupKeys:el(`notificationGroupSelected-${key}`).checked ? [...new Set([...groupKeys, selectedGroup])].sort() : groupKeys.filter(group => group !== selectedGroup) });
        renderRule(); status(`${snapshot.options.groups.find(group => group.key === selectedGroup).label} ${el(`notificationGroupSelected-${key}`).checked ? 'included for' : 'removed from'} ${snapshot.options.types.find(type => type.key === key).label}. Save settings to apply.`);
      });
      el(`notificationGroupConfigure-${key}`).addEventListener('click', () => {
        if (!allowed() || busy || !snapshot) return;
        selected = key; view = 'type'; renderRule(); el('notificationType').focus();
      });
    }
    el('notificationType').addEventListener('change', () => {
      if (!allowed() || busy || !snapshot || !KEYS.includes(el('notificationType').value)) return;
      selected = el('notificationType').value; renderRule();
    });
    for (const [id,key] of [['notificationEnabled','enabled'],['notificationUseDefaults','includeDefaultRecipients']]) {
      el(id).addEventListener('change', () => { setRule({[key]:el(id).checked}); renderRule(); });
    }
    el('notificationUserSearch').addEventListener('input', () => { if (allowed() && !busy) { renderUserPicker(); controls(); } });
    el('notificationGroupPicker').addEventListener('change', controls);
    el('notificationUserPicker').addEventListener('change', controls);
    el('notificationAddGroup').addEventListener('click', () => {
      if (!allowed() || busy || !snapshot) return;
      const key = el('notificationGroupPicker').value;
      if (!snapshot.options.groups.some(group => group.key === key)) return;
      setRule({groupKeys:[...new Set([...snapshot.rules[selected].groupKeys,key])].sort()}); renderRule();
      status('Department / role group added.'); el('notificationGroupPicker').focus();
    });
    for (const [id,field,opposite] of [['notificationIncludeUser','userIds','excludedUserIds'],['notificationExcludeUser','excludedUserIds','userIds']]) {
      el(id).addEventListener('click', () => {
        if (!allowed() || busy || !snapshot) return;
        const userId = el('notificationUserPicker').value;
        if (!snapshot.options.users.some(user => user.id === userId)) return;
        setRule({[field]:[...new Set([...snapshot.rules[selected][field],userId])].sort(),[opposite]:snapshot.rules[selected][opposite].filter(key => key !== userId)});
        renderRule(); status(`User ${field === 'userIds' ? 'will receive' : 'is excluded from'} this notification type.`); el('notificationUserPicker').focus();
      });
    }
    el('notificationForm').addEventListener('submit', event => { event.preventDefault(); return save(); });
    controls();
    return {open,reload,save,clear,dirty,isBusy:()=>busy};
  }
  return {KEYS,parseSnapshot,create};
});

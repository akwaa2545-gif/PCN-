(function exposeRecovery(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PCN_DOCUMENT_RECOVERY = api;
})(typeof globalThis === 'object' ? globalThis : this, function recoveryFactory() {
  'use strict';
  const PREFIX = 'pcn.document-draft.v1:';
  const MAX_BYTES = 250 * 1024;
  const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

  function plainData(value, depth = 0, budget = {remaining:30000}) {
    if (--budget.remaining < 0 || depth > 12) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.every(item => plainData(item, depth + 1, budget));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.entries(value).every(([key,item]) =>
      !['__proto__','constructor','prototype'].includes(key) && plainData(item, depth + 1, budget));
  }

  function serialized(value) {
    if (!plainData(value)) throw new Error('Invalid recovery data');
    const raw = JSON.stringify(value);
    if (new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error('Recovery data too large');
    return raw;
  }

  function create(options) {
    const clock = options.now || Date.now;
    const startTimer = options.setTimeout || setTimeout;
    const stopTimer = options.clearTimeout || clearTimeout;
    const offered = new Set();
    let timer = null;
    let destroyed = false;

    function status(state, extra = {}) {
      options.onStatus?.({state,...extra});
    }

    function unavailable() {
      status('unavailable',{message:'Local draft recovery is unavailable. Save your document with Update PCN.'});
    }

    function context() {
      const current = options.getContext();
      if (!current || !current.ready || current.viewOnly || !current.userId) return null;
      const userId = String(current.userId);
      const recordId = current.recordId == null || current.recordId === '' ? 'new' : String(current.recordId);
      const version = String(current.version ?? '');
      if (userId.length > 256 || recordId.length > 256 || version.length > 256) return null;
      const key = `${PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(recordId)}`;
      return {userId,recordId,version,key,dirty:Boolean(current.dirty)};
    }

    function storage() {
      return options.storage || globalThis.localStorage;
    }

    function cancelTimer() {
      if (timer !== null) stopTimer(timer);
      timer = null;
    }

    function sameDocument(left, right) {
      return Boolean(left && right && left.key === right.key && left.version === right.version);
    }

    function persist(expected) {
      timer = null;
      if (destroyed) return;
      try {
        const current = context();
        if (!sameDocument(current,expected) || !current.dirty) return;
        const savedAt = clock();
        const draft = {schema:1,userId:current.userId,recordId:current.recordId,
          version:current.version,savedAt,snapshot:options.capture()};
        storage().setItem(current.key,serialized(draft));
        status('saved',{savedAt});
      } catch (_) {
        unavailable();
      }
    }

    function schedule() {
      cancelTimer();
      if (destroyed) return;
      try {
        const expected = context();
        if (expected?.dirty) timer = startTimer(()=>persist(expected),1000);
      } catch (_) {
        unavailable();
      }
    }

    function validDraft(draft, expected) {
      return draft?.schema === 1 && draft.userId === expected.userId && draft.recordId === expected.recordId &&
        typeof draft.version === 'string' && draft.version.length <= 256 && Number.isFinite(draft.savedAt) &&
        draft.savedAt <= clock() + 60000 && clock() - draft.savedAt <= MAX_AGE &&
        Object.hasOwn(draft,'snapshot') && plainData(draft.snapshot);
    }

    function readDraft(expected) {
      const raw = storage().getItem(expected.key);
      if (raw === null) return null;
      let draft;
      try {
        if (new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error('Oversized recovery draft');
        draft = JSON.parse(raw);
        if (!validDraft(draft,expected)) throw new Error('Invalid recovery draft');
      } catch (_) {
        storage().removeItem(expected.key);
        return null;
      }
      return draft;
    }

    function offerDraft(draft, expected) {
      const stale = draft.version !== expected.version;
      let consumed = false;
      const currentOffer = () => !destroyed && !consumed && sameDocument(context(),expected);
      const discard = () => {
        try {
          if (!currentOffer() || context().dirty) return false;
          // Another tab may have saved a newer local draft while this offer was open.
          const latest = readDraft(expected);
          if (!latest || serialized(latest) !== serialized(draft)) return false;
          cancelTimer();
          storage().removeItem(expected.key);
          consumed = true;
          status('cleared');
          return true;
        } catch (_) { unavailable(); return false; }
      };
      const restore = () => {
        try {
          if (!currentOffer() || stale || context().dirty) return false;
          const latest = readDraft(expected);
          if (!latest || serialized(latest) !== serialized(draft)) return false;
          options.restore(JSON.parse(serialized(draft.snapshot)));
          consumed = true;
          status('restored',{savedAt:draft.savedAt});
          return true;
        } catch (_) { unavailable(); return false; }
      };
      status(stale ? 'stale' : 'available',{savedAt:draft.savedAt});
      options.onOffer?.({savedAt:draft.savedAt,stale,restore,discard});
    }

    function check() {
      if (destroyed) return;
      try {
        const expected = context();
        if (!expected || expected.dirty) return;
        const token = JSON.stringify([expected.key,expected.version]);
        if (offered.has(token)) return;
        const draft = readDraft(expected);
        if (!draft) return;
        offered.add(token);
        offerDraft(draft,expected);
      } catch (_) { unavailable(); }
    }

    function clear(expectedSnapshot) {
      cancelTimer();
      if (destroyed) return false;
      try {
        const current = context();
        if (!current) return false;
        if (arguments.length && serialized(options.capture()) !== serialized(expectedSnapshot)) {
          schedule();
          return false;
        }
        storage().removeItem(current.key);
        status('cleared');
        return true;
      } catch (_) { unavailable(); return false; }
    }

    function destroy() {
      destroyed = true;
      cancelTimer();
      offered.clear();
    }

    return {schedule,check,clear,destroy};
  }

  return Object.freeze({create});
});

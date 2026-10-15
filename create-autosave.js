(function (root, factory) {
  const model = typeof module === 'object' && module.exports ? require('./create-model') : root.PCN_CREATE_MODEL;
  const api = factory(model);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PCN_CREATE_AUTOSAVE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model) {
  'use strict';
  const signatureActions=['prepared','checked','approved'];
  const at=(object,path)=>path.split('.').reduce((value,key)=>value?.[key],object);
  function editable(record) {
    if (!record) return true;
    if (record.status!=='draft') return false;
    const review=record.internalReview;
    if (signatureActions.some(action=>review?.supplierSignoff?.[action]?.checked===true)) return false;
    return !['signoff.gscTet','signoff.prodEngTet','signoff.qaTet','tapbu.gsc','tapbu.qa','qateFinal.signoff']
      .some(path=>signatureActions.some(action=>at(review,`${path}.${action}`)===true));
  }

  function create(options) {
    if (typeof options?.read!=='function' || typeof options.write!=='function') throw new TypeError('Autosave requires read and write callbacks.');
    const serialize=options.serialize || model.toPayload;
    const now=options.now || Date.now;
    const scheduleTimer=options.setTimeout || setTimeout;
    const cancelTimer=options.clearTimeout || clearTimeout;
    const debounceMs=options.debounceMs ?? 1500;
    const minIntervalMs=options.minIntervalMs ?? 10000;
    const clientDraftKey=options.clientDraftKey;
    let record=options.initialRecord || null;
    let baseline=record?JSON.stringify(serialize(record)):null;
    let state='idle',dirty=false,stopped=false,paused=false,lastError=null,lastSavedAt=null;
    let timer=null,pending=0,tail=Promise.resolve();

    function report(next, extra={}) {
      state=next;
      options.onStatus?.({state:next,...extra});
    }
    function clearTimer() {
      if (timer!==null) cancelTimer(timer);
      timer=null;
    }
    function enqueue(operation) {
      pending++;
      const result=tail.then(operation);
      tail=result.then(()=>{pending--;},()=>{pending--;});
      return result;
    }
    function differs() { return baseline!==JSON.stringify(serialize(options.read())); }
    function schedule() {
      clearTimer();
      if (!dirty || stopped || paused || !editable(record)) return;
      const throttle=lastSavedAt===null?0:Math.max(0,minIntervalMs-(now()-lastSavedAt));
      report('waiting');
      timer=scheduleTimer(()=>{
        timer=null;
        // Background errors are reported below; explicit flush and retry retain rejection for their callers.
        flush().catch(()=>{});
      },Math.max(debounceMs,throttle));
    }

    async function save(force, replayed=false) {
      if (stopped || !editable(record)) return record;
      if (paused) throw lastError;
      if (!dirty && !(force && !record)) return record;
      const raw=options.read();
      const snapshot=serialize(raw);
      if (record && baseline===JSON.stringify(snapshot)) {
        dirty=false;
        return record;
      }
      report('saving');
      try {
        const result=await options.write(snapshot,{clientDraftKey,id:record?.id,version:record?.version,
          ...(raw.isTestDocument===true?{testDocument:true}:{})});
        if (!result?.record?.id) throw new Error('Draft save did not return the saved record.');
        record=result.record;
        baseline=JSON.stringify(serialize(record));
        lastSavedAt=now();
        dirty=differs();
        if (!editable(record)) {
          clearTimer();
          if (!stopped) {
            options.onSaved?.({record,snapshot,reused:result.reused===true,unsavedChanges:dirty});
            dirty=differs();
            report('stopped',{savedAt:lastSavedAt,unsavedChanges:dirty,
              ...(dirty?{snapshot:serialize(options.read())}:{})});
          }
          return record;
        }
        // A lost POST response can return an older, atomically reused draft. Adopt its version,
        // then save current content before claiming that the current document has been saved.
        if (result.reused===true && dirty) {
          if (replayed) throw new Error('The existing draft could not be synchronized. Retry saving.');
          return await save(true,true);
        }
        if (!stopped) {
          options.onSaved?.({record,snapshot,reused:result.reused===true});
          dirty=differs();
          report('saved',{savedAt:lastSavedAt});
          if (dirty) schedule();
        }
        return record;
      } catch (error) {
        paused=true;
        dirty=true;
        lastError=error;
        clearTimer();
        if (!stopped) report(error?.status===409 || error?.statusCode===409?'conflict':'error',{error});
        throw error;
      }
    }

    function markDirty() {
      if (stopped || !editable(record)) return;
      dirty=differs();
      schedule();
    }
    function flush({force=false}={}) {
      clearTimer();
      return enqueue(()=>save(force));
    }
    function retry() {
      if (stopped || !editable(record)) return Promise.resolve(record);
      paused=false;
      lastError=null;
      return flush({force:true});
    }
    function adopt(next) {
      if (!next?.id) throw new TypeError('A saved record is required.');
      record=next;
      baseline=JSON.stringify(serialize(record));
      dirty=differs();
      if (!editable(record)) {
        clearTimer();
        report('stopped',{unsavedChanges:dirty,...(dirty?{snapshot:serialize(options.read())}:{})});
      }
      return record;
    }
    function exclusive(operation) {
      clearTimer();
      return enqueue(async()=>{
        try {
          // Edits can arrive while the prerequisite save is in flight. The operation must
          // receive the latest saved generation, or explicitly ask the user to finish editing.
          for (let attempt=0;attempt<3;attempt++) {
            dirty=differs();
            await save(true);
            clearTimer();
            if (stopped || !editable(record)) throw new Error('This document is no longer an editable draft.');
            dirty=differs();
            if (!dirty) break;
          }
          if (dirty) throw new Error('Finish editing the current changes, then try this action again.');
          const result=await operation(record);
          if (result?.record) adopt(result.record);
          return result;
        } catch (error) {
          if (error?.status===409 || error?.statusCode===409) {
            paused=true;
            lastError=error;
            report('conflict',{error});
          }
          throw error;
        } finally {
          if (dirty) schedule();
        }
      });
    }
    function stop() { stopped=true;clearTimer();report('stopped'); }
    function getState() { return {state,record,dirty,pending:pending>0,clientDraftKey,savedAt:lastSavedAt}; }
    return Object.freeze({markDirty,flush,retry,exclusive,adopt,stop,getState});
  }
  return Object.freeze({create});
});

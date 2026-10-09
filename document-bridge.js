(function (root) {
  'use strict';
  const signing = /^(supplierSignoff\.(approved|checked|prepared)\.(checked|name|date)|signoff\.[^.]+\.(approved|checked|prepared)(Name|Date)?|tapbu\.(gsc|qa)\.(approved|checked|prepared)(Name|Date)?|qateFinal\.signoff\.(approved|checked|prepared)(Name|Date)?|qateFinal\.(approve|reject))$/;
  function recoveryKey(control) {
    if (control.id) return `id:${control.id}`;
    if (control.dataset?.internalField) return `review:${control.dataset.internalField}`;
    if (control.dataset?.recoveryKey) return `row:${control.dataset.recoveryKey}`;
    return control.name ? `choice:${control.name}:${control.value}` : '';
  }
  function canRecoverControl(control) {
    return Boolean(recoveryKey(control) && !control.disabled && !control.readOnly &&
      !['hidden','button','submit','file'].includes(control.type) && !signing.test(control.dataset?.internalField || ''));
  }
  function captureControls(controls) {
    return Array.from(controls).filter(canRecoverControl).map(control => ({key:recoveryKey(control),type:control.type,
      value:['checkbox','radio'].includes(control.type) ? Boolean(control.checked) : String(control.value ?? '')}));
  }
  function applyControls(snapshot, getControls) {
    if (!Array.isArray(snapshot) || snapshot.length > 1000) return;
    for (const item of snapshot) {
      const control = Array.from(getControls()).find(candidate => recoveryKey(candidate) === item?.key);
      if (!control || !canRecoverControl(control) || item.type !== control.type) continue;
      if (['checkbox','radio'].includes(control.type)) {
        if (typeof item.value === 'boolean') control.checked = item.value;
      } else if (typeof item.value === 'string' && item.value.length <= 10000) control.value = item.value;
    }
  }
  function exportStamp(record, dirty) {
    const terminal = ['approved','rejected','closed'].includes(record.status);
    return {id:record.id || 'Unassigned',revision:record.documentControl?.contentRevision ? String(record.documentControl.contentRevision) : 'Not recorded',
      status:String(record.status || 'draft').toUpperCase().replace(/_/g,' '),watermark:dirty ? 'UNSAVED PREVIEW' : terminal ? '' : 'DRAFT'};
  }
  function recoveredRows(rows, formId, controls) {
    return rows.map(row => {
      const optionText=row.optionText || row.originalText || row.text;
      const values=Object.fromEntries(['text','currentCondition','newCondition'].map(field=> {
        const control=Array.from(controls).find(item=>item.dataset?.recoveryKey===`${formId}:${optionText}:${field}`);
        return [field,control && canRecoverControl(control) ? control.value : row[field]];
      }));
      return {...row,...values};
    });
  }
  function mount(options) {
    const doc = root.document;
    const getControls = () => doc.querySelectorAll('#submissionView input, #submissionView select, #submissionView textarea');
    const context = () => options.getContext();
    const recoveryContext = () => { const current=context(); return {userId:current.user?.id,recordId:current.record.id || 'new',
      version:current.savedRecord?.version || '',ready:current.ready,viewOnly:current.viewOnly || ['approved','rejected','closed'].includes(current.record.status),dirty:current.dirty}; };
    const status = doc.getElementById('documentRecoveryStatus');
    const offer = doc.getElementById('documentRecoveryOffer');
    const message = doc.getElementById('documentRecoveryMessage');
    const restoreButton = doc.getElementById('documentRecoveryRestore');
    const discardButton = doc.getElementById('documentRecoveryDiscard');
    let offered;
    const capture = () => captureControls(getControls());
    const recovery = root.PCN_DOCUMENT_RECOVERY.create({getContext:recoveryContext,capture,
      restore(snapshot) {
        const selectors = snapshot.filter(item => ['id:changeForm','id:riskLevel'].includes(item.key));
        applyControls(selectors,getControls);
        options.prepareRestore();
        applyControls(snapshot,getControls);
        options.finishRestore();
        offer.hidden=true;
      },
      onStatus(update) { status.textContent=update.state==='saved' ? `Recovery copy saved ${new Date(update.savedAt).toLocaleTimeString()}` :
        update.state==='unavailable' ? 'Draft recovery unavailable on this browser' : update.state==='restored' ? 'Recovered edits — save to update PCN' : ''; },
      onOffer(value) { offered=value; offer.hidden=false; restoreButton.hidden=value.stale;
        message.textContent=value.stale ? 'A recovery copy belongs to an older saved version. It cannot replace this document.' :
          `Unfinished edits found from ${new Date(value.savedAt).toLocaleString()}. Recover them to continue editing.`; }
    });
    restoreButton.addEventListener('click',()=> { if(offered?.restore()) offer.hidden=true; });
    discardButton.addEventListener('click',()=> { if(offered?.discard()) {offer.hidden=true;offered=null;} });
    const workspace = root.PCN_DOCUMENT_WORKSPACE.mount({...options,container:doc.getElementById('documentWorkspace')});
    const changed = event => {
      if (!event.target.closest?.('#submissionView')) return;
      root.queueMicrotask(()=> { workspace.render(); recovery.schedule(); });
    };
    doc.addEventListener('input',changed); doc.addEventListener('change',changed);
    const stampPrint = () => {
      const current=context(),stamp=exportStamp(current.savedRecord || current.record,current.dirty);
      doc.getElementById('documentPrintIdentity').textContent=`${stamp.id} · Content revision ${stamp.revision} · ${stamp.status}`;
      const watermark=doc.getElementById('documentPrintWatermark'); watermark.textContent=stamp.watermark; watermark.hidden=!stamp.watermark;
    };
    root.addEventListener('beforeprint',stampPrint);
    return {
      loaded() {offered=null;offer.hidden=true;recovery.check();workspace.refresh();},
      changed() {workspace.render();recovery.schedule();},
      submitted() {return capture();},
      saved(snapshot) {recovery.clear(snapshot);workspace.refresh();},
      discard() {recovery.clear();offer.hidden=true;},
      async exportPdf() {
        const current=context();
        if (!current.ready || current.dirty || !current.savedRecord?.id) {options.notify('warning','Save before exporting','Save the PCN before exporting its controlled copy.');return;}
        try {
          const latest=await options.apiFetch(`/api/pcns/${encodeURIComponent(current.savedRecord.id)}`);
          const now=context();
          if(now.dirty || now.savedRecord?.id!==latest.id || latest.version!==now.savedRecord?.version) {
            options.notify('warning','Document changed','Reload the latest saved revision before exporting.');return;
          }
          stampPrint(); root.print();
        } catch(error) {options.notify('error','Export unavailable',error.message);}
      },
      destroy() {recovery.destroy();workspace.destroy();doc.removeEventListener('input',changed);doc.removeEventListener('change',changed);root.removeEventListener('beforeprint',stampPrint);}
    };
  }
  const api={mount,recoveryKey,canRecoverControl,captureControls,applyControls,exportStamp,recoveredRows};
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.PCN_DOCUMENT_BRIDGE=api;
})(typeof window==='object' ? window : globalThis);

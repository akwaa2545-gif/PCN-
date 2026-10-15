(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.PCN_CREATE_UI = api; root.document.addEventListener('DOMContentLoaded', () => api.mount(root)); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const stages = ['details','changes','documents','review'];
  const labels = {details:'Details',changes:'Changes',documents:'Documents',review:'Review & submit'};
  function completion(checks) {
    const items = (checks?.items || []).filter(item => item.blocking);
    return {complete:items.filter(item => item.complete).length,total:items.length,missing:items.filter(item => !item.complete)};
  }
  function stageForIssue(issue) {
    const field = issue?.field || issue?.key || '';
    if (issue?.attachment || field.startsWith('internalReview.docs.') || field.includes('materialCodeDescription')) return 'documents';
    if (['supplierName','manufacturerName','materialName','changeForm','riskLevel'].includes(field)) return 'details';
    return field === 'version' ? 'review' : 'changes';
  }
  function testFillMode({savedRecord,hasContent}) { return savedRecord?.id ? 'confirm-new' : hasContent ? 'confirm-replace' : 'fill'; }
  function retryMode(status,record) { return status==='conflict'&&record?.id?'reload':'retry'; }
  function isPreviewMessage(event,expected) {
    const data=event?.data;
    return Boolean(expected && event.origin===expected.origin && event.source===expected.source &&
      data?.type==='pcn-document-preview' && ['ready','error'].includes(data.state) &&
      data.id===expected.id && data.version===expected.version && data.request===expected.request);
  }
  function canReuseClientKey({key,record,freshIdentity}) { return !record&&!freshIdentity&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key || ''); }
  function remainingErrors(errors,checks) {
    return errors.filter(issue=>{const check=checks.items.find(item=>item.key===issue.key);return !check || !check.complete;});
  }
  function createEntryGuard() {
    let generation=0;
    return {next:()=>++generation,current:token=>token===generation};
  }
  function notificationPreview(notification = {}) {
    if(notification.configurationStatus==='invalid')return 'Notification configuration needs attention. An administrator can check notification settings.';
    if(notification.configurationStatus!=='configured')return 'Notification sending is not configured. Your PCN can still be submitted.';
    return notification.recipientConfigured?'The action notification will be queued after submission.':'No action-mail recipient is configured. An administrator can check notification settings.';
  }
  function editableDraft(record) {
    if(record?.status!=='draft')return false;
    const review=record.internalReview || {},actions=['prepared','checked','approved'];
    if(actions.some(action=>review.supplierSignoff?.[action]?.checked===true))return false;
    return !['signoff.gscTet','signoff.prodEngTet','signoff.qaTet','tapbu.gsc','tapbu.qa','qateFinal.signoff'].some(path=>{
      const group=path.split('.').reduce((value,key)=>value?.[key],review);return actions.some(action=>group?.[action]===true);
    });
  }
  function savedDocument(model,current,update,serialize) {
    const record=update.record || update;
    const matches=update.unsavedChanges!==true && Boolean(update.snapshot) && JSON.stringify(serialize(current))===JSON.stringify(update.snapshot);
    const content=matches?model.toPayload(record):current;
    return {document:{...content,id:record.id,version:record.version,status:record.status,isTestDocument:record.isTestDocument===true},matches};
  }
  function notificationLabel(notification = {}) {
    const state = notification.state || notification.status;
    return ({pending:'Queued',queued:'Queued',sending:'Processing',processing:'Processing',sent:'Accepted by workflow',
      accepted:'Accepted by workflow',cancelled:'Cancelled',superseded:'Superseded',not_queued:'Not queued',not_required:'No notification required',
      not_configured:'Not configured',recipient_not_configured:'Recipient not configured'})[state] || 'Needs attention';
  }
  function createSubmission({autosave,api}) {
    let pending;
    async function run() {
      const flushed = await autosave.flush({force:true});
      return autosave.exclusive(async canonical => {
        const record = canonical || flushed;
        if (!record?.id || record.status !== 'draft') throw new Error('Open an editable draft before submitting.');
        const preflight = await api(`/api/pcn-drafts/${encodeURIComponent(record.id)}/preflight`, {method:'POST',body:JSON.stringify({version:record.version})});
        if (!preflight.checks?.ready) {
          const error = new Error('Complete the required items before submitting.');
          error.details = {missing:completion(preflight.checks).missing};
          throw error;
        }
        let saved;
        try {
          saved = await api(`/api/pcns/${encodeURIComponent(record.id)}`,{method:'PATCH',body:JSON.stringify({version:record.version,status:'submitted'})});
        } catch (error) {
          if (error.status && error.status < 500) throw error;
          let latest;
          try { latest = await api(`/api/pcns/${encodeURIComponent(record.id)}`); }
          catch { throw new Error('Submission was not confirmed. Your draft is kept; check its latest status before trying again.'); }
          if (latest.status === 'draft') throw new Error('Submission was not confirmed. Your draft is kept; review it and try submitting again.');
          saved = latest;
        }
        autosave.stop();
        try {
          const receipt = await api(`/api/pcns/${encodeURIComponent(saved.id)}/receipt?version=${encodeURIComponent(saved.version)}`);
          return {...receipt,id:saved.id,version:saved.version};
        } catch {
          return {id:saved.id,version:saved.version,nextAction:preflight.nextAction,
            notification:{state:'needs_attention',message:'Your PCN was submitted. Notification status could not be loaded; open the PCN to check its workflow.'}};
        }
      });
    }
    return {submit() {
      if (!pending) pending = run().finally(() => {pending = null;});
      return pending;
    }};
  }
  function mount(root) {
    const doc = root.document, model = root.PCN_CREATE_MODEL, readiness = root.PCN_READINESS;
    const $ = id => doc.getElementById(id);
    const state = {master:null,user:null,document:null,savedRecord:null,stage:'details',editable:true,
      canSetRequirements:false,scannerConfigured:false,documents:[],busy:false,errors:[],clientDraftKey:null,preflight:null};
    let autosave,documents,recovery,recoveryOffer,submission,receiptTimer,receiptPolls=0;
    let previewGeneration=0,previewExpected=null,previewTimer;
    const entryGuard=createEntryGuard(),receiptGuard=createEntryGuard();
    const api = (path,options) => root.PCN_SESSION.fetch(path,options);
    function node(tag,text,className) {
      const element = doc.createElement(tag);
      if (text !== undefined) element.textContent = String(text);
      if (className) element.className = className;
      return element;
    }
    function button(text,action,className='create-button') {
      const element = node('button',text,className); element.type='button';element.addEventListener('click',action);return element;
    }
    function uuid() {
      if (root.crypto.randomUUID) return root.crypto.randomUUID();
      const bytes = root.crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
      const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }
    function serialize(record) {
      const payload=model.toPayload(record);
      if (state.canSetRequirements) return payload;
      const {internalReview,...content}=payload;return content;
    }
    function checks() { return readiness.buildChecks(state.document || {},state.documents); }
    function notify(type,title,message,missing=[]) {
      $('createNotice').hidden=false;$('createNotice').dataset.type=type;
      $('noticeTitle').textContent=title;$('noticeMessage').textContent=message || '';
      $('noticeItems').replaceChildren(...missing.map(item=>{const li=node('li');li.append(button(`${item.label} →`,()=>focusIssue(item,true),'create-link'));return li;}));
    }
    function report(error) {
      state.errors=error.details?.missing || [];
      renderErrors();
      notify('error',state.errors.length?`Complete ${state.errors.length} required item${state.errors.length===1?'':'s'}`:'Action needs attention',error.message,state.errors);
      if (state.errors.length) focusIssue(state.errors[0]);
    }
    function confirm(title,message,accept='Continue') {
      const dialog=$('createConfirm');$('confirmTitle').textContent=title;$('confirmMessage').textContent=message;$('confirmAccept').textContent=accept;
      return new Promise(resolve=>{
        const close=()=>resolve(dialog.returnValue==='confirm');
        dialog.addEventListener('close',close,{once:true});dialog.showModal();$('confirmCancel').focus();
      });
    }
    function setBusy(value) {
      state.busy=value;
      $('createMutationLock').disabled=value||!state.editable;
      $('fillTestDocument').disabled=value;
      for (const id of ['saveDraftButton','nextStage','submitButton','previewDocument','refreshReview']) $(id).disabled=value||!state.editable;
      $('createEditor').setAttribute('aria-busy',String(value));
    }
    function saved(update) {
      const record=update.record || update;
      const firstSave=!state.savedRecord;
      state.savedRecord=record;
      const adopted=savedDocument(model,state.document,update,serialize),matches=adopted.matches;
      state.document=adopted.document;
      if (record.documentAttachments) state.documents=record.documentAttachments;
      state.editable=editableDraft(record);
      state.unsavedAfterReplay=update.unsavedChanges===true;
      $('draftIdentity').textContent=record.id;$('testDocumentBadge').hidden=state.document.isTestDocument!==true;
      root.history.replaceState(null,'',`/create?draft=${encodeURIComponent(record.id)}`);
      if(matches)recovery?.clear();else recovery?.schedule();renderProgress();renderErrors();
      if (matches) renderFields();
      if(firstSave&&record.status==='draft') void api(`/api/pcn-drafts/${encodeURIComponent(record.id)}`).then(result=>{
        if(state.savedRecord?.id!==record.id)return;
        state.scannerConfigured=result.scannerConfigured===true;documents?.render();
      }).catch(error=>notify('error','Document service status unavailable',error.message));
      if(update.unsavedChanges){
        $('saveRecoveryCopy').hidden=false;$('canonicalDocumentLink').hidden=false;$('canonicalDocumentLink').href=`/form.html?id=${encodeURIComponent(record.id)}`;
        $('draftStatusBadge').textContent=record.status;setBusy(false);renderFields();recovery?.schedule();
        notify('error','The saved PCN has already moved on','Your newer text remains on this page. Download it before opening the saved PCN; this document can no longer be autosaved.');
      }
    }
    function saveStatus(update) {
      const text=({idle:'Unsaved draft',waiting:'Unsaved changes',saving:'Saving…',saved:`Saved at ${new Date(update.savedAt || Date.now()).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`,
        error:root.navigator.onLine===false?'Offline · edits kept':'Save needs attention',conflict:'Document changed · edits kept',stopped:'Draft saving stopped'})[update.state] || 'Unsaved';
      $('draftSaveStatus').textContent=text;$('actionSaveStatus').textContent=text;
      if(['error','conflict'].includes(update.state))$('saveAnnouncement').textContent=text;
      $('retrySave').hidden=!['error','conflict'].includes(update.state);
      $('retrySave').textContent=retryMode(update.state,state.savedRecord)==='reload'?'Reload latest draft':'Retry save';
      if(update.state==='error'||update.state==='conflict') notify('error','Draft not saved',update.error?.message || text);
    }
    function createSaver(initialRecord=null) {
      autosave?.stop();
      autosave=root.PCN_CREATE_AUTOSAVE.create({read:()=>state.document,serialize,initialRecord,clientDraftKey:state.clientDraftKey,
        write:(document,meta)=>meta.id?api(`/api/pcn-drafts/${encodeURIComponent(meta.id)}`,{method:'PATCH',body:JSON.stringify({version:meta.version,document})}):
          api('/api/pcn-drafts',{method:'POST',body:JSON.stringify({clientDraftKey:meta.clientDraftKey,document,...(meta.testDocument?{testDocument:true}:{})})}),
        onSaved:saved,onStatus:saveStatus});
      submission=createSubmission({autosave,api});
      documents?.destroy();
      documents=root.PCN_CREATE_DOCUMENTS.mount({container:$('createDocuments'),api,autosave,
        getContext:()=>({record:state.document,savedRecord:state.savedRecord,editable:state.editable,canSetRequirements:state.canSetRequirements,scannerConfigured:state.scannerConfigured}),
        onChange:next=>changed(next),onSaved:record=>{saved(record);state.documents=record.documentAttachments || state.documents;renderProgress();},
        onAttachments:(files,identity)=>{if(state.savedRecord?.id===identity.id&&state.savedRecord?.version===identity.version){state.documents=files;renderProgress();}},notify});
      createRecovery();
    }
    function createRecovery() {
      recovery?.destroy();recoveryOffer=null;$('createRecovery').hidden=true;
      recovery=root.PCN_DOCUMENT_RECOVERY.create({
        getContext:()=>({userId:state.user.id,recordId:state.savedRecord?.id || state.clientDraftKey,version:state.savedRecord?.version || '',ready:true,viewOnly:!state.editable&&!state.unsavedAfterReplay,dirty:autosave.getState().dirty||state.unsavedAfterReplay}),
        capture:()=>({document:model.toPayload(state.document),isTestDocument:state.document.isTestDocument===true}),
        restore:snapshot=>{
          const test=state.savedRecord?state.savedRecord.isTestDocument===true:snapshot.isTestDocument===true;
          const restored=model.fromTemplate(snapshot.document,{canSetRequirements:state.canSetRequirements});
          if(!state.canSetRequirements&&state.savedRecord)restored.internalReview=model.toPayload(state.savedRecord).internalReview;
          state.document={...restored,...(test?{isTestDocument:true}:{})};
          changed(state.document);renderFields();$('createRecovery').hidden=true;
        },
        onOffer:offer=>{recoveryOffer=offer;$('createRecovery').hidden=false;$('restoreRecovery').hidden=offer.stale;
          $('recoveryMessage').textContent=offer.stale?'This recovery copy belongs to an older version. It cannot replace the saved draft.':'Recover unfinished edits from this browser, then save to update your draft.';},
        onStatus:update=>{if(update.state==='unavailable')notify('info','Browser recovery unavailable','Server draft saving is still available.');}
      });
      recovery.check();
    }
    function changed(next) {
      state.document=next;state.preflight=null;
      state.errors=remainingErrors(state.errors,checks());
      autosave.markDirty();recovery?.schedule();
      renderProgress();renderErrors();documents?.render();
      $('testDocumentBadge').hidden=state.document.isTestDocument!==true;
      $('sampleDateField').hidden=state.document.sampleSubmitted!=='yes';
    }
    function renderProgress() {
      const list=checks(),progress=completion(list);
      $('completionCount').textContent=`${progress.complete} of ${progress.total} required items complete`;
      $('completionProgress').max=progress.total || 1;$('completionProgress').value=progress.complete;
      $('completionItems').replaceChildren(...list.items.filter(item=>item.blocking).map(item=>{
        const li=node('li',undefined,item.complete?'is-complete':'');
        const control=button('',()=>focusIssue(item,true));control.append(node('span',item.complete?'✓':'○'),node('span',item.label));li.append(control);return li;
      }));
    }
    function renderErrors() {
      doc.querySelectorAll('[data-error]').forEach(element=>{
        const field=element.dataset.error,issue=state.errors.find(item=>item.field===field || item.key===field);
        element.id=`${field}Error`;element.textContent=issue?`${issue.label || field} is required.`:'';
        const control=$(field);if(control){control.setAttribute('aria-invalid',String(Boolean(issue)));if(issue)control.setAttribute('aria-describedby',element.id);else control.removeAttribute('aria-describedby');}
      });
    }
    function selectedOption() {
      const rows=state.document.changeRows || [];
      const row=rows.find(item=>item.text===state.document.selectedChange && item.risk===state.document.riskLevel);
      return state.master.formDefinitions[state.document.changeForm]?.riskOptions.find(option=>option.text===(row?.optionText || state.document.selectedChange));
    }
    function renderFields() {
      doc.querySelectorAll('[data-field]').forEach(control=>{control.value=state.document[control.dataset.field] ?? '';control.disabled=!state.editable;});
      renderCategories();renderAdditionalRows();$('sampleDateField').hidden=state.document.sampleSubmitted!=='yes';
      $('testDocumentBadge').hidden=state.document.isTestDocument!==true;renderErrors();
    }
    function renderCategories() {
      const select=$('changeCategory'),selected=selectedOption();
      select.replaceChildren(node('option','Select a change'));select.firstChild.value='';
      const options=state.master.formDefinitions[state.document.changeForm]?.riskOptions || [];
      for (const option of options.filter(item=>item.risk===state.document.riskLevel)) {const entry=node('option',option.text);entry.value=option.text;select.append(entry);}
      select.value=selected?.text || '';select.disabled=!state.editable;
    }
    function renderAdditionalRows() {
      const selected=selectedOption();
      const rows=(state.document.changeRows || []).filter(row=>row.optionText!==selected?.text);
      $('additionalChangeRows').replaceChildren(...rows.map(row=>{
        const section=node('section',undefined,'create-extra-row');section.append(node('h3',row.text));
        const fields=node('div',undefined,'create-fields');
        for (const [key,label] of [['currentCondition','Current condition'],['newCondition','New condition']]) {
          const wrapper=node('label',label,'create-field'),input=node('textarea');input.rows=3;input.maxLength=2000;input.value=row[key] || '';input.disabled=!state.editable;
          input.dataset.rowOption=row.optionText;input.dataset.rowField=key;
          input.addEventListener('input',()=>changed({...state.document,changeRows:state.document.changeRows.map(item=>item.optionText===row.optionText?{...item,[key]:input.value}:item)}));wrapper.append(input);fields.append(wrapper);
        }
        section.append(fields);return section;
      }));
    }
    function focusIssue(issue,dismiss=false) {
      if(dismiss)$('createNotice').hidden=true;
      const stage=stageForIssue(issue);showStage(stage,false);
      if(stage==='documents'){documents?.focusRequirement(issue.field || issue.key);return;}
      const field=issue.field || issue.key;
      const control=$(field) || (field.startsWith('changeRows')?$('currentCondition'):null) || $(`${stage}Title`);
      control?.focus();control?.scrollIntoView({block:'start',behavior:'auto'});
    }
    function showStage(stage,focus=true) {
      if(!stages.includes(stage))return;
      state.stage=stage;
      doc.querySelectorAll('[data-panel]').forEach(panel=>{panel.hidden=panel.dataset.panel!==stage;});
      doc.querySelectorAll('[data-stage]').forEach(control=>{if(control.dataset.stage===stage)control.setAttribute('aria-current','step');else control.removeAttribute('aria-current');});
      const index=stages.indexOf(stage);$('mobileStage').textContent=`Step ${index+1} of 4 · ${labels[stage]}`;
      $('previousStage').hidden=index===0;$('nextStage').hidden=index===3;$('submitButton').hidden=index!==3;
      if(stage==='review'){renderReview();void preflight(false);}
      if(stage==='documents') void documents?.refresh().catch(report);
      if(focus)$(`${stage}Title`)?.focus();
    }
    function renderReview() {
      const content=$('reviewSummary');content.replaceChildren();
      const groups=[['details','Supplier details',[['Supplier',state.document.supplierName],['Manufacturer',state.document.manufacturerName],['Material',state.document.materialName],['Change form',state.master.formDefinitions[state.document.changeForm]?.label],['Risk',state.document.riskLevel]]],
        ['changes','Proposed change',[['Change',state.document.selectedChange],['Current condition',state.document.currentCondition],['New condition',state.document.newCondition],['Reason',state.document.reason],['Target start',state.document.desiredStart],['Sample submission',state.document.sampleSubmitted==='pending'?'Not selected':state.document.sampleSubmitted],['Sample date',state.document.sampleSubmittedDate],['Sample location',state.document.sampleLocation],['Price',state.document.priceLevel],['Identification',state.document.identification]]],
        ['documents','Documents',checks().items.filter(item=>item.attachment).map(item=>[item.label,item.complete?'Ready':'Required file missing or awaiting scan'])]];
      for(const [stage,title,values]of groups){
        const section=node('section',undefined,'create-summary-section'),heading=node('div',undefined,'create-summary-heading'),edit=button('Edit',()=>showStage(stage),'create-link');edit.setAttribute('aria-label',`Edit ${title.toLowerCase()}`);heading.append(node('h3',title),edit);
        const list=node('dl');for(const [label,value]of values){list.append(node('dt',label),node('dd',value || 'Not provided'));}
        if(!values.length)list.append(node('dd','No required document categories selected.'));
        section.append(heading,list);content.append(section);
      }
    }
    async function preflight(showErrors=true) {
      if(state.busy)return;
      setBusy(true);
      try {
        const record=await autosave.flush({force:true});
        if(!record?.id) return;
        const result=await api(`/api/pcn-drafts/${encodeURIComponent(record.id)}/preflight`,{method:'POST',body:JSON.stringify({version:record.version})});
        state.preflight=result;
        $('nextActionLabel').textContent=result.nextAction?.label || 'No next signing action';
        $('nextActionPeople').textContent=(result.nextAction?.people || []).map(person=>person.displayName || person.employeeCode).join(', ') || 'See the responsible department and role above.';
        $('reviewMailStatus').textContent=notificationPreview(result.notification);
        if(showErrors&&!result.checks?.ready){state.errors=completion(result.checks).missing;renderErrors();notify('error',`Complete ${state.errors.length} required items`,'Your draft is saved. Complete these items before submitting.',state.errors);}
        return result;
      }catch(error){if(showErrors)report(error);else notify('error','Readiness check unavailable',error.message);}
      finally{setBusy(false);}
    }
    function renderReceipt(receipt,generation) {
      if(generation===undefined)generation=receiptGuard.next();
      if(!receiptGuard.current(generation))return;
      $('createEditor').hidden=true;$('createEntry').hidden=true;$('submissionReceipt').hidden=false;
      const identity=receipt.id || receipt.pcnId || state.savedRecord?.id;
      $('receiptIdentity').textContent=identity;$('receiptOpen').href=`/form.html?id=${encodeURIComponent(identity)}`;
      $('draftIdentity').textContent=identity;$('draftSaveStatus').textContent='Submitted';$('draftStatusBadge').textContent='Submitted';
      $('receiptDetails').replaceChildren();
      const action=receipt.nextAction || receipt.action || {};
      for(const [title,text]of [['Next responsibility',action.label || 'See the PCN workflow for the next action.'],['Action notification',notificationLabel(receipt.notification)],['Notification details',receipt.notification?.message || 'Workflow acceptance does not confirm mailbox delivery.']]){
        const row=node('div',undefined,'create-receipt-detail');row.append(node('strong',title),node('p',text));$('receiptDetails').append(row);
      }
      state.editable=false;recovery?.clear();$('fillTestDocument').hidden=true;
      if(!receiptPolls)$('receiptTitle').focus();
      const status=receipt.notification?.state || receipt.notification?.status;
      if(['pending','queued','sending','processing'].includes(status)&&receiptPolls++<6){
        clearTimeout(receiptTimer);receiptTimer=root.setTimeout(async()=>{try{const next=await api(`/api/pcns/${encodeURIComponent(identity)}/receipt?version=${encodeURIComponent(receipt.version || state.savedRecord?.version || '')}`);if(receiptGuard.current(generation))renderReceipt(next,generation);}catch(error){if(receiptGuard.current(generation))notify('error','Notification status unavailable',error.message);}},5000);
      }
    }
    async function submit() {
      if(state.busy)return;
      setBusy(true);
      try{const receipt=await submission.submit();renderReceipt(receipt);}
      catch(error){report(error);}
      finally{setBusy(false);}
    }
    async function begin(document,record=null,capabilities={}) {
      entryGuard.next();
      receiptGuard.next();clearTimeout(receiptTimer);
      state.document=document;state.savedRecord=record;state.documents=record?.documentAttachments || [];state.preflight=null;state.errors=[];state.unsavedAfterReplay=false;
      state.editable=capabilities.editable!==false;state.canSetRequirements=capabilities.canSetRequirements ?? state.canSetRequirements;
      state.scannerConfigured=capabilities.scannerConfigured===true;state.clientDraftKey=uuid();
      const query=new URLSearchParams(root.location.search),existing=query.get('client');
      if(canReuseClientKey({record,key:existing,freshIdentity:capabilities.freshIdentity}))state.clientDraftKey=existing;
      root.history.replaceState(null,'',record?`/create?draft=${encodeURIComponent(record.id)}`:`/create?client=${state.clientDraftKey}`);
      $('createEntry').hidden=true;$('createLoading').hidden=true;$('submissionReceipt').hidden=true;$('createEditor').hidden=false;$('fillTestDocument').hidden=false;
      $('draftIdentity').textContent=record?.id || 'New document';
      $('draftStatusBadge').textContent='Draft';$('saveRecoveryCopy').hidden=true;$('canonicalDocumentLink').hidden=true;
      createSaver(record);
      if(record){
        const savedAt=Date.parse(record.updatedAt);
        if(Number.isFinite(savedAt))saveStatus({state:'saved',savedAt});
        else{$('draftSaveStatus').textContent='Saved draft';$('actionSaveStatus').textContent='Saved draft';}
      }else saveStatus({state:'idle'});
      renderFields();renderProgress();showStage('details');setBusy(false);
      if(record)await documents.refresh().catch(report);
    }
    async function replaceAllowed(message='Start a new document? Your saved draft remains available to resume.') {
      if(!state.document)return true;
      if(!model.hasMeaningfulContent(state.document,state.master))return true;
      return confirm('Start another PCN?',message,'Start new PCN');
    }
    async function newDocument() {
      entryGuard.next();
      receiptGuard.next();clearTimeout(receiptTimer);
      if(!await replaceAllowed())return;
      autosave?.stop();documents?.destroy();recovery?.destroy();clearTimeout(receiptTimer);receiptPolls=0;
      state.document=null;state.savedRecord=null;$('createEditor').hidden=true;$('submissionReceipt').hidden=true;$('createEntry').hidden=false;$('entryChoices').hidden=true;
      $('draftIdentity').textContent='New document';$('draftSaveStatus').textContent='Choose how to begin';$('testDocumentBadge').hidden=true;$('fillTestDocument').hidden=true;
      $('draftStatusBadge').textContent='Draft';$('saveRecoveryCopy').hidden=true;$('canonicalDocumentLink').hidden=true;
      root.history.replaceState(null,'','/create');
      $('startTitle').focus();
    }
    async function fillTest() {
      entryGuard.next();
      const mode=testFillMode({savedRecord:state.savedRecord,hasContent:state.document&&model.hasMeaningfulContent(state.document,state.master)});
      if(mode!=='fill'&&!await confirm(mode==='confirm-new'?'Start a new testing document?':'Replace these values with test data?',mode==='confirm-new'?'A testing document needs a fresh draft. Your current draft remains available. No approval or file checks are skipped.':'Example values will replace the entered content. No approval or file checks are skipped.','Use test values'))return;
      root.history.replaceState(null,'','/create');
      await begin(model.sample(state.master));changed(state.document);
      notify('info','TESTING DOC','Example values are filled in. Review them before submitting; normal checks still apply.');
    }
    async function entryChoices(kind) {
      const generation=entryGuard.next();
      const container=$('entryChoices');container.hidden=false;container.replaceChildren();
      if(kind==='copy'){
        const label=node('label','PCN number to copy'),input=node('input');input.id='templatePcnId';input.placeholder='PCN-2026-0001';input.maxLength=20;label.append(input);
        const action=button('Copy document content',async()=>{
          const id=input.value.trim().toUpperCase();if(!/^PCN-\d{4}-\d{4}$/.test(id)){notify('error','Enter a PCN number','Use a PCN number such as PCN-2026-0001.');input.focus();return;}
          const request=entryGuard.next();action.disabled=true;
          try{const projection=await api(`/api/pcns/${id}/template`);if(!entryGuard.current(request))return;await begin(model.fromTemplate(projection,{canSetRequirements:state.canSetRequirements}),null,{freshIdentity:true});changed(state.document);}
          catch(error){if(entryGuard.current(request))report(error);}finally{action.disabled=false;}
        },'create-button create-primary');action.id='copyTemplate';container.append(label,action);input.focus();
      }else if(kind==='resume'){
        container.append(node('p','Loading your drafts…'));
        try{const drafts=await api('/api/pcn-drafts');if(!entryGuard.current(generation))return;const list=node('div',undefined,'create-choices-list');
          for(const draft of drafts){const control=button(`${draft.id} · ${draft.supplierName || 'Untitled supplier'}${draft.isTestDocument?' · TESTING DOC':''}`,async()=>{const request=entryGuard.next();control.disabled=true;try{const result=await api(`/api/pcn-drafts/${encodeURIComponent(draft.id)}`);if(entryGuard.current(request))await begin(result.record,result.record,result);}catch(error){if(entryGuard.current(request))report(error);}finally{control.disabled=false;}});control.dataset.draft=draft.id;list.append(control);}
          const summary=node('p',drafts.length?`${drafts.length} unfinished draft${drafts.length===1?'':'s'} saved to your account.`:'You have no unfinished drafts. Start a blank PCN to create one.');summary.setAttribute('role','status');
          container.replaceChildren(summary,...(drafts.length?[list]:[]));container.focus();
        }catch(error){if(entryGuard.current(generation)){report(error);container.replaceChildren(node('p','Your drafts could not be loaded. Try again.'));}}
      }else{
        const label=node('label','Choose a common change'),select=node('select');select.id='starterOption';
        const options=Object.values(state.master.formDefinitions).flatMap(form=>form.riskOptions.map(option=>({form,option})));
        options.forEach(({form,option},index)=>{const entry=node('option',`${form.label} · ${option.risk} · ${option.text}`);entry.value=index;select.append(entry);});label.append(select);
        const action=button('Use this starter',async()=>{const {form,option}=options[Number(select.value)];await begin(model.selectChange({...model.blank(state.master),changeForm:form.id},option),null,{freshIdentity:true});changed(state.document);},'create-button create-primary');action.id='useStarter';container.append(label,action);select.focus();
      }
    }
    function resetPreview() {
      previewGeneration++;previewExpected=null;root.clearTimeout(previewTimer);
      const frame=$('documentPreviewFrame');frame.hidden=true;frame.removeAttribute('src');
      setBusy(false);$('previewDocument').focus({preventScroll:true});
    }
    function closePreview() { if($('documentPreviewDialog').open)$('documentPreviewDialog').close(); }
    function receivePreviewMessage(event) {
      if(!$('documentPreviewDialog').open || !isPreviewMessage(event,previewExpected))return;
      root.clearTimeout(previewTimer);
      const status=$('documentPreviewStatus'),frame=$('documentPreviewFrame');
      if(event.data.state==='ready'){status.hidden=true;frame.hidden=false;}
      else{previewExpected=null;frame.hidden=true;status.hidden=false;status.dataset.state='error';status.textContent=typeof event.data.message==='string'?event.data.message:'The document could not be loaded. Close this preview and try again.';}
    }
    async function preview() {
      if(!state.savedRecord&&!model.hasMeaningfulContent(state.document,state.master)){notify('info','Add document details first','Enter some details before saving a draft for preview.');return;}
      if($('documentPreviewDialog').open)return;
      const request=++previewGeneration,dialog=$('documentPreviewDialog'),frame=$('documentPreviewFrame'),status=$('documentPreviewStatus');
      previewExpected=null;frame.hidden=true;status.hidden=false;status.dataset.state='loading';status.textContent='Saving your draft for preview…';
      dialog.showModal();$('closeDocumentPreview').focus();
      setBusy(true);
      try{
        const record=await autosave.flush({force:true});
        if(request!==previewGeneration || !dialog.open)return;
        if(!/^PCN-\d{4}-\d{4}$/.test(record?.id || '') || !/^[a-f0-9]{16}$/i.test(record?.version || ''))throw new Error('Save a draft before previewing the document.');
        const version=record.version.toLowerCase();
        previewExpected={source:frame.contentWindow,origin:root.location.origin,id:record.id,version,request:String(request)};
        status.textContent='Loading PCN document…';
        frame.src=`/document-preview?id=${encodeURIComponent(record.id)}&version=${encodeURIComponent(version)}&request=${request}`;
        previewTimer=root.setTimeout(()=>{
          if(request!==previewGeneration || !dialog.open)return;
          previewExpected=null;status.dataset.state='error';status.textContent='The preview is taking too long. Close it and try again.';
        },20000);
      }catch(error){
        if(request===previewGeneration && dialog.open){status.dataset.state='error';status.textContent=error.message || 'The document could not be loaded.';}
      }finally{if(request===previewGeneration)setBusy(false);}
    }
    function bind() {
      $('confirmCancel').addEventListener('click',()=>$('createConfirm').close('cancel'));$('confirmAccept').addEventListener('click',()=>$('createConfirm').close('confirm'));
      $('dismissNotice').addEventListener('click',()=>$('createNotice').hidden=true);
      $('closeDocumentPreview').addEventListener('click',closePreview);
      $('documentPreviewDialog').addEventListener('close',resetPreview);
      $('documentPreviewDialog').addEventListener('cancel',event=>{event.preventDefault();closePreview();});
      $('documentPreviewFrame').addEventListener('load',()=>{
        if(!$('documentPreviewDialog').open || !previewExpected)return;
        try{$('documentPreviewFrame').contentDocument?.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closePreview();}});}catch{/* Cross-origin redirects remain hidden until a valid preview message. */}
      });
      root.addEventListener('message',receivePreviewMessage);
      $('startBlank').addEventListener('click',()=>begin(model.blank(state.master)));
      $('startCommon').addEventListener('click',()=>entryChoices('starter'));$('startCopy').addEventListener('click',()=>entryChoices('copy'));$('startResume').addEventListener('click',()=>entryChoices('resume'));
      $('testDocument').addEventListener('click',fillTest);$('fillTestDocument').addEventListener('click',fillTest);$('newDocument').addEventListener('click',newDocument);$('receiptNew').addEventListener('click',newDocument);
      $('saveRecoveryCopy').addEventListener('click',()=>{
        const data=JSON.stringify({document:model.toPayload(state.document),isTestDocument:state.document.isTestDocument===true},null,2);
        const url=root.URL.createObjectURL(new root.Blob([data],{type:'application/json'})),link=node('a');link.href=url;link.download='pcn-unsaved-content.json';doc.body.append(link);link.click();link.remove();root.setTimeout(()=>root.URL.revokeObjectURL(url),1000);
      });
      $('saveDraftButton').addEventListener('click',async()=>{setBusy(true);try{await autosave.flush({force:true});notify('success','Draft saved','You can resume this document from your account on another computer.');}catch(error){report(error);}finally{setBusy(false);}});
      $('retrySave').addEventListener('click',async()=>{try{
        if(retryMode(autosave.getState().state,state.savedRecord)==='reload'){if(await confirm('Reload the latest draft?','Your current browser recovery copy stays separate. Loading the latest version will replace the fields on this page.','Reload draft')){const result=await api(`/api/pcn-drafts/${state.savedRecord.id}`);await begin(result.record,result.record,result);}}
        else await autosave.retry();
      }catch(error){report(error);}});
      $('restoreRecovery').addEventListener('click',()=>recoveryOffer?.restore());$('discardRecovery').addEventListener('click',()=>{recoveryOffer?.discard();$('createRecovery').hidden=true;});
      $('previewDocument').addEventListener('click',preview);$('refreshReview').addEventListener('click',()=>preflight());$('submitButton').addEventListener('click',submit);
      $('previousStage').addEventListener('click',()=>showStage(stages[stages.indexOf(state.stage)-1]));
      $('nextStage').addEventListener('click',()=>{const missing=completion(checks()).missing.filter(issue=>stageForIssue(issue)===state.stage);if(missing.length){state.errors=missing;renderErrors();notify('error',`Complete ${missing.length} required items`,'Your edits are kept. Complete these items to continue.',missing);focusIssue(missing[0]);return;}showStage(stages[stages.indexOf(state.stage)+1]);});
      doc.querySelectorAll('[data-stage]').forEach(control=>control.addEventListener('click',()=>showStage(control.dataset.stage)));
      doc.querySelectorAll('[data-field]').forEach(control=>{
        const field=control.dataset.field;
        if(['supplierName','materialName','changeForm','riskLevel','selectedChange','currentCondition','newCondition','reason','desiredStart','sampleSubmitted'].includes(field))control.setAttribute('aria-required','true');
        control.addEventListener(['SELECT'].includes(control.tagName)?'change':'input',()=>{
          if(!state.editable)return;
          if(field==='changeForm'){if(state.document.changeRows?.length&&!root.confirm('Changing the form clears its change categories. Continue?')){control.value=state.document.changeForm;return;}changed(model.changeForm(state.document,control.value,state.master));renderFields();}
          else if(field==='riskLevel'){changed({...state.document,riskLevel:control.value,selectedChange:'',currentCondition:'',newCondition:''});renderFields();}
          else if(['selectedChange','currentCondition','newCondition'].includes(field)&&selectedOption())changed(model.selectChange(state.document,selectedOption(),{[field==='selectedChange'?'text':field]:control.value}));
          else changed({...state.document,[field]:control.value});
        });
        control.addEventListener('blur',()=>{const issue=checks().items.find(item=>item.field===field&&item.blocking&&!item.complete);if(issue&&!state.errors.some(item=>item.key===issue.key)){state.errors=[...state.errors,issue];renderErrors();}});
      });
      $('changeCategory').addEventListener('change',()=>{const option=state.master.formDefinitions[state.document.changeForm]?.riskOptions.find(item=>item.text===$('changeCategory').value);if(option){changed(model.selectChange(state.document,option));renderFields();}});
      root.addEventListener('beforeunload',event=>{if(autosave?.getState().dirty){event.preventDefault();event.returnValue='';}});
      root.addEventListener('pagehide',()=>recovery?.schedule());
    }
    async function init() {
      bind();
      doc.querySelectorAll('#createEntry button').forEach(control=>control.disabled=true);
      try{
        const session=await root.PCN_SESSION.require(null,{requireRole:true});if(!session)return;state.user=session.user;
        root.PCN_SESSION.mountProfile(session.user,error=>report(error));
        state.canSetRequirements=(state.user.roles || []).some(role=>['admin','reviewer','gsc','developer'].includes(String(role).toLowerCase()));
        state.master=await api('/api/master-data');
        $('changeForm').replaceChildren(...Object.values(state.master.formDefinitions).map(form=>{const option=node('option',form.label);option.value=form.id;return option;}));
        const draft=new URLSearchParams(root.location.search).get('draft');
        if(draft){const result=await api(`/api/pcn-drafts/${encodeURIComponent(draft)}`);await begin(result.record,result.record,result);}
        else{$('createLoading').hidden=true;$('draftSaveStatus').textContent='Choose how to begin';}
      }catch(error){report(error);$('createLoading').textContent='The workspace could not be loaded. Refresh to try again.';}
      finally{doc.querySelectorAll('#createEntry button').forEach(control=>control.disabled=!state.master);}
    }
    void init();
    return {getState:()=>state,destroy(){entryGuard.next();receiptGuard.next();previewGeneration++;previewExpected=null;root.clearTimeout(previewTimer);root.removeEventListener('message',receivePreviewMessage);closePreview();$('documentPreviewFrame').removeAttribute('src');autosave?.stop();documents?.destroy();recovery?.destroy();clearTimeout(receiptTimer);}};
  }
  return Object.freeze({completion,stageForIssue,testFillMode,retryMode,isPreviewMessage,canReuseClientKey,remainingErrors,createEntryGuard,notificationPreview,editableDraft,savedDocument,notificationLabel,createSubmission,mount});
});

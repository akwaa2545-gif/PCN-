(function (root) {
  'use strict';
  const terminalStatuses = new Set(['approved','rejected','closed']);
  const allowedTypes = new Set(['application/pdf','image/png','image/jpeg','text/plain']);
  function canMutate(context) {
    const record = context.savedRecord || context.record;
    return Boolean(context.ready && !context.dirty && !context.viewOnly && record?.id && record.version && !terminalStatuses.has(String(record.status).toLowerCase()));
  }
  function canDownload(file) { return file.scanStatus === 'clean'; }
  function asItems(value) {
    if (Array.isArray(value)) return value;
    const list=value?.items || value?.revisions || value?.documents;
    return Array.isArray(list) ? list : [];
  }
  function normalizeRevision(entry) {
    return {...entry,number:entry.number ?? entry.revision ?? entry.contentRevision,reason:entry.reason || entry.snapshot?.documentControl?.revisionReason,changes:Array.isArray(entry.changes) ? entry.changes : []};
  }
  function displayValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) return value.map(displayValue).join(', ');
    if (typeof value === 'object') return Object.keys(value).sort().map(key => `${key}: ${displayValue(value[key])}`).join('; ');
    return String(value);
  }
  function formatSize(bytes) {
    const value = Math.max(0,Number(bytes) || 0);
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${value} B`;
  }
  function downloadName(name) { return String(name || 'document').replace(/[\\/\x00-\x1f]/g,'_'); }
  function filePayload(file,base64,version,requirementName) {
    if (!allowedTypes.has(file.type)) throw new Error('Choose a PDF, PNG, JPG, or text file.');
    if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('Choose a nonempty file up to 10 MiB.');
    return {fileName:file.name,contentType:file.type,base64,version,...(requirementName ? {requirementName} : {})};
  }
  function mount(options) {
    const {container,getContext,apiFetch} = options;
    if (!container || typeof getContext !== 'function' || typeof apiFetch !== 'function') throw new Error('Document workspace requires a container, context, and API client.');
    const doc = container.ownerDocument;
    let data = {history:[],documents:[],checks:null,action:null,errors:{}};
    let tab = 'history';
    let generation = 0;
    let busy = false;
    function setBusy(value) {busy=value;options.onMutationBusy?.(value);}
    let destroyed = false;
    let dataKey = '';
    let dialogSequence = 0;
    const dialogs = new Set();
    const urls = new Set();
    const identity = () => {
      const context = getContext();
      const record = context.savedRecord || context.record || {};
      return {context,record,key:`${record.id || ''}:${record.version || ''}`};
    };
    const current = (key) => !destroyed && identity().key === key;
    const endpoint = (record,tail) => `/api/pcns/${encodeURIComponent(record.id)}/${tail}`;
    function node(tag,text,className) {
      const element = doc.createElement(tag);
      if (text !== undefined) element.textContent = String(text);
      if (className) element.className = className;
      return element;
    }
    function button(text,handler,className,disabled = false) {
      const element = node('button',text,className);
      element.type = 'button';
      element.disabled = disabled;
      element.addEventListener('click',handler);
      return element;
    }
    function report(error,title = 'Document action failed') {
      const message = error?.message || 'The document service could not complete this action.';
      options.notify?.('error',title,message);
      if (!destroyed) {
        const notice = container.querySelector('[data-workspace-notice]');
        if (notice) { notice.textContent = message; notice.hidden = false; }
      }
    }
    function contextHint(context) {
      if (!context.ready) return 'Document services are loading.';
      if (!(context.savedRecord || context.record)?.id) return 'Save this PCN to use history and attachments.';
      if (context.dirty) return 'Save your document changes before uploading files, starting a revision, or exporting.';
      return '';
    }
    function createDialog(title) {
      const dialog = node('dialog',undefined,'dw-dialog');
      const heading = node('h2',title);
      heading.id = `dw-dialog-${++dialogSequence}`;
      dialog.setAttribute('aria-labelledby',heading.id);
      dialog.append(heading);
      doc.body.append(dialog);
      dialogs.add(dialog);
      dialog.addEventListener('close',() => { dialogs.delete(dialog); dialog.remove(); },{once:true});
      dialog.addEventListener('click',event => event.stopPropagation());
      dialog.addEventListener('keydown',event => {
        if (event.key === 'Escape') { event.stopPropagation(); return; }
        if (event.key !== 'Tab') return;
        const controls = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]')].filter(item => !item.hidden);
        const first = controls[0],last = controls.at(-1);
        if (event.shiftKey && doc.activeElement === first) {event.preventDefault();last?.focus();}
        else if (!event.shiftKey && doc.activeElement === last) {event.preventDefault();first?.focus();}
      });
      return dialog;
    }
    function confirm(title,message,{reasonRequired = false,actionText = 'Continue'} = {}) {
      return new Promise(resolve => {
        const dialog = createDialog(title);
        dialog.append(node('p',message,'dw-dialog-copy'));
        let reason;
        if (reasonRequired) {
          const label = node('label','Reason for revision','dw-label');
          reason = node('textarea');
          reason.rows = 3;
          reason.maxLength = 1000;
          reason.required = true;
          label.append(reason);
          dialog.append(label);
        }
        const actions = node('div',undefined,'dw-dialog-actions');
        actions.append(button('Cancel',() => dialog.close('cancel'),'dw-button'),button(actionText,() => {
          if (reasonRequired && !reason.value.trim()) {reason.setCustomValidity('Enter a reason for this revision.');reason.reportValidity();return;}
          dialog.close('confirm');
        },'dw-button dw-button-primary'));
        dialog.append(actions);
        dialog.addEventListener('close',() => resolve(dialog.returnValue === 'confirm' ? {reason:reason?.value.trim()} : null),{once:true});
        reason?.addEventListener('input',() => reason.setCustomValidity(''));
        dialog.showModal();
        (reason || actions.firstElementChild).focus();
      });
    }
    function empty(text) { return node('p',text,'dw-empty'); }
    function errorFor(name,parent) {
      if (!data.errors[name]) return false;
      parent.append(node('p',data.errors[name],'dw-error'));
      return true;
    }
    function renderAction(parent,context) {
      const action = node('section',undefined,'dw-action');
      action.append(node('h3','Next action'));
      if (errorFor('action',action)) {parent.append(action);return;}
      if (!data.action) action.append(empty('Loading workflow responsibility…'));
      else {
        const next = data.action;
        action.append(node('strong',next.terminal ? 'Workflow complete' : next.label || [next.department,next.step || next.signingStep].filter(Boolean).join(' — ') || 'Awaiting submission'));
        if (next.message) action.append(node('p',next.message,'dw-muted'));
        const people = asItems(next.people).map(person => person.displayName || person.employeeCode).filter(Boolean);
        if (people.length) action.append(node('p',people.join(', '),'dw-people'));
        if (next.canAct && next.field && !context.viewOnly) action.append(button('Go to signing box',() => options.focusField?.(next.field),'dw-button dw-button-primary'));
      }
      parent.append(action);
    }
    function renderHistory(parent,context,record) {
      const toolbar = node('div',undefined,'dw-panel-toolbar');
      toolbar.append(node('h3','Saved history'));
      const canStart = Boolean(data.historyCapabilities?.canStartRevision ?? context.canStartRevision);
      if (canStart) toolbar.append(button('Start new revision',startRevision,'dw-button',busy || context.dirty || context.viewOnly));
      parent.append(toolbar);
      if (errorFor('history',parent)) return;
      if (!data.history.length) {parent.append(empty('No revision history is available for this PCN.'));return;}
      const list = node('ol',undefined,'dw-revisions');
      for (const raw of data.history) {
        const entry = normalizeRevision(raw);
        const item = node('li');
        const open = button(`Save ${entry.number ?? '—'}`,() => showRevision(entry,record),'dw-revision-link');
        item.append(open,node('span',[entry.contentRevision ? `Content revision ${entry.contentRevision}` : '',entry.reason || entry.event || entry.status || 'Saved document'].filter(Boolean).join(' · '),'dw-revision-reason'));
        item.append(node('span',[entry.createdBy?.displayName || entry.createdBy || entry.changedBy || entry.actor,formatDate(entry.createdAt || entry.changedAt || entry.savedAt)].filter(Boolean).join(' · '),'dw-muted'));
        list.append(item);
      }
      parent.append(list);
    }
    async function showRevision(entry,record) {
      const key = identity().key;
      try {
        const result = await apiFetch(endpoint(record,`revisions/${encodeURIComponent(entry.number)}`));
        if (!current(key)) return;
        const detail = normalizeRevision(result);
        const dialog = createDialog(`Save ${detail.number ?? entry.number}`);
        if(detail.contentRevision)dialog.append(node('p',`Content revision ${detail.contentRevision}`,'dw-muted'));
        dialog.append(node('p',detail.reason || entry.reason || 'Saved document revision','dw-dialog-copy'));
        const changes = detail.changes;
        if (changes.length) {
          const scroll = node('div',undefined,'dw-change-scroll');
          const table = node('table',undefined,'dw-changes');
          const head = node('thead'),row = node('tr');
          ['Field','Previous','Saved'].forEach(text => row.append(node('th',text)));
          head.append(row);table.append(head);
          const body = node('tbody');
          for (const change of changes) {
            const changeRow = node('tr');
            changeRow.append(node('th',change.label || change.field || change.path || 'Document field'),node('td',displayValue(change.before)),node('td',displayValue(change.after)));
            body.append(changeRow);
          }
          table.append(body);scroll.append(table);dialog.append(scroll);
        } else dialog.append(empty('No field differences were recorded for this revision.'));
        if (detail.snapshot) {
          const snapshot = node('details');
          snapshot.append(node('summary','View saved document data'),node('pre',JSON.stringify(detail.snapshot,null,2),'dw-snapshot'));
          dialog.append(snapshot);
        }
        const actions = node('div',undefined,'dw-dialog-actions');
        actions.append(button('Close',() => dialog.close(),'dw-button dw-button-primary'));dialog.append(actions);
        dialog.showModal();actions.firstElementChild.focus();
      } catch (error) {if(current(key)) report(error,'Could not load revision');}
    }
    async function startRevision() {
      const before = identity();
      if (busy || before.context.dirty || before.context.viewOnly) return;
      const answer = await confirm('Start a new revision','Existing signatures stay in history. The revised document must pass its signing steps again.',{reasonRequired:true,actionText:'Start revision'});
      if (!answer || !current(before.key) || getContext().dirty) return;
      setBusy(true);render();
      try {
        const result = await apiFetch(endpoint(before.record,'revisions'),{method:'POST',body:JSON.stringify({version:before.record.version,reason:answer.reason})});
        if (!current(before.key)) return;
        await options.onStartRevision?.(result);
        await refresh();
      } catch (error) {if(current(before.key)) report(error,'Could not start revision');}
      finally {setBusy(false);if(!destroyed) render();}
    }
    function renderDocuments(parent,context,record) {
      const toolbar = node('div',undefined,'dw-panel-toolbar');
      toolbar.append(node('h3','Supporting files'));
      if (!context.viewOnly) toolbar.append(button('Upload file',() => chooseFile(record),'dw-button dw-button-primary',busy || !canMutate(context)));
      parent.append(toolbar);
      if (errorFor('documents',parent)) return;
      if (!data.documents.length) {parent.append(empty('No supporting files have been uploaded.'));return;}
      const list = node('ul',undefined,'dw-files');
      for (const file of data.documents) {
        const item = node('li');
        const description = node('div',undefined,'dw-file-description');
        description.append(node('strong',file.fileName || 'Document'),node('span',[formatSize(file.sizeBytes),file.requirementName,file.contentRevision ? `Revision ${file.contentRevision}` : ''].filter(Boolean).join(' · '),'dw-muted'));
        description.append(node('span',[file.uploadedBy?.displayName || file.uploadedBy,formatDate(file.uploadedAt)].filter(Boolean).join(' · '),'dw-muted'));
        if (!canDownload(file)) description.append(node('span',file.scanStatus === 'pendingScan' ? 'Awaiting security scan' : `Download unavailable: ${file.scanStatus || 'scan status unknown'}`,'dw-file-status'));
        item.append(description);
        const actions = node('div',undefined,'dw-file-actions');
        if (canDownload(file)) {
          if (['application/pdf','image/png','image/jpeg','text/plain'].includes(file.contentType)) actions.append(button(file.contentType === 'application/pdf' ? 'Open PDF' : 'Preview',() => readFile(file,record,true),'dw-button',busy));
          actions.append(button('Download',() => readFile(file,record,false),'dw-button',busy));
        }
        if (!context.viewOnly) actions.append(button('Remove',() => removeFile(file,record),'dw-button dw-button-danger',busy || !canMutate(context)));
        item.append(actions);list.append(item);
      }
      parent.append(list);
    }
    function chooseFile(record) {
      if (!canMutate(getContext()) || busy) return;
      const key = identity().key;
      const input = node('input');input.type='file';input.accept='.pdf,.png,.jpg,.jpeg,.txt';
      input.addEventListener('change',async () => {
        const file = input.files?.[0];
        if (!file || !current(key) || !canMutate(getContext())) return;
        let payload;
        try {payload=filePayload(file,'',record.version);} catch(error) {report(error);return;}
        const dialog=createDialog('Upload supporting file');
        dialog.append(node('p',`${file.name} · ${formatSize(file.size)}`,'dw-dialog-copy'));
        const label=node('label','Required document category (optional)','dw-label');
        const select=node('select');select.append(node('option','Other supporting file'));
        select.firstElementChild.value='';
        const requirements=asItems(data.checks?.items).filter(item=>item.attachment || item.requirementName);
        for(const item of requirements){const option=node('option',item.label);option.value=item.requirementName || item.key;select.append(option);}
        label.append(select);dialog.append(label);
        dialog.append(node('p','The file remains unavailable for download until a trusted security scan clears it.','dw-muted'));
        const actions=node('div',undefined,'dw-dialog-actions');
        actions.append(button('Cancel',()=>dialog.close(),'dw-button'),button('Upload',async()=>{
          if(!current(key)||!canMutate(getContext())||busy){dialog.close();return;}
          setBusy(true);dialog.close();render();
          try {
            const bytes=new Uint8Array(await file.arrayBuffer());
            if(!current(key)||!canMutate(getContext()))return;
            let binary='';for(let offset=0;offset<bytes.length;offset+=8192) binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
            payload={...payload,base64:root.btoa(binary),...(select.value ? {requirementName:select.value}: {})};
            const result=await apiFetch(endpoint(record,'documents'),{method:'POST',body:JSON.stringify(payload)});
            if(!current(key))return;
            await options.onSavedFile?.(result);await refresh();
          }catch(error){if(current(key))report(error,'Upload failed');}
          finally{setBusy(false);if(!destroyed)render();}
        },'dw-button dw-button-primary'));
        dialog.append(actions);dialog.showModal();select.focus();
      },{once:true});
      input.click();
    }
    async function removeFile(file,record) {
      const key=identity().key;
      if(!canMutate(getContext())||busy)return;
      const answer=await confirm('Remove supporting file',`Remove ${file.fileName}? This removes the active attachment from this PCN.`,{actionText:'Remove file'});
      if(!answer||!current(key)||!canMutate(getContext()))return;
      setBusy(true);render();
      try {
        const result=await apiFetch(endpoint(record,`documents/${encodeURIComponent(file.id)}`),{method:'DELETE',body:JSON.stringify({version:record.version})});
        if(!current(key))return;
        await options.onSavedFile?.(result);await refresh();
      }catch(error){if(current(key))report(error,'Could not remove file');}
      finally{setBusy(false);if(!destroyed)render();}
    }
    async function readFile(file,record,preview) {
      if(!canDownload(file))return;
      const key=identity().key;
      try {
        const response=await root.fetch(endpoint(record,`documents/${encodeURIComponent(file.id)}`),{credentials:'same-origin',cache:'no-store'});
        if(!response.ok) throw new Error(response.status===423 ? 'This file has not passed its security scan.' : `Could not read this file (${response.status}).`);
        const receivedType=response.headers.get('content-type')?.split(';')[0].trim();
        if(receivedType && receivedType!==file.contentType) throw new Error('The stored file type does not match its metadata.');
        const blob=await response.blob();if(!current(key))return;
        if(preview&&file.contentType==='text/plain') {
          const text=await blob.text();if(!current(key))return;
          showPreview(file,node('pre',text,'dw-text-preview'));
        }else {
          const url=root.URL.createObjectURL(blob);urls.add(url);
          if(preview) {
            let content;
            if(file.contentType==='application/pdf') {
              content=node('div');content.append(node('p','Open this scanned PDF in your browser viewer, or download it.','dw-dialog-copy'));
              const pdfActions=node('div',undefined,'dw-dialog-actions');
              const open=node('a','Open in PDF viewer','dw-button dw-button-primary');
              open.href=url;open.target='_blank';open.rel='noopener noreferrer';
              const download=node('a','Download PDF','dw-button');download.href=url;download.download=downloadName(file.fileName);
              pdfActions.append(open,download);content.append(pdfActions);
            } else {
              content=node('img');content.src=url;content.alt=file.fileName;content.className='dw-image-preview';
            }
            const dialog=showPreview(file,content);
            dialog.addEventListener('close',()=>{root.URL.revokeObjectURL(url);urls.delete(url);},{once:true});
          }else {
            const link=node('a');link.href=url;link.download=downloadName(file.fileName);doc.body.append(link);link.click();link.remove();
            root.setTimeout(()=>{root.URL.revokeObjectURL(url);urls.delete(url);},1000);
          }
        }
      }catch(error){if(current(key))report(error,'Could not open file');}
    }
    function showPreview(file,content) {
      const dialog=createDialog(file.fileName || 'Document preview');dialog.append(content);
      const actions=node('div',undefined,'dw-dialog-actions');actions.append(button('Close',()=>dialog.close(),'dw-button dw-button-primary'));
      dialog.append(actions);dialog.showModal();actions.firstElementChild.focus();return dialog;
    }
    function renderChecks(parent) {
      parent.append(node('h3','Saved document checklist'));
      if(errorFor('checks',parent))return;
      if(!data.checks){parent.append(empty('Loading document checks…'));return;}
      const items=asItems(data.checks.items);
      parent.append(node('p',data.checks.ready ? 'Required checks are complete.' : 'Complete the required items before advancing.','dw-check-summary'));
      const list=node('ul',undefined,'dw-checks');
      for(const item of items){
        const row=node('li',undefined,item.complete ? 'dw-check-complete' : 'dw-check-missing');
        row.append(node('span',item.complete ? '✓' : '!', 'dw-check-mark'));
        const text=node('div');text.append(node('strong',item.label),node('span',item.complete ? 'Complete' : item.blocking ? 'Required' : 'Optional','dw-muted'));row.append(text);
        if(item.field&&!item.complete)row.append(button('Go to field',()=>options.focusField?.(item.field),'dw-button'));
        list.append(row);
      }
      parent.append(list);
    }
    function render() {
      if(destroyed)return;
      const {context,record,key}=identity();
      if(dataKey!==key){data={history:[],documents:[],checks:null,action:null,errors:{}};dataKey=key;}
      container.replaceChildren();container.classList.add('document-workspace');
      const header=node('div',undefined,'dw-header');header.append(node('h2','Document control'));
      header.append(button('Print / PDF',()=>{if(!getContext().dirty) getContext().exportPdf?.();},'dw-button',busy||!context.ready||!record.id||context.dirty||typeof context.exportPdf!=='function'));
      container.append(header);
      const notice=node('p','','dw-error');notice.dataset.workspaceNotice='';notice.hidden=true;notice.setAttribute('role','alert');container.append(notice);
      const hint=contextHint(context);if(hint)container.append(node('p',hint,'dw-hint'));
      if(!record.id)return;
      renderAction(container,context);
      const tabs=node('div',undefined,'dw-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Document control');
      const labels={history:'History',documents:'Attachments',checks:'Checks'};
      for(const name of Object.keys(labels)){
        const control=button(labels[name],()=>{tab=name;render();container.querySelector(`#dw-tab-${name}`)?.focus();},'dw-tab');
        control.id=`dw-tab-${name}`;control.setAttribute('role','tab');control.setAttribute('aria-selected',String(tab===name));control.setAttribute('aria-controls','dw-panel');control.tabIndex=tab===name ? 0 : -1;
        control.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const names=Object.keys(labels),index=names.indexOf(name);tab=event.key==='Home' ? names[0] : event.key==='End' ? names.at(-1) : names[(index+(event.key==='ArrowRight'?1:2))%3];render();container.querySelector(`#dw-tab-${tab}`)?.focus();});
        tabs.append(control);
      }
      container.append(tabs);
      const panel=node('section',undefined,'dw-panel');panel.id='dw-panel';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',`dw-tab-${tab}`);panel.tabIndex=0;
      if(tab==='history')renderHistory(panel,context,record);
      else if(tab==='documents')renderDocuments(panel,context,record);
      else renderChecks(panel);
      container.append(panel);
    }
    async function refresh() {
      const initial=identity();const sequence=++generation;
      render();
      if(!initial.context.ready||!initial.record.id){data={history:[],documents:[],checks:null,action:null,errors:{}};render();return;}
      const results=await Promise.allSettled(['revisions','documents','checks','action'].map(name=>apiFetch(endpoint(initial.record,name))));
      if(sequence!==generation||!current(initial.key))return;
      const names=['history','documents','checks','action'];const next={history:[],documents:[],checks:null,action:null,errors:{}};
      results.forEach((result,index)=>{const name=names[index];if(result.status==='fulfilled'){next[name]=index<2 ? asItems(result.value) : result.value;if(index===0)next.historyCapabilities=result.value?.capabilities;}else next.errors[name]=result.reason?.message || `Could not load ${name}.`;});
      data=next;dataKey=initial.key;render();
    }
    function destroy() {
      destroyed=true;generation++;
      for(const dialog of dialogs){if(dialog.open)dialog.close('cancel');else dialog.remove();}
      for(const url of urls)root.URL.revokeObjectURL(url);urls.clear();container.replaceChildren();
    }
    render();return {refresh,render,destroy};
  }
  function formatDate(value) {
    if(!value)return '';
    const date=new Date(value);return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
  }
  const api={mount,canMutate,canDownload,asItems,normalizeRevision,displayValue,filePayload,downloadName,formatSize};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PCN_DOCUMENT_WORKSPACE=api;
})(typeof window!=='undefined' ? window : globalThis);

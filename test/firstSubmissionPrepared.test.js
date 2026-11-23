const test = require('node:test');
const assert = require('node:assert/strict');
const { PcnService } = require('../src/pcnService');
const { PcnCreationService } = require('../src/pcnCreation');
const { buildAction } = require('../src/documentChecks');
const { resolveNextMailTarget } = require('../src/mailRouting');
const { hasSignatures } = require('../src/documentControl');
const { memoryRepository, unsignedPayload } = require('./helpers/apiHarness');

const preparedPath = 'signoff.gscTet.prepared';
const initial = '2026-11-23T04:20:30.000Z';
const later = '2026-11-24T06:10:20.000Z';
const actor = { id:'gsc-preparer', username:'preparer', displayName:'Verified GSC Preparer',
  roles:['gsc'], department:'gscTet', signingStep:'prepared', isActive:true };
const admin = { ...actor, id:'administrator', roles:['admin'], department:null, signingStep:null };
function setup() {
  const repository = memoryRepository(); let now = initial;
  const service = new PcnService(repository, () => new Date(now));
  const creation = new PcnCreationService({ service, repository,
    documents:{ async listForRecords(ids) { return new Map(await Promise.all(ids.map(async id => [id,
      {parentVersion:(await repository.findById(id)).version,attachments:[]}]))); } },
    authRepository:{async listUsers(){return[];}},mailConfigurationStatus:()=> 'not_configured' });
  return { repository, service, creation, time(value){now=value;} };
}
function assertPrepared(record, user, signedAt) {
  const step = record.internalReview.signoff.gscTet;
  assert.equal(step.prepared,true);
  assert.equal(step.preparedName,user.displayName);
  assert.equal(step.preparedDate,signedAt.slice(0,10));
  assert.notEqual(step.checked,true); assert.notEqual(step.approved,true);
  assert.deepEqual(record.documentControl.signatureBindings[preparedPath], {
    userId:user.id,displayName:user.displayName,signedAt,
    contentRevision:record.documentControl.contentRevision,contentHash:record.documentControl.contentHash
  });
  assert.equal(buildAction(record,user).signingStep,'checked');
  assert.equal(resolveNextMailTarget(record).groupKey,'department.gscTet.checked');
}

test('first submitted TA and SC creations automatically prepare for authorized submitters with real bindings',async()=>{
  for (const documentType of ['ta','sc']) for (const user of [actor,admin,
    {...actor,id:'developer',roles:['developer'],department:'developer',signingStep:null}]) {
    const f=setup(); const input={...unsignedPayload,documentType}; const before=structuredClone(input);
    const saved=await f.service.create(input,'Untrusted actor label',user);
    assert.equal(saved.status,'submitted'); assertPrepared(saved,user,initial);
    assert.deepEqual(input,before);
    const revision=(await f.repository.getRevisions(saved.id))[0];
    assert(revision.changes.some(change=>change.path==='internalReview.signoff.gscTet.prepared' && change.after===true));
  }
});

test('draft creation and autosave remain unsigned; status-only first submission records its actual time once',async()=>{
  const f=setup();
  const saved=await f.creation.create({clientDraftKey:'50000000-0000-4000-8000-000000000101',document:unsignedPayload},'Preparer',actor);
  assert.equal(hasSignatures(saved.record),false);
  assert.equal((await f.creation.list(actor)).length,1);
  f.time(later);
  const edited=(await f.creation.update(saved.record.id,{version:saved.record.version,document:{reason:'Edited before submission'}},'Preparer',actor)).record;
  assert.equal(hasSignatures(edited),false);
  const autosaved=(await f.creation.update(edited.id,{version:edited.version,document:{materialName:'Autosaved material'}},'Preparer',actor)).record;
  assert(autosaved.documentControl.contentRevision>1);
  const preflight=await f.creation.preflight(autosaved.id,{version:autosaved.version},actor);
  assert.equal(preflight.nextAction.signingStep,'checked');
  assert.equal(hasSignatures(await f.repository.findById(autosaved.id)),false,'Preflight never persists its projection');
  const submitted=await f.service.update(autosaved.id,{version:autosaved.version,status:'submitted'},'Preparer',actor);
  assertPrepared(submitted,actor,later);
  const bindings=structuredClone(submitted.documentControl.signatureBindings);
  f.time('2026-11-25T08:00:00.000Z');
  const repeated=await f.service.update(submitted.id,{version:submitted.version,status:'submitted'},'Preparer',actor);
  assert.deepEqual(repeated.documentControl.signatureBindings,bindings);
  assert.equal(repeated.internalReview.signoff.gscTet.preparedDate,later.slice(0,10));
});

test('first submission with final content edits binds the submitted content rather than the earlier draft',async()=>{
  const f=setup(); const draft=await f.service.create({...unsignedPayload,status:'draft'},'Preparer',actor);
  f.time(later);
  const submitted=await f.service.update(draft.id,{version:draft.version,status:'submitted',materialName:'Final submitted material'},'Preparer',actor);
  assert.equal(submitted.documentControl.contentRevision,draft.documentControl.contentRevision+1);
  assert.notEqual(submitted.documentControl.contentHash,draft.documentControl.contentHash);
  assertPrepared(submitted,actor,later);
});

test('automatic preparation never grants an unrelated, wrong-step or invalid Developer assignment signing authority',async()=>{
  const denied=[{...actor,id:'supplier',roles:['supplier'],department:null,signingStep:null},
    {...actor,id:'qa',roles:['qa'],department:'qaTet'},
    {...actor,id:'checker',signingStep:'checked'},
    {...actor,id:'unassigned',department:null,signingStep:null},
    {...actor,id:'invalid-developer',roles:['developer','qa'],department:'developer',signingStep:null}];
  for (const user of denied) {
    const f=setup(); const saved=await f.service.create(unsignedPayload,'Creator',user);
    assert.equal(hasSignatures(saved),false);
    assert.equal(buildAction(saved,user).signingStep,'prepared');
    const draft=await f.service.create({...unsignedPayload,status:'draft'},'Creator',user);
    const submitted=await f.service.update(draft.id,{version:draft.version,status:'submitted'},'Creator',user);
    assert.equal(hasSignatures(submitted),false);
    const nextDraft=await f.service.create({...unsignedPayload,status:'draft'},'Creator',user);
    assert.equal((await f.creation.preflight(nextDraft.id,{version:nextDraft.version},user)).nextAction.signingStep,'prepared');
  }
});

test('failed first submission and stale updates persist no automatic signature',async()=>{
  const f=setup();
  const draft=await f.service.create({...unsignedPayload,status:'draft',reason:''},'Preparer',actor);
  await assert.rejects(f.service.update(draft.id,{version:draft.version,status:'submitted'},'Preparer',actor),{statusCode:400});
  assert.equal(hasSignatures(await f.repository.findById(draft.id)),false);
  const edited=await f.service.update(draft.id,{version:draft.version,reason:'Complete'},'Preparer',actor);
  await assert.rejects(f.service.update(draft.id,{version:draft.version,status:'submitted'},'Preparer',actor),{statusCode:409});
  assert.equal(hasSignatures(await f.repository.findById(edited.id)),false);
});

test('first submission cannot conceal forged metadata or unauthorized Checked/Approved payloads',async()=>{
  const f=setup();
  for (const group of [{preparedName:'Forged signer'},{preparedDate:'1999-01-01'},{checked:true},{approved:true}]) {
    await assert.rejects(f.service.create({...unsignedPayload,internalReview:{signoff:{gscTet:group}}},'Preparer',actor),
      error=>[400,403].includes(error.statusCode));
  }
  const supplied=await f.service.create({...unsignedPayload,internalReview:{signoff:{gscTet:{prepared:true,preparedName:'Forged',preparedDate:'1999-01-01'}}}},'Preparer',actor);
  assertPrepared(supplied,actor,initial);
  const draft=await f.service.create({...unsignedPayload,status:'draft',internalReview:{signoff:{gscTet:{prepared:false,preparedName:'',preparedDate:''}}}},'Preparer',actor);
  await assert.rejects(f.service.update(draft.id,{version:draft.version,status:'submitted',
    internalReview:{signoff:{gscTet:{prepared:false,preparedName:'Forged on an unchanged checkbox'}}}},'Preparer',actor),{statusCode:400});
  assert.equal(hasSignatures(await f.repository.findById(draft.id)),false);
});

test('active records, revision drafts and supplier-action resubmissions never receive a backfilled auto signature',async()=>{
  for (const [status,submittedAt] of [['submitted',initial],['supplier_action',initial],['draft',initial]]) {
    const f=setup();
    const existing=await f.repository.create({...unsignedPayload,status,submittedAt,ownerUserId:actor.id,createdAt:initial,updatedAt:initial},'Historical import');
    f.time(later);
    const saved=await f.service.update(existing.id,{version:existing.version,status:'submitted'},'Preparer',actor);
    assert.equal(hasSignatures(saved),false,`${status} is not a new unsigned first submission`);
  }
});

test('retained historical draft signatures and idempotent draft replays never re-sign',async()=>{
  const f=setup(); const options={clientDraftKey:'50000000-0000-4000-8000-000000000102'};
  const draft=await f.service.create({...unsignedPayload,status:'draft'},'Preparer',actor,options);
  const submitted=await f.service.update(draft.id,{version:draft.version,status:'submitted'},'Preparer',actor);
  f.time(later);
  const replay=await f.service.create({...unsignedPayload,status:'draft'},'Preparer',actor,options);
  assert.equal(replay.creationReused,true); assert.equal(replay.version,submitted.version);
  assert.deepEqual(replay.documentControl,submitted.documentControl);
  const historical=await f.repository.create({...f.service.normalizeInput({...unsignedPayload,status:'draft',
    internalReview:{signoff:{gscTet:{prepared:true,preparedName:'Original signer',preparedDate:'2026-10-01'}}}}),
    submittedAt:null,ownerUserId:admin.id,createdAt:initial,updatedAt:initial},'Historical import');
  const retained=await f.service.update(historical.id,{version:historical.version,status:'submitted'},'Administrator',admin);
  assert.equal(retained.internalReview.signoff.gscTet.preparedName,'Original signer');
  assert.equal(retained.internalReview.signoff.gscTet.preparedDate,'2026-10-01');
});

test('explicit revision drafts and actors without a current signing identity never receive an automatic signature',async()=>{
  const f=setup();
  for (const marker of [{revisionStartedAt:initial},{revisionStartedBy:'Original reviser'},{revisionReason:'Requalification'}]) {
    const revision=await f.repository.create({...f.service.normalizeInput({...unsignedPayload,status:'draft'}),submittedAt:null,
      ownerUserId:actor.id,createdAt:initial,updatedAt:initial,documentControl:{...marker,contentRevision:3}},'Revision draft');
    const saved=await f.service.update(revision.id,{version:revision.version,status:'submitted'},'Preparer',actor);
    assert.equal(hasSignatures(saved),false);
  }
  for (const user of [{...admin,id:undefined},{...admin,isActive:false},undefined]) {
    const created=await f.service.create(unsignedPayload,'Internal fixture',user);
    assert.equal(hasSignatures(created),false);
  }
});

test('eligible first-submission preflight predicts Checked routing without saving a signature or notification',async()=>{
  const f=setup();
  await f.repository.saveNotificationSettings({schemaVersion:2,groups:[{key:'department.gscTet.checked',emails:'checked@example.test'}],legacyGroups:[]},'Setup');
  const draft=await f.service.create({...unsignedPayload,status:'draft'},'Preparer',actor);
  const before=await f.repository.findById(draft.id);
  const result=await f.creation.preflight(draft.id,{version:draft.version},actor);
  assert.equal(result.nextAction.signingStep,'checked');
  assert.equal(result.notification.recipientConfigured,true);
  assert.deepEqual(await f.repository.findById(draft.id),before);
  assert.equal((await f.repository.getRevisions(draft.id)).length,1);
});

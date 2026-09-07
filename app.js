'use strict';

/* Identity-scoped local-first sync. No stale whole-profile writes. */
let _currentUser = null;
let _clearAuthError = () => {};
let _outbox = null;
let _transport = null;
let _metaClient = null;
const _profileClients = new Map();
const _capturedProfiles = new Map();
let _capturedMeta = null;
let _applyingCloud = false;
let _cloudGeneration = 0;
let _pendingView = null;
const _syncStatuses = new Map();
function accountKey(suffix) { return 'df3:' + JSON.stringify([_currentUser?.uid ?? null,suffix]); }
function profileKey(pid, suffix) { return accountKey(JSON.stringify(['profile',pid,suffix])); }
function _fsDocPath(uid, pid) { return 'users/' + uid + '/profiles/' + pid; }
function _fsMetaPath(uid) { return 'users/' + uid + '/meta/root'; }
function _profileSnapshot() {
  return DailyFlowSyncCore.normalizeProfile({
    ...(_capturedProfiles.get(state.activeProfileId) || {}),
    entries: state.notes.entries, pomLog: state.pomLog, focusLog: state.focusLog || {},
    settings: state.settings, achievements: state.achievements, quickNotes: state.quickNotes,
    customCats: state.customCats, lastDate: todayStr()
  });
}
function _storeProfile(pid, data) {
  localStorage.setItem(profileKey(pid, 'document'), JSON.stringify(data));
  const mapping = { entries:'entries', pomLog:'pomlog', focusLog:'focusLog', settings:'settings',
    achievements:'achievements', quickNotes:'quicknotes', customCats:'customcats' };
  for (const [field, key] of Object.entries(mapping))
    localStorage.setItem(profileKey(pid, key), JSON.stringify(data[field]));
}
function _editingTask() {
  const node = document.activeElement;
  return !!(node && /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) &&
    (node.closest('#log') || node.closest('.modal-overlay.open') || node.closest('.profile-drop') ||
      node.closest('#v-settings') || node.closest('#qcPopup') || node.closest('.qnote')));
}
function _applyProfileAppearance() {
  const s=state.settings;
  document.documentElement.setAttribute('data-theme',s.dark?'dark':'light');
  applyAccentColor(s.accentColor || '#7C3AED');
  document.documentElement.style.fontSize=(s.fontSize || 16)+'px';
  applyRingStyle(s.ringStyle || 'solid');
  applyWarmLight(s.warmLight || 0);
  const slider=document.getElementById('warmSlider');if(slider)slider.value=s.warmLight || 0;
  applyFocusMode();updateClocks();populateCatSelects();
  if(!state.timer.running && !state.timer.resumePending && !state.timer.sessionId && state.timer.remainingMs===state.timer.durationMs){
    state.timer.timeLeft=getModeSecs(state.timer.mode);
    state.timer.durationMs=state.timer.remainingMs=state.timer.timeLeft*1000;
    renderTimeDisplay();renderRing();
  }
  if(state.ui.view==='settings' && !_editingTask()){loadSettingsUI();renderCategoryManager();}
}
function _clearProfileWorkspace() {
  clearInterval(state.timer.iv);
  state.activeProfileId=null;
  state.notes.entries={};state.pomLog={};state.focusLog={};state.quickNotes=[];state.customCats=[];
  state.achievements={unlocked:[]};state.settings={...DEFAULT_SETTINGS};
  _pendingView=null;_timerShouldResume=false;restoreTimerSnapshot({});
  _clearRenderedProfileEditors();
  for(const id of ['entryInput','descInput','qcTextarea']){const el=document.getElementById(id);if(el)el.value='';}
  _newSubtasks=[];_renderNewStList();
  const capture=document.getElementById('qcPopup');if(capture)capture.style.display='none';
}
function _clearRenderedProfileEditors() {
  // A previous account/profile's DOM must not be captured as the next one's draft.
  document.getElementById('log')?.replaceChildren();
  _editId=null;
  for(const id of ['commentFormId','rollFormId','subtaskFormId','timeSpentId'])state.ui[id]=null;
}
function _renderWorkspaceAvailability() {
  const main=document.querySelector('main.main');if(!main)return;
  let empty=document.getElementById('emptyWorkspace');
  if(!empty){
    empty=document.createElement('section');empty.id='emptyWorkspace';empty.className='empty';
    empty.style.cssText='margin:32px auto;padding:32px;max-width:560px;text-align:center';
    const title=document.createElement('h2');title.textContent='No profiles yet';
    const text=document.createElement('p');text.textContent='Create a profile to begin. Previously removed profile data is retained for recovery.';
    text.style.margin='16px 0';
    const button=document.createElement('button');button.className='primary-btn';button.textContent='Create profile';button.onclick=openCreateProfile;
    empty.append(title,text,button);main.before(empty);
  }
  const available=!!state.activeProfileId;
  empty.hidden=available;main.style.display=available?'':'none';main.inert=!available;
  const fab=document.getElementById('fabBtn');if(fab)fab.style.display=available?'':'none';
}
function _renderLoadedProfile() {
  _applyProfileAppearance();
  renderProfileSelector();renderDateHeader();renderLog();renderStats();renderCalendar();renderQuickNotes();
  renderTimerAll();updateSessionBanner();_renderWorkspaceAvailability();
  if(_timerShouldResume && state.activeProfileId){_timerShouldResume=false;startTimer();}
}
function _showMetaData(data) {
  _capturedMeta=DailyFlowSyncCore.normalizeMeta(data);
  localStorage.setItem(accountKey('profiles'),JSON.stringify(data.profiles));
  if(!window._df_appReady)return;
  state.profiles=data.profiles;
  const ids=new Set(data.profiles.map(p=>p.id));
  if(!ids.has(state.activeProfileId)) {
    if(state.activeProfileId){
      // Finish under the old profile while the new metadata already excludes it.
      if(state.timer.running || state.timer.resumePending)stopTimer('profile-removed');
      save();
    }
    _pendingView=null;_clearRenderedProfileEditors();
    if(data.profiles.length){state.activeProfileId=data.profiles[0].id;loadProfileData(state.activeProfileId);}
    else _clearProfileWorkspace();
    if(state.activeProfileId)localStorage.setItem(accountKey('activeProfile'),state.activeProfileId);
    else localStorage.removeItem(accountKey('activeProfile'));
    _renderLoadedProfile();
  } else renderProfileSelector();
  for(const [pid,client] of _profileClients)if(!ids.has(pid)){
    client.stop();_profileClients.delete(pid);_capturedProfiles.delete(pid);
    _syncStatuses.delete(client.path);
  }
  for(const p of data.profiles)_ensureProfileClient(p.id).catch(error=>_syncStatus('storage',{label:'Needs attention',error:error.message}));
}
function _showProfileData(pid, data) {
  _storeProfile(pid, data);
  if (!window._df_appReady || state.activeProfileId !== pid) return;
  if (_editingTask()) { _pendingView = { pid, data }; return; }
  _applyingCloud = true;
  try {
    state.notes.entries = data.entries;
    state.pomLog = data.pomLog; state.focusLog = data.focusLog || {};
    state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    state.achievements = data.achievements;
    state.quickNotes = data.quickNotes; state.customCats = data.customCats;
    _capturedProfiles.set(pid, DailyFlowSyncCore.normalizeProfile(data));
    _applyProfileAppearance();
    renderLog(); renderStats(); renderCalendar(); renderQuickNotes();
    if (state.ui.view === 'analytics') renderAnalytics();
  } finally { _applyingCloud = false; }
}
function _syncStatus(scope, status) {
  _syncStatuses.set(scope, status);
  const values = [..._syncStatuses.values()];
  const label = values.some(s => s.label === 'Needs attention') ? 'Needs attention'
    : values.some(s => s.label === 'Syncing') ? 'Syncing'
    : values.some(s => s.label === 'Saved locally') ? 'Saved locally' : 'Synced';
  const el = document.getElementById('syncStatus');
  if (el) { el.textContent = label; el.dataset.status = label; el.title = values.map(s=>s.error).filter(Boolean).join('\n') || label; }
}
function _stopCloudClients() {
  _cloudGeneration++;
  _metaClient?.stop(); _metaClient = null;
  _profileClients.forEach(c => c.stop()); _profileClients.clear();
  _capturedProfiles.clear(); _capturedMeta = null; _syncStatuses.clear(); _pendingView = null;
}
function _journal(operations, client, stableId) {
  if (!client || !operations.length) return Promise.resolve();
  const key = accountKey('intentJournal');
  const entries = JSON.parse(localStorage.getItem(key) || '[]');
  const intent = { id: stableId || crypto.randomUUID(), path: client.path, operations };
  if (!entries.some(x => x.id === intent.id)) entries.push(intent);
  localStorage.setItem(key, JSON.stringify(entries)); // durable before asynchronous IDB work
  return client.enqueue(operations, intent.id).then(() => {
    const remaining = JSON.parse(localStorage.getItem(key) || '[]').filter(x => x.id !== intent.id);
    localStorage.setItem(key, JSON.stringify(remaining));
  }).catch(error => _syncStatus(client.path, { label:'Needs attention', error:error.message }));
}
async function _restoreJournal() {
  const uid=_currentUser?.uid,generation=_cloudGeneration;
  const key = accountKey('intentJournal');
  const intents = JSON.parse(localStorage.getItem(key) || '[]');
  for (const intent of intents) {
    if(uid!==_currentUser?.uid || generation!==_cloudGeneration)return;
    const client = intent.path === _metaClient?.path ? _metaClient
      : [..._profileClients.values()].find(c => c.path === intent.path);
    if (!client) continue;
    await client.enqueue(intent.operations, intent.id);
    if(uid!==_currentUser?.uid || generation!==_cloudGeneration)return;
    localStorage.setItem(key, JSON.stringify(JSON.parse(localStorage.getItem(key) || '[]').filter(x=>x.id!==intent.id)));
  }
}
async function _ensureProfileClient(pid) {
  if(!_currentUser)return null;
  if (_profileClients.has(pid)) return _profileClients.get(pid);
  const generation = _cloudGeneration;
  const uid = _currentUser.uid;
  const client = new DailyFlowSync.Client({
    uid:_currentUser.uid, profileId:pid, outbox:_outbox, transport:_transport,
    onStatus:status => { if (generation === _cloudGeneration) _syncStatus(_fsDocPath(uid, pid), status); },
    onData:data => { if (generation === _cloudGeneration) _showProfileData(pid, data); }
  });
  _profileClients.set(pid, client);
  _recoverTimeCheckpoint(pid);
  await client.start();
  if(generation!==_cloudGeneration || uid!==_currentUser?.uid){
    client.stop();if(_profileClients.get(pid)===client)_profileClients.delete(pid);return null;
  }
  return client;
}
function _scheduleSyncToFirestore() {
  if (!_currentUser || !_metaClient || _applyingCloud) return;
  const meta = DailyFlowSyncCore.normalizeMeta({ profiles:state.profiles });
  if (_capturedMeta) _journal(DailyFlowSyncCore.diffMeta(_capturedMeta, meta), _metaClient);
  _capturedMeta = meta;
  const pid = state.activeProfileId;
  if(!pid)return;
  const after = _profileSnapshot();
  const before = _capturedProfiles.get(pid);
  _capturedProfiles.set(pid, after);
  const client = _profileClients.get(pid);
  if (client && before) _journal(DailyFlowSyncCore.diffProfile(before, after), client);
  else if (!client) {
    // New profiles have no server data. Existing profiles are always loaded on sign-in.
    _ensureProfileClient(pid).catch(error => _syncStatus('storage',{label:'Needs attention',error:error.message}));
    _journal(DailyFlowSyncCore.diffProfile(DailyFlowSyncCore.normalizeProfile({}), after), _profileClients.get(pid));
  }
}
async function _pushToFirestore() {
  await Promise.all([_metaClient, ..._profileClients.values()].filter(Boolean).map(c=>c.flush()));
}
async function _pullFromFirestore(uid) {
  const generation=_cloudGeneration;
  const current=()=>generation===_cloudGeneration && uid===_currentUser?.uid;
  if(!current())return;
  const outbox=_outbox || await DailyFlowSync.Outbox.open();
  if(!current())return;
  _outbox=outbox;
  _transport = DailyFlowSync.firebaseTransport({
    db:window._df_db, doc:window._df_doc, onSnapshot:window._df_onSnapshot,
    runTransaction:window._df_runTransaction
  });
  // Load the existing account before rendering; never import unscoped browser data.
  let meta;
  try {
    const snap = await window._df_getDoc(window._df_doc(window._df_db, _fsMetaPath(uid)));
    if(!current())return;
    meta = DailyFlowSyncCore.normalizeMeta(snap.exists() ? snap.data() : {});
    meta = await _outbox.acceptBaseline(_fsMetaPath(uid), meta);
    if(!current())return;
  } catch (error) {
    if(!current())return;
    if (error.code === 'schema' || error.code === 'permission-denied') throw error;
    meta = DailyFlowSyncCore.normalizeMeta(await _outbox.read('baseline:' + _fsMetaPath(uid)) || {});
    if(!current())return;
    _syncStatus('connection', {label:'Saved locally',error:error.message});
  }
  if (!current()) return;
  for (const p of meta.profiles || []) {
    if (!current()) return;
    try {
      const snap = await window._df_getDoc(window._df_doc(window._df_db, _fsDocPath(uid,p.id)));
      if(!current())return;
      const data = DailyFlowSyncCore.normalizeProfile(snap.exists() ? snap.data() : {});
      await _outbox.acceptBaseline(_fsDocPath(uid,p.id), data);
      if(!current())return;
    } catch (error) { if(!current())return;if (error.code === 'schema' || error.code === 'permission-denied') throw error; }
    if (!current()) return;
    await _ensureProfileClient(p.id);
    if(!current())return;
  }
  if (!current()) return;
  localStorage.setItem(accountKey('profiles'), JSON.stringify(meta.profiles));
  _capturedMeta = meta;
  _metaClient = new DailyFlowSync.Client({
    uid, meta:true, outbox:_outbox, transport:_transport,
    onStatus:s => {if(current())_syncStatus('meta',s);},
    onData:data => {
      if (!current()) return;
      _showMetaData(data);
    }
  });
  await _metaClient.start();
  if(!current())return;
  await _restoreJournal();
}
function _recoverTimeCheckpoint(pid) {
  const checkpointKey = profileKey(pid, 'segmentCheckpoint');
  const raw = localStorage.getItem(checkpointKey);
  if (!raw) return;
  const checkpoint = JSON.parse(raw);
  const client = _profileClients.get(pid);
  // The same journal ID survives crashes on either side of the IDB hand-off.
  if (client) _journal([{type:'segment',segment:checkpoint.segment}], client, 'segment:' + checkpoint.segment.id);
  _storeProfile(pid, checkpoint.next);
  const key = profileKey(pid, 'segments');
  const records = JSON.parse(localStorage.getItem(key) || '{}');
  records[checkpoint.segment.id] = checkpoint.segment;
  localStorage.setItem(key, JSON.stringify(records));
  localStorage.removeItem(checkpointKey);
}
function recordTimeSegment(segment) {
  const pid = segment.profileId || state.activeProfileId;
  if (pid !== state.activeProfileId) throw new Error('Timer belongs to another profile');
  const key = profileKey(pid, 'segments');
  const records = JSON.parse(localStorage.getItem(key) || '{}');
  if (records[segment.id]) return;
  const next = DailyFlowSyncCore.applySegment(_profileSnapshot(), segment);
  // One atomic checkpoint precedes all multi-key cache updates and dedupe marks.
  localStorage.setItem(profileKey(pid, 'segmentCheckpoint'), JSON.stringify({segment,next}));
  _recoverTimeCheckpoint(pid);
  state.notes.entries = next.entries; state.pomLog = next.pomLog; state.focusLog = next.focusLog;
  save();
}
function openSyncStatus() {
  const clients = [_metaClient, ..._profileClients.values()].filter(Boolean);
  const conflictClient = clients.find(c=>c.conflict);
  const old = document.getElementById('syncReview');
  if (old) old.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'syncReview'; dialog.style.cssText='padding:24px;max-width:640px;width:calc(100% - 32px);margin:auto;border:1px solid var(--border);border-radius:14px;background:var(--surface);color:var(--text)';
  const title = document.createElement('h2'); title.textContent = conflictClient ? 'Review conflicting changes' : 'Synchronization';
  dialog.append(title);
  const message = document.createElement('p');
  message.textContent = conflictClient ? conflictClient.conflict.message : (!_currentUser
    ? 'Local preview: no cloud account is connected. Your data stays on this browser.'
    : [..._syncStatuses.values()].map(s=>s.label + (s.error ? ': '+s.error : '')).join('\n'));
  message.style.cssText='white-space:pre-wrap;margin:16px 0'; dialog.append(message);
  if (conflictClient) {
    const details = document.createElement('pre');
    const pendingOperation = conflictClient.conflict.row.operation;
    details.textContent = JSON.stringify({pendingChange:pendingOperation,serverConflict:conflictClient.conflict.details}, null, 2);
    details.style.cssText='white-space:pre-wrap;max-height:40vh;overflow:auto;font-size:.8rem'; dialog.append(details);
    const keep = document.createElement('button'); keep.className='primary-btn'; keep.textContent='Keep cloud version of this change';
    keep.onclick=async()=>{ await conflictClient.keepServerVersion(); dialog.close(); }; dialog.append(keep);
    const reviewed = DailyFlowSync.reviewedPatch(conflictClient.base, pendingOperation);
    if (reviewed) {
      const local=document.createElement('button'); local.className='outline-btn'; local.textContent='Use my edited fields';
      local.onclick=async()=>{
        if (!confirm('Apply your edited fields to the reviewed cloud version? Other fields stay unchanged. A newer remote edit will be reviewed again.')) return;
        await conflictClient.retryWithOperation(reviewed); dialog.close();
      }; dialog.append(local);
    }
    const recovery=document.createElement('button'); recovery.className='outline-btn'; recovery.textContent='Download this pending change';
    recovery.onclick=()=>{
      const url=URL.createObjectURL(new Blob([JSON.stringify(pendingOperation,null,2)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='dailyflow-pending-change.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };dialog.append(recovery);
    const help=document.createElement('p'); help.textContent='Deleted or carried records are not resurrected automatically. Download the pending change to recover its content. Other queued changes are retained.'; dialog.append(help);
  }
  const retry=document.createElement('button'); retry.textContent='Retry sync'; retry.className='outline-btn'; retry.onclick=()=>_pushToFirestore(); dialog.append(retry);
  const close=document.createElement('button'); close.textContent='Close'; close.className='outline-btn'; close.onclick=()=>dialog.close(); dialog.append(close);
  document.body.append(dialog); dialog.showModal();
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (_pendingView && !_editingTask()) {
    const pending = _pendingView; _pendingView = null;
    _showProfileData(pending.pid, _profileClients.get(pending.pid)?.view || pending.data);
  }
}, 150));

// Show / hide the login screen
function _showLoginScreen(visible) {
  const el = document.getElementById('loginScreen');
  if (el) el.style.display = visible ? 'flex' : 'none';
}

// Show/hide user account UI based on auth state
function _updateUserBadge(user) {
  const section           = document.getElementById('profileDropSignout');
  const userMenuWrap      = document.getElementById('userMenuWrap');
  const userMenuEmail     = document.getElementById('userMenuEmail');
  const settingsCard      = document.getElementById('settingsAccountCard');
  const settingsSignedIn  = document.getElementById('settingsSignedInAs');
  const displayName       = user ? (user.displayName || user.email || user.phoneNumber || '') : '';
  if (user) {
    if (section)          section.style.display         = 'block';
    if (userMenuWrap)     userMenuWrap.style.display     = 'flex';
    if (userMenuEmail)    userMenuEmail.textContent      = displayName;
    if (settingsCard)     settingsCard.style.display     = 'block';
    if (settingsSignedIn) settingsSignedIn.textContent   = `Signed in as ${displayName}`;
  } else {
    if (section)          section.style.display         = 'none';
    if (userMenuWrap)     userMenuWrap.style.display     = 'none';
    if (settingsCard)     settingsCard.style.display     = 'none';
  }
}

// Bootstrap Firebase auth — called once the DOM is ready
function _initFirebaseAuth() {
  if (!window._df_firebaseReady) {
    window.addEventListener('dailyflow-firebase-ready', _initFirebaseAuth, { once:true });
    return;
  }
  if (window._df_firebaseError) {
    _showLoginScreen(true);
    document.getElementById('loginError').textContent = window._df_firebaseError;
    return;
  }

  // ── Tab switching ──────────────────────────────────────
  document.querySelectorAll('.auth-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById('tab-' + btn.dataset.tab);
      if (panel) panel.classList.add('active');
      _clearAuthError();
    });
  });

  // ── Helper: show/clear error ───────────────────────────
  function _showAuthError(msg) {
    const el = document.getElementById('loginError');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }
  _clearAuthError = function() {
    const el = document.getElementById('loginError');
    if (el) { el.textContent = ''; el.style.display = 'none'; }
  };

  function _friendlyError(code) {
    const map = {
      'auth/invalid-email':            'Invalid email address.',
      'auth/user-not-found':           'No account found with this email.',
      'auth/wrong-password':           'Incorrect password.',
      'auth/email-already-in-use':     'An account with this email already exists.',
      'auth/weak-password':            'Password must be at least 6 characters.',
      'auth/too-many-requests':        'Too many attempts. Please try again later.',
      'auth/invalid-verification-code':'Incorrect OTP code.',
      'auth/invalid-phone-number':     'Invalid phone number. Include country code (e.g. +91).',
      'auth/popup-closed-by-user':     'Sign-in cancelled.',
      'auth/network-request-failed':   'Network error. Check your connection.',
    };
    return map[code] || 'Sign-in failed. Please try again.';
  }

  // ── GOOGLE sign-in ─────────────────────────────────────
  const googleBtn = document.getElementById('googleSignInBtn');
  if (googleBtn) {
    googleBtn.addEventListener('click', async () => {
      googleBtn.disabled = true;
      googleBtn.textContent = 'Signing in…';
      _clearAuthError();
      try {
        await window._df_signInGoogle();
      } catch (err) {
        googleBtn.disabled = false;
        googleBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.36-8.16 2.36-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg> Continue with Google`;
        if (err.code !== 'auth/popup-closed-by-user') _showAuthError(_friendlyError(err.code));
      }
    });
  }

  // ── EMAIL sign-in / sign-up ────────────────────────────
  let _emailMode = 'signin'; // 'signin' | 'signup'

  document.getElementById('emailSignInMode')?.addEventListener('click', () => {
    _emailMode = 'signin';
    document.getElementById('emailSignInMode').classList.add('active');
    document.getElementById('emailSignUpMode').classList.remove('active');
    document.getElementById('confirmPasswordInput').style.display = 'none';
    document.getElementById('emailSubmitBtn').textContent = 'Sign In';
    document.getElementById('forgotPasswordBtn').style.display = '';
    _clearAuthError();
  });

  document.getElementById('emailSignUpMode')?.addEventListener('click', () => {
    _emailMode = 'signup';
    document.getElementById('emailSignUpMode').classList.add('active');
    document.getElementById('emailSignInMode').classList.remove('active');
    document.getElementById('confirmPasswordInput').style.display = 'block';
    document.getElementById('emailSubmitBtn').textContent = 'Create Account';
    document.getElementById('forgotPasswordBtn').style.display = 'none';
    _clearAuthError();
  });

  document.getElementById('emailSubmitBtn')?.addEventListener('click', async () => {
    const email    = document.getElementById('emailInput').value.trim();
    const password = document.getElementById('passwordInput').value;
    const confirm  = document.getElementById('confirmPasswordInput').value;
    if (!email || !password) { _showAuthError('Please enter email and password.'); return; }
    if (_emailMode === 'signup' && password !== confirm) { _showAuthError('Passwords do not match.'); return; }

    const btn = document.getElementById('emailSubmitBtn');
    btn.disabled = true;
    btn.textContent = '…';
    _clearAuthError();
    try {
      if (_emailMode === 'signin') {
        await window._df_signInEmail(email, password);
      } else {
        await window._df_signUpEmail(email, password);
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = _emailMode === 'signin' ? 'Sign In' : 'Create Account';
      _showAuthError(_friendlyError(err.code));
    }
  });

  // Enter key submits email form
  ['emailInput','passwordInput','confirmPasswordInput'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('emailSubmitBtn')?.click();
    });
  });

  // Forgot password
  document.getElementById('forgotPasswordBtn')?.addEventListener('click', async () => {
    const email = document.getElementById('emailInput').value.trim();
    if (!email) { _showAuthError('Enter your email first, then click Forgot password.'); return; }
    try {
      await window._df_sendPasswordReset(email);
      _showAuthError(''); // clear error
      const el = document.getElementById('loginError');
      if (el) { el.style.color = '#10B981'; el.textContent = 'Reset email sent! Check your inbox.'; el.style.display = 'block'; }
    } catch (err) {
      _showAuthError(_friendlyError(err.code));
    }
  });

  // ── PHONE sign-in ──────────────────────────────────────
  let _confirmationResult = null;
  let _recaptchaVerifier  = null;
  let _recaptchaRendered  = false;

  function _resetRecaptcha() {
    // Destroy old verifier and clear the container so Firebase can re-render
    try { if (_recaptchaVerifier) _recaptchaVerifier.clear(); } catch(_) {}
    _recaptchaVerifier = null;
    _recaptchaRendered = false;
    const container = document.getElementById('recaptcha-container');
    if (container) container.innerHTML = '';
  }

  function _ensureRecaptcha() {
    if (_recaptchaRendered || !window._df_RecaptchaVerifier) return;
    try {
      // Invisible reCAPTCHA — attaches to the Send OTP button, fires automatically
      // No checkbox for the user to tick — seamless UX
      _recaptchaVerifier = window._df_RecaptchaVerifier('sendOtpBtn', {
        size: 'invisible',
        callback: () => {},  // called when reCAPTCHA passes — signInWithPhoneNumber handles it
      });
      _recaptchaRendered = true;
    } catch(e) {
      console.warn('[DailyFlow] reCAPTCHA init error:', e.message);
    }
  }

  // Init when phone tab becomes visible (not before — container must be in DOM)
  document.querySelectorAll('.auth-tab').forEach(btn => {
    if (btn.dataset.tab === 'phone') {
      btn.addEventListener('click', () => setTimeout(_ensureRecaptcha, 150));
    }
  });

  document.getElementById('sendOtpBtn')?.addEventListener('click', async () => {
    const phone = document.getElementById('phoneInput').value.trim();
    if (!phone) { _showAuthError('Enter your phone number with country code (e.g. +91 98765 43210).'); return; }

    // Make sure phone has + prefix
    const formattedPhone = phone.startsWith('+') ? phone : '+' + phone;

    _ensureRecaptcha();

    if (!_recaptchaVerifier) {
      _showAuthError('reCAPTCHA not ready. Please wait a moment and try again.');
      return;
    }

    const btn = document.getElementById('sendOtpBtn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    _clearAuthError();

    try {
      _confirmationResult = await window._df_signInPhone(formattedPhone, _recaptchaVerifier);
      document.getElementById('phone-step-1').style.display = 'none';
      document.getElementById('phone-step-2').style.display = 'block';
      document.getElementById('phoneSentTo').textContent = formattedPhone;
      document.getElementById('otpInput').focus();
    } catch (err) {
      console.error('[DailyFlow] Phone auth error:', err.code, err.message);
      btn.disabled = false;
      btn.textContent = 'Send OTP';
      _resetRecaptcha();
      // Re-init after a short delay so next attempt works
      setTimeout(_ensureRecaptcha, 300);
      _showAuthError(_friendlyError(err.code));
    }
  });

  document.getElementById('verifyOtpBtn')?.addEventListener('click', async () => {
    const otp = document.getElementById('otpInput').value.trim();
    if (!otp || otp.length < 6) { _showAuthError('Enter the 6-digit OTP.'); return; }
    const btn = document.getElementById('verifyOtpBtn');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    _clearAuthError();
    try {
      await _confirmationResult.confirm(otp);
      // onAuthStateChanged fires and handles the rest
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Verify & Sign In';
      _showAuthError(_friendlyError(err.code));
    }
  });

  document.getElementById('otpInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('verifyOtpBtn')?.click();
  });

  document.getElementById('resendOtpBtn')?.addEventListener('click', () => {
    document.getElementById('phone-step-1').style.display = 'block';
    document.getElementById('phone-step-2').style.display = 'none';
    document.getElementById('sendOtpBtn').disabled = false;
    document.getElementById('sendOtpBtn').textContent = 'Send OTP';
    _resetRecaptcha();
    _confirmationResult = null;
    _clearAuthError();
    setTimeout(_ensureRecaptcha, 300);
  });

  // ── Sign-out buttons ───────────────────────────────────
  async function doSignOut() {
    if (state.timer.running) stopTimer('account');
    save();
    document.getElementById('profileDrop')?.classList.remove('open');
    document.getElementById('userMenuDrop')?.classList.remove('open');
    await window._df_signOut();
  }
  document.getElementById('signOutBtn')?.addEventListener('click', doSignOut);
  document.getElementById('headerSignOutBtn')?.addEventListener('click', doSignOut);
  document.getElementById('settingsSignOutBtn')?.addEventListener('click', doSignOut);

  // ── Header user menu toggle ────────────────────────────
  document.getElementById('userMenuBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('userMenuDrop')?.classList.toggle('open');
  });
  document.addEventListener('click', () => {
    document.getElementById('userMenuDrop')?.classList.remove('open');
  });

  // ── Auth state listener ────────────────────────────────
  if (window._df_onAuthStateChanged) {
    window._df_onAuthStateChanged(async (user) => {
      if (_currentUser?.uid !== user?.uid) {
        if (state.timer.running || state.timer.resumePending) stopTimer('account');
        _stopCloudClients();
        if(window._df_appReady){state.profiles=[];_clearProfileWorkspace();_renderLoadedProfile();}
      }
      _currentUser = user;
      const authGeneration=_cloudGeneration;
      if (user) {
        // Show login screen with loading message while fetching data
        const loginScreen = document.getElementById('loginScreen');
        if (loginScreen) {
          // Replace card content temporarily with loading state
          loginScreen.querySelector('h2').textContent = 'Loading your data…';
        }
        try { await _pullFromFirestore(user.uid); }
        catch (error) {
          if(_currentUser?.uid!==user.uid || authGeneration!==_cloudGeneration)return;
          _showAuthError('Your data could not be loaded safely. ' + error.message);
          _showLoginScreen(true);
          return;
        }
        if (_currentUser?.uid !== user.uid || authGeneration!==_cloudGeneration) return;
        _showLoginScreen(false);
        _updateUserBadge(user);

        if (window._df_appReady) {
          load();
          _renderLoadedProfile();
          renderProfileSelector();
          renderLog();
          renderStats();
          renderCalendar();
          renderQuickNotes();
          renderTimerAll(); updateSessionBanner();
          _scheduleSyncToFirestore();
          checkEod();
        }
      } else {
        // Restore login card heading on sign-out
        const h2 = document.querySelector('#loginScreen h2');
        if (h2) h2.textContent = 'Welcome';
        // Reset phone steps
        const s1 = document.getElementById('phone-step-1');
        const s2 = document.getElementById('phone-step-2');
        if (s1) s1.style.display = 'block';
        if (s2) s2.style.display = 'none';
        // Re-enable buttons
        ['googleSignInBtn','emailSubmitBtn','sendOtpBtn'].forEach(id => {
          const b = document.getElementById(id);
          if (b) b.disabled = false;
        });
        _showLoginScreen(true);
        _updateUserBadge(null);
      }
    });
  } else {
    _showLoginScreen(false); // No Firebase configured — run locally
  }
}

/* ─────────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────────── */

const CIRCUMFERENCE = 2 * Math.PI * 96; // 603.186…

const CATS = {
  work:     { emoji: '💼', label: 'Work',     pill: 'cp-work',     color: '#3B82F6' },
  personal: { emoji: '🏠', label: 'Personal', pill: 'cp-personal', color: '#EC4899' },
  health:   { emoji: '💪', label: 'Health',   pill: 'cp-health',   color: '#10B981' },
  study:    { emoji: '📚', label: 'Study',    pill: 'cp-study',    color: '#F59E0B' },
  creative: { emoji: '🎨', label: 'Creative', pill: 'cp-creative', color: '#8B5CF6' },
  other:    { emoji: '✨', label: 'Other',    pill: 'cp-other',    color: '#6B7280' },
};

function getAllCats() {
  const all = { ...CATS };
  (state.customCats || []).forEach(c => {
    all[c.id] = { emoji: c.emoji, label: c.label, pill: '', color: c.color, custom: true };
  });
  return all;
}

const CAT_COLOR_PRESETS = [
  '#EF4444','#F97316','#F59E0B','#84CC16',
  '#10B981','#06B6D4','#3B82F6','#6366F1',
  '#8B5CF6','#EC4899','#14B8A6','#6B7280',
];

const MODE_COLORS = {
  stopwatch:  { stroke: '#7C3AED', modeClass: '' },
  work:       { stroke: '#7C3AED', modeClass: ''          },
  shortBreak: { stroke: '#059669', modeClass: 'mode-short' },
  longBreak:  { stroke: '#D97706', modeClass: 'mode-long'  },
};

const MODE_LABELS = {
  stopwatch: 'Stopwatch',
  work: 'Focus Time', shortBreak: 'Short Break', longBreak: 'Long Break',
};

const ACHIEVEMENTS = [
  // ── Beginner ──────────────────────────────────────
  { id: 'first_entry',   icon: '📝', title: 'First Steps',       desc: 'Log your very first activity',              tier: 'bronze'   },
  { id: 'first_pom',     icon: '🍅', title: 'Pomodoro Rookie',   desc: 'Complete your first pomodoro',              tier: 'bronze'   },
  { id: 'first_done',    icon: '✅', title: 'Task Done!',         desc: 'Complete your first task',                  tier: 'bronze'   },
  { id: 'first_comment', icon: '💬', title: 'Communicator',      desc: 'Add a comment to a task',                   tier: 'bronze'   },
  { id: 'first_subtask', icon: '📋', title: 'Planner',           desc: 'Add a sub-task to a task',                  tier: 'bronze'   },
  { id: 'first_roll',    icon: '📅', title: 'Rolling Forward',   desc: 'Roll a task to the next day',               tier: 'bronze'   },
  // ── Productivity ──────────────────────────────────
  { id: 'fire_day',      icon: '🔥', title: 'On Fire',           desc: 'Complete 4 pomodoros in one day',           tier: 'silver'   },
  { id: 'power_day',     icon: '⚡', title: 'Power Day',         desc: 'Complete 8 pomodoros in a single day',      tier: 'gold'     },
  { id: 'tasks_10',      icon: '📌', title: 'Getting Things Done', desc: 'Complete 10 tasks total',                tier: 'silver'   },
  { id: 'tasks_50',      icon: '🏆', title: 'Task Master',       desc: 'Complete 50 tasks total',                   tier: 'gold'     },
  { id: 'poms_10',       icon: '🍅', title: 'Pomodoro Pro',      desc: 'Complete 10 pomodoros in total',            tier: 'silver'   },
  { id: 'poms_50',       icon: '🍅', title: 'Pomodoro Master',   desc: 'Complete 50 pomodoros in total',            tier: 'gold'     },
  { id: 'poms_100',      icon: '🍅', title: 'Pomodoro Legend',   desc: 'Complete 100 pomodoros in total',           tier: 'platinum' },
  // ── Streaks ───────────────────────────────────────
  { id: 'streak_3',      icon: '🌱', title: 'Seedling',          desc: 'Maintain a 3-day logging streak',           tier: 'bronze'   },
  { id: 'streak_7',      icon: '💪', title: 'One Week Strong',   desc: 'Maintain a 7-day logging streak',           tier: 'silver'   },
  { id: 'streak_14',     icon: '🚀', title: 'Two Weeks!',        desc: 'Maintain a 14-day logging streak',          tier: 'gold'     },
  { id: 'streak_30',     icon: '👑', title: 'Unstoppable',       desc: 'Maintain a 30-day logging streak',          tier: 'platinum' },
  // ── Special ───────────────────────────────────────
  { id: 'early_bird',    icon: '🌅', title: 'Early Bird',        desc: 'Log an entry before 8 AM',                  tier: 'silver'   },
  { id: 'night_owl',     icon: '🦉', title: 'Night Owl',         desc: 'Log an entry after 10 PM',                  tier: 'silver'   },
  { id: 'all_clear',     icon: '✨', title: 'All Clear',         desc: 'Complete every task in a day (min 3)',       tier: 'gold'     },
  { id: 'tagger',        icon: '🏷️', title: 'Tag Collector',     desc: 'Use 5 unique hashtags across your log',     tier: 'silver'   },
  { id: 'deep_focus',    icon: '🧘', title: 'Deep Focus',        desc: 'Track a task and finish a pomodoro on it',  tier: 'silver'   },
];

/* ─────────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────────── */

const state = {
  timer: {
    mode: 'work',
    timeLeft: 25 * 60,
    running: false,
    iv: null,
    cyclePos: 0,
    totalToday: 0,
    activeEntryId: null,
    activeEntryDate: null,
    durationMs: 25 * 60000,
    remainingMs: 25 * 60000,
    elapsedMs: 0,
    deadlineAt: null,
    sessionId: null,
    segmentIndex: 0,
    segmentStartedAt: null,
  },
  notes: {
    date: todayStr(),
    entries: {},      // { 'YYYY-MM-DD': [entry, …] }
  },
  pomLog: {},         // { 'YYYY-MM-DD': number } – pomodoros completed per day
  settings: {
    workDuration:      25,
    shortBreakDuration: 5,
    longBreakDuration:  15,
    longBreakInterval:  4,
    autoStartBreaks:   false,
    autoStartWork:     false,
    desktopNotifs:     false,
    endOfDaySummary:   true,
    dark:              false,
    warmLight:         0,
    timezone:          'local',
    // new customizations
    accentColor:       '#7C3AED',
    fontSize:          16,
    timerSound:        'beep',
    ringStyle:         'solid',
    focusMode:         false,
    dailyGoal:         0,
    weekStartMonday:   true,
    timeFormat24:      false,
    defaultCat:        'work',
    ghostDisplay:      'both',   // 'both' | 'banner' | 'drawer' | 'off'
    ghostDismissed:    [],
    commentViewMode:   'expandcollapse', // 'expandcollapse' | 'expandonly'
  },
  ui: {
    view:          'log',
    search:        '',
    filterCat:     '',
    filterPri:     '',
    descOpen:      false,
    commentFormId:  null,  // entry id showing add-comment form
    rollFormId:     null,  // entry id showing roll-to-next-day form
    subtaskFormId:  null,  // entry id showing add-subtask input
    timeSpentId:    null,  // entry id showing time-spent prompt
    taskScope:     'daily',
    entryDateExplicit: false,
  },
  ambient: {
    type:   'none',
    volume: 0.4,
    ctx:    null,
    source: null,
    gain:   null,
  },
  cal: {
    year:  new Date().getFullYear(),
    month: new Date().getMonth(),
  },
  analytics: {
    selectedDate:    null,
    chartWeekOffset: 0,     // 0=current week, -1=prev week, etc.
    chartMode:       '7d',  // '7d' | '14d'
  },
  achievements: {
    unlocked: [],
  },
  quickNotes:   [],
  customCats:   [],
  // ── Profiles (global, not per-profile) ───────────
  profiles:         [],   // [{ id, name, emoji, color, createdAt }]
  activeProfileId:  null,
};

const DEFAULT_SETTINGS = {
  workDuration: 25, shortBreakDuration: 5, longBreakDuration: 15,
  longBreakInterval: 4, autoStartBreaks: false, autoStartWork: false,
  desktopNotifs: false, endOfDaySummary: true, autoRollover: false, dark: false,
  warmLight: 0, timezone: 'local',
  commentViewMode: 'expandcollapse', // 'expandcollapse' | 'expandonly'
};

const PROFILE_EMOJIS = [
  '👤','💼','🏠','📚','💪','🎯','🚀','💡',
  '🎨','🎮','🌍','❤️','⭐','🔥','💰','🧘',
  '🎸','✈️','🌱','👨‍💻','🏋️','🎓','🍕','🎵',
];

const PROFILE_COLORS = [
  '#7C3AED','#3B82F6','#10B981','#F59E0B',
  '#EF4444','#EC4899','#06B6D4','#8B5CF6',
  '#F97316','#84CC16','#14B8A6','#6B7280',
];

let _dragId              = null;
let _editId              = null;
let _toastTm             = null;
let _timerShouldResume   = false; // set true on load if timer was running
const _logDrafts = {};
function _logDraftKey() { return profileKey(state.activeProfileId,'editorDrafts'); }

/* ─────────────────────────────────────────────────────
   UTILITIES
───────────────────────────────────────────────────── */

function todayStr() {
  return DailyFlowWorkflows.dateKey(Date.now());
}

function fmtTime(secs) {
  return `${String(Math.floor(secs / 60)).padStart(2,'0')}:${String(secs % 60).padStart(2,'0')}`;
}

function fmtDate(str) {
  const d     = new Date(str + 'T00:00:00');
  const today = todayStr();
  const yest  = offsetDate(today, -1);
  const tom   = offsetDate(today,  1);
  const long  = d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  if (str === today) return ['Today', long];
  if (str === yest)  return ['Yesterday', long];
  if (str === tom)   return ['Tomorrow', long];
  return [d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' }),
          d.toLocaleDateString('en-US', { year:'numeric' })];
}

function offsetDate(base, delta) {
  const d = new Date(base + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return DailyFlowWorkflows.dateKey(d);
}

function nowTime() {
  return new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true });
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function parseTags(text) {
  const m = String(text).match(/#(\w+)/g);
  return m ? [...new Set(m.map(t => t.slice(1).toLowerCase()))] : [];
}

function fmtContent(text) {
  return esc(text).replace(/#(\w+)/g, '<span class="entry-tag">#$1</span>');
}

/* ─────────────────────────────────────────────────────
   GHOST TASKS — helpers
   A "ghost" = entry where done=false AND rolledTo=null AND date < today.
   Dismissed ghosts are stored in state.settings.ghostDismissed (array of entry IDs).
───────────────────────────────────────────────────── */

function getGhostTasks() {
  const today    = todayStr();
  const dismissed = new Set(state.settings.ghostDismissed || []);
  const ghosts   = [];
  Object.keys(state.notes.entries).sort().forEach(dateStr => {
    if (dateStr >= today) return;
    (state.notes.entries[dateStr] || []).forEach(e => {
      if (!e.done && !e.rolledTo && !e.archived && !dismissed.has(e.id)) {
        ghosts.push({ entry: e, date: dateStr });
      }
    });
  });
  return ghosts; // sorted oldest first
}

function dismissGhost(entryId) {
  archiveEntry(entryId);
}

function rollGhostToday(entryId, sourceDate) {
  const result = DailyFlowWorkflows.carry(state.notes.entries, sourceDate, entryId, todayStr(), Date.now());
  if (!result) return;
  save(); renderLog(); renderCalendar(); renderStats();
  showToast('✓ Task carried to Today');
  checkAchievements();
}

function ghostDaysAgo(dateStr) {
  const today = new Date(todayStr() + 'T00:00:00');
  const then  = new Date(dateStr   + 'T00:00:00');
  const diff  = Math.round((today - then) / 86400000);
  return diff === 1 ? 'yesterday' : diff + 'd ago';
}

function renderGhostBanner() {
  const el = document.getElementById('ghostBanner');
  if (!el) return;
  const mode = state.settings.ghostDisplay || 'both';
  if (mode !== 'both' && mode !== 'banner') { el.style.display = 'none'; return; }
  const ghosts = getGhostTasks();
  if (!ghosts.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  const isOpen = el.classList.contains('ghost-expanded');
  const countLabel = ghosts.length === 1 ? '1 unfinished task' : ghosts.length + ' unfinished tasks';

  let tasksHtml = '';
  if (isOpen) {
    tasksHtml = ghosts.map(function(g) {
      const cat     = getAllCats()[g.entry.cat] || CATS.other;
      const ageText = ghostDaysAgo(g.date);
      const textEsc = esc(g.entry.content);
      const ageHtml = '<span class="ghost-age">' + ageText + '</span>';
      const catHtml = '<span class="ghost-cat-pill">' + cat.emoji + ' ' + cat.label + '</span>';
      return '<div class="ghost-task-row">'
        + '<div class="ghost-task-info">'
        + '<div class="ghost-task-text">' + textEsc + '</div>'
        + '<div class="ghost-task-meta">' + ageHtml + catHtml + '</div>'
        + '</div>'
        + '<div class="ghost-task-actions">'
        + '<button class="ghost-btn ghost-roll" onclick="rollGhostToday(\'' + g.entry.id + '\',\'' + g.date + '\')" title="Roll to today">Roll Today</button>'
        + '<button class="ghost-btn ghost-dismiss" onclick="dismissGhost(\'' + g.entry.id + '\')" title="Dismiss">✕</button>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  const chevron   = isOpen ? '&#9650;' : '&#9660;';
  const bodyStyle = isOpen ? '' : 'display:none';

  el.innerHTML = '<div class="ghost-banner-header" onclick="toggleGhostBanner()">'
    + '<span class="ghost-banner-icon">&#128123;</span>'
    + '<div class="ghost-banner-title">'
    + '<strong>' + countLabel + ' from past days</strong>'
    + '<span>Carry to today or archive for later</span>'
    + '</div>'
    + '<span class="ghost-banner-chevron">' + chevron + '</span>'
    + '</div>'
    + '<div class="ghost-banner-body" style="' + bodyStyle + '">' + tasksHtml + '</div>';
}

function toggleGhostBanner() {
  const el = document.getElementById('ghostBanner');
  if (!el) return;
  el.classList.toggle('ghost-expanded');
  renderGhostBanner();
}

function renderGhostDrawer() {
  const el   = document.getElementById('ghostDrawerBody');
  const hdr  = document.getElementById('ghostDrawerCount');
  if (!el) return;
  const mode = state.settings.ghostDisplay || 'both';
  const card = document.getElementById('ghostDrawerCard');
  if (card) {
    if (mode !== 'both' && mode !== 'drawer') { card.style.display = 'none'; return; }
    card.style.display = '';
  }
  const ghosts = getGhostTasks();
  if (hdr) hdr.textContent = ghosts.length;
  if (!ghosts.length) {
    el.innerHTML = '<div class="ghost-drawer-empty">All clear \u2728 No earlier unfinished tasks.</div>';
    return;
  }
  el.innerHTML = ghosts.map(function(g) {
    const cat     = getAllCats()[g.entry.cat] || CATS.other;
    const ageText = ghostDaysAgo(g.date);
    const textEsc = esc(g.entry.content);
    return '<div class="ghost-drawer-item">'
      + '<span class="ghost-drawer-age">' + ageText + '</span>'
      + '<div class="ghost-drawer-info">'
      + '<div class="ghost-drawer-text">' + textEsc + '</div>'
      + '<div class="ghost-drawer-cat">' + cat.emoji + ' ' + cat.label + '</div>'
      + '</div>'
      + '<div class="ghost-drawer-actions">'
      + '<button class="ghost-btn ghost-roll" onclick="rollGhostToday(\'' + g.entry.id + '\',\'' + g.date + '\')" title="Roll to today">Roll</button>'
      + '<button class="ghost-btn ghost-dismiss" onclick="dismissGhost(\'' + g.entry.id + '\')" title="Dismiss">&#10005;</button>'
      + '</div>'
      + '</div>';
  }).join('');
}

function toggleGhostDrawer() {
  const body    = document.getElementById('ghostDrawerBody');
  const chevron = document.getElementById('ghostDrawerChevron');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(90deg)';
}

function getModeSecs(mode) {
  const s = state.settings;
  return { work: s.workDuration*60, shortBreak: s.shortBreakDuration*60, longBreak: s.longBreakDuration*60, stopwatch: 0 }[mode];
}

/* ─────────────────────────────────────────────────────
   AUDIO – Timer sounds
───────────────────────────────────────────────────── */

function beep(type) {
  const sound = state.settings.timerSound || 'beep';
  if (sound === 'none') return;
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const play = (freq, t0, dur, wave='sine') => {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type = wave; osc.frequency.value = freq;
      g.gain.setValueAtTime(.3, ctx.currentTime + t0);
      g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + t0 + dur);
      osc.start(ctx.currentTime + t0);
      osc.stop(ctx.currentTime + t0 + dur);
    };
    if (sound === 'beep') {
      if (type === 'done')  { play(440,0,.15); play(550,.18,.15); play(660,.36,.2); }
      else                  { play(660,0,.09); }
    } else if (sound === 'bell') {
      if (type === 'done')  { play(880,0,.4,'triangle'); play(1100,.45,.3,'triangle'); }
      else                  { play(880,0,.2,'triangle'); }
    } else if (sound === 'soft') {
      if (type === 'done')  { play(523,0,.3,'sine'); play(659,.25,.3,'sine'); play(784,.5,.4,'sine'); }
      else                  { play(659,0,.15,'sine'); }
    }
  } catch (_) {}
}

/* ─────────────────────────────────────────────────────
   AUDIO – Ambient
───────────────────────────────────────────────────── */

const ambient = {
  start(type, vol) {
    this.stop();
    if (type === 'none') return;
    try {
      this.ctx  = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = vol;
      this.gain.connect(this.ctx.destination);

      const sr  = this.ctx.sampleRate;
      const len = sr * 4;
      const buf = this.ctx.createBuffer(1, len, sr);
      const data = buf.getChannelData(0);

      if (type === 'white') {
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      } else if (type === 'rain') {
        // Pink noise (Paul Kellet algorithm)
        let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          b0 = .99886*b0 + w*.0555179; b1 = .99332*b1 + w*.0750759;
          b2 = .96900*b2 + w*.1538520; b3 = .86650*b3 + w*.3104856;
          b4 = .55000*b4 + w*.5329522; b5 = -.7616*b5 - w*.0168980;
          data[i] = (b0+b1+b2+b3+b4+b5+b6+w*.5362) * .11;
          b6 = w * .115926;
        }
      } else if (type === 'brown') {
        let last = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          data[i] = (last + .02 * w) / 1.02;
          last = data[i]; data[i] *= 3.5;
        }
      }

      this.source = this.ctx.createBufferSource();
      this.source.buffer = buf;
      this.source.loop = true;
      this.source.connect(this.gain);
      this.source.start();
    } catch (_) {}
  },
  stop() {
    try { if (this.source) this.source.stop(); } catch (_) {}
    try { if (this.ctx)    this.ctx.close();   } catch (_) {}
    this.source = this.ctx = this.gain = null;
  },
  setVol(vol) {
    if (this.gain) this.gain.gain.value = vol;
  },
};

/* ─────────────────────────────────────────────────────
   QUICK NOTES
───────────────────────────────────────────────────── */

function openQuickCapture() {
  const popup = document.getElementById('qcPopup');
  if (!popup) return;
  popup.style.display = '';
  setTimeout(() => document.getElementById('qcTextarea')?.focus(), 30);
}

function closeQuickCapture() {
  const popup = document.getElementById('qcPopup');
  if (popup) popup.style.display = 'none';
}

function saveQuickNote() {
  const ta   = document.getElementById('qcTextarea');
  const text = ta?.value.trim();
  if (!text) { ta?.focus(); return; }
  if (!state.quickNotes) state.quickNotes = [];
  state.quickNotes.unshift({ id: Date.now().toString(), text, time: nowTime(), ts: Date.now() });
  ta.value = '';
  save();
  renderQuickNotes();
  closeQuickCapture();
  showToast('📝 Note saved!');
}

function deleteQuickNote(id) {
  state.quickNotes = (state.quickNotes || []).filter(n => n.id !== id);
  save();
  renderQuickNotes();
}

function convertNoteToTask(id) {
  const note = (state.quickNotes || []).find(n => n.id === id);
  if (!note) return;
  prefillTaskInput(note.text);
  deleteQuickNote(id);
  showToast('✅ Note moved to task input — fill in the details and hit Add!');
}

function quickCaptureToTask() {
  const ta   = document.getElementById('qcTextarea');
  const text = ta?.value.trim();
  if (!text) { ta?.focus(); return; }
  prefillTaskInput(text);
  if (ta) ta.value = '';
  closeQuickCapture();
  showToast('✅ Moved to task input!');
}

function prefillTaskInput(text) {
  switchView('log');
  const input = document.getElementById('entryInput');
  if (!input) return;
  input.value = text;
  input.focus();
  input.select();
  input.style.borderColor = 'var(--primary)';
  input.style.boxShadow   = '0 0 0 3px rgba(124,58,237,.18)';
  setTimeout(() => { input.style.borderColor = ''; input.style.boxShadow = ''; }, 1600);
}

let _qnEditId = null;

function editQuickNote(id) {
  _qnEditId = id;
  renderQuickNotes();
  setTimeout(() => {
    const el = document.getElementById(`qne-${id}`);
    if (el) { el.focus(); el.select(); }
  }, 30);
}

function saveQuickNoteEdit(id) {
  const el   = document.getElementById(`qne-${id}`);
  const text = el?.value.trim();
  if (!text) return;
  const note = (state.quickNotes || []).find(n => n.id === id);
  if (note) { note.text = text; save(); }
  _qnEditId = null;
  renderQuickNotes();
}

function cancelQuickNoteEdit() {
  _qnEditId = null;
  renderQuickNotes();
}

function renderQuickNotes() {
  const container = document.getElementById('qnotesList');
  if (!container) return;
  const notes = state.quickNotes || [];
  if (!notes.length) {
    container.innerHTML = '<div class="qnotes-empty">No quick notes yet.<br>Press <strong>Q</strong> or click <strong>+</strong> to capture.</div>';
    return;
  }
  container.innerHTML = notes.map(n => {
    const isEditing = _qnEditId === n.id;
    return `
    <div class="qnote-item">
      ${isEditing ? `
        <textarea class="qn-edit-area" id="qne-${n.id}"
          onkeydown="if(event.key==='Enter'&&event.ctrlKey){saveQuickNoteEdit('${n.id}')}if(event.key==='Escape'){cancelQuickNoteEdit()}"
        >${esc(n.text)}</textarea>
        <div class="qnote-footer">
          <span class="qnote-time">${n.time}</span>
          <div class="qnote-btns">
            <button class="qnote-btn to-task" onclick="saveQuickNoteEdit('${n.id}')">✓ Save</button>
            <button class="qnote-btn del" onclick="cancelQuickNoteEdit()">✕ Cancel</button>
          </div>
        </div>
      ` : `
        <div class="qnote-text">${esc(n.text)}</div>
        <div class="qnote-footer">
          <span class="qnote-time">${n.time}</span>
          <div class="qnote-btns">
            <button class="qnote-btn" onclick="editQuickNote('${n.id}')" title="Edit note">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Edit
            </button>
            <button class="qnote-btn to-task" onclick="convertNoteToTask('${n.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10"><polyline points="9 18 15 12 9 6"/></svg>
              → Task
            </button>
            <button class="qnote-btn del" onclick="deleteQuickNote('${n.id}')">✕</button>
          </div>
        </div>
      `}
    </div>`;
  }).join('');
}

/* ─────────────────────────────────────────────────────
   PROFILE MANAGEMENT
───────────────────────────────────────────────────── */

function renderProfileSelector() {
  const btn  = document.getElementById('profileBtn');
  const list = document.getElementById('profileDropList');
  if (!btn || !list) return;

  const active = state.profiles.find(p => p.id === state.activeProfileId);
  if (!active) {
    document.getElementById('pAvatarBtn').textContent='👤';
    document.getElementById('pNameBtn').textContent='Create profile';
    list.replaceChildren();return;
  }

  // Update button
  document.getElementById('pAvatarBtn').textContent       = active.emoji;
  document.getElementById('pAvatarBtn').style.background  = active.color;
  document.getElementById('pNameBtn').textContent         = active.name;

  // Update dropdown list
  list.innerHTML = state.profiles.map(p => {
    const isActive   = p.id === state.activeProfileId;
    const isRenaming = p.id === _renamingProfileId;

    if (isRenaming) {
      return `
        <div class="profile-drop-item renaming" onclick="event.stopPropagation()">
          <span class="p-drop-avatar" style="background:${p.color}">${p.emoji}</span>
          <input class="p-rename-input" id="p-rename-${p.id}"
            value="${esc(p.name)}" maxlength="20" autocomplete="off"
            onkeydown="handleRenameKey(event,'${p.id}')"
            onclick="event.stopPropagation()" />
          <button class="p-rename-save" onclick="event.stopPropagation();saveRename('${p.id}')" title="Save">✓</button>
          <button class="p-rename-cancel" onclick="event.stopPropagation();cancelRename()" title="Cancel">✕</button>
        </div>`;
    }

    return `
      <div class="profile-drop-item ${isActive ? 'active' : ''}" onclick="switchToProfile('${p.id}')">
        <span class="p-drop-avatar" style="background:${p.color}">${p.emoji}</span>
        <span class="p-drop-name">${esc(p.name)}</span>
        ${isActive ? '<span class="p-active-dot">●</span>' : ''}
        <div class="p-item-actions">
          <button class="p-edit-btn" onclick="event.stopPropagation();startRename('${p.id}')" title="Rename">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          ${!isActive ? `<button class="p-del-btn" onclick="event.stopPropagation();deleteProfile('${p.id}')" title="Delete">✕</button>` : ''}
        </div>
      </div>`;
  }).join('');

  // Auto-focus rename input if open
  if (_renamingProfileId) {
    setTimeout(() => {
      const inp = document.getElementById(`p-rename-${_renamingProfileId}`);
      if (inp) { inp.focus(); inp.select(); }
    }, 20);
  }
}

function toggleProfileDrop() {
  _renamingProfileId = null; // close any open rename on toggle
  document.getElementById('profileDrop').classList.toggle('open');
}

function startRename(id) {
  _renamingProfileId = id;
  renderProfileSelector();
}

function cancelRename() {
  _renamingProfileId = null;
  renderProfileSelector();
}

function saveRename(id) {
  const inp  = document.getElementById(`p-rename-${id}`);
  const name = inp?.value.trim();
  if (!name) { inp?.focus(); return; }

  const prof = state.profiles.find(p => p.id === id);
  if (prof) {
    prof.name = name;
    localStorage.setItem(accountKey('profiles'), JSON.stringify(state.profiles));
    _scheduleSyncToFirestore();
  }
  _renamingProfileId = null;
  renderProfileSelector(); // re-render dropdown
  // If renaming active profile, update the button label too
  if (id === state.activeProfileId) {
    document.getElementById('pNameBtn').textContent = name;
  }
  showToast(`✓ Renamed to "${name}"`);
}

function handleRenameKey(e, id) {
  if (e.key === 'Enter')  saveRename(id);
  if (e.key === 'Escape') cancelRename();
}

function switchToProfile(id) {
  if(!state.profiles.some(p=>p.id===id))return;
  document.getElementById('profileDrop').classList.remove('open');
  if (id === state.activeProfileId) return;

  // Stop timer if running
  if (state.timer.running || state.timer.resumePending) stopTimer('profile');

  // Save current profile fully
  save();

  // Switch
  _pendingView=null;_clearRenderedProfileEditors();
  state.activeProfileId = id;
  localStorage.setItem(accountKey('activeProfile'), id);
  loadProfileData(id);
  _applyProfileAppearance();_renderWorkspaceAvailability();_scheduleSyncToFirestore();

  // Re-render everything
  document.documentElement.setAttribute('data-theme', state.settings.dark ? 'dark' : 'light');
  applyWarmLight(state.settings.warmLight || 0);
  const warmSl = document.getElementById('warmSlider');
  if (warmSl) warmSl.value = state.settings.warmLight || 0;

  if (!state.timer._restored) state.timer.timeLeft = getModeSecs(state.timer.mode);
  delete state.timer._restored;

  populateCatSelects();
  renderTimerAll();
  renderDateHeader();
  renderLog();
  renderStats();
  renderCalendar();
  renderQuickNotes();
  renderProfileSelector();

  if (_timerShouldResume) { _timerShouldResume = false; startTimer(); }

  showToast(`Switched to ${state.profiles.find(p=>p.id===id)?.emoji} ${state.profiles.find(p=>p.id===id)?.name}`);
}

function deleteProfile(id) {
  if (state.profiles.length <= 1) { showToast('Cannot delete the only profile.'); return; }
  const prof = state.profiles.find(p => p.id === id);
  if (!prof) return;
  if (!confirm(`Delete profile "${prof.emoji} ${prof.name}" and ALL its data? This cannot be undone.`)) return;

  // Wipe all namespaced keys
  ['entries','pomlog','settings','timer','achievements','quicknotes','customcats','lastDate','eod_shown']
    .forEach(k => localStorage.removeItem(profileKey(id, k)));

  state.profiles = state.profiles.filter(p => p.id !== id);
  localStorage.setItem(accountKey('profiles'), JSON.stringify(state.profiles));

  if (state.activeProfileId === id) {
    switchToProfile(state.profiles[0].id);
  } else {
    renderProfileSelector();
  }
  showToast('Profile deleted.');
  _scheduleSyncToFirestore();
}

/* ── Create profile modal ─────────────────────────── */

let _newProfileEmoji    = '👤';
let _newProfileColor    = '#7C3AED';
let _renamingProfileId  = null;

function openCreateProfile() {
  document.getElementById('profileDrop').classList.remove('open');
  _newProfileEmoji = '👤';
  _newProfileColor = PROFILE_COLORS[0];
  document.getElementById('newProfileName').value = '';
  renderCreateProfileUI();
  updateProfilePreview();
  openModal('createProfileModal');
  setTimeout(() => document.getElementById('newProfileName').focus(), 100);
}

function renderCreateProfileUI() {
  // Emoji grid
  const eg = document.getElementById('profileEmojiGrid');
  if (eg) {
    eg.innerHTML = PROFILE_EMOJIS.map(em =>
      `<button class="p-emoji-btn ${em === _newProfileEmoji ? 'selected' : ''}"
         onclick="selectNewEmoji('${em}')">${em}</button>`
    ).join('');
  }
  // Color swatches
  const cg = document.getElementById('profileColorGrid');
  if (cg) {
    cg.innerHTML = PROFILE_COLORS.map(c =>
      `<span class="cat-swatch ${c === _newProfileColor ? 'selected' : ''}"
         data-color="${c}" style="background:${c}"
         onclick="selectNewColor('${c}')"></span>`
    ).join('');
  }
}

function selectNewEmoji(em) {
  _newProfileEmoji = em;
  renderCreateProfileUI();
  updateProfilePreview();
}

function selectNewColor(c) {
  _newProfileColor = c;
  renderCreateProfileUI();
  updateProfilePreview();
}

function updateProfilePreview() {
  const name  = document.getElementById('newProfileName')?.value.trim() || 'My Profile';
  const av    = document.getElementById('previewAvatar');
  const nm    = document.getElementById('previewName');
  if (av) { av.textContent = _newProfileEmoji; av.style.background = _newProfileColor; }
  if (nm) nm.textContent = name;
}

function submitCreateProfile() {
  const name = document.getElementById('newProfileName')?.value.trim();
  if (!name) {
    document.getElementById('newProfileName').focus();
    showToast('Please enter a profile name.');
    return;
  }
  const id   = 'p_' + Date.now().toString(36);
  const prof = { id, name, emoji: _newProfileEmoji, color: _newProfileColor, createdAt: Date.now() };
  state.profiles.push(prof);
  localStorage.setItem(accountKey('profiles'), JSON.stringify(state.profiles));
  closeModal('createProfileModal');
  switchToProfile(id);
  showToast(`✓ Profile "${_newProfileEmoji} ${name}" created!`);
}

/* ─────────────────────────────────────────────────────
   CALENDAR
───────────────────────────────────────────────────── */

function renderCalendar() {
  const container = document.getElementById('calContainer');
  if (!container) return;

  const { year, month } = state.cal;
  const today     = todayStr();
  const firstDay  = new Date(year, month, 1);
  const lastDay   = new Date(year, month + 1, 0);
  const startMon  = state.settings.weekStartMonday !== false;
  const startDow  = startMon ? (firstDay.getDay() + 6) % 7 : firstDay.getDay();
  const monthLbl  = firstDay.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  let html = `
    <div class="cal-nav-row">
      <button class="icon-btn cal-nav-btn" onclick="calNav(-1)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <span class="cal-month-lbl">${monthLbl}</span>
      <button class="icon-btn cal-nav-btn" onclick="calNav(1)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>
    <div class="cal-grid">
      ${startMon
        ? '<span class="cal-dow">Mo</span><span class="cal-dow">Tu</span><span class="cal-dow">We</span><span class="cal-dow">Th</span><span class="cal-dow">Fr</span><span class="cal-dow">Sa</span><span class="cal-dow">Su</span>'
        : '<span class="cal-dow">Su</span><span class="cal-dow">Mo</span><span class="cal-dow">Tu</span><span class="cal-dow">We</span><span class="cal-dow">Th</span><span class="cal-dow">Fr</span><span class="cal-dow">Sa</span>'
      }`;

  for (let i = 0; i < startDow; i++) html += '<span class="cal-cell empty"></span>';

  for (let d = 1; d <= lastDay.getDate(); d++) {
    const ds    = DailyFlowWorkflows.dateKey(new Date(year, month, d));
    const cnt   = (state.notes.entries[ds] || []).length;
    const poms  = state.pomLog[ds] || 0;
    const isFut = ds > today;

    // Ghost heat: any past day with undismissed pending-unrolled tasks
    const dismissed = new Set(state.settings.ghostDismissed || []);
    const hasGhost = !isFut && ds < today && (state.notes.entries[ds] || []).some(
      e => !e.done && !e.rolledTo && !e.archived && !dismissed.has(e.id)
    );

    const cls   = [
      'cal-cell',
      ds === today             ? 'cal-today'    : '',
      ds === state.notes.date  ? 'cal-selected' : '',
      isFut                    ? 'cal-future'   : '',
      cnt > 0                 ? 'cal-active'   : '',
      hasGhost                 ? 'cal-ghost'    : '',
    ].filter(Boolean).join(' ');

    const dot = cnt > 0
      ? `<span class="cal-dot" style="background:${poms > 0 ? 'var(--c-long)' : 'var(--primary)'}"></span>`
      : '';

    const ghostIndicator = hasGhost ? '<span class="cal-ghost-dot"></span>' : '';
    const title = `${ds}: ${cnt} entr${cnt===1?'y':'ies'}${poms?' · 🍅'+poms:''}${hasGhost?' · earlier unfinished':''}`;
    const click = `onclick="navigateToDate('${ds}')"`;
    html += `<span class="${cls}" ${click} title="${title}">${d}${dot}${ghostIndicator}</span>`;
  }

  html += '</div>';
  container.innerHTML = html;
}

function calNav(delta) {
  state.cal.month += delta;
  if (state.cal.month < 0)  { state.cal.month = 11; state.cal.year--; }
  if (state.cal.month > 11) { state.cal.month = 0;  state.cal.year++; }
  renderCalendar();
}

function navigateToDate(dateStr) {
  if (!DailyFlowWorkflows.validDate(dateStr)) return;
  state.ui.taskScope = 'daily';
  state.notes.date = dateStr;
  // Sync calendar to show the selected month
  const d = new Date(dateStr + 'T00:00:00');
  state.cal.year  = d.getFullYear();
  state.cal.month = d.getMonth();
  if (state.ui.view !== 'log') switchView('log');
  renderDateHeader();
  renderLog();
  renderStats();
  renderCalendar();
}

/* ─────────────────────────────────────────────────────
   ANALYTICS – Interactive Day Detail
───────────────────────────────────────────────────── */

function selectAnalyticsDate(dateStr) {
  if (!dateStr || dateStr > todayStr()) return;
  state.analytics.selectedDate = dateStr;
  renderAnalyticsDayDetail();
  // Re-render charts to show selection highlight
  renderWeeklyChart();
  renderHeatmap();
  const el = document.getElementById('analyticsDayDetail');
  if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
}

function renderAnalyticsDayDetail() {
  const card = document.getElementById('analyticsDayDetail');
  if (!card) return;
  const dateStr = state.analytics.selectedDate;
  if (!dateStr) { card.style.display = 'none'; return; }
  card.style.display = '';

  const entries = state.notes.entries[dateStr] || [];
  const poms    = state.pomLog[dateStr] || 0;
  const done    = entries.filter(e => e.done).length;
  const [label, sub] = fmtDate(dateStr);

  document.getElementById('detailDateLbl').textContent = label;
  document.getElementById('detailSubLbl').innerHTML =
    `${esc(sub || dateStr)}&ensp;·&ensp;${entries.length} entr${entries.length===1?'y':'ies'}` +
    (poms  ? `&ensp;·&ensp;🍅 ${poms} pomodoro${poms===1?'':'s'}` : '') +
    (done  ? `&ensp;·&ensp;✅ ${done} done` : '');

  const entriesEl = document.getElementById('detailEntriesList');
  if (entries.length === 0) {
    entriesEl.innerHTML = '<div class="detail-empty">No entries logged for this day.</div>';
    return;
  }
  entriesEl.innerHTML = entries.map(e => {
    const cat   = getAllCats()[e.cat] || CATS.other;
    const priCs = e.priority && e.priority !== 'none' ? `pri-badge pri-${e.priority}` : '';
    const priLb = { high:'High', medium:'Medium', low:'Low' }[e.priority] || '';
    return `
      <div class="detail-entry ${e.done ? 'done-entry' : ''}">
        <span class="cat-badge" style="width:28px;height:28px;font-size:.85rem;flex-shrink:0">${cat.emoji}</span>
        <div style="flex:1;min-width:0">
          <div class="entry-text" style="${e.done?'text-decoration:line-through':''}">${fmtContent(e.content)}</div>
          <div class="entry-meta">
            <span class="entry-time">${e.time}</span>
            <span class="cat-pill ${cat.pill}">${cat.label}</span>
            ${priCs ? `<span class="${priCs}">${priLb}</span>` : ''}
            ${(e.pomodoros||0)>0 ? `<span class="pom-badge">🍅 ${e.pomodoros}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

/* ─────────────────────────────────────────────────────
   PERSISTENCE
───────────────────────────────────────────────────── */

function pk(suffix) { return profileKey(state.activeProfileId, suffix); }

function saveTimerState() {
  if (!state.activeProfileId) return;
  try { localStorage.setItem(pk('timer'), JSON.stringify(getTimerSnapshot())); }
  catch (error) { _syncStatus('storage', {label:'Needs attention',error:'Timer could not be saved: ' + error.message}); }
}
function save() {
  if (!state.activeProfileId) return;
  _scheduleSyncToFirestore(); // Synchronous intent journal precedes cache changes.
  _storeProfile(state.activeProfileId, _profileSnapshot());
  saveTimerState();
  localStorage.setItem(pk('lastDate'), todayStr());
  localStorage.setItem(accountKey('profiles'), JSON.stringify(state.profiles));
  localStorage.setItem(accountKey('activeProfile'), state.activeProfileId);
}
function loadProfileData(pid) {
  _recoverTimeCheckpoint(pid);
  clearInterval(state.timer.iv);
  state.notes.entries = {}; state.pomLog = {}; state.focusLog = {};
  state.quickNotes = []; state.customCats = []; state.achievements = {unlocked:[]};
  state.settings = {...DEFAULT_SETTINGS};
  _timerShouldResume = false;
  const read = (name, fallback) => {
    const raw = localStorage.getItem(profileKey(pid, name));
    if (!raw) return fallback;
    try { return JSON.parse(raw); }
    catch { _syncStatus('storage', {label:'Needs attention',error:'A saved ' + name + ' record needs recovery; original data was retained.'}); return fallback; }
  };
  state.notes.entries = read('entries', {});
  state.pomLog = read('pomlog', {}); state.focusLog = read('focusLog', {});
  state.settings = {...DEFAULT_SETTINGS, ...read('settings', {})};
  state.achievements = {...state.achievements, ...read('achievements', {})};
  state.quickNotes = read('quicknotes', []); state.customCats = read('customcats', []);
  _capturedProfiles.set(pid, read('document', {}));
  restoreTimerSnapshot(read('timer', {}));
}
function migrateToProfiles() {
  const def = {id:'p_default',name:'Personal',emoji:'👤',color:'#7C3AED',createdAt:Date.now()};
  state.profiles = [def]; state.activeProfileId = def.id;
  // Legacy data is not associated with a known Firebase UID. It may only be
  // recovered in the isolated local preview, never attached to a signed-in user.
  if (window._df_localMode && !_currentUser) {
    const oldProfiles = localStorage.getItem('df2_profiles');
    if (oldProfiles) {
      try { const parsed=JSON.parse(oldProfiles); if (parsed.length) state.profiles=parsed; } catch {}
    }
    for (const p of state.profiles) {
      for (const name of ['entries','pomlog','settings','timer','achievements','quicknotes','customcats','lastDate']) {
        const previous=localStorage.getItem('df2_p'+p.id+'_'+name) || (p.id==='p_default' ? localStorage.getItem('df2_'+name) : null);
        if (previous) localStorage.setItem(profileKey(p.id,name),previous);
      }
    }
    state.activeProfileId=state.profiles[0].id;
  }
  localStorage.setItem(accountKey('profiles'),JSON.stringify(state.profiles));
  localStorage.setItem(accountKey('activeProfile'),state.activeProfileId);
  loadProfileData(state.activeProfileId);
}
function load() {
  state.profiles=[];
  try { state.profiles=JSON.parse(localStorage.getItem(accountKey('profiles')) || '[]'); } catch {}
  if (!state.profiles.length) {
    if(_currentUser){_clearProfileWorkspace();return;}
    migrateToProfiles();return;
  }
  const saved=localStorage.getItem(accountKey('activeProfile'));
  state.activeProfileId=state.profiles.some(p=>p.id===saved) ? saved : state.profiles[0].id;
  loadProfileData(state.activeProfileId);
}

/* TIMER — logic and snapshots are implemented below. */

function setMode(mode) {
  if (!MODE_LABELS[mode]) return;
  if (state.timer.running) stopTimer('switch');
  Object.assign(state.timer, {mode, timeLeft: getModeSecs(mode), durationMs: getModeSecs(mode)*1000,
    remainingMs: getModeSecs(mode)*1000, elapsedMs: 0, sessionId: null, segmentIndex: 0,
    segmentStartedAt: null, deadlineAt: null, resumePending: false, _restored: false});
  saveTimerState();
  renderTimerAll();
}

function startTimer() {
  if(!state.activeProfileId)return;
  if (state.timer.running) return;
  if (!flushPendingTimeSegments()) return;
  const timer = state.timer;
  if (timer.resumePending) {
    timer.resumePending = false;
    timer.running = true;
    timer.iv = setInterval(tick, 250);
    tick();
    renderTimerAll();
    applyFocusMode();
    return;
  }
  if (!timer.sessionId) {
    timer.sessionId = 'session_' + (globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`);
    timer.segmentIndex = 0;
    timer.profileId = state.activeProfileId;
    timer.durationMs = getModeSecs(timer.mode)*1000;
    // A restored legacy pause may have a remaining time but no session identity.
    if (!Number.isFinite(timer.remainingMs)) timer.remainingMs = timer.durationMs;
    if (!Number.isFinite(timer.elapsedMs)) timer.elapsedMs = 0;
  }
  timer.segmentStartedAt = Date.now();
  timer.deadlineAt = timer.mode === 'stopwatch' ? null : timer.segmentStartedAt + timer.remainingMs;
  state.timer.running = true;
  saveTimerState();
  beep('start');
  sendDesktopNotif(
    state.timer.mode === 'stopwatch' ? '⏱ Stopwatch started' : state.timer.mode === 'work' ? '🍅 Focus session started' : '☕ Break started',
    fmtTime(state.timer.timeLeft) + ' on the clock'
  );
  state.timer.iv = setInterval(tick, 250);
  renderPlayBtn();
  updateNavWave();
  applyFocusMode();
}

function stopTimer(reason = 'pause', completedPomodoro = false) {
  const timer = state.timer;
  const pending = [...(timer.pendingSegments || [])];
  if (reason === 'pause' && timer.running && timer.mode !== 'stopwatch' && Date.now() >= timer.deadlineAt) {
    timerDone();
    return;
  }
  if (timer.running || timer.resumePending) {
    const now = Date.now();
    const end = timer.mode === 'stopwatch' ? now : Math.min(now, timer.deadlineAt);
    const timing = DailyFlowWorkflows.clock(timer, now);
    const parts = DailyFlowWorkflows.splitSegment(timer.segmentStartedAt, end);
    if (!parts.length && completedPomodoro) parts.push({date: todayStr(), startedAt:end, endedAt:end, activeSeconds:0});
    // Breaks are never recorded as focused work. The hook owns totals and deduplication.
    if (timer.mode === 'work' || timer.mode === 'stopwatch') {
      parts.forEach((part, index) => {
        const complete = completedPomodoro && index === parts.length - 1;
        if (part.activeSeconds || complete) pending.push({
          ...part, id: `${timer.sessionId}_${timer.segmentIndex++}`, sessionId: timer.sessionId,
          profileId: timer.profileId || state.activeProfileId, taskId: timer.activeEntryId || null,
          taskDate: timer.activeEntryDate || null, kind: timer.mode === 'stopwatch' ? 'stopwatch' : 'pomodoro',
          completedPomodoro: complete, reason,
        });
      });
    }
    timer.remainingMs = timing.remainingMs;
    timer.elapsedMs = timing.elapsedMs;
    timer.timeLeft = timer.mode === 'stopwatch' ? Math.floor(timing.elapsedMs/1000) : Math.ceil(timing.remainingMs/1000);
    timer.segmentStartedAt = null;
    timer.deadlineAt = null;
    timer.resumePending = false;
  }
  clearInterval(state.timer.iv);
  state.timer.iv      = null;
  state.timer.running = false;
  state.timer.pendingSegments = pending;
  // Persist the stopped clock and delivery intent together before crediting any segment.
  saveTimerState();
  flushPendingTimeSegments();
  renderPlayBtn();
  updateNavWave();
  applyFocusMode();
  renderTimeDisplay();
  renderStats();
  updateSessionBanner();
}

function flushPendingTimeSegments() {
  const timer = state.timer;
  try {
    while (timer.pendingSegments?.length) {
      recordTimeSegment(timer.pendingSegments[0]);
      timer.pendingSegments.shift();
      saveTimerState();
    }
    return true;
  } catch (error) {
    console.error('Pending timer segment retained for retry:', error);
    showToast('Time saved on this device; retry recording before starting another session.');
    return false;
  }
}

function getTimerSnapshot() {
  const {iv, _restored, ...snapshot} = state.timer;
  return {...snapshot, running: !!(snapshot.running || snapshot.resumePending), version: 2, date: todayStr(), savedAt: Date.now()};
}

function restoreTimerSnapshot(snapshot = {}) {
  clearInterval(state.timer.iv);
  const mode = MODE_LABELS[snapshot.mode] ? snapshot.mode : 'work';
  const durationMs = getModeSecs(mode)*1000;
  const remainingMs = Number.isFinite(snapshot.remainingMs) ? Math.max(0, snapshot.remainingMs)
    : Number.isFinite(snapshot.timeLeft) ? Math.max(0, snapshot.timeLeft*1000) : durationMs;
  Object.assign(state.timer, {mode, running:false, iv:null, durationMs, remainingMs, elapsedMs:0,
    deadlineAt:null, segmentStartedAt:null, sessionId:null, segmentIndex:0, activeEntryId:null,
    activeEntryDate:null, profileId:state.activeProfileId, cyclePos:0, resumePending:false, pendingSegments:[]},
    snapshot.version === 2 ? snapshot : {});
  state.timer.iv = null;
  state.timer.running = false;
  state.timer.totalToday = state.pomLog[todayStr()] || 0;
  state.timer._restored = true;
  if (snapshot.version !== 2) {
    // Legacy snapshots cannot identify a work segment safely; restore them paused.
    state.timer.cyclePos = snapshot.cyclePos || 0;
    state.timer.timeLeft = Math.ceil(remainingMs/1000);
  }
  const resumable = snapshot.version === 2 && snapshot.running && snapshot.sessionId &&
    Number.isFinite(snapshot.segmentStartedAt) && (mode === 'stopwatch' || Number.isFinite(snapshot.deadlineAt));
  state.timer.resumePending = !!resumable;
  _timerShouldResume = !!resumable;
  flushPendingTimeSegments();
}

/* ── SVG wave paths — generated once on first call ── */
let _waveReady = false;
function _initWavePaths() {
  // Builds a smooth sine-wave fill path using cubic bezier curves.
  // x0/x1: horizontal range (wider than header to support translation animation)
  // T: period px, A: amplitude px, cy: baseline y, fillY: bottom of fill (header height)
  function genPath(x0, x1, T, A, cy, fillY) {
    const hp = T / 2;
    let d = `M${x0} ${cy}`;
    let up = true;
    for (let x = x0; x < x1; x += hp) {
      const nx = x + hp;
      const py = up ? cy - A : cy + A;          // peak or trough
      d += ` C${x + hp * 0.4} ${py},${x + hp * 0.6} ${py},${nx} ${cy}`;
      up = !up;
    }
    d += ` L${x1} ${fillY} L${x0} ${fillY}Z`;
    return d;
  }
  const p1 = document.getElementById('wfPath1');
  const p2 = document.getElementById('wfPath2');
  if (p1) p1.setAttribute('d', genPath(-880, 2640, 220, 8, 42, 56));
  if (p2) p2.setAttribute('d', genPath(-640, 2400, 160, 12, 36, 56));
  _waveReady = true;
}

// Wave animation state
let _waveCurrentW = 0;
let _waveRafId    = null;   // clip-width interpolation
let _waveAnimId   = null;   // continuous wave motion
let _waveOff1     = 0;      // running offset for wave 1 (drifts left)
let _waveOff2     = 0;      // running offset for wave 2 (drifts right)

// Per-frame speeds: wave1 period=220px over 3s, wave2 period=160px over 2s @ ~60fps
const _W1_SPEED = 220 / (3 * 60);
const _W2_SPEED = 160 / (2 * 60);

function _startWaveMotion() {
  if (_waveAnimId) return;
  const p1 = document.getElementById('wfPath1');
  const p2 = document.getElementById('wfPath2');
  function frame() {
    _waveOff1 = (_waveOff1 + _W1_SPEED) % 220;
    _waveOff2 = (_waveOff2 + _W2_SPEED) % 160;
    if (p1) p1.setAttribute('transform', `translate(${-_waveOff1},0)`);
    if (p2) p2.setAttribute('transform', `translate(${_waveOff2},0)`);
    _waveAnimId = requestAnimationFrame(frame);
  }
  _waveAnimId = requestAnimationFrame(frame);
}

function _stopWaveMotion() {
  if (_waveAnimId) { cancelAnimationFrame(_waveAnimId); _waveAnimId = null; }
}

function updateNavWave() {
  if (!_waveReady) _initWavePaths();
  const wrap = document.getElementById('headerWaveWrap');
  if (!wrap) return;

  const total   = state.timer.durationMs / 1000 || 1;
  const pct     = state.timer.mode === 'stopwatch' ? (state.timer.timeLeft > 0 ? 35 : 0)
    : Math.max(0, Math.min(100, ((total - state.timer.timeLeft) / total) * 100));
  const running = state.timer.running;

  if (running || pct > 0) {
    wrap.style.opacity = '1';
    _startWaveMotion();
    const headerW = document.querySelector('.header')?.offsetWidth || window.innerWidth;
    const minPx   = running ? headerW * 0.08 : 0;
    // CSS transition on the wrapper handles the smooth growth
    wrap.style.width = Math.max(minPx, (pct / 100) * headerW) + 'px';
  } else {
    wrap.style.opacity = '0';
    wrap.style.width   = '0px';
    _stopWaveMotion();
  }
}

function tick() {
  if (!state.timer.running) return;
  const timing = DailyFlowWorkflows.clock(state.timer, Date.now());
  state.timer.timeLeft = state.timer.mode === 'stopwatch' ? Math.floor(timing.elapsedMs/1000) : Math.ceil(timing.remainingMs/1000);
  if (state.timer.mode !== 'stopwatch' && timing.remainingMs <= 0) {
    timerDone();
  } else {
    renderRing();
    renderTimeDisplay();
    updateNavWave();
  }
}

function timerDone() {
  if (!state.timer.running || state.timer.mode === 'stopwatch' || !state.timer.sessionId || Date.now() < state.timer.deadlineAt) return;
  const wasWork = state.timer.mode === 'work';
  stopTimer('complete', wasWork);

  if (wasWork) {
    state.timer.cyclePos = (state.timer.cyclePos + 1) % state.settings.longBreakInterval;
    state.timer.totalToday = state.pomLog[todayStr()] || 0;

    save();
    beep('done');
    showToast('🍅 Pomodoro complete! Take a break.');
    sendDesktopNotif('🍅 Pomodoro complete!', 'Time for a break.');
    renderStats();
    updateSessionBanner();
    renderLog(); // update pom badges
    checkAchievements();

    const nextMode = state.timer.cyclePos === 0 ? 'longBreak' : 'shortBreak';
    setMode(nextMode);
    if (state.settings.autoStartBreaks && !document.hidden) startTimer();
  } else {
    beep('done');
    showToast('☕ Break over! Ready to focus?');
    sendDesktopNotif('☕ Break over!', 'Ready to focus?');
    setMode('work');
    if (state.settings.autoStartWork && !document.hidden) startTimer();
  }
}

function resetTimer() {
  stopTimer('reset');
  setMode(state.timer.mode);
}

function skipTimer() {
  const mode = state.timer.mode;
  stopTimer('skip');
  setMode(mode === 'work' ? 'shortBreak' : 'work');
  showToast('Skipped. No Pomodoro completion added.');
}

function finishTimer() {
  if (state.timer.running && state.timer.mode !== 'stopwatch' && Date.now() >= state.timer.deadlineAt) {
    timerDone();
    return;
  }
  stopTimer('finish');
  setMode(state.timer.mode);
  showToast('Tracked time saved.');
}

/* ─────────────────────────────────────────────────────
   TIMER – Rendering
───────────────────────────────────────────────────── */

function renderTimerAll() {
  renderTimerModeUI();
  renderRing();
  renderTimeDisplay();
  renderPlayBtn();
  renderDots();
  updateNavWave();
  updateSessionBanner();
}

function renderTimerModeUI() {
  const card = document.querySelector('.timer-card');
  card.className = 'card timer-card ' + MODE_COLORS[state.timer.mode].modeClass;

  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === state.timer.mode);
  });
  document.querySelector('[data-timer-kind="stopwatch"]')?.classList.toggle('active', state.timer.mode === 'stopwatch');
  document.getElementById('skipBtn').hidden = state.timer.mode === 'stopwatch';

  document.getElementById('timerLabel').textContent = MODE_LABELS[state.timer.mode];

  const ring = document.getElementById('timerRing');
  ring.style.stroke = MODE_COLORS[state.timer.mode].stroke;
  ring.style.strokeDasharray = CIRCUMFERENCE;
}

function renderRing() {
  const prog = state.timer.mode === 'stopwatch' ? 1 : Math.max(0, Math.min(1, state.timer.timeLeft / (state.timer.durationMs/1000 || getModeSecs(state.timer.mode))));
  document.getElementById('timerRing').style.strokeDashoffset = CIRCUMFERENCE * (1 - prog);
}

function renderTimeDisplay() {
  const t = fmtTime(state.timer.timeLeft);
  document.getElementById('timerTime').textContent = t;
  document.title = state.timer.running ? `${t} — DailyFlow` : 'DailyFlow';
}

function renderPlayBtn() {
  const btn   = document.getElementById('playBtn');
  const txt   = document.getElementById('playText');
  const play  = btn.querySelector('.play-icon');
  const pause = btn.querySelector('.pause-icon');
  const finish = document.getElementById('finishBtn');
  if (finish) finish.disabled = !state.timer.sessionId;
  if (state.timer.running) {
    txt.textContent = 'Pause'; play.style.display = 'none'; pause.style.display = 'block';
  } else {
    txt.textContent = state.timer.sessionId || state.timer.remainingMs !== state.timer.durationMs ? 'Resume' : 'Start'; play.style.display = 'block'; pause.style.display = 'none';
  }
}

function renderDots() {
  const n   = state.settings.longBreakInterval;
  const pos = state.timer.cyclePos;
  let html  = '';
  for (let i = 0; i < n; i++) {
    let cls = 'dot';
    if (i < pos) cls += ' done';
    else if (i === pos && state.timer.mode === 'work') cls += ' current';
    html += `<span class="${cls}"></span>`;
  }
  document.getElementById('dotsRow').innerHTML = html;
  document.getElementById('cycleInfo').textContent =
    `Session ${pos + 1} of ${n} · ${state.timer.totalToday} done today`;
}

/* ─────────────────────────────────────────────────────
   STATS
───────────────────────────────────────────────────── */

function renderStats() {
  const entries = (state.notes.entries[todayStr()] || []).filter(entry => !entry.archived && !entry.rolledTo);
  document.getElementById('sEntries').textContent = entries.length;
  const poms = state.pomLog[todayStr()] || 0;
  state.timer.totalToday = poms;
  const goal = state.settings.dailyGoal || 0;
  if (goal > 0) {
    const pct = Math.min(100, Math.round((poms / goal) * 100));
    document.getElementById('sPomodos').textContent = `${poms}/${goal}`;
    document.getElementById('sPomodos').title = `${pct}% of daily goal`;
  } else {
    document.getElementById('sPomodos').textContent = poms;
    document.getElementById('sPomodos').title = '';
  }
  const seconds = state.focusLog?.[todayStr()] || 0;
  document.getElementById('sFocus').textContent = seconds >= 60 ? `${Math.floor(seconds/60)}m` : `${seconds}s`;
  document.getElementById('sFocus').title = `${seconds} recorded seconds today`;
  renderDots();
  renderGhostBanner();
  renderGhostDrawer();
}

/* ─────────────────────────────────────────────────────
   DATE NAVIGATION
───────────────────────────────────────────────────── */

function renderDateHeader() {
  const [main, sub] = fmtDate(state.notes.date);
  document.getElementById('dateMain').textContent = main;
  document.getElementById('dateSub').textContent  = sub || '';
  const next = document.getElementById('nextDay');
  next.disabled = false;
  next.style.opacity = next.disabled ? '.3' : '1';
  syncEntryDatePicker();
}

function changeDate(delta) {
  const str = offsetDate(state.notes.date, delta);
  state.ui.taskScope = 'daily';
  state.notes.date = str;
  renderDateHeader();
  renderLog();
  renderStats();
  renderCalendar();
}

function goToday() {
  state.ui.taskScope = 'daily';
  state.notes.date = todayStr();
  renderDateHeader();
  renderLog();
  renderStats();
  renderCalendar();
}

/* ─────────────────────────────────────────────────────
   ENTRIES – CRUD
───────────────────────────────────────────────────── */

/* ── Sub-tasks at creation ──────────────────────────── */
let _newSubtasks = [];

function _renderNewStList() {
  const list = document.getElementById('newStList');
  const btn  = document.getElementById('toggleNewSt');
  if (!list) return;
  if (_newSubtasks.length === 0) {
    list.style.display = 'none';
    list.innerHTML = '';
    if (btn) btn.dataset.active = 'false';
    return;
  }
  list.style.display = '';
  list.innerHTML = `
    <div class="cmd-panel-label">// SUBTASKS</div>
    ${_newSubtasks.map((t, i) => `
    <div class="new-st-item">
      <span class="new-st-bullet">◦${i+1}</span>
      <input class="new-st-input" value="${esc(t)}"
        placeholder="Sub-task ${i+1}…"
        oninput="_newSubtasks[${i}]=this.value"
        onkeydown="if(event.key==='Enter'){event.preventDefault();_addNewSubtask();}if(event.key==='Backspace'&&this.value===''){event.preventDefault();_removeNewSt(${i});}" />
      <button class="st-del" onclick="_removeNewSt(${i})" title="Remove">✕</button>
    </div>`).join('')}
    <button class="cmd-toggle-btn" style="margin-top:4px;font-size:.7rem" onclick="_addNewSubtask()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Add another
    </button>
  `;
  if (btn) btn.dataset.active = 'true';
  // focus last input
  const inputs = list.querySelectorAll('.new-st-input');
  if (inputs.length) inputs[inputs.length-1].focus();
}

function _addNewSubtask() {
  _newSubtasks.push('');
  _renderNewStList();
}

function _removeNewSt(i) {
  _newSubtasks.splice(i, 1);
  _renderNewStList();
}

function addEntry() {
  if(!state.activeProfileId){showToast('Create a profile first.');return;}
  const input     = document.getElementById('entryInput');
  const desc      = document.getElementById('descInput');
  const datePick  = document.getElementById('entryDate');
  const text      = input.value.trim();

  if (!text) {
    input.style.borderColor = '#EF4444';
    setTimeout(() => { input.style.borderColor = ''; }, 800);
    input.focus();
    return;
  }

  // Use the date picker value if set, otherwise fall back to current view date
  const targetDate = (datePick?.value) || state.notes.date;
  if (!DailyFlowWorkflows.validDate(targetDate)) {
    showToast('Choose a valid task date.');
    datePick?.focus();
    return;
  }

  const entry = {
    id:         'task_' + (globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`),
    content:    text,
    notes:      desc.value.trim(),
    cat:        document.getElementById('catSel').value,
    priority:   document.getElementById('priSel').value,
    tags:       parseTags(text),
    time:       nowTime(),
    ts:         Date.now(),
    done:       false,
    pomodoros:  0,
    subtasks:   _newSubtasks.map(t => t.trim()).filter(Boolean).map(t => ({ id: Date.now().toString() + Math.random(), text: t, done: false })),
    comments:   [],
    rolledFrom:   null,
    rolledTo:     null,
    autoRollover: false,
  };

  if (!state.notes.entries[targetDate]) state.notes.entries[targetDate] = [];
  state.notes.entries[targetDate].unshift(entry);

  input.value = '';
  desc.value  = '';
  _newSubtasks = [];
  _renderNewStList();
  // reset toggle buttons
  state.ui.descOpen = false;
  const descPanel = document.getElementById('descRow');
  if (descPanel) descPanel.style.display = 'none';
  const descBtn = document.getElementById('toggleDesc');
  if (descBtn) descBtn.dataset.active = 'false';
  save();

  const isDifferentDate = targetDate !== state.notes.date;
  if (isDifferentDate) {
    const [lbl] = fmtDate(targetDate);
    showToast(`✓ Task added to ${lbl}`, () => navigateToDate(targetDate));
    // Just update calendar to reflect the new dot
    renderCalendar();
  } else {
    renderLog();
    renderStats();
    renderCalendar();
  }
  checkAchievements();
  renderStats();
  if (state.ui.taskScope !== 'daily') renderLog();
  input.focus();
}

function syncEntryDatePicker() {
  const dp = document.getElementById('entryDate');
  if (!dp) return;
  if (!state.ui.entryDateExplicit || !dp.value) dp.value = state.notes.date;
  // Highlight if different from today
  dp.classList.toggle('date-changed', dp.value !== todayStr());
}

function delEntry(id) {
  const d = DailyFlowWorkflows.locate(state.notes.entries, id)?.date;
  if (state.notes.entries[d]) {
    state.notes.entries[d] = state.notes.entries[d].filter(e => e.id !== id);
    if (state.timer.activeEntryId === id) trackEntry(id);
    save(); renderLog(); renderStats(); renderCalendar();
  }
}

function toggleDone(id) {
  const entry = findEntry(id);
  if (!entry) return;
  if (!entry.done) {
    // About to mark done — ask for time spent (optional)
    promptTimeSpent(id);
  } else {
    // Un-marking done: just toggle off
    entry.done = false;
    entry.timeSpent = null;
    state.ui.timeSpentId = null;
    save();
    renderLog();
    renderStats();
  }
}

function startEdit(id, fromDblclick) {
  if (_editId && _editId !== id) cancelEdit(_editId);
  const entry    = findEntry(id);
  if (!entry) return;
  const textEl   = document.getElementById(`et-${id}`);
  const inpEl    = document.getElementById(`ei-${id}`);
  const ctrlsEl  = document.getElementById(`editcontrols-${id}`);
  const catSelEl = document.getElementById(`ec-${id}`);
  if (!textEl || !inpEl) return;

  if (inpEl.classList.contains('show')) {
    // Save
    const val = inpEl.value.trim();
    if (val) {
      entry.content = val;
      entry.tags    = parseTags(val);
    }
    if (catSelEl) entry.cat = catSelEl.value;
    _editId = null;
    inpEl.classList.remove('show');
    save();
    renderLog();
  } else {
    // Enter edit mode — flash confirms dblclick
    if (fromDblclick) {
      textEl.classList.remove('edit-flash');
      void textEl.offsetWidth; // force reflow so re-adding the class re-triggers
      textEl.classList.add('edit-flash');
      setTimeout(() => textEl.classList.remove('edit-flash'), 260);
    }
    textEl.classList.add('hide');
    inpEl.classList.add('show');
    if (ctrlsEl) ctrlsEl.classList.add('show');
    inpEl.focus(); inpEl.select();
    _editId = id;
    inpEl.onkeydown = e => {
      if (e.key === 'Enter')  startEdit(id);
      if (e.key === 'Escape') cancelEdit(id);
    };
  }
}

function cancelEdit(id) {
  const textEl  = document.getElementById(`et-${id}`);
  const inpEl   = document.getElementById(`ei-${id}`);
  const ctrlsEl = document.getElementById(`editcontrols-${id}`);
  if (textEl)  textEl.classList.remove('hide');
  if (inpEl)   inpEl.classList.remove('show');
  if (inpEl) inpEl.value = findEntry(id)?.content || '';
  delete (_logDrafts[_logDraftKey()] || {})[`ei-${id}`];
  if (ctrlsEl) ctrlsEl.classList.remove('show');
  if (_editId === id) _editId = null;
}

function toggleNotes(id) {
  const el = document.getElementById(`notes-${id}`);
  const btn = document.getElementById(`ntoggle-${id}`);
  if (!el) return;
  const open = el.classList.toggle('show');
  if (btn) btn.textContent = open ? '▲ Hide notes' : '▼ Show notes';
}

function trackEntry(id) {
  if (state.timer.running) stopTimer('switch');
  // A link change starts a fresh session; already saved segments keep their original task.
  const mode = state.timer.mode;
  setMode(mode);
  if (state.timer.activeEntryId === id) {
    state.timer.activeEntryId = null;
    state.timer.activeEntryDate = null;
  } else {
    state.timer.activeEntryId = id;
    state.timer.activeEntryDate = DailyFlowWorkflows.locate(state.notes.entries, id)?.date || null;
  }
  saveTimerState();
  renderLog();
  updateSessionBanner();
}

function updateSessionBanner() {
  const banner = document.getElementById('sessionBanner');
  const label = document.getElementById('timerLinkedTask');
  if (label) label.textContent = 'No task linked · time still counts';
  if (state.timer.activeEntryId) {
    const e = findEntry(state.timer.activeEntryId);
    if (e) {
      banner.style.display = '';
      document.getElementById('bannerTask').textContent = e.content.replace(/#\w+/g,'').trim();
      const p = e.pomodoros || 0;
      document.getElementById('bannerPoms').textContent = `${p} pomodoro${p===1?'':'s'} · ${Math.floor((e.focusSeconds || 0)/60)}m tracked`;
      if (label) label.textContent = `Linked: ${e.content} · ${state.timer.activeEntryDate || ''}`;
      return;
    }
  }
  banner.style.display = 'none';
}

function reorderEntries(srcId, tgtId) {
  const arr = state.notes.entries[state.notes.date];
  if (!arr) return;
  const si = arr.findIndex(e => e.id === srcId);
  const ti = arr.findIndex(e => e.id === tgtId);
  if (si === -1 || ti === -1) return;
  const [item] = arr.splice(si, 1);
  arr.splice(ti, 0, item);
  save(); renderLog();
}

function findEntry(id) {
  return DailyFlowWorkflows.locate(state.notes.entries, id)?.entry || null;
}

function archiveEntry(id) {
  const entry = findEntry(id);
  if (!entry) return;
  entry.archived = !(entry.archived || (state.settings.ghostDismissed || []).includes(id));
  state.settings.ghostDismissed = (state.settings.ghostDismissed || []).filter(value => value !== id);
  save(); renderLog(); renderStats(); renderCalendar();
  showToast(entry.archived ? 'Task archived. Open Archived to restore it.' : 'Task restored.');
}

function setTaskScope(scope) {
  state.ui.taskScope = scope;
  renderLog();
}

/* ─────────────────────────────────────────────────────
   COMMENTS
───────────────────────────────────────────────────── */

function toggleCommentForm(id) {
  state.ui.commentFormId = state.ui.commentFormId === id ? null : id;
  state.ui.rollFormId    = null;
  state.ui.subtaskFormId = null;
  renderLog();
  if (state.ui.commentFormId === id) document.getElementById(`cmtInput-${id}`)?.focus();
}

function cancelCommentForm() {
  state.ui.commentFormId = null;
  renderLog();
}

function submitComment(id) {
  const el = document.getElementById(`cmtInput-${id}`);
  if (!el) return;
  const text = el.value.trim();
  if (!text) { el.focus(); return; }
  const entry = findEntry(id);
  if (!entry) return;
  if (!entry.comments) entry.comments = [];
  entry.comments.push({ id: Date.now().toString(), text, time: nowTime(), ts: Date.now() });
  el.value = '';
  state.ui.commentFormId = null;
  save();
  renderLog();
  renderCalendar();
  checkAchievements();
}

function deleteComment(entryId, commentId) {
  const entry = findEntry(entryId);
  if (!entry || !entry.comments) return;
  entry.comments = entry.comments.filter(c => c.id !== commentId);
  save();
  renderLog();
}

function toggleCommentSection(id) {
  const el = document.getElementById(`cmts-${id}`);
  if (!el) return;
  const collapsed = el.classList.toggle('cmt-collapsed');
  const arrow = document.getElementById(`cmtarrow-${id}`);
  if (arrow) arrow.classList.toggle('cmt-arrow-open', !collapsed);
}

/* ─────────────────────────────────────────────────────
   SUB-TASKS
───────────────────────────────────────────────────── */

function toggleSubtaskForm(id) {
  state.ui.subtaskFormId  = state.ui.subtaskFormId === id ? null : id;
  state.ui.commentFormId  = null;
  state.ui.rollFormId     = null;
  renderLog();
  if (state.ui.subtaskFormId === id) {
    setTimeout(() => document.getElementById(`sti-${id}`)?.focus(), 30);
  }
}

function cancelSubtaskForm() {
  state.ui.subtaskFormId = null;
  renderLog();
}

function submitSubtask(id) {
  const el = document.getElementById(`sti-${id}`);
  if (!el) return;
  const text = el.value.trim();
  if (!text) { el.focus(); return; }
  const entry = findEntry(id);
  if (!entry) return;
  if (!entry.subtasks) entry.subtasks = [];
  entry.subtasks.push({ id: Date.now().toString(), text, done: false });
  // Keep form open so user can add more
  el.value = '';
  save();
  renderLog();
  checkAchievements();
  setTimeout(() => document.getElementById(`sti-${id}`)?.focus(), 30);
}

function handleSubtaskKey(e, id) {
  if (e.key === 'Enter')  { e.preventDefault(); submitSubtask(id); }
  if (e.key === 'Escape') cancelSubtaskForm();
}

function toggleSubtask(entryId, stId) {
  const entry = findEntry(entryId);
  if (!entry || !entry.subtasks) return;
  const st = entry.subtasks.find(s => s.id === stId);
  if (!st) return;
  st.done = !st.done;

  // Auto-complete main task when ALL sub-tasks are checked
  if (entry.subtasks.length > 0 && entry.subtasks.every(s => s.done) && !entry.done) {
    entry.done = true;
    showToast('🎉 All sub-tasks done! Task marked complete.');
  }
  // If unchecking a subtask, un-complete the parent too
  if (!st.done && entry.done) entry.done = false;

  save();
  renderLog();
  renderStats();
  checkAchievements();
}

/* ─────────────────────────────────────────────────────
   TIME SPENT ON TASK
───────────────────────────────────────────────────── */

function promptTimeSpent(id) {
  const entry = findEntry(id);
  if (!entry) return;

  // Show inline time input on the entry
  state.ui.timeSpentId = id;
  renderLog();
  setTimeout(() => document.getElementById(`tsi-${id}`)?.focus(), 30);
}

function saveTimeSpent(id) {
  const el    = document.getElementById(`tsi-${id}`);
  const entry = findEntry(id);
  if (!entry) return;

  const raw = el?.value.trim();
  if (raw) {
    entry.timeSpent = raw;
  }
  // Mark done regardless of whether time was entered
  entry.done = true;
  state.ui.timeSpentId = null;
  save();
  renderLog();
  renderStats();
  checkAchievements();
}

function skipTimeSpent(id) {
  const entry = findEntry(id);
  if (entry) entry.done = true;
  state.ui.timeSpentId = null;
  save();
  renderLog();
  renderStats();
  checkAchievements();
}

function deleteSubtask(entryId, stId) {
  const entry = findEntry(entryId);
  if (!entry || !entry.subtasks) return;
  entry.subtasks = entry.subtasks.filter(s => s.id !== stId);
  save();
  renderLog();
}

/* ── Subtask edit in-place ──────────────────────────── */
function startEditSubtask(entryId, stId, fromDblclick) {
  const textEl   = document.getElementById(`st-text-${stId}`);
  const inputEl  = document.getElementById(`st-ei-${stId}`);
  const editBtn  = document.getElementById(`st-editbtn-${stId}`);
  const saveBtn  = document.getElementById(`st-savebtn-${stId}`);
  if (!textEl || !inputEl) return;
  if (fromDblclick) {
    textEl.classList.remove('st-edit-flash');
    void textEl.offsetWidth;
    textEl.classList.add('st-edit-flash');
    setTimeout(() => textEl.classList.remove('st-edit-flash'), 260);
  }
  textEl.style.display  = 'none';
  inputEl.style.display = 'block';
  if (editBtn) editBtn.style.display = 'none';
  if (saveBtn) saveBtn.style.display = 'inline-flex';
  inputEl.focus();
  inputEl.select();
}

function saveEditSubtask(entryId, stId) {
  const inputEl = document.getElementById(`st-ei-${stId}`);
  if (!inputEl) return;
  const val = inputEl.value.trim();
  if (!val) return;
  const entry = findEntry(entryId);
  if (!entry || !entry.subtasks) return;
  const st = entry.subtasks.find(s => s.id === stId);
  if (st) st.text = val;
  inputEl.style.display = 'none';
  delete (_logDrafts[_logDraftKey()] || {})[`st-ei-${stId}`];
  save();
  renderLog();
}

function handleStEditKey(e, entryId, stId) {
  if (e.key === 'Enter')  { e.preventDefault(); saveEditSubtask(entryId, stId); }
  if (e.key === 'Escape') {
    document.getElementById(`st-ei-${stId}`)?.style.setProperty('display', 'none');
    delete (_logDrafts[_logDraftKey()] || {})[`st-ei-${stId}`];
    renderLog();
  }
}



function showRollForm(id) {
  state.ui.rollFormId    = state.ui.rollFormId === id ? null : id;
  state.ui.commentFormId = null;
  state.ui.subtaskFormId = null;
  renderLog();
  if (state.ui.rollFormId === id) document.getElementById(`rollDate-${id}`)?.focus();
}

function cancelRollForm() {
  state.ui.rollFormId = null;
  renderLog();
}

function confirmRoll(id) {
  const found = DailyFlowWorkflows.locate(state.notes.entries, id);
  if (!found) return;
  const targetDate = document.getElementById(`rollDate-${id}`)?.value || offsetDate(found.date, 1);
  if (!DailyFlowWorkflows.validDate(targetDate) || targetDate <= found.date) {
    showToast('Choose a valid date after ' + found.date);
    return;
  }
  const note = document.getElementById(`rollInput-${id}`)?.value.trim() || '';
  const time = document.getElementById(`rollTime-${id}`)?.value.trim() || '';
  if (time) found.entry.timeSpent = time;
  const result = DailyFlowWorkflows.carry(state.notes.entries, found.date, id, targetDate, Date.now(),
    `↩ Carried from ${found.date}${time ? ' · ⏱ '+time+' spent' : ''}${note ? ' — '+note : ''}`);
  if (!result) return;
  state.ui.rollFormId = null;
  save(); renderLog(); renderCalendar(); renderStats();
  showToast('✓ Task carried to ' + fmtDate(targetDate)[0]);
  checkAchievements();
}

/* ─────────────────────────────────────────────────────
   LOG – Rendering
───────────────────────────────────────────────────── */

function getFilteredEntries() {
  const scope = state.ui.taskScope || 'daily';
  const all = scope === 'daily' ? (state.notes.entries[state.notes.date] || []).filter(e => !e.archived)
    : DailyFlowWorkflows.unfinished(state.notes.entries, todayStr(), scope === 'archived', state.settings.ghostDismissed || []).map(item => item.entry);
  const q   = state.ui.search.toLowerCase();
  const cat = state.ui.filterCat;
  const pri = state.ui.filterPri;
  return all.filter(e => {
    if (cat && e.cat !== cat) return false;
    if (pri && e.priority !== pri) return false;
    if (q) {
      const haystack = [e.content, e.notes, ...(e.tags||[])].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function renderLog() {
  const container = document.getElementById('log');
  const previousFocus = document.activeElement;
  const focusId = container.contains(previousFocus) ? previousFocus.id : null;
  const selection = focusId && typeof previousFocus.selectionStart === 'number'
    ? [previousFocus.selectionStart, previousFocus.selectionEnd] : null;
  const draftKey = _logDraftKey();
  const drafts = _logDrafts[draftKey] || (_logDrafts[draftKey] = {});
  container.querySelectorAll('textarea[id], input[id], select[id]').forEach(el => {
    if (el.classList.contains('edit-input') && !el.classList.contains('show')) return;
    if (el.classList.contains('st-edit-input') && el.style.display === 'none') return;
    if (el.id) drafts[el.id] = { value: el.value, editingSubtask: el.classList.contains('st-edit-input') };
  });
  const notesOpen = [...container.querySelectorAll('.entry-notes.show')].map(el => el.id);
  const commentsOpen = [...container.querySelectorAll('.entry-comments:not(.cmt-collapsed)')].map(el => el.id);
  const entries   = getFilteredEntries();
  const scope = state.ui.taskScope || 'daily';
  document.querySelectorAll('[data-task-scope]').forEach(button => button.classList.toggle('active', button.dataset.taskScope === scope));

  if (!entries.length) {
    const all = (state.notes.entries[state.notes.date] || []).length;
    container.innerHTML = `
      <div class="empty">
        <div class="empty-icon">${all > 0 ? '🔍' : '📝'}</div>
        <div class="empty-title">${scope === 'archived' ? 'No archived tasks' : scope === 'unfinished' ? 'No unfinished tasks' : all > 0 ? 'No matching entries' : 'No entries yet'}</div>
        <div class="empty-sub">${scope !== 'daily' || all > 0 ? 'Try adjusting your filters.' : 'Add your first task above!'}</div>
      </div>`;
    return;
  }

  let previousGroup = '';
  container.innerHTML = entries.map(entry => {
    const entryDate = DailyFlowWorkflows.locate(state.notes.entries, entry.id)?.date || state.notes.date;
    const group = entryDate < todayStr() ? 'Earlier' : entryDate === todayStr() ? 'Today' : 'Upcoming';
    const groupHeading = scope !== 'daily' && group !== previousGroup ? `<h3 class="task-group-heading">${group}</h3>` : '';
    previousGroup = group;
    const cat        = getAllCats()[entry.cat] || CATS.other;
    const isTrack    = state.timer.activeEntryId === entry.id;
    const poms       = entry.pomodoros || 0;
    const doneCs     = entry.done ? 'done-entry' : '';
    const priCs      = entry.priority && entry.priority !== 'none' ? `pri-badge pri-${entry.priority}` : '';
    const priLbl     = { high:'High', medium:'Medium', low:'Low' }[entry.priority] || '';
    const hasNotes   = entry.notes && entry.notes.trim();
    const comments   = entry.comments  || [];
    const subtasks   = entry.subtasks  || [];
    const stDone     = subtasks.filter(s => s.done).length;
    const stPct      = subtasks.length ? Math.round((stDone / subtasks.length) * 100) : 0;
    const targetDate = offsetDate(entryDate, 1);
    const [targetLbl] = fmtDate(targetDate);
    const showCmtForm  = state.ui.commentFormId  === entry.id;
    const showRollForm = state.ui.rollFormId     === entry.id;
    const showStForm    = state.ui.subtaskFormId  === entry.id;
    const showTimeForm  = state.ui.timeSpentId    === entry.id;

    // ── Sub-tasks block ───────────────────────────────
    const subtasksHtml = `
      <div class="subtasks-section">
        ${subtasks.length > 0 ? `
          <div class="st-progress-row">
            <div class="st-prog-bar"><div class="st-prog-fill" style="width:${stPct}%"></div></div>
            <span class="st-prog-lbl">${stDone}/${subtasks.length} done</span>
          </div>
          <div class="subtasks-list">
            ${subtasks.map(st => `
              <div class="subtask-item ${st.done ? 'st-done' : ''}" id="sti-wrap-${st.id}" data-stid="${st.id}" data-entryid="${entry.id}">
                <label class="st-check">
                  <input type="checkbox" ${st.done ? 'checked' : ''}
                    onchange="toggleSubtask('${entry.id}','${st.id}')">
                  <span class="st-box"></span>
                </label>
                <span class="st-text" id="st-text-${st.id}">${esc(st.text)}</span>
                <input class="st-edit-input" id="st-ei-${st.id}" value="${esc(st.text)}"
                  style="display:none"
                  onkeydown="handleStEditKey(event,'${entry.id}','${st.id}')"
                  onclick="event.stopPropagation()" />
                <button class="st-edit" id="st-editbtn-${st.id}"
                  onclick="startEditSubtask('${entry.id}','${st.id}')" title="Edit">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="st-save" id="st-savebtn-${st.id}" style="display:none"
                  onclick="saveEditSubtask('${entry.id}','${st.id}')" title="Save">✓</button>
                <button class="st-del" onclick="deleteSubtask('${entry.id}','${st.id}')"
                  title="Remove">✕</button>
              </div>`).join('')}
          </div>` : ''}
        ${showStForm ? `
          <div class="add-st-row">
            <input class="add-st-input" id="sti-${entry.id}"
              placeholder="Sub-task… (Enter to add, Esc to close)"
              autocomplete="off"
              onkeydown="handleSubtaskKey(event,'${entry.id}')" />
            <button class="outline-btn sm-btn" onclick="submitSubtask('${entry.id}')">Add</button>
            <button class="act-btn" onclick="cancelSubtaskForm()" title="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>` : `
          <button class="add-st-btn" onclick="toggleSubtaskForm('${entry.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
              width="12" height="12"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add sub-task
          </button>`}
      </div>`;

    // Rolled-from / rolled-to badges
    const rolledFromBadge = entry.rolledFrom
      ? `<span class="rolled-badge rfrom">↩ from ${fmtDate(entry.rolledFrom)[0]}</span>` : '';
    const rolledToBadge = entry.rolledTo
      ? `<span class="rolled-badge rto">→ ${fmtDate(entry.rolledTo)[0]}</span>` : '';

    // Comments HTML
    const cmtMode = state.settings.commentViewMode || 'expandcollapse';
    const cmtsHtml = comments.length > 0 ? `
      <div class="entry-comments cmt-collapsed" id="cmts-${entry.id}">
        ${comments.map(c => `
          <div class="comment-item ${c.system ? 'cmt-system' : ''}">
            <span class="cmt-time">${c.time}</span>
            <span class="cmt-text">${esc(c.text)}</span>
            ${!c.system ? `<button class="cmt-del" onclick="deleteComment('${entry.id}','${c.id}')" title="Delete comment">✕</button>` : ''}
          </div>`).join('')}
      </div>` : '';

    // Add-comment form
    const cmtFormHtml = showCmtForm ? `
      <div class="inline-form">
        <textarea class="inline-textarea" id="cmtInput-${entry.id}"
          placeholder="Add a comment or progress update…" rows="2"></textarea>
        <div class="inline-form-row">
          <button class="primary-btn sm-btn" onclick="submitComment('${entry.id}')">Add comment</button>
          <button class="outline-btn sm-btn" onclick="cancelCommentForm()">Cancel</button>
        </div>
      </div>` : '';

    // Roll to a specific date form
    const rollFormHtml = showRollForm ? `
      <div class="inline-form roll-inline">
        <div class="roll-form-title">📅 Roll task to a specific date</div>
        <div class="roll-two-fields">
          <div class="roll-field">
            <span class="roll-field-lbl">📅 Target date <span style="color:#EF4444">*</span></span>
            <input type="date" class="range-input roll-date-pick" id="rollDate-${entry.id}"
              value="${targetDate}"
              min="${offsetDate(entryDate, 1)}" />
          </div>
          <div class="roll-field">
            <span class="roll-field-lbl">⏱ Time spent today <span class="ts-optional">(optional)</span></span>
            <input class="add-st-input" id="rollTime-${entry.id}"
              placeholder="e.g. 2 hrs, 45 min…" autocomplete="off" />
          </div>
          <div class="roll-field">
            <span class="roll-field-lbl">📝 Note <span class="ts-optional">(optional — appears on the target day)</span></span>
            <textarea class="inline-textarea" id="rollInput-${entry.id}"
              placeholder="Why is it rolling? What needs to happen?…" rows="2"></textarea>
          </div>
        </div>
        <div class="inline-form-row">
          <button class="primary-btn sm-btn" onclick="confirmRoll('${entry.id}')">Roll over →</button>
          <button class="outline-btn sm-btn" onclick="cancelRollForm()">Cancel</button>
        </div>
      </div>` : '';

    const catColor = cat.color || '#6B7280';

    return `
      ${groupHeading}<div class="log-entry ${doneCs}" data-id="${entry.id}">

        <!-- ── Drag grip (hidden at rest, revealed on hover) ── -->
        <div class="entry-grip">
          <span class="entry-grip-icon">&#8942;&#8942;</span>
          <span class="entry-grip-label">drag to reorder</span>
          <span class="entry-grip-hint">dblclick to edit</span>
        </div>

        <!-- ── Category side label ── -->
        <div class="cat-side-label" style="background:${catColor}">${cat.label}</div>

        <!-- ── Main row ── -->
        <div class="entry-main-row">
          <label class="check-wrap">
            <input type="checkbox" ${entry.done?'checked':''} onchange="toggleDone('${entry.id}')">
            <span class="checkmark"></span>
          </label>
          <div class="cat-badge">${cat.emoji}</div>
          <div class="entry-body">
            <div class="entry-content-line">
              <div class="entry-text" id="et-${entry.id}"
                style="${entry.done?'text-decoration:line-through':''}">${fmtContent(entry.content)}</div>
              ${priCs        ? `<span class="${priCs}">${priLbl}</span>` : ''}
              ${rolledFromBadge}${rolledToBadge}
            </div>
            <input class="edit-input" id="ei-${entry.id}" value="${esc(entry.content)}" />
            <div class="edit-controls" id="editcontrols-${entry.id}">
              <select class="edit-cat-sel" id="ec-${entry.id}">
                ${Object.entries(getAllCats()).map(([k,v]) => `<option value="${k}" ${entry.cat===k?'selected':''}>${v.emoji} ${v.label}</option>`).join('')}
              </select>
              <button class="primary-btn sm-btn" onclick="startEdit('${entry.id}')">Save</button>
              <button class="outline-btn sm-btn" onclick="cancelEdit('${entry.id}')">Cancel</button>
            </div>
            ${subtasksHtml}
            ${hasNotes ? `
              <div class="entry-notes" id="notes-${entry.id}">${esc(entry.notes)}</div>
              <button class="notes-toggle" id="ntoggle-${entry.id}"
                onclick="toggleNotes('${entry.id}')">▼ Show notes</button>` : ''}
            <div class="entry-meta">
              <span class="entry-time">${entry.time}</span>
              ${scope !== 'daily' ? `<button class="task-date-link" onclick="navigateToDate('${entryDate}')">${entryDate}</button>` : ''}
              ${cat.custom
                ? `<span class="cat-pill" style="background:${cat.color}">${cat.label}</span>`
                : `<span class="cat-pill ${cat.pill}">${cat.label}</span>`}
              ${poms > 0 ? `<span class="pom-badge">🍅 ${poms}</span>` : ''}
              ${entry.focusSeconds > 0 ? `<span class="time-spent-badge">⏱ ${Math.floor(entry.focusSeconds/60)}m tracked</span>` : ''}
              ${entry.timeSpent ? `<span class="time-spent-badge">⏱ ${esc(entry.timeSpent)}</span>` : ''}
              ${subtasks.length > 0
                ? `<span class="st-meta-pill ${stDone===subtasks.length?'st-all-done':''}">${stDone}/${subtasks.length} ✓</span>` : ''}
              ${comments.length > 0
                ? `<button class="cmt-toggle-btn" onclick="toggleCommentSection('${entry.id}')">
                     💬 ${comments.length} comment${comments.length===1?'':'s'}
                   </button>` : ''}
            </div>
          </div>
          <div class="entry-actions">
            <button class="act-btn archive-task" title="${entry.archived || scope === 'archived' ? 'Restore task' : 'Archive task'}"
              onclick="archiveEntry('${entry.id}')">${entry.archived || scope === 'archived' ? 'Restore' : 'Archive'}</button>
            ${(comments.length > 0 && cmtMode === 'expandcollapse') ? `
            <button class="act-btn cmt-expand-btn" id="cmtarrow-${entry.id}"
              title="Expand/collapse comments"
              onclick="toggleCommentSection('${entry.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>` : ''}
            <button class="act-btn ${showCmtForm?'act-active':''}" title="Add comment"
              onclick="toggleCommentForm('${entry.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </button>
            ${!entry.done && !entry.rolledTo ? `
            <button class="act-btn roll-btn ${showRollForm?'act-active':''}" title="Roll to ${targetLbl}"
              onclick="showRollForm('${entry.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="12" y1="15" x2="16" y2="15"/><polyline points="14 13 16 15 14 17"/></svg>
            </button>` : ''}
            ${(()=>{
              const _isAR = !!entry.autoRollover;
              const _arTitle = _isAR ? 'Auto-carry ON \u2014 click to disable' : 'Auto-carry OFF \u2014 click to enable daily auto-roll';
              return (!entry.done && !entry.rolledTo)
                ? '<button class="act-btn autoroll-btn' + (_isAR?' autoroll-active':'') + '" title="' + _arTitle + '" onclick="toggleAutoRollover(\'' + entry.id + '\')">'
                  + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>'
                  + '</button>'
                : '';
            })()}
            <button class="act-btn ${isTrack?'track-active':''}"
              title="${isTrack?'Stop tracking':'Track with pomodoro'}"
              onclick="trackEntry('${entry.id}')">
              <svg viewBox="0 0 24 24" fill="${isTrack?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </button>
            <button class="act-btn" title="Edit" onclick="startEdit('${entry.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="act-btn del" title="Delete" onclick="delEntry('${entry.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
        </div>

        <!-- ── Time Spent Prompt ── -->
        ${showTimeForm ? `
          <div class="inline-form time-spent-form">
            <div class="ts-title">⏱ How long did this take? <span class="ts-optional">(optional)</span></div>
            <div class="ts-row">
              <input class="add-st-input" id="tsi-${entry.id}" placeholder="e.g. 45 min, 2 hrs, 1h 30m…"
                onkeydown="if(event.key==='Enter'){saveTimeSpent('${entry.id}')}if(event.key==='Escape'){skipTimeSpent('${entry.id}')}" />
              <button class="primary-btn sm-btn" onclick="saveTimeSpent('${entry.id}')">Done ✓</button>
              <button class="outline-btn sm-btn" onclick="skipTimeSpent('${entry.id}')">Skip</button>
            </div>
          </div>` : ''}

        <!-- ── Comments ── -->
        ${cmtsHtml}

        <!-- ── Add comment form ── -->
        ${cmtFormHtml}

        <!-- ── Roll to next day form ── -->
        ${rollFormHtml}

      </div>`;
  }).join('');

  Object.entries(drafts).forEach(([id, draft]) => {
    const el = document.getElementById(id);
    if (!el || !container.contains(el)) return;
    if (el.classList.contains('edit-input') && _editId !== id.slice(3)) return;
    el.value = draft.value;
    if (draft.editingSubtask) {
      const stId = id.replace('st-ei-', '');
      el.style.display = 'block';
      document.getElementById(`st-text-${stId}`)?.style.setProperty('display', 'none');
      document.getElementById(`st-editbtn-${stId}`)?.style.setProperty('display', 'none');
      document.getElementById(`st-savebtn-${stId}`)?.style.setProperty('display', 'inline-flex');
    }
  });
  if (_editId) {
    document.getElementById(`et-${_editId}`)?.classList.add('hide');
    document.getElementById(`ei-${_editId}`)?.classList.add('show');
    document.getElementById(`editcontrols-${_editId}`)?.classList.add('show');
  }
  notesOpen.forEach(id => document.getElementById(id)?.classList.add('show'));
  commentsOpen.forEach(id => document.getElementById(id)?.classList.remove('cmt-collapsed'));
  if (focusId) {
    const focus = document.getElementById(focusId);
    focus?.focus({preventScroll:true});
    if (focus && selection && focus.setSelectionRange && focus.type !== 'date' && focus.type !== 'number') {
      try { focus.setSelectionRange(...selection); } catch (_) {}
    }
  }
}

/* ─────────────────────────────────────────────────────
   ANALYTICS – Data
───────────────────────────────────────────────────── */

function calcStreak() {
  let streak = 0;
  let d = todayStr();
  while (true) {
    const entries = state.notes.entries[d];
    if (!entries || entries.length === 0) break;
    streak++;
    d = offsetDate(d, -1);
  }
  return streak;
}

function allTimeStats() {
  let entries = 0, poms = 0, days = 0;
  Object.entries(state.notes.entries).forEach(([date, arr]) => {
    if (arr.length > 0) {
      entries += arr.length;
      poms += state.pomLog[date] || 0;
      days++;
    }
  });
  return { entries, poms, days };
}

function allTags() {
  const counts = {};
  Object.values(state.notes.entries).forEach(arr => {
    arr.forEach(e => {
      (e.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
    });
  });
  return Object.entries(counts).sort((a,b) => b[1]-a[1]);
}

function catCounts() {
  const c = {};
  Object.values(state.notes.entries).forEach(arr => {
    arr.forEach(e => { c[e.cat] = (c[e.cat] || 0) + 1; });
  });
  return c;
}

/* ─────────────────────────────────────────────────────
   ACHIEVEMENTS
───────────────────────────────────────────────────── */

function parseHour(timeStr) {
  const m = String(timeStr).match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return -1;
  let h = parseInt(m[1]);
  if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
  if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
  return h;
}

function evaluateAchievement(id) {
  const allEntries = Object.values(state.notes.entries).flat();
  const doneTasks  = allEntries.filter(e => e.done).length;
  const totalPoms  = Object.values(state.pomLog).reduce((a, b) => a + b, 0);
  const streak     = calcStreak();

  switch (id) {
    case 'first_entry':   return allEntries.length >= 1;
    case 'first_pom':     return totalPoms >= 1;
    case 'first_done':    return doneTasks >= 1;
    case 'first_comment': return allEntries.some(e => (e.comments||[]).some(c => !c.system));
    case 'first_subtask': return allEntries.some(e => (e.subtasks||[]).length > 0);
    case 'first_roll':    return allEntries.some(e => e.rolledTo);
    case 'fire_day':      return Object.values(state.pomLog).some(v => v >= 4);
    case 'power_day':     return Object.values(state.pomLog).some(v => v >= 8);
    case 'tasks_10':      return doneTasks >= 10;
    case 'tasks_50':      return doneTasks >= 50;
    case 'poms_10':       return totalPoms >= 10;
    case 'poms_50':       return totalPoms >= 50;
    case 'poms_100':      return totalPoms >= 100;
    case 'streak_3':      return streak >= 3;
    case 'streak_7':      return streak >= 7;
    case 'streak_14':     return streak >= 14;
    case 'streak_30':     return streak >= 30;
    case 'early_bird':    return allEntries.some(e => { const h = parseHour(e.time); return h >= 0 && h < 8; });
    case 'night_owl':     return allEntries.some(e => { const h = parseHour(e.time); return h >= 22; });
    case 'all_clear':     return Object.values(state.notes.entries).some(arr => arr.length >= 3 && arr.every(e => e.done));
    case 'tagger':        return new Set(allEntries.flatMap(e => e.tags || [])).size >= 5;
    case 'deep_focus':    return allEntries.some(e => (e.pomodoros||0) > 0);
    default:              return false;
  }
}

function checkAchievements() {
  const unlocked = state.achievements.unlocked;
  const newly    = [];

  ACHIEVEMENTS.forEach(a => {
    if (!unlocked.includes(a.id) && evaluateAchievement(a.id)) {
      unlocked.push(a.id);
      newly.push(a);
    }
  });

  if (newly.length > 0) {
    save();
    newly.forEach((a, i) => setTimeout(() => showAchievementToast(a), i * 1800));
    if (state.ui.view === 'analytics') renderAchievements();
  }
}

function showAchievementToast(a) {
  const el = document.getElementById('achieveToast');
  if (!el) return;
  document.getElementById('achToastIcon').textContent  = a.icon;
  document.getElementById('achToastTitle').textContent = a.title;
  document.getElementById('achToastDesc').textContent  = a.desc;
  el.className = `achieve-toast tier-${a.tier} show`;
  clearTimeout(el._tm);
  el._tm = setTimeout(() => el.classList.remove('show'), 4500);
}

function renderAchievements() {
  const grid     = document.getElementById('achGrid');
  const countEl  = document.getElementById('achCount');
  const fillEl   = document.getElementById('achFill');
  if (!grid) return;

  const unlocked = state.achievements.unlocked;
  const total    = ACHIEVEMENTS.length;
  const done     = unlocked.length;
  const pct      = Math.round((done / total) * 100);

  if (countEl) countEl.textContent = `${done} / ${total} unlocked`;
  if (fillEl)  fillEl.style.width  = pct + '%';

  grid.innerHTML = ACHIEVEMENTS.map(a => {
    const isUnlocked = unlocked.includes(a.id);
    return `
      <div class="ach-card ${isUnlocked ? 'unlocked' : 'locked'} tier-${a.tier}"
           title="${a.desc}">
        <div class="ach-tier-dot"></div>
        <div class="ach-icon">${a.icon}</div>
        <div class="ach-title">${a.title}</div>
        <div class="ach-desc">${a.desc}</div>
        ${isUnlocked ? '<div class="ach-check">✓</div>' : ''}
      </div>`;
  }).join('');
}

/* ─────────────────────────────────────────────────────
   ANALYTICS – Rendering
───────────────────────────────────────────────────── */

function renderAnalytics() {
  const streak = calcStreak();
  document.getElementById('streakNum').textContent = streak;
  document.getElementById('streakDetail').textContent =
    streak === 0 ? 'Start logging to build your streak!'
    : streak === 1 ? 'Great start! Keep it up.'
    : `${streak} consecutive days of activity 💪`;

  const at = allTimeStats();
  document.getElementById('atEntries').textContent = at.entries;
  document.getElementById('atPomodos').textContent = at.poms;
  document.getElementById('atDays').textContent    = at.days;

  renderAchievements();
  renderWeeklyChart();
  renderBiWeeklyChart();  // NEW: bi-weekly view
  renderPieChart();
  renderTagCloud();
  renderHeatmap();
  renderAnalyticsDayDetail();
}

function renderWeeklyChart() {
  const svg = document.getElementById('weeklyChart');
  const W=680, H=260, pL=46, pB=48, pT=18, pR=16;
  const cW = W-pL-pR, cH = H-pB-pT;

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const str = offsetDate(todayStr(), -i);
    const d   = new Date(str + 'T00:00:00');
    days.push({
      str,
      label:   d.toLocaleDateString('en-US', { weekday:'short' }),
      entries: (state.notes.entries[str] || []).length,
      poms:    state.pomLog[str] || 0,
    });
  }

  const maxV = Math.max(...days.map(d => Math.max(d.entries, d.poms)), 1);
  const grp  = cW / 7;
  const bW   = grp * 0.32;

  let out = '';

  // Gridlines
  for (let i = 0; i <= 4; i++) {
    const y   = pT + cH - (i/4)*cH;
    const val = Math.round((i/4)*maxV);
    out += `<line x1="${pL}" y1="${y}" x2="${W-pR}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
    out += `<text x="${pL-6}" y="${y+4}" text-anchor="end" font-size="11" fill="var(--text3)">${val}</text>`;
  }

  days.forEach((day, i) => {
    const cx  = pL + (i + .5) * grp;
    const eH  = (day.entries / maxV) * cH;
    const pH  = (day.poms    / maxV) * cH;
    const eY  = pT + cH - eH;
    const pY  = pT + cH - pH;
    const sel = day.str === state.analytics.selectedDate;
    const opa = sel ? '1' : '.45';
    const txtFill = sel ? 'var(--primary)' : 'var(--text3)';

    // Invisible click zone over the whole column
    out += `<rect x="${cx - grp/2}" y="${pT}" width="${grp}" height="${cH + pB/2}" fill="transparent" style="cursor:pointer" onclick="selectAnalyticsDate('${day.str}')" title="${day.str}"/>`;

    // Highlight background for selected day
    if (sel) out += `<rect x="${cx - grp/2 + 3}" y="${pT}" width="${grp - 6}" height="${cH}" rx="4" fill="rgba(124,58,237,.06)"/>`;

    out += `<rect x="${cx - bW}" y="${eY}" width="${bW}" height="${eH}" rx="3" fill="var(--primary)" opacity="${opa}" style="pointer-events:none"/>`;
    out += `<rect x="${cx}"      y="${pY}" width="${bW}" height="${pH}" rx="3" fill="var(--primary)" style="pointer-events:none"/>`;
    if (day.entries > 0) out += `<text x="${cx - bW/2}" y="${eY-4}" text-anchor="middle" font-size="10" fill="${txtFill}" style="pointer-events:none">${day.entries}</text>`;
    if (day.poms    > 0) out += `<text x="${cx + bW/2}" y="${pY-4}" text-anchor="middle" font-size="10" fill="${sel?'var(--primary)':'var(--text2)'}" style="pointer-events:none">${day.poms}</text>`;
    out += `<text x="${cx}" y="${H-pB/3}" text-anchor="middle" font-size="11" font-weight="${sel?'700':'400'}" fill="${sel?'var(--primary)':'var(--text2)'}" style="pointer-events:none">${day.label}</text>`;
  });

  svg.innerHTML = out;
}

function renderBiWeeklyChart() {
  const svg = document.getElementById('weeklyChart');
  const W=680, H=260, pL=46, pB=48, pT=18, pR=16;
  const cW = W-pL-pR, cH = H-pB-pT;

  // Days to show: 7 or 14 based on chartMode
  const daysToShow = state.analytics.chartMode === '14d' ? 14 : 7;
  const weeksLabel = state.analytics.chartMode === '14d' ? 'Last 2 Weeks' : 'Last 7 Days';

  // Update header text + nav state
  const periodEl = document.querySelector('.chart-period');
  if (periodEl) {
    const isOffset = state.analytics.chartWeekOffset > 0;
    if (isOffset) {
      const daysToShowLabel = state.analytics.chartMode === '14d' ? 14 : 7;
      const offsetDays = state.analytics.chartWeekOffset * daysToShowLabel;
      const fromStr = offsetDate(todayStr(), -(offsetDays + daysToShowLabel - 1));
      const toStr   = offsetDate(todayStr(), -offsetDays);
      const from = new Date(fromStr + 'T00:00:00');
      const to   = new Date(toStr   + 'T00:00:00');
      const fmt = d => d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
      periodEl.textContent = fmt(from) + ' – ' + fmt(to);
    } else {
      periodEl.textContent = weeksLabel;
    }
  }
  // Disable next button when at current period
  const nextBtn = document.getElementById('nextWeek');
  if (nextBtn) nextBtn.disabled = state.analytics.chartWeekOffset === 0;

  const days = [];
  for (let i = daysToShow - 1; i >= 0; i--) {
    const offset = i + state.analytics.chartWeekOffset * daysToShow;
    const str = offsetDate(todayStr(), -offset);
    const d   = new Date(str + 'T00:00:00');
    days.push({
      str,
      label:   d.toLocaleDateString('en-US', { weekday:'short' }),
      entries: (state.notes.entries[str] || []).length,
      poms:    state.pomLog[str] || 0,
      done:    state.notes.entries[str] ? state.notes.entries[str].filter(e => e.done).length : 0,
    });
  }

  // Max value for scaling (entries, pomodoros, or completed tasks)
  const maxV = Math.max(
    ...days.flatMap(d => [d.entries, d.poms, d.done]),
    1
  );

  // Bar geometry: 3 bars per day (entries, completed tasks, pomodoros), spaced
  const grp  = cW / daysToShow;          // width per day-group
  const subW = grp * 0.25;                // width per sub-bar
  const gap  = (grp - 3 * subW) / 4;     // gap between bars and at edges

  let out = '';

  // Gridlines (4 horizontal lines)
  for (let i = 0; i <= 4; i++) {
    const y   = pT + cH - (i/4)*cH;
    const val = Math.round((i/4)*maxV);
    out += `<line x1="${pL}" y1="${y}" x2="${W-pR}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
    out += `<text x="${pL-6}" y="${y+4}" text-anchor="end" font-size="11" fill="var(--text3)">${val}</text>`;
  }

  days.forEach((day, i) => {
    const dayX = pL + i * grp; // left edge of day-group

    // Calculate bar positions
    const bar1X = dayX + gap;
    const bar2X = bar1X + subW + gap;
    const bar3X = bar2X + subW + gap;

    // Entry count (purple bar)
    const entH    = (day.entries / maxV) * cH;
    const entY    = pT + cH - entH;
    const entOpa  = day.entries > 0 ? '1' : '.45';
    const entFill = day.entries > 0 ? 'var(--primary)' : 'var(--border)';
    const entTextFill = day.entries > 0 ? 'var(--primary)' : 'var(--text3)';

    // Completed tasks (green bar)
    const doneH   = (day.done / maxV) * cH;
    const doneY   = pT + cH - doneH;
    const doneOpa = day.done > 0 ? '1' : '.45';
    const doneFill = day.done > 0 ? 'var(--success)' : 'var(--border)';
    const doneTextFill = day.done > 0 ? 'var(--success)' : 'var(--text3)';

    // Pomodoros (amber bar)
    const pomH    = (day.poms / maxV) * cH;
    const pomY    = pT + cH - pomH;
    const pomOpa  = day.poms > 0 ? '1' : '.45';
    const pomFill = day.poms > 0 ? 'var(--c-long)' : 'var(--border)';
    const pomTextFill = day.poms > 0 ? 'var(--c-long)' : 'var(--text3)';

    // Invisible click zone over the whole column
    out += `<rect x="${dayX}" y="${pT}" width="${grp}" height="${cH + pB/2}" fill="transparent" style="cursor:pointer" onclick="selectAnalyticsDate('${day.str}')" title="${day.str}"/>`;

    // Highlight background for selected day (full width)
    if (day.str === state.analytics.selectedDate) {
      out += `<rect x="${dayX + 2}" y="${pT}" width="${grp - 4}" height="${cH}" rx="4" fill="rgba(124,58,237,.06)"/>`;
    }

    // --- Three bars ---
    // 1. Entries (purple)
    out += `<rect x="${bar1X}" y="${entY}" width="${subW}" height="${entH}" rx="3" fill="${entFill}" opacity="${entOpa}" style="pointer-events:none"/>`;
    if (day.entries > 0) out += `<text x="${bar1X + subW/2}" y="${entY-4}" text-anchor="middle" font-size="10" fill="${entTextFill}" style="pointer-events:none">${day.entries}</text>`;

    // 2. Completed tasks (green)
    out += `<rect x="${bar2X}" y="${doneY}" width="${subW}" height="${doneH}" rx="3" fill="${doneFill}" opacity="${doneOpa}" style="pointer-events:none"/>`;
    if (day.done > 0) out += `<text x="${bar2X + subW/2}" y="${doneY-4}" text-anchor="middle" font-size="10" fill="${doneTextFill}" style="pointer-events:none">${day.done}</text>`;

    // 3. Pomodoros (amber)
    out += `<rect x="${bar3X}" y="${pomY}" width="${subW}" height="${pomH}" rx="3" fill="${pomFill}" opacity="${pomOpa}" style="pointer-events:none"/>`;
    if (day.poms > 0) out += `<text x="${bar3X + subW/2}" y="${pomY-4}" text-anchor="middle" font-size="10" fill="${pomTextFill}" style="pointer-events:none">${day.poms}</text>`;

    // Day label (Mon, Tue, etc) - centered under the group
    out += `<text x="${dayX + grp/2}" y="${H - pB/3}" text-anchor="middle" font-size="11" fill="var(--text2)" style="pointer-events:none">${day.label}</text>`;
  });

  svg.innerHTML = out;
}

function donutPath(cx, cy, outerR, innerR, startA, endA) {
  const rad = a => (a - 90) * Math.PI / 180;
  const px  = (r, a) => [cx + r*Math.cos(rad(a)), cy + r*Math.sin(rad(a))];
  const span = Math.min(endA - startA, 359.99);
  const ea   = startA + span;
  const large = span > 180 ? 1 : 0;
  const [ox1,oy1] = px(outerR, startA);
  const [ox2,oy2] = px(outerR, ea);
  const [ix1,iy1] = px(innerR, ea);
  const [ix2,iy2] = px(innerR, startA);
  return `M${ox1} ${oy1} A${outerR} ${outerR} 0 ${large} 1 ${ox2} ${oy2} L${ix1} ${iy1} A${innerR} ${innerR} 0 ${large} 0 ${ix2} ${iy2}Z`;
}

function renderPieChart() {
  const svg    = document.getElementById('pieChart');
  const legend = document.getElementById('pieLegend');
  const counts = catCounts();
  const total  = Object.values(counts).reduce((a,b) => a+b, 0);

  if (total === 0) {
    svg.innerHTML    = `<text x="100" y="105" text-anchor="middle" font-size="13" fill="var(--text3)">No data yet</text>`;
    legend.innerHTML = '';
    return;
  }

  const cx=100, cy=100, outerR=88, innerR=54;
  const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]);

  if (sorted.length === 1) {
    const [cat] = sorted[0];
    const color = getAllCats()[cat]?.color || '#6B7280';
    svg.innerHTML =
      `<circle cx="${cx}" cy="${cy}" r="${outerR}" fill="${color}"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${innerR}" fill="var(--surface)"/>` +
      `<text x="${cx}" y="${cy-6}" text-anchor="middle" font-size="20" font-weight="700" fill="var(--text)">${total}</text>` +
      `<text x="${cx}" y="${cy+12}" text-anchor="middle" font-size="10" fill="var(--text3)">TOTAL</text>`;
  } else {
    let cur = 0, paths = '';
    sorted.forEach(([cat, count]) => {
      const pct   = count / total;
      const end   = cur + pct * 360;
      const color = getAllCats()[cat]?.color || '#6B7280';
      paths += `<path d="${donutPath(cx,cy,outerR,innerR,cur,end)}" fill="${color}"/>`;
      cur = end;
    });
    paths += `<circle cx="${cx}" cy="${cy}" r="${innerR}" fill="var(--surface)"/>`;
    paths += `<text x="${cx}" y="${cy-6}" text-anchor="middle" font-size="20" font-weight="700" fill="var(--text)">${total}</text>`;
    paths += `<text x="${cx}" y="${cy+12}" text-anchor="middle" font-size="10" fill="var(--text3)">TOTAL</text>`;
    svg.innerHTML = paths;
  }

  legend.innerHTML = sorted.map(([cat, count]) => {
    const info  = getAllCats()[cat] || CATS.other;
    const color = info.color;
    return `<div class="legend-item">
      <span class="legend-color" style="background:${color}"></span>
      <span class="legend-label">${info.emoji} ${info.label}</span>
      <span class="legend-count">${count}</span>
    </div>`;
  }).join('');
}

function renderTagCloud() {
  const container = document.getElementById('tagCloud');
  const tags = allTags().slice(0, 20);
  if (tags.length === 0) {
    container.innerHTML = '<span style="color:var(--text3);font-size:.83rem">No tags yet. Use #tag in your entries.</span>';
    return;
  }
  container.innerHTML = tags.map(([tag, count]) =>
    `<span class="tag-pill">#${esc(tag)} <span class="tag-count">${count}</span></span>`
  ).join('');
}

function renderHeatmap() {
  const container = document.getElementById('heatmap');
  const today  = todayStr();
  const WEEKS  = 16;
  const DAYS   = WEEKS * 7;

  // Align to Monday
  const startDate = new Date(today + 'T00:00:00');
  startDate.setDate(startDate.getDate() - DAYS + 1);
  const dow = (startDate.getDay() + 6) % 7; // 0=Mon
  startDate.setDate(startDate.getDate() - dow);

  let html = '';
  for (let i = 0; i < DAYS; i++) {
    const d   = new Date(startDate);
    d.setDate(d.getDate() + i);
    const str   = d.toLocaleDateString('en-CA');
    const count = (state.notes.entries[str] || []).length;
    const label = d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
    const isFut = str > today;
    const level = isFut ? -1 : count===0 ? 0 : count<=2 ? 1 : count<=4 ? 2 : count<=7 ? 3 : 4;
    const isSel = str === state.analytics.selectedDate;
    const click = !isFut ? `onclick="selectAnalyticsDate('${str}')" style="cursor:pointer${isSel?';outline:2px solid var(--primary);outline-offset:1px':''}"` : '';
    html += `<div class="hcell" data-level="${level}" title="${isFut?'':label+': '+count+' entr'+(count===1?'y':'ies')}" ${click}></div>`;
  }
  container.innerHTML = html;
}

/* ─────────────────────────────────────────────────────
   CUSTOM CATEGORIES
───────────────────────────────────────────────────── */

function populateCatSelects() {
  const cats = getAllCats();
  const ids  = ['catSel', 'filterCat'];
  ids.forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '';
    // For filterCat add "All" option
    if (selId === 'filterCat') {
      sel.innerHTML = '<option value="">All categories</option>';
    }
    Object.entries(cats).forEach(([id, cat]) => {
      const opt = document.createElement('option');
      opt.value       = id;
      opt.textContent = `${cat.emoji} ${cat.label}`;
      sel.appendChild(opt);
    });
    // Restore previous selection if still valid, else fall back to defaultCat
    if ([...sel.options].some(o => o.value === cur)) {
      sel.value = cur;
    } else if (selId === 'catSel') {
      const def = state.settings.defaultCat || 'work';
      if ([...sel.options].some(o => o.value === def)) sel.value = def;
    }
  });
}

function renderCategoryManager() {
  const grid = document.getElementById('catGrid');
  if (!grid) return;

  const swatches = CAT_COLOR_PRESETS.map(c =>
    `<span class="cat-swatch" data-color="${c}" style="background:${c}"
      onclick="selectCatColor('${c}')" title="${c}"></span>`
  ).join('');

  // Default cats (read-only)
  const defaultHtml = Object.entries(CATS).map(([, cat]) =>
    `<span class="cat-chip" style="background:${cat.color}20;border-color:${cat.color}40;color:${cat.color}">
       ${cat.emoji} ${cat.label}
     </span>`
  ).join('');

  // Custom cats
  const customHtml = (state.customCats || []).length === 0
    ? '<p class="cat-none">No custom categories yet.</p>'
    : (state.customCats || []).map(c =>
        `<span class="cat-chip cat-chip-custom" style="background:${c.color}20;border-color:${c.color};color:${c.color}">
           ${c.emoji} ${c.label}
           <button class="cat-chip-del" onclick="deleteCustomCat('${c.id}')" title="Delete">✕</button>
         </span>`
      ).join('');

  grid.innerHTML = `
    <div class="cat-section-lbl">Built-in</div>
    <div class="cat-chips">${defaultHtml}</div>
    <div class="cat-section-lbl" style="margin-top:12px">Your categories</div>
    <div class="cat-chips" id="customCatChips">${customHtml}</div>

    <div class="new-cat-form" id="newCatForm">
      <div class="new-cat-row">
        <input class="new-cat-emoji" id="newCatEmoji" maxlength="2" placeholder="😀" />
        <input class="new-cat-name"  id="newCatName"  maxlength="20" placeholder="Category name…"
          onkeydown="if(event.key==='Enter') addCustomCat()" />
      </div>
      <div class="cat-swatches" id="catSwatches">${swatches}</div>
      <input type="hidden" id="newCatColor" value="${CAT_COLOR_PRESETS[6]}" />
      <button class="primary-btn" onclick="addCustomCat()" style="margin-top:8px;width:100%;justify-content:center">
        + Add Category
      </button>
    </div>`;

  // Highlight default selected color
  highlightCatSwatch(document.getElementById('newCatColor')?.value);
}

function selectCatColor(color) {
  const hidden = document.getElementById('newCatColor');
  if (hidden) hidden.value = color;
  highlightCatSwatch(color);
}

function highlightCatSwatch(color) {
  document.querySelectorAll('.cat-swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === color);
  });
}

function addCustomCat() {
  const emoji = document.getElementById('newCatEmoji')?.value.trim() || '🏷️';
  const label = document.getElementById('newCatName')?.value.trim();
  const color = document.getElementById('newCatColor')?.value || '#3B82F6';

  if (!label) {
    document.getElementById('newCatName')?.focus();
    showToast('Please enter a category name.');
    return;
  }
  // Prevent duplicate names
  const all = getAllCats();
  if (Object.values(all).some(c => c.label.toLowerCase() === label.toLowerCase())) {
    showToast('A category with that name already exists.');
    return;
  }

  const id = 'cat_' + Date.now().toString(36);
  if (!state.customCats) state.customCats = [];
  state.customCats.push({ id, label, emoji, color });
  save();
  populateCatSelects();
  renderCategoryManager();
  showToast(`✓ Category "${emoji} ${label}" created!`);
}

function deleteCustomCat(id) {
  // Check if any entries use this category
  const usedCount = Object.values(state.notes.entries)
    .flat()
    .filter(e => e.cat === id).length;

  if (usedCount > 0 && !confirm(`${usedCount} task(s) use this category. They'll be changed to "Other". Delete anyway?`)) return;

  // Reassign entries to 'other'
  Object.values(state.notes.entries).flat().forEach(e => { if (e.cat === id) e.cat = 'other'; });

  state.customCats = (state.customCats || []).filter(c => c.id !== id);
  save();
  populateCatSelects();
  renderCategoryManager();
  renderLog();
  showToast('Category deleted.');
}

/* ─────────────────────────────────────────────────────
   SETTINGS
───────────────────────────────────────────────────── */

function loadSettingsUI() {
  const s = state.settings;
  document.getElementById('s-work').value     = s.workDuration;
  document.getElementById('s-short').value    = s.shortBreakDuration;
  document.getElementById('s-long').value     = s.longBreakDuration;
  document.getElementById('s-interval').value = s.longBreakInterval;
  document.getElementById('s-autoBreak').checked = s.autoStartBreaks;
  document.getElementById('s-autoWork').checked  = s.autoStartWork;
  document.getElementById('s-notifs').checked    = s.desktopNotifs;
  document.getElementById('s-eod').checked       = s.endOfDaySummary;
  if (document.getElementById('s-autoRollover')) document.getElementById('s-autoRollover').checked = !!s.autoRollover;
  if (document.getElementById('s-ghostDisplay')) document.getElementById('s-ghostDisplay').value = s.ghostDisplay || 'both';
  if (document.getElementById('s-commentViewMode')) document.getElementById('s-commentViewMode').value = s.commentViewMode || 'expandcollapse';
  // new
  const accent = s.accentColor || '#7C3AED';
  const fsEl   = document.getElementById('s-fontsize');
  const fsVal  = document.getElementById('s-fontsizeVal');
  if (document.getElementById('s-accent')) document.getElementById('s-accent').value = accent;
  if (fsEl) { fsEl.value = s.fontSize || 16; if (fsVal) fsVal.textContent = (s.fontSize||16)+'px'; }
  if (document.getElementById('s-sound'))    document.getElementById('s-sound').value   = s.timerSound  || 'beep';
  if (document.getElementById('s-ring'))     document.getElementById('s-ring').value    = s.ringStyle   || 'solid';
  if (document.getElementById('s-focusMode')) document.getElementById('s-focusMode').checked = !!s.focusMode;
  if (document.getElementById('s-goal'))     document.getElementById('s-goal').value    = s.dailyGoal   || 0;
  if (document.getElementById('s-24h'))      document.getElementById('s-24h').checked   = !!s.timeFormat24;
  if (document.getElementById('s-weekSun'))  document.getElementById('s-weekSun').checked = !s.weekStartMonday;
  if (document.getElementById('s-defcat'))   document.getElementById('s-defcat').value  = s.defaultCat  || 'work';
  // live preview hooks
  const fsSlider = document.getElementById('s-fontsize');
  if (fsSlider) {
    fsSlider.oninput = () => {
      const v = parseInt(fsSlider.value, 10);
      if (fsVal) fsVal.textContent = v + 'px';
      document.documentElement.style.fontSize = v + 'px';
    };
  }
  const accentPicker = document.getElementById('s-accent');
  if (accentPicker) {
    accentPicker.oninput = () => applyAccentColor(accentPicker.value);
  }
  const resetBtn = document.getElementById('s-accentReset');
  if (resetBtn) resetBtn.onclick = () => {
    if (accentPicker) accentPicker.value = '#7C3AED';
    applyAccentColor('#7C3AED');
  };
}

function applySettings() {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v,10)||lo));
  const s = state.settings;
  s.workDuration        = clamp(document.getElementById('s-work').value,     1, 120);
  s.shortBreakDuration  = clamp(document.getElementById('s-short').value,    1,  30);
  s.longBreakDuration   = clamp(document.getElementById('s-long').value,     1,  60);
  s.longBreakInterval   = clamp(document.getElementById('s-interval').value, 2,  10);
  s.autoStartBreaks     = document.getElementById('s-autoBreak').checked;
  s.autoStartWork       = document.getElementById('s-autoWork').checked;
  s.desktopNotifs       = document.getElementById('s-notifs').checked;
  s.endOfDaySummary     = document.getElementById('s-eod').checked;
  s.autoRollover        = document.getElementById('s-autoRollover')?.checked || false;
  s.ghostDisplay        = document.getElementById('s-ghostDisplay')?.value   || 'both';
  s.commentViewMode     = document.getElementById('s-commentViewMode')?.value || 'expandcollapse';
  // new
  s.accentColor      = document.getElementById('s-accent')?.value    || '#7C3AED';
  s.fontSize         = clamp(document.getElementById('s-fontsize')?.value || 16, 13, 20);
  s.timerSound       = document.getElementById('s-sound')?.value     || 'beep';
  s.ringStyle        = document.getElementById('s-ring')?.value      || 'solid';
  s.focusMode        = document.getElementById('s-focusMode')?.checked || false;
  s.dailyGoal        = clamp(document.getElementById('s-goal')?.value || 0, 0, 50);
  s.timeFormat24     = document.getElementById('s-24h')?.checked     || false;
  s.weekStartMonday  = !(document.getElementById('s-weekSun')?.checked || false);
  s.defaultCat       = document.getElementById('s-defcat')?.value    || 'work';

  applyAccentColor(s.accentColor);
  document.documentElement.style.fontSize = s.fontSize + 'px';
  applyRingStyle(s.ringStyle);
  updateClocks();
  renderCalendar();
  renderGhostBanner();
  renderGhostDrawer();

  if (s.desktopNotifs && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // New durations apply to an idle session. A paused session keeps its remaining time.
  if (!state.timer.running && !state.timer.sessionId && state.timer.remainingMs === state.timer.durationMs) {
    state.timer.timeLeft = getModeSecs(state.timer.mode);
    state.timer.durationMs = state.timer.timeLeft*1000;
    state.timer.remainingMs = state.timer.durationMs;
    renderTimeDisplay();
    renderRing();
  }
  renderDots();
  renderStats();
  applyFocusMode();
  save();

  const msg = document.getElementById('saveMsg');
  msg.style.display = 'inline';
  setTimeout(() => { msg.style.display = 'none'; }, 2000);
}

/* ─────────────────────────────────────────────────────
   NOTIFICATIONS
───────────────────────────────────────────────────── */

function showToast(msg, action) {
  const el = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  el.onclick = typeof action === 'function' ? action : null;
  el.style.cursor = action ? 'pointer' : '';
  el.title = action ? 'Open this task date' : '';
  el.classList.add('show');
  clearTimeout(_toastTm);
  _toastTm = setTimeout(() => el.classList.remove('show'), 4000);
}

function sendDesktopNotif(title, body) {
  if (!state.settings.desktopNotifs) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, tag: 'dailyflow' }); } catch (_) {}
}

/* ─────────────────────────────────────────────────────
   AUTO-ROLLOVER  (per-task ↺ flag + morning review)
   When state.settings.autoRollover is on, any entry with
   entry.autoRollover=true that is still incomplete at the
   start of a new day gets silently rolled to today.
   A single modal then prompts for time-spent + note on
   each carried task before the user starts their day.
───────────────────────────────────────────────────── */

function toggleAutoRollover(id) {
  // Search ALL dates, not just the current view — findEntry only checks state.notes.date
  let entry = null;
  for (const dateStr of Object.keys(state.notes.entries)) {
    const found = state.notes.entries[dateStr].find(e => e.id === id);
    if (found) { entry = found; break; }
  }
  if (!entry) return;
  entry.autoRollover = !entry.autoRollover;
  save();
  renderLog();
  const label = entry.autoRollover ? 'Auto-carry ON — task rolls to next day if incomplete' : 'Auto-carry OFF';
  showToast(label);
}

// Called at startup when a new day is detected.
// Walks ALL dates between prevDate and today (handles multi-day gaps).
// Silently rolls autoRollover=true, done=false entries forward to today.
// Returns an array of { newEntry, sourceDate, origEntry } for the modal.
function checkAutoRollover() {
  if (!state.settings.autoRollover) return [];
  const rolls = DailyFlowWorkflows.autoCarry(state.notes.entries, todayStr(), Date.now(), state.settings.ghostDismissed || []);
  if (rolls.length) {
    save(); renderLog(); renderCalendar(); renderStats();
    showAutoRollModal(rolls);
  }
  return rolls;
}

function showAutoRollModal(rolls) {
  if (!rolls?.length) return;
  const summary = document.getElementById('carrySummary');
  if (!summary) return;
  summary.hidden = false;
  summary.innerHTML = `<span>↺ ${rolls.length} task${rolls.length === 1 ? '' : 's'} carried to today. Progress and history kept.</span>
    <button class="outline-btn sm-btn" onclick="navigateToDate(todayStr())">View today</button>
    <button class="act-btn" aria-label="Dismiss carry summary" onclick="this.parentElement.hidden=true">×</button>`;
}

function saveAutoRollModal() {
  const modal = document.getElementById('autoRollModal');
  if (!modal || !modal._rolls) { closeModal('autoRollModal'); return; }
  const rolls = modal._rolls;

  rolls.forEach(function(r, i) {
    const timeVal = (document.getElementById('ar-time-' + i)?.value || '').trim();
    const noteVal = (document.getElementById('ar-note-' + i)?.value || '').trim();

    if (timeVal) r.origEntry.timeSpent = timeVal;

    if (noteVal) {
      if (!r.newEntry.comments) r.newEntry.comments = [];
      r.newEntry.comments.unshift({
        id:   Date.now().toString() + Math.random(),
        text: noteVal,
        time: nowTime(),
        ts:   Date.now(),
      });
    }
  });

  save();
  renderLog();
  closeModal('autoRollModal');
  if (typeof modal._onClose === 'function') { const cb = modal._onClose; modal._onClose = null; cb(); }
  showToast('\u2713 Auto-carried tasks updated');
}

function checkEod() {
  const shown = localStorage.getItem(pk('eod_shown'));
  const prevDate = localStorage.getItem(pk('lastDate'));
  const rolls = checkAutoRollover();
  // The carry summary is nonblocking. An explicitly enabled EOD summary remains available.
  if (!rolls.length && state.settings.endOfDaySummary && shown !== todayStr() && prevDate && prevDate < todayStr()) {
    showEodSummary(prevDate);
  }
  if (prevDate && prevDate < todayStr()) localStorage.setItem(pk('eod_shown'), todayStr());
}

function showEodSummary(date) {
  const entries = state.notes.entries[date] || [];
  if (entries.length === 0) return;
  const poms  = state.pomLog[date] || 0;
  const done  = entries.filter(e => e.done).length;
  const [main] = fmtDate(date);

  document.getElementById('eodTitle').textContent = `${main}'s Summary 🎉`;
  document.getElementById('eodContent').innerHTML = `
    <p>Here's what you accomplished on <strong>${main}</strong>:</p>
    <br>
    <p>✅ <strong>${done}</strong> of <strong>${entries.length}</strong> tasks completed</p>
    <p>🍅 <strong>${poms}</strong> pomodoro${poms===1?'':'s'} · ${Math.floor((state.focusLog?.[date] || 0)/60)} min of recorded focus</p>
    <br>
    <p><strong>Top activities:</strong></p>
    ${entries.slice(0,3).map(e => `<p>• ${esc(e.content.replace(/#\w+/g,'').trim())}</p>`).join('')}
  `;
  openModal('eodModal');
}

/* ─────────────────────────────────────────────────────
   DATE-RANGE EXPORT  (.md / .xlsx)
───────────────────────────────────────────────────── */

function setRangePreset(preset) {
  const from  = document.getElementById('exportFrom');
  const to    = document.getElementById('exportTo');
  if (!from || !to) return;
  const today = todayStr();
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  if (event?.target) event.target.classList.add('active');

  switch (preset) {
    case 'today':
      from.value = today; to.value = today; break;
    case 'week': {
      const d   = new Date(today + 'T00:00:00');
      const dow = (d.getDay() + 6) % 7;
      from.value = offsetDate(today, -dow); to.value = today; break;
    }
    case 'lastweek': {
      const d       = new Date(today + 'T00:00:00');
      const dow     = (d.getDay() + 6) % 7;
      const lastMon = offsetDate(today, -(dow + 7));
      from.value = lastMon; to.value = offsetDate(lastMon, 6); break;
    }
    case '7days':
      from.value = offsetDate(today, -6); to.value = today; break;
    case 'month': {
      const d = new Date(today + 'T00:00:00');
      from.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
      to.value   = today; break;
    }
  }
}

function exportDateRange() {
  const from = document.getElementById('exportFrom')?.value;
  const to   = document.getElementById('exportTo')?.value;
  const fmt  = document.querySelector('input[name="exportFmt"]:checked')?.value || 'md';
  if (!from || !to)    { showToast('Please select a date range.'); return; }
  if (from > to)       { showToast('"From" must be before "To".'); return; }
  if (fmt === 'md')    buildMarkdownExport(from, to);
  else                 loadSheetJS(() => buildExcelExport(from, to));
}

/* ── Markdown ─────────────────────────────────────── */

function buildMarkdownExport(from, to) {
  const cats      = getAllCats();
  const [fromLbl] = fmtDate(from);
  const [toLbl]   = fmtDate(to);
  const genDate   = new Date().toLocaleDateString('en-US', {weekday:'long',year:'numeric',month:'long',day:'numeric'});

  // ── Collect all entries in range, annotated with their date ──
  const all = [];
  let cur = from;
  while (cur <= to) {
    (state.notes.entries[cur] || []).forEach(e => all.push({ ...e, _date: cur }));
    cur = offsetDate(cur, 1);
  }

  const done    = all.filter(e => e.done);
  const pending = all.filter(e => !e.done);

  // Stats
  let totPoms = 0;
  cur = from;
  while (cur <= to) { totPoms += state.pomLog[cur] || 0; cur = offsetDate(cur, 1); }
  const totFocusMin = Math.floor(Object.entries(state.focusLog || {}).filter(([date]) => date >= from && date <= to).reduce((sum, [,seconds]) => sum + seconds, 0)/60);
  const focusHM     = totFocusMin >= 60
    ? `${Math.floor(totFocusMin/60)}h ${totFocusMin%60}m`
    : `${totFocusMin} min`;
  const compRate    = all.length ? Math.round(done.length / all.length * 100) : 0;

  // Most active day
  let bestDay = '', bestCount = 0;
  cur = from;
  while (cur <= to) {
    const n = (state.notes.entries[cur] || []).length;
    if (n > bestCount) { bestCount = n; bestDay = cur; }
    cur = offsetDate(cur, 1);
  }

  // Top category
  const catCount = {};
  all.forEach(e => { catCount[e.cat] = (catCount[e.cat]||0)+1; });
  const topCatEntry = Object.entries(catCount).sort((a,b)=>b[1]-a[1])[0];
  const topCat      = topCatEntry ? cats[topCatEntry[0]] || CATS.other : null;

  // Tags
  const tagMap = {};
  all.forEach(e => (e.tags||[]).forEach(t => { tagMap[t] = (tagMap[t]||0)+1; }));
  const topTags = Object.entries(tagMap).sort((a,b)=>b[1]-a[1]).slice(0,12);

  // Group done/pending by category — sorted by count desc
  const groupByCat = (arr) => {
    const g = {};
    arr.forEach(e => { if (!g[e.cat]) g[e.cat] = []; g[e.cat].push(e); });
    return Object.entries(g).sort((a,b) => b[1].length - a[1].length);
  };
  const doneByCat    = groupByCat(done);
  const pendingByCat = groupByCat(pending);

  let md = '';

  // ════════════════════════════════════════
  //  HEADER
  // ════════════════════════════════════════
  md += `# 📋 Work Report — ${fromLbl} to ${toLbl}\n\n`;
  md += `> **Generated:** ${genDate}  \n`;
  md += `> *This report is auto-generated from DailyFlow and can be used for weekly reviews, yearly accomplishments, and performance appraisals.*\n\n`;
  md += `---\n\n`;

  // ════════════════════════════════════════
  //  1. EXECUTIVE SUMMARY
  // ════════════════════════════════════════
  md += `## 📊 Executive Summary\n\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| 📝 Total Tasks | **${all.length}** |\n`;
  md += `| ✅ Completed | **${done.length}** |\n`;
  md += `| ⏳ Pending / Carried forward | **${pending.length}** |\n`;
  md += `| 📈 Completion Rate | **${compRate}%** |\n`;
  md += `| 🍅 Pomodoro Sessions | **${totPoms}** |\n`;
  md += `| ⏱ Total Focus Time | **${focusHM}** |\n`;
  if (bestDay) md += `| 📅 Most Productive Day | **${fmtDate(bestDay)[0]}** (${bestCount} tasks) |\n`;
  if (topCat)  md += `| 🏆 Top Category | **${topCat.emoji} ${topCat.label}** (${topCatEntry[1]} tasks) |\n`;
  if (topTags.length) md += `| 🏷️ Key Themes | ${topTags.slice(0,5).map(([t])=>'`#'+t+'`').join(' ')} |\n`;
  md += '\n';

  // ════════════════════════════════════════
  //  2. KEY ACCOMPLISHMENTS  (by category)
  // ════════════════════════════════════════
  md += `---\n\n## ✅ Key Accomplishments\n\n`;
  md += `> Completed work grouped by category — suitable for weekly reports and appraisal documentation.\n\n`;

  if (doneByCat.length === 0) {
    md += `*No completed tasks in this period.*\n\n`;
  } else {
    doneByCat.forEach(([catId, entries]) => {
      const cat = cats[catId] || CATS.other;
      const catPoms    = entries.reduce((s,e) => s + (e.pomodoros||0), 0);
      const catTimeArr = entries.filter(e => e.timeSpent).map(e => e.timeSpent);
      md += `### ${cat.emoji} ${cat.label}`;
      md += `  *(${entries.length} item${entries.length===1?'':'s'}`;
      if (catPoms > 0) md += ` · 🍅 ${catPoms}`;
      md += `)*\n\n`;
      entries.forEach(e => { md += mdEntryFull(e, cats); });
    });
  }

  // ════════════════════════════════════════
  //  3. PENDING & CARRY-FORWARD  (by category)
  // ════════════════════════════════════════
  md += `---\n\n## ⏳ Pending & Carried Forward\n\n`;

  if (pendingByCat.length === 0) {
    md += `> 🎉 **All tasks completed this period!**\n\n`;
  } else {
    md += `> Items not yet completed — review and plan for next period.\n\n`;
    pendingByCat.forEach(([catId, entries]) => {
      const cat = cats[catId] || CATS.other;
      md += `### ${cat.emoji} ${cat.label}  *(${entries.length} pending)*\n\n`;
      entries.forEach(e => { md += mdEntryFull(e, cats); });
    });
  }

  // ════════════════════════════════════════
  //  4. DAILY BREAKDOWN TABLE
  // ════════════════════════════════════════
  md += `---\n\n## 📅 Daily Breakdown\n\n`;
  md += `| Date | Day | Tasks | ✅ Done | ⏳ Pending | 🍅 Pomodoros | ⏱ Focus |\n`;
  md += `|------|-----|------:|-------:|----------:|------------:|--------:|\n`;
  let dTot=0, dDone=0, dPoms=0;
  cur = from;
  while (cur <= to) {
    const arr  = state.notes.entries[cur] || [];
    const poms = state.pomLog[cur] || 0;
    const dn   = arr.filter(e => e.done).length;
    if (arr.length > 0 || poms > 0 || state.focusLog?.[cur] > 0) {
      const d = new Date(cur+'T00:00:00');
      const dateStr = d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
      const dayStr  = d.toLocaleDateString('en-US',{weekday:'short'});
      md += `| ${dateStr} | ${dayStr} | ${arr.length} | ${dn} | ${arr.length-dn} | ${poms} | ${Math.floor((state.focusLog?.[cur] || 0)/60)} min |\n`;
      dTot += arr.length; dDone += dn; dPoms += poms;
    }
    cur = offsetDate(cur, 1);
  }
  const dPct = dTot ? Math.round(dDone/dTot*100) : 0;
  md += `| **Total** | | **${dTot}** | **${dDone}** | **${dTot-dDone}** | **${dPoms}** | **${totFocusMin} min** |\n\n`;
  md += `> Overall completion rate: **${dPct}%**\n\n`;

  // ════════════════════════════════════════
  //  5. KEY THEMES & TAGS
  // ════════════════════════════════════════
  if (topTags.length > 0) {
    md += `---\n\n## 🏷️ Key Themes & Tags\n\n`;
    md += `| Tag | Count |\n|---|---|\n`;
    topTags.forEach(([t, c]) => { md += `| \`#${t}\` | ${c} |\n`; });
    md += '\n';
  }

  // ════════════════════════════════════════
  //  6. UPDATES & COMMENTS
  // ════════════════════════════════════════
  const withComments = all.filter(e => (e.comments||[]).some(c => !c.system));
  if (withComments.length > 0) {
    md += `---\n\n## 💬 Notable Updates & Progress Notes\n\n`;
    withComments.forEach(e => {
      const cat = cats[e.cat] || CATS.other;
      md += `**${cat.emoji} ${e.content}** *(${fmtDate(e._date)[0]})*\n`;
      (e.comments||[]).filter(c => !c.system).forEach(c => {
        md += `- *${c.time}*  ${c.text}\n`;
      });
      md += '\n';
    });
  }

  // ════════════════════════════════════════
  //  7. FOR APPRAISAL / YEARLY REFERENCE
  // ════════════════════════════════════════
  md += `---\n\n## 🏆 For Appraisal & Yearly Accomplishments\n\n`;
  md += `> *Copy this section into your yearly accomplishments document or use directly in performance reviews.*\n\n`;
  md += `### Impact Summary\n\n`;
  md += `- Delivered **${done.length} completed items** across **${doneByCat.length} area${doneByCat.length===1?'':'s'}**\n`;
  md += `- Invested **${focusHM}** of focused, deep work (${totPoms} sessions)\n`;
  md += `- Task completion rate: **${compRate}%**\n`;
  if (pending.length > 0) md += `- **${pending.length}** items carried forward to next period\n`;
  md += '\n';

  if (doneByCat.length > 0) {
    md += `### Accomplishments by Area\n\n`;
    doneByCat.forEach(([catId, entries]) => {
      const cat = cats[catId] || CATS.other;
      md += `**${cat.emoji} ${cat.label}**\n`;
      entries.forEach(e => {
        md += `- ${e.content}`;
        if (e.timeSpent)     md += ` *(${e.timeSpent})*`;
        if (e.pomodoros > 0) md += ` *(🍅×${e.pomodoros})*`;
        md += '\n';
        if (e.notes?.trim()) md += `  - ${e.notes.split('\n')[0]}\n`; // first line of notes
      });
      md += '\n';
    });
  }

  md += `---\n\n*Generated by [DailyFlow](https://dailyflow.app) — ${genDate}*\n`;

  dl(new Blob([md], { type: 'text/markdown' }), `report-${from}-to-${to}.md`);
  showToast('📄 Report exported!');
}

/* ── Entry formatter for MD report ───────────────── */

function mdEntryFull(e, cats) {
  const cat  = cats[e.cat] || CATS.other;
  const pri  = { high:'🔴 High', medium:'🟡 Medium', low:'🟢 Low' }[e.priority] || '';
  const done = e.done;
  const dStr = new Date(e._date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',weekday:'short'});

  let s = `**${done ? '✅' : '⏳'} ${e.content}**`;
  s += `  *(${dStr})*`;
  if (pri)              s += `  ${pri}`;
  if (e.timeSpent)      s += `  ⏱ ${e.timeSpent}`;
  if (e.pomodoros > 0)  s += `  🍅×${e.pomodoros}`;
  if (e.tags?.length)   s += `  ${e.tags.map(t=>'`#'+t+'`').join(' ')}`;
  s += '\n';

  if (e.notes?.trim()) {
    s += `\n> ${e.notes.trim().replace(/\n/g, '\n> ')}\n`;
  }

  if (e.subtasks?.length) {
    const stDone = e.subtasks.filter(st=>st.done).length;
    s += `\n*Sub-tasks (${stDone}/${e.subtasks.length} done):*\n`;
    e.subtasks.forEach(st => { s += `- [${st.done?'x':' '}] ${st.text}\n`; });
  }

  const rollCmts = (e.comments||[]).filter(c =>  c.system);
  const userCmts = (e.comments||[]).filter(c => !c.system);
  if (rollCmts.length) {
    s += '\n';
    rollCmts.forEach(c => { s += `> 📅 *${c.text}*\n`; });
  }
  if (userCmts.length) {
    s += '\n';
    userCmts.forEach(c => { s += `> 💬 **${c.time}** — ${c.text}\n`; });
  }

  s += '\n';
  return s;
}

/* ── Excel (SheetJS) ──────────────────────────────── */

function loadSheetJS(cb, onError) {
  if (window.XLSX) { cb(); return; }
  showToast('⏳ Loading Excel library…');
  const s = document.createElement('script');
  s.src     = 'vendor/xlsx.full.min.js';
  s.onload  = cb;
  s.onerror = () => {
    const error = new Error('Excel support could not load. Reload the app and try again.');
    showToast(error.message); if (onError) onError(error);
  };
  document.head.appendChild(s);
}

function buildExcelExport(from, to) {
  const wb   = window.XLSX.utils.book_new();
  const cats = getAllCats();

  // Sheet 1: Tasks
  const rows = [['Date','Day','Time','Category','Priority','Task','Status','Time Spent','Pomodoros','Tags','Notes','Sub-tasks','Roll History','Comments']];
  let cur = from;
  while (cur <= to) {
    (state.notes.entries[cur] || []).forEach(e => {
      const cat    = cats[e.cat] || CATS.other;
      const day    = new Date(cur+'T00:00:00').toLocaleDateString('en-US',{weekday:'long'});
      rows.push([
        cur, day, e.time,
        `${cat.emoji} ${cat.label}`,
        e.priority || 'none',
        e.content,
        e.done ? 'Done' : 'Pending',
        e.timeSpent || '',
        e.pomodoros || 0,
        (e.tags||[]).map(t=>'#'+t).join(' '),
        e.notes || '',
        (e.subtasks||[]).map(s=>`[${s.done?'x':' '}] ${s.text}`).join(' | '),
        (e.comments||[]).filter(c=>c.system).map(c=>c.text).join(' | '),
        (e.comments||[]).filter(c=>!c.system).map(c=>`${c.time}: ${c.text}`).join(' | '),
      ]);
    });
    cur = offsetDate(cur, 1);
  }
  const ws1 = window.XLSX.utils.aoa_to_sheet(rows);
  ws1['!cols'] = [{wch:12},{wch:10},{wch:9},{wch:14},{wch:9},{wch:42},{wch:9},{wch:12},{wch:10},{wch:18},{wch:28},{wch:28},{wch:32},{wch:32}];
  window.XLSX.utils.book_append_sheet(wb, ws1, 'Tasks');

  // Sheet 2: Daily Summary
  const sRows = [['Date','Day','Total','Done','Pending','% Done','Pomodoros','Focus (min)']];
  let totT=0, totD=0, totP=0, totSeconds=0;
  cur = from;
  while (cur <= to) {
    const arr  = state.notes.entries[cur] || [];
    const poms = state.pomLog[cur] || 0;
    const done = arr.filter(e => e.done).length;
    const day  = new Date(cur+'T00:00:00').toLocaleDateString('en-US',{weekday:'long'});
    const seconds = state.focusLog?.[cur] || 0;
    sRows.push([cur, day, arr.length, done, arr.length-done, arr.length?Math.round(done/arr.length*100)+'%':'0%', poms, Math.floor(seconds/60)]);
    totSeconds += seconds;
    totT += arr.length; totD += done; totP += poms;
    cur = offsetDate(cur, 1);
  }
  sRows.push(['TOTAL','',totT,totD,totT-totD,totT?Math.round(totD/totT*100)+'%':'0%',totP,Math.floor(totSeconds/60)]);
  const ws2 = window.XLSX.utils.aoa_to_sheet(sRows);
  ws2['!cols'] = [{wch:12},{wch:11},{wch:8},{wch:7},{wch:9},{wch:8},{wch:10},{wch:12}];
  window.XLSX.utils.book_append_sheet(wb, ws2, 'Daily Summary');

  window.XLSX.writeFile(wb, `dailyflow-${from}-to-${to}.xlsx`);
  showToast('📊 Excel file downloaded!');
}

/* ─────────────────────────────────────────────────────
   EXPORT / IMPORT
───────────────────────────────────────────────────── */

function exportJson() {
  dl(new Blob([JSON.stringify(createProfileBackup(),null,2)], {type:'application/json'}), `dailyflow-${todayStr()}.json`);
}

function exportCsv() {
  dl(new Blob([DailyFlowWorkflows.backupCsv(createProfileBackup())], {type:'text/csv;charset=utf-8'}), `dailyflow-${todayStr()}.csv`);
}

function createProfileBackup() {
  return {format:'dailyflow-backup',version:3,exportedAt:new Date().toISOString(),
    profile:{...state.profiles.find(profile=>profile.id===state.activeProfileId)},data:_profileSnapshot()};
}

function exportBackupMarkdown() {
  dl(new Blob([DailyFlowWorkflows.backupMarkdown(createProfileBackup())],{type:'text/markdown;charset=utf-8'}),`dailyflow-${todayStr()}.md`);
}

function exportBackupExcel() {
  const backup=createProfileBackup();
  loadSheetJS(()=>{
    const rows=DailyFlowWorkflows.backupRows(backup);
    const workbook=XLSX.utils.book_new();
    const tasks=XLSX.utils.aoa_to_sheet(rows.filter((row,index)=>index===0 || row[0]==='task')
      .map(row=>row.slice(0,5).map(value=>String(value ?? '').slice(0,16000))));
    tasks['!cols']=[{wch:12},{wch:12},{wch:22},{wch:48},{wch:48},{wch:48}];
    XLSX.utils.book_append_sheet(workbook,tasks,'Tasks');
    XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(rows.filter((row,index)=>index===0 || row[0]==='backup-json')),'Backup');
    XLSX.writeFile(workbook,`dailyflow-${todayStr()}.xlsx`);
  });
}

function dl(blob, name) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importJson(file) {
  try {
    if(file.size>10*1024*1024)throw new Error('Choose a backup smaller than 10 MB.');
    const extension=file.name.split('.').pop().toLowerCase();
    let backup;
    if(extension==='xlsx') {
      await new Promise((resolve,reject)=>loadSheetJS(resolve,reject));
      const workbook=XLSX.read(await file.arrayBuffer(),{type:'array'});
      if(!workbook.Sheets.Backup)throw new Error('This spreadsheet has no full backup sheet.');
      backup=DailyFlowWorkflows.validateBackup(DailyFlowWorkflows.backupFromRows(XLSX.utils.sheet_to_json(workbook.Sheets.Backup,{header:1,defval:''})),DailyFlowSyncCore);
    } else {
      if(!['json','csv','md'].includes(extension))throw new Error('Choose a DailyFlow JSON, CSV, Markdown or Excel backup.');
      backup=DailyFlowWorkflows.parseBackupText(await file.text(),extension,DailyFlowSyncCore);
    }
    showImportPreview(backup);
  } catch(error) {showToast('Import could not be prepared: '+error.message);}
}

function showImportPreview(backup) {
  document.getElementById('importPreview')?.remove();
  const dialog=document.createElement('dialog');dialog.id='importPreview';dialog.className='backup-preview';
  const pid=state.activeProfileId,uid=_currentUser?.uid || 'local';
  const profile=state.profiles.find(value=>value.id===pid);
  dialog.innerHTML=`<h2>Preview backup import</h2>
    <p>Merge into <strong>${esc(profile?.name || 'this profile')}</strong>. Existing tasks, comments and subtasks are kept.</p>
    <label>Matching IDs and settings <select id="importPreference" class="filter-sel"><option value="existing">Keep existing values</option><option value="backup">Use backup values</option></select></label>
    <label><input type="checkbox" id="importMetrics" checked> Include recorded time and Pomodoro totals</label>
    <p id="importSummary" role="status"></p><details><summary>Review changes</summary><ul id="importChanges"></ul></details><p id="importError" role="alert"></p>
    <div class="backup-preview-actions"><button class="outline-btn" id="importPause">Pause timer and refresh preview</button>
    <button class="primary-btn" id="confirmImport">Merge backup</button><button class="outline-btn" id="cancelImport">Cancel</button></div>`;
  let plan;
  const scopeOkay=()=>state.activeProfileId===pid && (_currentUser?.uid || 'local')===uid;
  const refresh=()=>{
    dialog.querySelector('#importError').textContent='';
    try {
      if(!scopeOkay())throw new Error('The account or profile changed. Close this preview and import again.');
      plan=DailyFlowWorkflows.prepareBackupImport(_profileSnapshot(),backup,DailyFlowSyncCore,{
        preferBackup:dialog.querySelector('#importPreference').value==='backup',includeMetrics:dialog.querySelector('#importMetrics').checked});
      const s=plan.summary;
      dialog.querySelector('#importSummary').textContent=`${s.addedTasks} new tasks; ${s.matchingTasks} matching tasks with differences; ${s.quickNotes} quick notes; ${s.categories} custom categories; ${s.metricDays} days with recorded totals. Totals are restored by date, never added twice.`;
      const changes=dialog.querySelector('#importChanges');changes.replaceChildren();
      const addLine=text=>{const li=document.createElement('li');li.textContent=text;changes.append(li);};
      Object.entries(plan.data.entries).forEach(([date,tasks])=>tasks.forEach(task=>{
        const previous=(plan.before.entries[date] || []).find(value=>value.id===task.id);
        if(DailyFlowSyncCore.equal(previous,task))return;
        addLine(`${date} · ${task.content} — ${previous?'Merge with existing task':'New task'}; ${task.done?'completed':task.archived?'archived':'unfinished'}; ${(task.subtasks || []).length} subtasks; ${(task.comments || []).length} comments.`);
      }));
      for(const date of new Set([...Object.keys(plan.before.focusLog),...Object.keys(plan.data.focusLog),...Object.keys(plan.before.pomLog),...Object.keys(plan.data.pomLog)])) {
        if(plan.before.focusLog[date]!==plan.data.focusLog[date] || plan.before.pomLog[date]!==plan.data.pomLog[date])
          addLine(`${date} totals: ${plan.before.focusLog[date] || 0}s → ${plan.data.focusLog[date] || 0}s focus; ${plan.before.pomLog[date] || 0} → ${plan.data.pomLog[date] || 0} Pomodoros.`);
      }
      Object.entries(plan.data.settings).forEach(([key,value])=>{if(!DailyFlowSyncCore.equal(plan.before.settings[key],value))addLine(`${key.replace(/([A-Z])/g,' $1')}: ${JSON.stringify(plan.before.settings[key] ?? 'unset')} → ${JSON.stringify(value)}`);});
      if(!changes.children.length)addLine('No task, settings or daily-total changes. Notes, categories and achievements are merged by their IDs.');
      dialog.querySelector('#confirmImport').disabled=state.timer.running || !!state.timer.pendingSegments?.length;
      dialog.querySelector('#importPause').hidden=!state.timer.running;
    } catch(error) {plan=null;dialog.querySelector('#confirmImport').disabled=true;dialog.querySelector('#importError').textContent=error.message;}
  };
  dialog.querySelector('#importPreference').onchange=refresh;
  dialog.querySelector('#importMetrics').onchange=refresh;
  dialog.querySelector('#importPause').onclick=()=>{stopTimer('pause');refresh();};
  dialog.querySelector('#cancelImport').onclick=()=>dialog.close();
  dialog.querySelector('#confirmImport').onclick=()=>{
    try {
      if(!plan || !scopeOkay())throw new Error('The account or profile changed. Open a new import preview.');
      if(state.timer.running || state.timer.pendingSegments?.length)throw new Error('Pause the timer before importing.');
      if(!DailyFlowSyncCore.equal(_profileSnapshot(),plan.before)){refresh();throw new Error('Profile data changed. Review the refreshed preview, then merge again.');}
      const client=_profileClients.get(pid);
      if(client)void _journal(plan.operations,client);
      _storeProfile(pid,plan.data);
      state.notes.entries=plan.data.entries;state.pomLog=plan.data.pomLog;state.focusLog=plan.data.focusLog;
      state.settings={...DEFAULT_SETTINGS,...plan.data.settings};state.achievements=plan.data.achievements;
      state.quickNotes=plan.data.quickNotes;state.customCats=plan.data.customCats;
      _capturedProfiles.set(pid,_profileSnapshot());save();
      document.documentElement.setAttribute('data-theme',state.settings.dark?'dark':'light');
      applyAccentColor(state.settings.accentColor || '#7C3AED');
      applyRingStyle(state.settings.ringStyle || 'solid');
      document.documentElement.style.fontSize=(state.settings.fontSize || 16)+'px';
      if(!state.timer.sessionId && state.timer.remainingMs===state.timer.durationMs)setMode(state.timer.mode);
      populateCatSelects();renderLog();renderStats();renderCalendar();renderQuickNotes();
      if(state.ui.view==='analytics')renderAnalytics();
      dialog.close();showToast('✓ Backup merged into '+(profile?.name || 'this profile')+'.');
    } catch(error) {dialog.querySelector('#importError').textContent=error.message;}
  };
  document.body.append(dialog);refresh();dialog.showModal();
}

/* ─────────────────────────────────────────────────────
   VIEW SWITCHING
───────────────────────────────────────────────────── */

function switchView(view) {
  state.ui.view = view;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `v-${view}`));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'analytics') renderAnalytics();
  if (view === 'settings')  { loadSettingsUI(); renderCategoryManager(); }
}

/* ─────────────────────────────────────────────────────
   MODALS
───────────────────────────────────────────────────── */

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

/* ─────────────────────────────────────────────────────
   CLOCKS
───────────────────────────────────────────────────── */

function tzAbbr(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'short',
    }).formatToParts(new Date());
    return parts.find(p => p.type === 'timeZoneName')?.value || tz;
  } catch (_) { return tz; }
}

function getTimeParts(date, tz) {
  try {
    const use24 = state.settings.timeFormat24;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: !use24,
    }).formatToParts(date);
    const get = t => parts.find(p => p.type === t)?.value || '--';
    return {
      hm:   `${get('hour')}:${get('minute')}`,
      s:     get('second'),
      ap:   use24 ? '' : (parts.find(p => p.type === 'dayPeriod' || p.type === 'dayperiod')?.value || '').toUpperCase(),
    };
  } catch (_) { return { hm: '--:--', s: '--', ap: '--' }; }
}

function tzDiffStr(tzA, tzB, now) {
  // Difference between tzA time and tzB time in hours/minutes
  try {
    const toMs = tz => new Date(now.toLocaleString('en-US', { timeZone: tz })).getTime();
    const diffMin = Math.round((toMs(tzA) - toMs(tzB)) / 60000);
    if (diffMin === 0) return 'Same as local';
    const sign = diffMin > 0 ? '+' : '−';
    const abs  = Math.abs(diffMin);
    const h    = Math.floor(abs / 60);
    const m    = abs % 60;
    return m > 0 ? `${sign}${h}h ${m}m` : `${sign}${h}h`;
  } catch (_) { return ''; }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el && el.textContent !== val) el.textContent = val;
}

function updateClocks() {
  const now     = new Date();
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // ── Local clock ─────────────────────────────
  const lp = getTimeParts(now, localTz);
  setText('lHM', lp.hm);
  setText('lS',  lp.s);
  setText('lAP', lp.ap);
  setText('lTZ', tzAbbr(localTz));
  // Date label e.g. "Mon, Jun 2"
  try {
    const dateLbl = new Intl.DateTimeFormat('en-US', {
      timeZone: localTz, weekday: 'short', month: 'short', day: 'numeric',
    }).format(now);
    setText('lDate', dateLbl);
  } catch (_) {}

  // ── World clock ─────────────────────────────
  const tzSel = document.getElementById('tzSelect');
  if (!tzSel) return;
  const selTz = tzSel.value === 'local' ? localTz : tzSel.value;

  const wp = getTimeParts(now, selTz);
  setText('tzHM', wp.hm);
  setText('tzS',  wp.s);
  setText('tzAP', wp.ap);
  setText('tzAbbrSpan', tzAbbr(selTz));
  setText('tzDiff', tzDiffStr(selTz, localTz, now));
}

function initClocks() {
  const tzSel = document.getElementById('tzSelect');
  if (tzSel) {
    const saved = state.settings.timezone || 'local';
    tzSel.value = saved;
    tzSel.addEventListener('change', e => {
      state.settings.timezone = e.target.value;
      save();
      updateClocks();
    });
  }
  updateClocks();
  setInterval(updateClocks, 1000);
}

/* ─────────────────────────────────────────────────────
   THEME & WARM LIGHT
───────────────────────────────────────────────────── */

function toggleTheme() {
  state.settings.dark = !state.settings.dark;
  document.documentElement.setAttribute('data-theme', state.settings.dark ? 'dark' : 'light');
  // Reset warm light when switching to dark (irrelevant in dark mode)
  if (state.settings.dark) {
    applyWarmLight(0);
    const sl = document.getElementById('warmSlider');
    if (sl) sl.value = 0;
  } else {
    applyWarmLight(state.settings.warmLight || 0);
  }
  save();
}

/* ─────────────────────────────────────────────────────
   ACCENT COLOR
───────────────────────────────────────────────────── */
function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return { r, g, b };
}
function darken(hex, amt) {
  const { r, g, b } = hexToRgb(hex);
  const d = v => Math.max(0, v - amt);
  return `#${[d(r),d(g),d(b)].map(v=>v.toString(16).padStart(2,'0')).join('')}`;
}
function applyAccentColor(hex) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) hex = '#7C3AED';
  const { r, g, b } = hexToRgb(hex);
  const root = document.documentElement;
  root.style.setProperty('--primary',      hex);
  root.style.setProperty('--primary-h',    darken(hex, 16));
  root.style.setProperty('--primary-glow', `rgba(${r},${g},${b},.25)`);
  root.style.setProperty('--c-work',       hex);
  // also update ring stroke if in work mode
  const ring = document.getElementById('timerRing');
  if (ring && state.timer.mode === 'work') ring.style.stroke = hex;
  // update wave
  updateNavWave();
}

/* ─────────────────────────────────────────────────────
   RING STYLE
───────────────────────────────────────────────────── */
function applyRingStyle(style) {
  const ring = document.getElementById('timerRing');
  if (!ring) return;
  if (style === 'dashed') {
    ring.style.strokeDasharray = '20 8';
    ring.style.strokeWidth = '10';
  } else if (style === 'thin') {
    ring.style.strokeDasharray = '';
    ring.style.strokeWidth = '3';
  } else { // solid
    ring.style.strokeDasharray = '';
    ring.style.strokeWidth = '10';
  }
  // re-render ring progress
  renderRing();
}

/* ─────────────────────────────────────────────────────
   FOCUS MODE — hide sidebar when timer running + focusMode on
───────────────────────────────────────────────────── */
function applyFocusMode() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  // Keep the timer and all its controls visible; quiet only the supporting cards.
  sidebar.classList.toggle('focus-active', !!state.settings.focusMode && state.timer.running &&
    (state.timer.mode === 'work' || state.timer.mode === 'stopwatch'));
}

function applyWarmLight(val) {
  state.settings.warmLight = val;
  // Map 0-100 → opacity 0-0.22  (subtle at low, noticeable warm at max)
  const opacity = (val / 100) * 0.22;
  const overlay = document.getElementById('warmOverlay');
  if (overlay) overlay.style.background = `rgba(210, 120, 30, ${opacity})`;

  // Update label
  const labelEl = document.getElementById('warmLabel');
  if (!labelEl) return;
  if      (val === 0)   labelEl.textContent = 'Cool white';
  else if (val <= 20)   labelEl.textContent = 'Slightly warm';
  else if (val <= 45)   labelEl.textContent = 'Warm';
  else if (val <= 70)   labelEl.textContent = 'Very warm';
  else if (val <= 90)   labelEl.textContent = 'Amber';
  else                  labelEl.textContent = 'Candlelight 🕯️';

  // Tint the label itself for visual feedback
  const hue = 30 + (val / 100) * 20;
  const sat = 60 + (val / 100) * 40;
  labelEl.style.color = val > 0 ? `hsl(${hue}, ${sat}%, 40%)` : 'var(--text3)';

  // Glow the button when warm light is on
  const wrap = document.getElementById('warmDropWrap');
  if (wrap) wrap.classList.toggle('active', val > 0);
}

/* ─────────────────────────────────────────────────────
   DRAG & DROP (event delegation)
───────────────────────────────────────────────────── */

function initDragDrop() {
  const log = document.getElementById('log');

  // Grip-only drag activation — set draggable only on grip mousedown, reset on dragend
  log.addEventListener('mousedown', e => {
    const grip = e.target.closest('.entry-grip');
    if (grip) {
      const card = grip.closest('[data-id]');
      if (card) card.draggable = true;
    }
  });

  log.addEventListener('dragstart', e => {
    const el = e.target.closest('[data-id]');
    if (el && el.draggable) {
      _dragId = el.dataset.id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    } else {
      e.preventDefault(); // cancel accidental drags not from grip
    }
  });

  log.addEventListener('dragend', () => {
    document.querySelectorAll('.log-entry').forEach(el => {
      el.classList.remove('dragging', 'drag-over');
      el.draggable = false; // reset — must not stay permanently draggable
    });
    _dragId = null;
  });

  log.addEventListener('dragover', e => {
    const el = e.target.closest('[data-id]');
    if (el && el.dataset.id !== _dragId) {
      e.preventDefault();
      document.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));
      el.classList.add('drag-over');
    }
  });

  log.addEventListener('drop', e => {
    e.preventDefault();
    const el = e.target.closest('[data-id]');
    if (el && _dragId && el.dataset.id !== _dragId) reorderEntries(_dragId, el.dataset.id);
  });

  // Double-click to edit — delegated, guards interactive descendants
  log.addEventListener('dblclick', e => {
    if (e.target.closest('button, input, textarea, select, a, label')) return;

    // Check if dblclick was on a subtask row first
    const stItem = e.target.closest('[data-stid]');
    if (stItem) {
      e.preventDefault();
      startEditSubtask(stItem.dataset.entryid, stItem.dataset.stid, true);
      return;
    }

    // Otherwise edit the main task card
    const card = e.target.closest('[data-id]');
    if (card) {
      e.preventDefault();
      startEdit(card.dataset.id, true); // true = fromDblclick → triggers purple flash
    }
  });
}

/* ─────────────────────────────────────────────────────
   KEYBOARD SHORTCUTS
───────────────────────────────────────────────────── */

function initKeyboard() {
  document.addEventListener('keydown', e => {
    if(!state.activeProfileId)return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (document.querySelector('.modal-overlay.open, dialog[open]')) {
      if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
      return;
    }
    switch (e.key) {
      case ' ':        e.preventDefault(); state.timer.running ? stopTimer() : startTimer(); break;
      case 'r': case 'R': resetTimer(); break;
      case 'n': case 'N': e.preventDefault(); document.getElementById('entryInput').focus(); break;
      case '1':        setMode('work');        break;
      case '2':        setMode('shortBreak'); break;
      case '3':        setMode('longBreak');  break;
      case 'q': case 'Q': openQuickCapture(); break;
      case '?':        openModal('shortcutsModal'); break;
      case 'Escape':   document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open')); break;
    }
  });
}

/* ─────────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────
   SIDEBAR DRAG-TO-REORDER
   Uses HTML5 drag-and-drop on the .drag-grip handle.
   Persisted to localStorage as df2_sidebarOrder.
───────────────────────────────────────────────────── */
const SIDEBAR_DEFAULT_ORDER = ['timer','stats','ghosts','ambient','qnotes','calendar'];
const SIDEBAR_ORDER_KEY = 'df2_sidebarOrder';

function loadSidebarOrder() {
  try {
    const raw = localStorage.getItem(SIDEBAR_ORDER_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      const full = [...arr];
      SIDEBAR_DEFAULT_ORDER.forEach(id => { if (!full.includes(id)) full.push(id); });
      return full;
    }
  } catch(e) {}
  return [...SIDEBAR_DEFAULT_ORDER];
}

function saveSidebarOrder() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const order = Array.from(sidebar.querySelectorAll('[data-panel]')).map(c => c.dataset.panel);
  localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify(order));
}

function applySidebarOrder() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const order = loadSidebarOrder();
  order.forEach(id => {
    const el = sidebar.querySelector(`[data-panel="${id}"]`);
    if (el) sidebar.appendChild(el);
  });
}

function initSidebarReorder() {
  applySidebarOrder();
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  let dragCard = null;

  sidebar.querySelectorAll('.drag-grip').forEach(grip => {
    const card = grip.closest('[data-panel]');
    if (!card) return;

    // make the whole card draggable but only start when grip is grabbed
    grip.addEventListener('mousedown', () => { card.draggable = true; });
    grip.addEventListener('touchstart', () => { card.draggable = true; }, {passive:true});

    card.addEventListener('dragstart', e => {
      dragCard = card;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.panel);
      // small delay so the ghost image renders before we dim the card
      setTimeout(() => card.classList.add('sidebar-dragging'), 0);
    });

    card.addEventListener('dragend', () => {
      card.draggable = false;
      card.classList.remove('sidebar-dragging');
      sidebar.querySelectorAll('.sidebar-dragover').forEach(c => c.classList.remove('sidebar-dragover'));
      // snap-in animation on the dropped card
      if (dragCard) {
        dragCard.classList.remove('sidebar-dropped');
        void dragCard.offsetWidth;
        dragCard.classList.add('sidebar-dropped');
        setTimeout(() => dragCard && dragCard.classList.remove('sidebar-dropped'), 400);
      }
      dragCard = null;
      saveSidebarOrder();
    });

    card.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!dragCard || card === dragCard) return;
      // figure out whether to insert before or after based on mouse Y
      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      sidebar.querySelectorAll('.sidebar-dragover').forEach(c => c.classList.remove('sidebar-dragover'));
      card.classList.add('sidebar-dragover');
      if (e.clientY < midY) {
        sidebar.insertBefore(dragCard, card);
      } else {
        sidebar.insertBefore(dragCard, card.nextSibling);
      }
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('sidebar-dragover');
    });

    card.addEventListener('drop', e => {
      e.preventDefault();
      card.classList.remove('sidebar-dragover');
    });
  });
}

function init() {
  load();
  document.documentElement.setAttribute('data-theme', state.settings.dark ? 'dark' : 'light');

  // Only reset timeLeft from settings if load() did NOT restore a saved value
  if (!state.timer._restored) {
    state.timer.timeLeft = getModeSecs(state.timer.mode);
  }
  delete state.timer._restored;

  populateCatSelects();
  renderProfileSelector();
  renderTimerAll();
  renderDateHeader();
  renderLog();
  renderStats();
  renderCalendar();
  renderQuickNotes();
  initClocks();
  checkEod();
  initSidebarReorder();
  // Apply persisted customisations
  applyAccentColor(state.settings.accentColor || '#7C3AED');
  if (state.settings.fontSize) document.documentElement.style.fontSize = state.settings.fontSize + 'px';
  applyRingStyle(state.settings.ringStyle || 'solid');

  // Timer controls
  document.getElementById('playBtn').addEventListener('click', () => {
    state.timer.running ? stopTimer() : startTimer();
  });
  document.getElementById('resetBtn').addEventListener('click', resetTimer);
  document.getElementById('skipBtn').addEventListener('click', skipTimer);
  document.getElementById('finishBtn').addEventListener('click', finishTimer);
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // Date nav
  document.getElementById('prevDay').addEventListener('click', () => changeDate(-1));
  document.getElementById('nextDay').addEventListener('click', () => changeDate(1));
  document.getElementById('todayBtn').addEventListener('click', goToday);

  // Add entry
  document.getElementById('addBtn').addEventListener('click', addEntry);
  document.getElementById('entryInput').addEventListener('keydown', e => { if (e.key==='Enter') addEntry(); });
  document.getElementById('entryDate')?.addEventListener('change', () => {
    state.ui.entryDateExplicit = !!document.getElementById('entryDate').value;
    syncEntryDatePicker();
  });
  document.getElementById('toggleDesc').addEventListener('click', () => {
    state.ui.descOpen = !state.ui.descOpen;
    const panel = document.getElementById('descRow');
    const btn   = document.getElementById('toggleDesc');
    panel.style.display = state.ui.descOpen ? '' : 'none';
    btn.dataset.active  = state.ui.descOpen ? 'true' : 'false';
    if (state.ui.descOpen) document.getElementById('descInput').focus();
  });

  // Sub-tasks at creation
  document.getElementById('toggleNewSt').addEventListener('click', () => {
    _addNewSubtask();
    const btn = document.getElementById('toggleNewSt');
    btn.dataset.active = 'true';
  });


  document.getElementById('bannerStop').addEventListener('click', () => {
    if (state.timer.activeEntryId) trackEntry(state.timer.activeEntryId);
  });

  // Search & filters
  document.getElementById('searchInput').addEventListener('input', e => {
    state.ui.search = e.target.value; renderLog();
  });
  document.getElementById('filterCat').addEventListener('change', e => {
    state.ui.filterCat = e.target.value; renderLog();
  });
  document.getElementById('filterPri').addEventListener('change', e => {
    state.ui.filterPri = e.target.value; renderLog();
  });

  // View navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Settings
  document.getElementById('saveSettings').addEventListener('click', applySettings);

  // Theme
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);

  // Warm light dropdown toggle
  const warmDropBtn = document.getElementById('warmDropBtn');
  const warmDropdown = document.getElementById('warmDropdown');
  const warmDropWrap = document.getElementById('warmDropWrap');
  if (warmDropBtn && warmDropdown) {
    warmDropBtn.addEventListener('click', e => {
      e.stopPropagation();
      warmDropdown.classList.toggle('open');
    });
    // Close when clicking outside
    document.addEventListener('click', e => {
      if (warmDropWrap && !warmDropWrap.contains(e.target)) {
        warmDropdown.classList.remove('open');
      }
    });
  }

  // Warm light slider
  const warmSl = document.getElementById('warmSlider');
  if (warmSl) {
    const savedWarm = state.settings.warmLight || 0;
    warmSl.value = savedWarm;
    warmSl.addEventListener('input', e => applyWarmLight(parseInt(e.target.value)));
    applyWarmLight(savedWarm);
  }

  // Shortcuts modal
  document.getElementById('shortcutsBtn').addEventListener('click', () => openModal('shortcutsModal'));
  document.getElementById('closeShortcuts').addEventListener('click', () => closeModal('shortcutsModal'));

  // EOD modal
  document.getElementById('closeEod').addEventListener('click', () => closeModal('eodModal'));

  // Analytics chart week nav
  document.getElementById('prevWeek')?.addEventListener('click', () => {
    state.analytics.chartWeekOffset++;
    renderBiWeeklyChart();
  });
  document.getElementById('nextWeek')?.addEventListener('click', () => {
    if (state.analytics.chartWeekOffset > 0) {
      state.analytics.chartWeekOffset--;
      renderBiWeeklyChart();
    }
  });
  document.getElementById('toggleWeekView')?.addEventListener('click', () => {
    state.analytics.chartMode = state.analytics.chartMode === '7d' ? '14d' : '7d';
    state.analytics.chartWeekOffset = 0; // reset to current period
    renderBiWeeklyChart();
  });
  document.getElementById('closeAutoRoll')?.addEventListener('click', saveAutoRollModal);
  document.getElementById('closeEodBtn').addEventListener('click', () => closeModal('eodModal'));

  // Ambient sound
  document.querySelectorAll('.amb-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.ambient.type = btn.dataset.sound;
      document.querySelectorAll('.amb-btn').forEach(b => b.classList.toggle('active', b === btn));
      ambient.start(state.ambient.type, state.ambient.volume);
    });
  });
  document.getElementById('volSlider').addEventListener('input', e => {
    state.ambient.volume = parseInt(e.target.value) / 100;
    ambient.setVol(state.ambient.volume);
  });

  // Date-range export
  document.getElementById('exportRangeBtn')?.addEventListener('click', exportDateRange);
  // Default the date pickers to "this week"
  const today = todayStr();
  const dow   = (new Date(today+'T00:00:00').getDay() + 6) % 7;
  const fromEl = document.getElementById('exportFrom');
  const toEl   = document.getElementById('exportTo');
  if (fromEl) fromEl.value = offsetDate(today, -dow);
  if (toEl)   toEl.value   = today;

  // Export / import
  document.getElementById('exportJsonBtn').addEventListener('click', exportJson);
  document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);
  document.getElementById('exportBackupMdBtn').addEventListener('click', exportBackupMarkdown);
  document.getElementById('exportBackupXlsxBtn').addEventListener('click', exportBackupExcel);
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', e => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = '';
  });

  // Analytics day detail
  document.getElementById('detailGoToLog')?.addEventListener('click', () => {
    if (state.analytics.selectedDate) navigateToDate(state.analytics.selectedDate);
  });
  document.getElementById('detailClose')?.addEventListener('click', () => {
    state.analytics.selectedDate = null;
    renderAnalyticsDayDetail();
    renderWeeklyChart();
    renderHeatmap();
  });

  // Close modal on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
  });

  // Profile selector
  document.getElementById('profileBtn')?.addEventListener('click', e => {
    e.stopPropagation(); toggleProfileDrop();
  });
  document.getElementById('newProfileBtn')?.addEventListener('click', openCreateProfile);
  document.getElementById('closeCreateProfile')?.addEventListener('click', () => closeModal('createProfileModal'));
  document.getElementById('submitCreateProfile')?.addEventListener('click', submitCreateProfile);
  document.getElementById('newProfileName')?.addEventListener('input', updateProfilePreview);
  document.getElementById('newProfileName')?.addEventListener('keydown', e => { if (e.key==='Enter') submitCreateProfile(); });
  // Close profile dropdown on outside click
  document.addEventListener('click', e => {
    const drop = document.getElementById('profileDrop');
    const wrap = document.getElementById('profileSel');
    if (drop && wrap && !wrap.contains(e.target)) drop.classList.remove('open');
  });

  // Quick Notes
  document.getElementById('fabBtn')?.addEventListener('click', openQuickCapture);
  document.getElementById('qnAddBtn')?.addEventListener('click', openQuickCapture);
  document.getElementById('qcClose')?.addEventListener('click', closeQuickCapture);
  document.getElementById('qcSaveNote')?.addEventListener('click', saveQuickNote);
  document.getElementById('qcSaveTask')?.addEventListener('click', quickCaptureToTask);
  document.getElementById('qcTextarea')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); saveQuickNote(); }
    if (e.key === 'Escape') closeQuickCapture();
  });
  // Close popup when clicking outside
  document.addEventListener('click', e => {
    const popup = document.getElementById('qcPopup');
    const fab   = document.getElementById('fabBtn');
    if (popup && popup.style.display !== 'none' &&
        !popup.contains(e.target) && !fab.contains(e.target)) {
      closeQuickCapture();
    }
  });

  // Resume timer if it was running before the page closed/refreshed
  if (_timerShouldResume) {
    _timerShouldResume = false;
    startTimer();
  }

  // Save exact timer snapshot on page close / refresh
  window.addEventListener('beforeunload', saveTimerState);
  document.addEventListener('visibilitychange', () => {
    if (state.timer.running) tick();
    saveTimerState();
  });
  let observedDay = todayStr();
  setInterval(() => {
    if (todayStr() !== observedDay) {
      observedDay = todayStr();
      checkAutoRollover();
      renderStats(); renderCalendar(); renderDateHeader();
    }
  }, 30000);

  // Drag & drop
  initDragDrop();
  // Keyboard shortcuts
  initKeyboard();

  // PWA service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', {updateViaCache:'none'}).then(registration => {
      const announceUpdate = () => {
        if (registration.waiting && navigator.serviceWorker.controller) {
          showToast('An update is ready. It will apply after all DailyFlow tabs are closed.');
        }
      };
      announceUpdate();
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed') announceUpdate();
        });
      });
    }).catch(error => {
      console.warn('Offline app shell could not be prepared:', error.message);
    });
  }

  // Mark app as ready so auth state changes can trigger data reloads
  window._df_appReady = true;
}

document.addEventListener('DOMContentLoaded', () => {
  // Init Firebase auth first (shows login screen if not signed in)
  _initFirebaseAuth();
  // Init the app (runs even before sign-in; login screen overlays it)
  init();
  // ── DEBUG PANEL (activated via ?debug in URL) ──────────────────
  if (new URLSearchParams(window.location.search).has('debug')) {
    _initDebugPanel();
  }
});

function _initDebugPanel() {
  const panel = document.createElement('div');
  panel.id = 'df-debug';
  panel.style.cssText = [
    'position:fixed', 'bottom:0', 'right:0', 'width:340px', 'max-height:60vh',
    'overflow-y:auto', 'background:#111', 'color:#0f0', 'font:11px/1.5 monospace',
    'padding:10px', 'z-index:99999', 'border-top:2px solid #0f0',
    'border-left:2px solid #0f0', 'word-break:break-all'
  ].join(';');

  document.body.appendChild(panel);

  function log(msg, color) {
    const line = document.createElement('div');
    line.style.color = color || '#0f0';
    line.textContent = '[' + new Date().toISOString().slice(11,23) + '] ' + msg;
    panel.appendChild(line);
    panel.scrollTop = panel.scrollHeight;
  }

  log('=== DailyFlow Debug Panel ===', '#ff0');
  log('UA: ' + navigator.userAgent.slice(0,80));
  log('URL: ' + location.href);

  // SW status
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      if (!regs.length) { log('SW: none registered', '#f80'); return; }
      regs.forEach(r => {
        const sw = r.active || r.installing || r.waiting;
        log('SW state: ' + (sw ? sw.state : 'none') + ' scope: ' + r.scope);
        if (r.active) {
          r.active.postMessage({ type: 'ping' });
        }
      });
    });
    navigator.serviceWorker.addEventListener('message', e => {
      log('SW msg: ' + JSON.stringify(e.data));
    });
  } else {
    log('SW: not supported', '#f00');
  }

  // DOM check: wave elements
  setTimeout(() => {
    const wrap = document.getElementById('headerWaveWrap');
    const p1   = document.getElementById('wfPath1');
    const p2   = document.getElementById('wfPath2');
    const hdr  = document.querySelector('.header');
    log('--- DOM check ---', '#ff0');
    log('headerWaveWrap: ' + (wrap ? 'FOUND' : 'MISSING'), wrap ? '#0f0' : '#f00');
    log('wfPath1: '        + (p1   ? 'FOUND' : 'MISSING'), p1   ? '#0f0' : '#f00');
    log('wfPath2: '        + (p2   ? 'FOUND' : 'MISSING'), p2   ? '#0f0' : '#f00');
    if (wrap) {
      const cs = getComputedStyle(wrap);
      log('wrap position: ' + cs.position);
      log('wrap z-index:  ' + cs.zIndex);
      log('wrap display:  ' + cs.display);
      log('wrap overflow: ' + cs.overflow);
      log('wrap opacity:  ' + cs.opacity);
      log('wrap width:    ' + cs.width);
    }
    if (hdr) {
      const cs = getComputedStyle(hdr);
      log('header position: ' + cs.position);
      log('header overflow: ' + cs.overflow);
      log('header width:    ' + hdr.offsetWidth + 'px');
    }
  }, 500);

  // Patch updateNavWave to log calls
  const _origUpdateNavWave = window.updateNavWave || updateNavWave;
  const _patchWave = function() {
    const wrap = document.getElementById('headerWaveWrap');
    log('--- updateNavWave called ---', '#ff0');
    log('timer running: ' + (state && state.timer ? state.timer.running : '?'));
    log('timeLeft: '      + (state && state.timer ? state.timer.timeLeft : '?'));
    if (wrap) {
      log('wrap.style.width:   ' + wrap.style.width);
      log('wrap.style.opacity: ' + wrap.style.opacity);
      const cs = getComputedStyle(wrap);
      log('computed width:   ' + cs.width);
      log('computed opacity: ' + cs.opacity);
    } else {
      log('wrap: NOT FOUND at call time', '#f00');
    }
  };

  // Hook play button
  const playBtn = document.getElementById('playBtn');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      log('--- Play button clicked ---', '#ff0');
      setTimeout(_patchWave, 100);
      setTimeout(_patchWave, 1000);
      setTimeout(_patchWave, 2000);
    });
    log('Play button hooked');
  } else {
    log('Play button: NOT FOUND', '#f00');
  }

  log('--- CSS check ---', '#ff0');
  // Find the rule that applies to header-wave-wrap
  try {
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText && rule.selectorText.includes('header-wave')) {
            log('RULE: ' + rule.selectorText + ' => ' + rule.style.cssText.slice(0,80));
          }
        }
      } catch(e) { log('sheet blocked: ' + e.message, '#f80'); }
    }
  } catch(e) { log('CSS scan error: ' + e.message, '#f00'); }

  log('Debug ready. Start the timer!', '#0ff');
}

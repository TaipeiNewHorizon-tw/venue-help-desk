(function () {
  'use strict';

  var ICONS = {
    sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
    network: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.5a15 15 0 0 1 20 0"/><path d="M5.5 12.5a10 10 0 0 1 13 0"/><path d="M9 16.3a5 5 0 0 1 6 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor" stroke="none"/></svg>',
    clean: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z"/></svg>',
    catering: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8z"/><path d="M16 9h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 4.5c0 1-1 1-1 2s1 1 1 2"/><path d="M12 4.5c0 1-1 1-1 2s1 1 1 2"/></svg>',
    water: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.7 6 11a6 6 0 0 1-12 0c0-4.3 6-11 6-11z"/></svg>',
    power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
    furniture: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3"/><path d="M3 9h18v6H3z"/><path d="M5 15v4M19 15v4"/></svg>',
    parking: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9.5 16V8h3a3 3 0 0 1 0 6h-3"/></svg>',
    security: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3z"/></svg>',
    other: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>'
  };
  var ICON_OPTIONS = [
    { key: 'sound', label: '音響' },
    { key: 'network', label: '網路' },
    { key: 'clean', label: '清潔' },
    { key: 'catering', label: '餐飲' },
    { key: 'water', label: '飲水' },
    { key: 'power', label: '電力' },
    { key: 'furniture', label: '桌椅' },
    { key: 'parking', label: '停車' },
    { key: 'security', label: '保全' },
    { key: 'other', label: '其他（預設圖示）' }
  ];
  function iconFor(key) { return ICONS[key] || ICONS.other; }
  function iconOptionsHtml(selected) {
    return ICON_OPTIONS.map(function (o) {
      return '<option value="' + o.key + '"' + (o.key === selected ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
  }

  var DEFAULT_CATEGORIES = [
    { id: 'sound', label: '音響', icon: 'sound', requireNote: false },
    { id: 'network', label: '網路', icon: 'network', requireNote: false },
    { id: 'clean', label: '清潔', icon: 'clean', requireNote: false },
    { id: 'catering', label: '餐飲', icon: 'catering', requireNote: false },
    { id: 'other', label: '其他', icon: 'other', requireNote: true }
  ];

  var STATUS_ORDER = ['pending', 'in_progress', 'done'];
  var STATUS_LABEL = { pending: '待處理', in_progress: '處理中', done: '已完成' };

  var state = { venueName: '活動場地', rooms: [], requests: [], serviceHours: { start: '08:00', end: '23:59' }, categories: DEFAULT_CATEGORIES };
  var app = document.getElementById('app');

  var selectedCategory = null;
  var confirmingDelete = {};
  var settingsOpen = false;
  var activeTab = 'active';
  var qrModalRoom = null;
  var submitting = false;
  var connected = false;
  var needLogin = false; // staff view without a valid session shows the login form
  var roomParam = new URLSearchParams(location.search).get('room');
  // Dated QR codes open the customer page as /?p=<id>; the server looks up the room (and the time window) from the id.
  var passParam = new URLSearchParams(location.search).get('p');
  var customerMode = !!(roomParam || passParam);
  var blocked = null; // { code, message, validFrom } when the QR code is not usable (expired, not started yet, revoked...)
  var PASS_TEXT = {
    pass_required: '請掃描現場最新的 QR code，或聯絡工作人員',
    pass_invalid: '無法辨識此 QR code，請掃描現場最新的 QR code，或聯絡工作人員',
    pass_revoked: '此 QR code 已停用，請掃描現場最新的 QR code，或聯絡工作人員',
    pass_expired: '此 QR code 已過期，請掃描現場最新的 QR code，或聯絡工作人員',
    pass_not_started: '此 QR code 尚未到使用時間'
  };

  // ---- new-request alert (sound / tab-title flash) for the staff dashboard ----
  var lastPendingIds = null; // null = not yet initialised; first sync just sets the baseline, never alerts
  var alertMuted = false;
  try { alertMuted = localStorage.getItem('vhd_muted') === '1'; } catch (e) {}
  var audioCtx = null;
  // On-duty person's name, typed once per browser and sent with every accept/complete action.
  // Honour system (the dashboard has one shared password), used only to attribute work in reports.
  var staffName = '';
  try { staffName = localStorage.getItem('vhd_staff_name') || ''; } catch (e) {}
  var baseTitle = document.title;
  var titleFlashTimer = null;
  var titleFlashOn = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showToast(msg) {
    var old = document.querySelector('.toast');
    if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }

  // A click anywhere "warms up" the audio context — browsers block sound
  // that isn't triggered by a user gesture, so the very first alert after
  // opening the page may be silent (title flash + toast still fire) until
  // someone clicks anywhere on the page once.
  function ensureAudioCtx() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    } else if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(function () {});
    }
  }
  document.addEventListener('click', ensureAudioCtx);

  function beep(freq, delaySec, durSec) {
    setTimeout(function () {
      if (!audioCtx) return;
      try {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        var t0 = audioCtx.currentTime;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start(t0);
        o.stop(t0 + durSec + 0.02);
      } catch (e) {}
    }, delaySec * 1000);
  }

  function playAlertSound() {
    if (!audioCtx) return;
    beep(880, 0, 0.32);
    beep(1046, 0.2, 0.28);
  }

  function startTitleFlash(msg) {
    if (titleFlashTimer) return;
    titleFlashOn = false;
    titleFlashTimer = setInterval(function () {
      document.title = titleFlashOn ? baseTitle : msg;
      titleFlashOn = !titleFlashOn;
    }, 1000);
  }
  function stopTitleFlash() {
    if (titleFlashTimer) { clearInterval(titleFlashTimer); titleFlashTimer = null; }
    document.title = baseTitle;
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) stopTitleFlash(); });
  window.addEventListener('focus', stopTitleFlash);

  function computePendingIds(s) {
    var ids = {};
    (s.requests || []).forEach(function (r) { if (r.status === 'pending') ids[r.id] = true; });
    return ids;
  }

  function notifyNewRequests(count) {
    if (!alertMuted) playAlertSound();
    var label = count > 1 ? ('🔔 ' + count + ' 筆新求助') : '🔔 有新的求助';
    startTitleFlash(label + ' - 場地協助儀表板');
    showToast(count > 1 ? ('收到 ' + count + ' 筆新的求助請求') : '收到新的求助請求');
  }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (res.status === 401 && url !== '/api/login') {
        // staff session expired or missing: go back to the login screen
        needLogin = true;
        render();
      }
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (e) {
          var err = new Error(e.error || ('發生錯誤 (' + res.status + ')'));
          err.code = e.code;
          err.validFrom = e.validFrom;
          throw err;
        });
      }
      return res.json();
    });
  }

  function applyState(s) {
    if (currentView().type === 'staff') {
      var newPendingIds = computePendingIds(s);
      if (lastPendingIds) {
        var addedCount = 0;
        Object.keys(newPendingIds).forEach(function (id) { if (!lastPendingIds[id]) addedCount++; });
        if (addedCount > 0) notifyNewRequests(addedCount);
      }
      lastPendingIds = newPendingIds;
    }
    state = s;
    render();
  }

  function elapsedText(ts) {
    var diff = Math.max(0, Date.now() - ts);
    var m = Math.floor(diff / 60000);
    if (m < 1) return '剛剛';
    if (m < 60) return m + ' 分鐘前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小時前';
    return Math.floor(h / 24) + ' 天前';
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function formatDateTime(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function durationText(startTs, endTs) {
    var mins = Math.max(0, Math.round((endTs - startTs) / 60000));
    if (mins < 60) return mins + ' 分鐘';
    var h = Math.floor(mins / 60), m = mins % 60;
    return h + ' 小時' + (m ? m + ' 分鐘' : '');
  }
  function ageClass(ts, status) {
    if (status !== 'pending') return '';
    var m = (Date.now() - ts) / 60000;
    if (m >= 15) return 'age-critical';
    if (m >= 5) return 'age-warn';
    return '';
  }
  function isToday(ts) {
    var d = new Date(ts), n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }
  function minutesFromHHMM(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  // Uses the visitor's own device clock — fine here since clients are
  // physically at the venue, so device local time is Taipei time. The
  // server independently re-checks using Asia/Taipei time regardless.
  function isServiceOpen() {
    var sh = state.serviceHours || { start: '08:00', end: '23:59' };
    var startM = minutesFromHHMM(sh.start), endM = minutesFromHHMM(sh.end);
    if (startM == null || endM == null) return true;
    var d = new Date();
    var nowM = d.getHours() * 60 + d.getMinutes();
    if (startM <= endM) return nowM >= startM && nowM <= endM;
    return nowM >= startM || nowM <= endM;
  }

  function currentView() {
    var params = new URLSearchParams(location.search);
    var roomId = params.get('room');
    if (customerMode && blocked) return { type: 'blocked' };
    if (passParam) {
      // the public state of a pass contains exactly one room: the one the pass is for
      return state.rooms.length ? { type: 'client', room: state.rooms[0] } : { type: 'invalid' };
    }
    if (roomId) {
      var room = state.rooms.find(function (r) { return r.id === roomId; });
      return room ? { type: 'client', room: room } : { type: 'invalid' };
    }
    return { type: 'staff' };
  }

  function roomUrl(roomId) {
    return location.origin + '/?room=' + encodeURIComponent(roomId);
  }

  function setSyncIndicator() {
    var dot = document.getElementById('sync-dot');
    var label = document.getElementById('sync-label');
    if (!dot) return;
    dot.classList.remove('is-off', 'is-busy');
    if (submitting) { dot.classList.add('is-busy'); label.textContent = '同步中…'; }
    else if (!connected) { dot.classList.add('is-off'); label.textContent = '連線中斷，正在重新連線…'; }
    else { label.textContent = '即時同步中'; }
  }

  /* ---------------- client view ---------------- */
  function renderClient(room) {
    // Only today's own requests — so a new day's renter never sees a
    // previous company's history on what looks like "their" room page.
    var mine = state.requests.filter(function (r) { return r.roomId === room.id && isToday(r.createdAt); })
      .sort(function (a, b) { return b.createdAt - a.createdAt; }).slice(0, 6);

    var open = isServiceOpen();
    var sh = state.serviceHours || { start: '08:00', end: '23:59' };

    var catGrid = (state.categories || []).map(function (c) {
      var pressed = selectedCategory === c.id;
      return '<button type="button" class="cat-btn" data-cat="' + c.id + '" aria-pressed="' + pressed + '">' + iconFor(c.icon) + '<span>' + esc(c.label) + '</span></button>';
    }).join('');

    var selectedCat = (state.categories || []).find(function (c) { return c.id === selectedCategory; });
    var needsNote = !!(selectedCat && selectedCat.requireNote);
    var myList = mine.length ? mine.map(function (r) {
      return '<div class="req-row">' +
        '<div class="req-cat">' + iconFor(r.categoryIcon) + '</div>' +
        '<div class="req-main"><div class="req-title">' + esc(r.categoryLabel || r.category) + '</div>' +
        (r.note ? '<div class="req-note">' + esc(r.note) + '</div>' : '') + '</div>' +
        '<div style="text-align:right"><span class="pill pill--' + r.status + '">' + STATUS_LABEL[r.status] + '</span>' +
        '<div class="req-time">' + elapsedText(r.createdAt) + '</div></div></div>';
    }).join('') : '';

    var formHtml = open ?
      ('<div class="cat-grid">' + catGrid + '</div>' +
        '<label class="field-label" for="note-input">補充說明' + (needsNote ? '（請簡述問題）' : '（選填）') + '</label>' +
        '<textarea id="note-input" rows="3" maxlength="300" placeholder="' + (needsNote ? '請簡短描述您需要的協助…' : '若有其他細節，可在此補充…') + '"></textarea>' +
        '<button type="button" class="submit-btn" id="submit-btn"' + (submitting ? ' disabled' : '') + '>' + (submitting ? '送出中…' : '送出求助') + '</button>')
      : ('<div class="banner banner--info" style="margin-top:14px;">目前非服務時段(開放時間 ' + esc(sh.start) + '–' + esc(sh.end) + '),暫時無法送出新的求助,如有緊急狀況請直接聯絡工作人員。</div>');

    app.innerHTML =
      '<div class="shell shell--narrow">' +
        '<div class="room-head"><span class="brand-eyebrow">' + esc(state.venueName) + '</span><h1>' + esc(room.name) + '</h1><p style="color:var(--ink-soft);font-size:.9rem;margin-top:6px;">需要協助嗎？選擇項目後送出，工作人員會盡快為您服務。</p></div>' +
        formHtml +
        (mine.length ? '<div class="my-requests"><h2>本場地今天的請求</h2>' + myList + '</div>' : '') +
        '<div class="sync" style="justify-content:center;margin-top:22px;"><span class="sync-dot" id="sync-dot"></span><span id="sync-label">即時同步中</span></div>' +
      '</div>';

    app.querySelectorAll('.cat-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        selectedCategory = btn.getAttribute('data-cat');
        renderClient(room);
      });
    });
    var submitBtn = document.getElementById('submit-btn');
    if (submitBtn) submitBtn.addEventListener('click', function () {
      if (!selectedCategory) { showToast('請先選擇問題類別'); return; }
      var note = (document.getElementById('note-input').value || '').trim().slice(0, 300);
      var pickedCat = (state.categories || []).find(function (c) { return c.id === selectedCategory; });
      if (pickedCat && pickedCat.requireNote && !note) { showToast('請簡述問題內容'); return; }
      submitting = true;
      renderClient(room);
      api('POST', '/api/requests', passParam
        ? { p: passParam, category: selectedCategory, note: note }
        : { roomId: room.id, category: selectedCategory, note: note })
        .then(function (s) {
          selectedCategory = null;
          submitting = false;
          applyState(s);
          showToast('已送出，工作人員將盡快為您服務');
        })
        .catch(function (err) {
          submitting = false;
          if (err.code && /^pass_/.test(err.code)) {   // the QR code stopped being valid while the page was open
            blocked = { code: err.code, message: err.message, validFrom: err.validFrom };
            render();
            return;
          }
          renderClient(room);
          showToast(err.message || '送出失敗，請稍後再試');
        });
    });
    setSyncIndicator();
  }

  /* ---------------- staff view ---------------- */
  function tabBtn(id, label) {
    return '<button type="button" class="tab" data-tab="' + id + '" aria-selected="' + (activeTab === id) + '">' + label + '</button>';
  }

  function renderReqCard(r) {
    var cls = ageClass(r.createdAt, r.status);
    var actions = '';
    if (r.status === 'pending') actions = '<button type="button" class="btn btn--accent" data-action="advance" data-id="' + r.id + '" data-to="in_progress">接單處理</button>';
    else if (r.status === 'in_progress') actions = '<button type="button" class="btn btn--accent" data-action="advance" data-id="' + r.id + '" data-to="done">標記完成</button>';
    else actions = '<button type="button" class="btn btn--ghost" data-action="advance" data-id="' + r.id + '" data-to="pending">重新開啟</button>';
    return '<div class="card req-card ' + cls + '">' +
      '<div class="req-cat">' + iconFor(r.categoryIcon) + '</div>' +
      '<div class="req-body">' +
        '<div class="req-top"><span class="room-name">' + esc(r.roomName) + '</span><span class="pill pill--' + r.status + '">' + STATUS_LABEL[r.status] + '</span></div>' +
        '<div style="color:var(--ink-soft);font-size:.88rem;margin-top:2px;">' + esc(r.categoryLabel || r.category) + (r.note ? '　·　' + esc(r.note) : '') + '</div>' +
        '<div class="req-meta"><span class="age-tag">報修 ' + formatDateTime(r.createdAt) + '（' + elapsedText(r.createdAt) + '）</span>' +
        (r.acceptedBy ? '<span class="age-tag">接單：' + esc(r.acceptedBy) + '</span>' : '') +
        (r.status === 'done' && r.resolvedBy ? '<span class="age-tag">完成：' + esc(r.resolvedBy) + '</span>' : '') +
        (r.status === 'done' ? '<span class="age-tag">結案 ' + formatDateTime(r.updatedAt) + '　·　耗時 ' + durationText(r.createdAt, r.updatedAt) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="req-actions">' + actions + '</div>' +
    '</div>';
  }

  function renderSettings() {
    var rows = state.rooms.map(function (r) {
      var url = roomUrl(r.id);
      var deleting = !!confirmingDelete[r.id];
      return '<div class="room-row">' +
        '<input class="grow" value="' + esc(r.name) + '" data-onchange="rename-room" data-id="' + r.id + '">' +
        '<span class="link-chip" title="' + esc(url) + '">' + esc(url) + '</span>' +
        '<button type="button" class="btn" data-action="copy-link" data-id="' + r.id + '">複製連結</button>' +
        '<button type="button" class="btn" data-action="show-qr" data-id="' + r.id + '">QR code</button>' +
        '<a class="btn btn--ghost" href="' + esc(url) + '" target="_blank" rel="noopener">預覽</a>' +
        '<button type="button" class="btn ' + (deleting ? 'btn--danger' : 'btn--ghost') + '" data-action="delete-room" data-id="' + r.id + '">' + (deleting ? '確定刪除？' : '刪除') + '</button>' +
      '</div>';
    }).join('');
    var catRows = (state.categories || []).map(function (c) {
      var deletingCat = !!confirmingDelete[c.id];
      return '<div class="room-row">' +
        '<select data-onchange="category-icon" data-id="' + c.id + '" style="max-width:120px;">' + iconOptionsHtml(c.icon) + '</select>' +
        '<input class="grow" value="' + esc(c.label) + '" data-onchange="rename-category" data-id="' + c.id + '">' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:.82rem;color:var(--ink-soft);white-space:nowrap;"><input type="checkbox" style="width:auto;" data-onchange="category-note" data-id="' + c.id + '"' + (c.requireNote ? ' checked' : '') + '>需填說明</label>' +
        '<button type="button" class="btn ' + (deletingCat ? 'btn--danger' : 'btn--ghost') + '" data-action="delete-category" data-id="' + c.id + '">' + (deletingCat ? '確定刪除？' : '刪除') + '</button>' +
      '</div>';
    }).join('');
    var sh = state.serviceHours || { start: '08:00', end: '23:59' };
    return '<div class="card settings-panel">' +
      '<h2>場地服務QR-CODE設定</h2>' +
      '<p class="settings-sub">為每個場地產生專屬連結／QR code，張貼於場地內供客戶掃描求助。</p>' +
      '<div style="margin:10px 0 4px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);">' +
        '<b>每日 QR code（有日期、時段的）</b>' +
        '<p style="margin:4px 0 8px;font-size:.84rem;color:var(--ink-soft);">下班前列印隔天要用的場地 QR code，或臨時產生今天的；過了印在上面的時段就會失效。' +
          (state.qrRequirePass
            ? '目前<b>只接受有日期的 QR code</b>，下方舊的場地連結與 QR code 已經失效。'
            : '目前仍接受舊的場地 QR code（沒有日期的，離場的人也能用）。') + '</p>' +
        '<a class="btn btn--accent" href="/qr.html">產生／列印 QR code</a>' +
      '</div>' +
      '<label class="field-label">園區／場地總稱</label>' +
      '<input value="' + esc(state.venueName) + '" data-onchange="rename-venue" style="max-width:280px;">' +
      '<label class="field-label">求助服務時段(超過此時段，求助頁面暫停送出，避免舊連結在租借結束後仍被誤用)</label>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<input type="time" value="' + esc(sh.start) + '" data-onchange="service-start" style="max-width:140px;">' +
        '<span style="color:var(--ink-soft);">至</span>' +
        '<input type="time" value="' + esc(sh.end) + '" data-onchange="service-end" style="max-width:140px;">' +
        '<span style="color:var(--ink-faint);font-size:.78rem;">(結束時間設為 23:59 代表開放到當天午夜)</span>' +
      '</div>' +
      '<div style="margin-top:16px;">' + rows + '</div>' +
      '<div class="add-room"><input id="new-room-name" placeholder="新場地名稱，例如：3樓 A廳"><button type="button" class="btn btn--accent" data-action="add-room">新增場地</button></div>' +
      '<label class="field-label" style="margin-top:22px;">求助問題類別(客戶送出求助時可選擇的項目，可自行新增、改名、換圖示或刪除)</label>' +
      '<div>' + catRows + '</div>' +
      '<div class="add-room" style="margin-top:10px;">' +
        '<select id="new-cat-icon" style="max-width:120px;">' + iconOptionsHtml('other') + '</select>' +
        '<input id="new-cat-name" placeholder="新類別名稱，例如：飲水">' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:.82rem;color:var(--ink-soft);"><input type="checkbox" style="width:auto;" id="new-cat-note">需填說明</label>' +
        '<button type="button" class="btn btn--accent" data-action="add-category">新增類別</button>' +
      '</div>' +
    '</div>';
  }

  function renderQrModal() {
    var r = qrModalRoom;
    return '<div class="modal-overlay"><div class="modal">' +
      '<h3>' + esc(r.name) + '</h3>' +
      '<p style="color:var(--ink-soft);font-size:.84rem;">請掃描下方 QR code 前往求助頁面</p>' +
      '<div class="qr-box" id="qr-holder"></div>' +
      '<div class="link-chip" style="max-width:260px;margin:0 auto;">' + esc(roomUrl(r.id)) + '</div>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn" data-action="copy-link" data-id="' + r.id + '">複製連結</button>' +
        '<button type="button" class="btn btn--accent" data-action="close-qr">關閉</button>' +
      '</div>' +
    '</div></div>';
  }

  function setupQr(room) {
    var holder = document.getElementById('qr-holder');
    if (!holder) return;
    holder.innerHTML = '';
    if (window.QRCode) {
      new window.QRCode(holder, { text: roomUrl(room.id), width: 200, height: 200, correctLevel: window.QRCode.CorrectLevel.M });
    } else {
      holder.textContent = 'QR code 載入中，請稍候…';
    }
    var overlay = document.querySelector('.modal-overlay');
    if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) { qrModalRoom = null; renderStaff(); } });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { showToast('已複製連結'); }).catch(function () { showToast(text); });
    } else {
      showToast(text);
    }
  }

  function mutate(promise) {
    submitting = true;
    render();
    promise.then(applyState).catch(function (err) {
      submitting = false;
      render();
      showToast(err.message || '操作失敗，請稍後再試');
    });
  }

  function handleStaffAction(el) {
    var action = el.getAttribute('data-action') || el.getAttribute('data-onchange');
    if (action === 'advance') {
      var id = el.getAttribute('data-id'), to = el.getAttribute('data-to');
      if (!staffName) {
        showToast('請先在右上角輸入「值班人員」姓名');
        var nameInput0 = document.getElementById('staff-name');
        if (nameInput0) nameInput0.focus();
        return;
      }
      mutate(api('PATCH', '/api/requests/' + encodeURIComponent(id), { status: to, actor: staffName }));
    } else if (action === 'rename-venue') {
      mutate(api('PATCH', '/api/venue', { name: el.value.trim().slice(0, 60) || '活動場地' }));
    } else if (action === 'service-start' || action === 'service-end') {
      var curSh = state.serviceHours || { start: '08:00', end: '23:59' };
      var startVal = action === 'service-start' ? el.value : curSh.start;
      var endVal = action === 'service-end' ? el.value : curSh.end;
      if (!startVal || !endVal) return;
      mutate(api('PATCH', '/api/service-hours', { start: startVal, end: endVal }));
    } else if (action === 'rename-room') {
      var val = el.value.trim().slice(0, 40);
      if (val) mutate(api('PATCH', '/api/rooms/' + encodeURIComponent(el.getAttribute('data-id')), { name: val }));
    } else if (action === 'delete-room') {
      var did = el.getAttribute('data-id');
      if (confirmingDelete[did]) {
        clearTimeout(confirmingDelete[did]);
        delete confirmingDelete[did];
        mutate(api('DELETE', '/api/rooms/' + encodeURIComponent(did)));
      } else {
        confirmingDelete[did] = setTimeout(function () { delete confirmingDelete[did]; renderStaff(); }, 4000);
        renderStaff();
      }
    } else if (action === 'copy-link') {
      copyText(roomUrl(el.getAttribute('data-id')));
    } else if (action === 'show-qr') {
      qrModalRoom = state.rooms.find(function (r) { return r.id === el.getAttribute('data-id'); }) || null;
      renderStaff();
    } else if (action === 'close-qr') {
      qrModalRoom = null;
      renderStaff();
    } else if (action === 'add-room') {
      var input = document.getElementById('new-room-name');
      var val2 = (input.value || '').trim().slice(0, 40);
      if (!val2) { showToast('請輸入場地名稱'); return; }
      mutate(api('POST', '/api/rooms', { name: val2 }));
    } else if (action === 'rename-category') {
      var catVal = el.value.trim().slice(0, 20);
      if (catVal) mutate(api('PATCH', '/api/categories/' + encodeURIComponent(el.getAttribute('data-id')), { label: catVal }));
    } else if (action === 'category-icon') {
      mutate(api('PATCH', '/api/categories/' + encodeURIComponent(el.getAttribute('data-id')), { icon: el.value }));
    } else if (action === 'category-note') {
      mutate(api('PATCH', '/api/categories/' + encodeURIComponent(el.getAttribute('data-id')), { requireNote: el.checked }));
    } else if (action === 'delete-category') {
      var cid = el.getAttribute('data-id');
      if (confirmingDelete[cid]) {
        clearTimeout(confirmingDelete[cid]);
        delete confirmingDelete[cid];
        mutate(api('DELETE', '/api/categories/' + encodeURIComponent(cid)));
      } else {
        confirmingDelete[cid] = setTimeout(function () { delete confirmingDelete[cid]; renderStaff(); }, 4000);
        renderStaff();
      }
    } else if (action === 'add-category') {
      var nameInput = document.getElementById('new-cat-name');
      var iconSelect = document.getElementById('new-cat-icon');
      var noteCheck = document.getElementById('new-cat-note');
      var catName = (nameInput.value || '').trim().slice(0, 20);
      if (!catName) { showToast('請輸入類別名稱'); return; }
      mutate(api('POST', '/api/categories', { label: catName, icon: iconSelect.value, requireNote: !!noteCheck.checked }));
    }
  }

  function renderStaff() {
    // the whole dashboard is redrawn on every update: keep the name box focused while someone types in it
    var nameBox = document.activeElement && document.activeElement.id === 'staff-name' ? document.activeElement : null;
    var nameCaret = nameBox ? nameBox.selectionStart : 0;
    var all = state.requests;
    var pending = all.filter(function (r) { return r.status === 'pending'; });
    var inProgress = all.filter(function (r) { return r.status === 'in_progress'; });
    var doneToday = all.filter(function (r) { return r.status === 'done' && isToday(r.updatedAt); });
    // "今日總覽": every still-open request no matter how old (跨日未完成的舊案件
    // 不會被漏掉), plus anything opened or closed today so today's full picture
    // — including cases already結案 — stays visible without switching分頁.
    var todayOverview = all.filter(function (r) {
      return r.status !== 'done' || isToday(r.createdAt) || isToday(r.updatedAt);
    });

    var listSource;
    if (activeTab === 'active') listSource = todayOverview;
    else if (activeTab === 'pending') listSource = pending;
    else if (activeTab === 'in_progress') listSource = inProgress;
    else listSource = all.filter(function (r) { return r.status === 'done'; });

    listSource = listSource.slice().sort(function (a, b) {
      if (a.status !== b.status) return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
      return a.status === 'done' ? b.updatedAt - a.updatedAt : a.createdAt - b.createdAt;
    });

    var emptyLabel = activeTab === 'in_progress' ? '處理中的' : activeTab === 'pending' ? '待處理的' : activeTab === 'done' ? '已完成的' : '待處理、處理中或今日相關的';
    var cards = listSource.length ? listSource.map(renderReqCard).join('') : '<div class="empty card">目前沒有' + emptyLabel + '請求</div>';

    app.innerHTML =
      '<div class="shell">' +
        '<div class="topbar">' +
          '<div class="brand"><span class="brand-eyebrow">場地協助儀表板</span><span class="brand-name">' + esc(state.venueName) + '</span></div>' +
          '<div style="display:flex;align-items:center;gap:14px;">' +
            '<div class="sync"><span class="sync-dot" id="sync-dot"></span><span id="sync-label">即時同步中</span></div>' +
            '<label style="font-size:.82rem;color:var(--ink-soft);display:flex;align-items:center;gap:6px;">值班人員<input id="staff-name" value="' + esc(staffName) + '" placeholder="請輸入姓名" maxlength="40" style="width:110px;"></label>' +
            '<button type="button" class="btn" id="mute-toggle" title="開著這個分頁時，有新的求助會播提示音、分頁標題閃爍">' + (alertMuted ? '🔕 提醒已關閉' : '🔔 提醒已開啟') + '</button>' +
            '<a class="btn" href="/reports.html" style="text-decoration:none;color:inherit;">報表</a>' +
            '<button type="button" class="btn settings-toggle" id="settings-toggle">場地服務QR-CODE設定</button>' +
            '<button type="button" class="btn btn--ghost" id="logout-btn">登出</button>' +
          '</div>' +
        '</div>' +
        '<div class="stats">' +
          '<div class="stat"><b class="mono">' + pending.length + '</b><span>待處理</span></div>' +
          '<div class="stat"><b class="mono">' + inProgress.length + '</b><span>處理中</span></div>' +
          '<div class="stat"><b class="mono">' + doneToday.length + '</b><span>今日已完成</span></div>' +
        '</div>' +
        '<div class="tabs">' + tabBtn('active', '今日總覽') + tabBtn('pending', '待處理') + tabBtn('in_progress', '處理中') + tabBtn('done', '已完成') + '</div>' +
        '<div class="list">' + cards + '</div>' +
        (settingsOpen ? renderSettings() : '') +
      '</div>' +
      (qrModalRoom ? renderQrModal() : '');

    app.querySelectorAll('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () { activeTab = btn.getAttribute('data-tab'); renderStaff(); });
    });
    var st = document.getElementById('settings-toggle');
    if (st) st.addEventListener('click', function () { settingsOpen = !settingsOpen; renderStaff(); });
    var sn = document.getElementById('staff-name');
    if (sn) {
      sn.addEventListener('input', function () {
        staffName = sn.value.trim().slice(0, 40);
        try { localStorage.setItem('vhd_staff_name', staffName); } catch (e) {}
      });
      if (nameBox) { sn.focus(); try { sn.setSelectionRange(nameCaret, nameCaret); } catch (e) {} }
    }
    var lo = document.getElementById('logout-btn');
    if (lo) lo.addEventListener('click', function () {
      api('POST', '/api/logout').then(function () { location.reload(); }).catch(function () { location.reload(); });
    });
    var mt = document.getElementById('mute-toggle');
    if (mt) mt.addEventListener('click', function () {
      alertMuted = !alertMuted;
      try { localStorage.setItem('vhd_muted', alertMuted ? '1' : '0'); } catch (e) {}
      if (!alertMuted) { ensureAudioCtx(); playAlertSound(); }
      renderStaff();
    });
    app.querySelectorAll('[data-action]').forEach(function (el) {
      el.addEventListener('click', function () { handleStaffAction(el); });
    });
    app.querySelectorAll('[data-onchange]').forEach(function (el) {
      el.addEventListener('change', function () { handleStaffAction(el); });
    });
    if (qrModalRoom) setupQr(qrModalRoom);
    setSyncIndicator();
  }

  function renderLogin() {
    app.innerHTML =
      '<div class="shell shell--narrow">' +
        '<div class="room-head"><span class="brand-eyebrow">場地協助儀表板</span><h1>工作人員登入</h1></div>' +
        '<label class="field-label" for="login-pwd">密碼</label>' +
        '<input id="login-pwd" type="password" autocomplete="current-password" autofocus>' +
        '<button type="button" class="submit-btn" id="login-btn">登入</button>' +
        '<p id="login-msg" style="color:var(--ink-soft);font-size:.88rem;margin-top:10px;"></p>' +
      '</div>';
    var pwd = document.getElementById('login-pwd');
    var msg = document.getElementById('login-msg');
    function submit() {
      msg.textContent = '';
      api('POST', '/api/login', { password: pwd.value }).then(function () {
        location.reload();
      }).catch(function (err) {
        msg.textContent = err.message || '登入失敗';
      });
    }
    document.getElementById('login-btn').addEventListener('click', submit);
    pwd.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  }

  function fmtTaipei(ts) {
    return new Date(ts).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }

  function renderBlocked() {
    var msg = blocked.message || PASS_TEXT[blocked.code] || PASS_TEXT.pass_invalid;
    var extra = '';
    if (blocked.code === 'pass_not_started' && blocked.validFrom) {
      extra = '<p style="margin-top:8px;">這張 QR code 從 <b>' + esc(fmtTaipei(blocked.validFrom)) + '</b> 起可以使用。</p>';
    }
    app.innerHTML = '<div class="invalid-wrap"><div><h1 style="font-size:1.3rem;margin-bottom:8px;">目前無法使用這張 QR code</h1><p>' + esc(msg) + '</p>' + extra +
      '<p style="margin-top:12px;color:var(--ink-faint);font-size:.85rem;">如有緊急狀況，請直接聯絡現場工作人員。</p></div></div>';
  }

  function render() {
    if (!customerMode && needLogin) return renderLogin();
    var view = currentView();
    if (view.type === 'client') renderClient(view.room);
    else if (view.type === 'staff') renderStaff();
    else if (view.type === 'blocked') renderBlocked();
    else {
      app.innerHTML = '<div class="invalid-wrap"><div><h1 style="font-size:1.3rem;margin-bottom:8px;">找不到此場地連結</h1><p>請確認連結是否正確，或聯絡工作人員協助。</p></div></div>';
    }
  }

  function boot() {
    // Customers (?room=…) load only their own room's public data; staff load
    // the full state, which requires login.
    var url = passParam ? '/api/public?p=' + encodeURIComponent(passParam)
      : roomParam ? '/api/public?room=' + encodeURIComponent(roomParam) : '/api/state';
    fetch(url).then(function (r) {
      if (!customerMode && (r.status === 401 || r.status === 503)) {
        needLogin = true;
        render();
        return null;
      }
      if (customerMode && r.status === 403) {
        // QR code expired / not started yet / revoked / plain link no longer accepted
        return r.json().catch(function () { return {}; }).then(function (b) {
          blocked = { code: b.code, message: b.error, validFrom: b.validFrom };
          render();
          return null;
        });
      }
      return r.ok ? r.json() : null;
    }).then(function (s) {
      if (s) { state = s; render(); startSocket(); }
      else if (!needLogin && !blocked) render(); // unknown room → "invalid link" page
    }).catch(function () {
      render();
      showToast('無法連線到伺服器，請稍後重新整理');
    });

    setInterval(function () {
      if (!needLogin && !settingsOpen && !qrModalRoom) render();
    }, 30000);
  }

  function startSocket() {
    if (!window.io) return;
    var socket = passParam ? window.io({ query: { p: passParam } })
      : roomParam ? window.io({ query: { room: roomParam } }) : window.io();
    socket.on('connect', function () { connected = true; setSyncIndicator(); });
    socket.on('disconnect', function () { connected = false; setSyncIndicator(); });
    socket.on('state', function (s) { applyState(s); });
    socket.on('auth-required', function () { needLogin = true; render(); });
    // the QR code's time window ended (or it was revoked) while this page was open
    socket.on('pass-denied', function (d) {
      blocked = { code: d && d.code, message: PASS_TEXT[d && d.code] };
      socket.disconnect();
      render();
    });
  }

  boot();
})();

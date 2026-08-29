
(function () {
  'use strict';
 
  var CATEGORIES = [
    { id: 'sound', label: '音響', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>' },
    { id: 'network', label: '網路', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.5a15 15 0 0 1 20 0"/><path d="M5.5 12.5a10 10 0 0 1 13 0"/><path d="M9 16.3a5 5 0 0 1 6 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor" stroke="none"/></svg>' },
    { id: 'clean', label: '清潔', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z"/></svg>' },
    { id: 'catering', label: '餐飲', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8z"/><path d="M16 9h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 4.5c0 1-1 1-1 2s1 1 1 2"/><path d="M12 4.5c0 1-1 1-1 2s1 1 1 2"/></svg>' },
    { id: 'other', label: '其他', icon: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>' }
  ];
  var CAT_MAP = {};
  CATEGORIES.forEach(function (c) { CAT_MAP[c.id] = c; });
 
  var STATUS_ORDER = ['pending', 'in_progress', 'done'];
  var STATUS_LABEL = { pending: '待處理', in_progress: '處理中', done: '已完成' };
 
  var state = { venueName: '活動場地', rooms: [], requests: [], serviceHours: { start: '08:00', end: '23:59' } };
  var app = document.getElementById('app');
 
  var selectedCategory = null;
  var confirmingDelete = {};
  var settingsOpen = false;
  var activeTab = 'active';
  var qrModalRoom = null;
  var submitting = false;
  var connected = false;
 
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
 
  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (e) {
          throw new Error(e.error || ('發生錯誤 (' + res.status + ')'));
        });
      }
      return res.json();
    });
  }
 
  function applyState(s) {
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
 
    var catGrid = CATEGORIES.map(function (c) {
      var pressed = selectedCategory === c.id;
      return '<button type="button" class="cat-btn" data-cat="' + c.id + '" aria-pressed="' + pressed + '">' + c.icon + '<span>' + esc(c.label) + '</span></button>';
    }).join('');
 
    var needsNote = selectedCategory === 'other';
    var myList = mine.length ? mine.map(function (r) {
      var c = CAT_MAP[r.category] || CAT_MAP.other;
      return '<div class="req-row">' +
        '<div class="req-cat">' + c.icon + '</div>' +
        '<div class="req-main"><div class="req-title">' + esc(c.label) + '</div>' +
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
      if (selectedCategory === 'other' && !note) { showToast('請簡述問題內容'); return; }
      submitting = true;
      renderClient(room);
      api('POST', '/api/requests', { roomId: room.id, category: selectedCategory, note: note })
        .then(function (s) {
          selectedCategory = null;
          submitting = false;
          applyState(s);
          showToast('已送出，工作人員將盡快為您服務');
        })
        .catch(function (err) {
          submitting = false;
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
    var c = CAT_MAP[r.category] || CAT_MAP.other;
    var cls = ageClass(r.createdAt, r.status);
    var actions = '';
    if (r.status === 'pending') actions = '<button type="button" class="btn btn--accent" data-action="advance" data-id="' + r.id + '" data-to="in_progress">接單處理</button>';
    else if (r.status === 'in_progress') actions = '<button type="button" class="btn btn--accent" data-action="advance" data-id="' + r.id + '" data-to="done">標記完成</button>';
    else actions = '<button type="button" class="btn btn--ghost" data-action="advance" data-id="' + r.id + '" data-to="pending">重新開啟</button>';
    return '<div class="card req-card ' + cls + '">' +
      '<div class="req-cat">' + c.icon + '</div>' +
      '<div class="req-body">' +
        '<div class="req-top"><span class="room-name">' + esc(r.roomName) + '</span><span class="pill pill--' + r.status + '">' + STATUS_LABEL[r.status] + '</span></div>' +
        '<div style="color:var(--ink-soft);font-size:.88rem;margin-top:2px;">' + esc(c.label) + (r.note ? '　·　' + esc(r.note) : '') + '</div>' +
        '<div class="req-meta"><span class="age-tag">報修 ' + formatDateTime(r.createdAt) + '（' + elapsedText(r.createdAt) + '）</span>' +
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
    var sh = state.serviceHours || { start: '08:00', end: '23:59' };
    return '<div class="card settings-panel">' +
      '<h2>場地設定</h2>' +
      '<p class="settings-sub">為每個場地產生專屬連結／QR code，張貼於場地內供客戶掃描求助。</p>' +
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
      mutate(api('PATCH', '/api/requests/' + encodeURIComponent(id), { status: to }));
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
    }
  }
 
  function renderStaff() {
    var all = state.requests;
    var pending = all.filter(function (r) { return r.status === 'pending'; });
    var inProgress = all.filter(function (r) { return r.status === 'in_progress'; });
    var doneToday = all.filter(function (r) { return r.status === 'done' && isToday(r.updatedAt); });
 
    var listSource;
    if (activeTab === 'active') listSource = pending.concat(inProgress);
    else if (activeTab === 'pending') listSource = pending;
    else if (activeTab === 'in_progress') listSource = inProgress;
    else listSource = all.filter(function (r) { return r.status === 'done'; });
 
    listSource = listSource.slice().sort(function (a, b) {
      if (a.status !== b.status) return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
      return a.status === 'done' ? b.updatedAt - a.updatedAt : a.createdAt - b.createdAt;
    });
 
    var emptyLabel = activeTab === 'in_progress' ? '處理中的' : activeTab === 'pending' ? '待處理的' : activeTab === 'done' ? '已完成的' : '待處理或處理中的';
    var cards = listSource.length ? listSource.map(renderReqCard).join('') : '<div class="empty card">目前沒有' + emptyLabel + '請求</div>';
 
    app.innerHTML =
      '<div class="shell">' +
        '<div class="topbar">' +
          '<div class="brand"><span class="brand-eyebrow">場地協助儀表板</span><span class="brand-name">' + esc(state.venueName) + '</span></div>' +
          '<div style="display:flex;align-items:center;gap:14px;">' +
            '<div class="sync"><span class="sync-dot" id="sync-dot"></span><span id="sync-label">即時同步中</span></div>' +
            '<button type="button" class="btn settings-toggle" id="settings-toggle">場地設定</button>' +
          '</div>' +
        '</div>' +
        '<div class="stats">' +
          '<div class="stat"><b class="mono">' + pending.length + '</b><span>待處理</span></div>' +
          '<div class="stat"><b class="mono">' + inProgress.length + '</b><span>處理中</span></div>' +
          '<div class="stat"><b class="mono">' + doneToday.length + '</b><span>今日已完成</span></div>' +
        '</div>' +
        '<div class="tabs">' + tabBtn('active', '進行中') + tabBtn('pending', '待處理') + tabBtn('in_progress', '處理中') + tabBtn('done', '已完成') + '</div>' +
        '<div class="list">' + cards + '</div>' +
        (settingsOpen ? renderSettings() : '') +
      '</div>' +
      (qrModalRoom ? renderQrModal() : '');
 
    app.querySelectorAll('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () { activeTab = btn.getAttribute('data-tab'); renderStaff(); });
    });
    var st = document.getElementById('settings-toggle');
    if (st) st.addEventListener('click', function () { settingsOpen = !settingsOpen; renderStaff(); });
    app.querySelectorAll('[data-action]').forEach(function (el) {
      el.addEventListener('click', function () { handleStaffAction(el); });
    });
    app.querySelectorAll('[data-onchange]').forEach(function (el) {
      el.addEventListener('change', function () { handleStaffAction(el); });
    });
    if (qrModalRoom) setupQr(qrModalRoom);
    setSyncIndicator();
  }
 
  function render() {
    var view = currentView();
    if (view.type === 'client') renderClient(view.room);
    else if (view.type === 'staff') renderStaff();
    else {
      app.innerHTML = '<div class="invalid-wrap"><div><h1 style="font-size:1.3rem;margin-bottom:8px;">找不到此場地連結</h1><p>請確認連結是否正確，或聯絡工作人員協助。</p></div></div>';
    }
  }
 
  function boot() {
    fetch('/api/state').then(function (r) { return r.json(); }).then(function (s) {
      state = s;
      render();
    }).catch(function () {
      render();
      showToast('無法連線到伺服器，請稍後重新整理');
    });
 
    if (window.io) {
      var socket = window.io();
      socket.on('connect', function () { connected = true; setSyncIndicator(); });
      socket.on('disconnect', function () { connected = false; setSyncIndicator(); });
      socket.on('state', function (s) { applyState(s); });
    }
 
    setInterval(function () {
      if (!settingsOpen && !qrModalRoom) render();
    }, 30000);
  }
 
  boot();
})();
 

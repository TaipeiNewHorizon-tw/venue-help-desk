(function () {
  'use strict';

  var TZ = 'Asia/Taipei';
  var $ = function (id) { return document.getElementById(id); };
  var state = null;
  var STATUS_LABEL = { active: '使用中', not_started: '尚未開始', expired: '已過期', revoked: '已停用' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var e = new Error(data.error || ('發生錯誤 (' + res.status + ')')); e.status = res.status; throw e; }
        return data;
      });
    });
  }

  // ---- Taipei time helpers (the venue runs on Taipei time no matter where this page is opened) ----
  function taipeiParts(ms) {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date(ms));
    var m = {};
    parts.forEach(function (p) { m[p.type] = p.value; });
    var hh = m.hour === '24' ? '00' : m.hour;
    return { date: m.year + '-' + m.month + '-' + m.day, time: hh + ':' + m.minute };
  }
  function addDays(dateStr, n) {
    var d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function toMs(date, time) { return Date.parse(date + 'T' + time + ':00+08:00'); }
  function fmtDate(date) {
    var wd = new Date(toMs(date, '12:00')).toLocaleDateString('zh-TW', { timeZone: TZ, weekday: 'short' });
    return date.replace(/-/g, '/') + '（' + wd + '）';
  }

  // ---- card (what gets printed) ----
  function windowText(p) {
    var a = taipeiParts(p.validFrom), b = taipeiParts(p.validUntil - 1); // until is stored as end-of-minute, show the minute
    if (a.date === b.date) return { main: fmtDate(a.date), sub: a.time + ' – ' + b.time };
    return { main: fmtDate(a.date) + ' ' + a.time + ' 起', sub: '至 ' + fmtDate(b.date) + ' ' + b.time };
  }

  function cardEl(p) {
    var w = windowText(p);
    var el = document.createElement('div');
    el.className = 'qr-card';
    el.innerHTML =
      '<div class="venue">' + esc(state.venueName || '') + '</div>' +
      '<div class="room">' + esc(p.roomName) + '</div>' +
      '<div class="when">' + esc(w.main) + '<small>使用時段 ' + esc(w.sub) + '</small></div>' +
      '<div class="code"></div>' +
      '<div class="ask">需要協助嗎？請掃描 QR code，通知現場工作人員</div>' +
      '<div class="foot">此 QR code 僅於上述日期與時段有效　編號 ' + esc(p.id.slice(0, 4)) + '</div>';
    var holder = el.querySelector('.code');
    var url = location.origin + '/?p=' + encodeURIComponent(p.id);
    if (window.QRCode) {
      new window.QRCode(holder, { text: url, width: 220, height: 220, correctLevel: window.QRCode.CorrectLevel.M });
    } else {
      holder.innerHTML = '<span style="word-break:break-all;font-size:.8rem">' + esc(url) + '</span>';
    }
    return el;
  }

  function showCards(list) {
    var sheet = $('sheet');
    sheet.innerHTML = '';
    list.forEach(function (p) { sheet.appendChild(cardEl(p)); });
    $('preview-panel').hidden = !list.length;
    if (list.length) $('preview-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- already issued passes ----
  var passes = [];
  function renderPasses() {
    var tbody = $('passes').querySelector('tbody');
    $('passes').hidden = !passes.length;
    $('passes-empty').hidden = !!passes.length;
    $('passes-empty').textContent = '目前沒有。';
    tbody.innerHTML = passes.slice().sort(function (a, b) { return a.validFrom - b.validFrom || a.roomName.localeCompare(b.roomName); }).map(function (p) {
      var w = windowText(p);
      var canRevoke = p.status === 'active' || p.status === 'not_started';
      return '<tr><td>' + esc(p.roomName) + '</td><td>' + esc(w.main) + '<br><span style="color:var(--ink-soft)">' + esc(w.sub) + '</span></td>' +
        '<td><span class="tag ' + esc(p.status) + '">' + esc(STATUS_LABEL[p.status] || p.status) + '</span></td>' +
        '<td style="white-space:nowrap"><button class="btn" data-act="reprint" data-id="' + esc(p.id) + '">重印</button> ' +
        (canRevoke ? '<button class="btn" data-act="revoke" data-id="' + esc(p.id) + '">停用</button>' : '') + '</td></tr>';
    }).join('');
  }

  function loadPasses() {
    return api('GET', '/api/passes').then(function (d) { passes = d.passes || []; renderPasses(); });
  }

  // ---- form ----
  var SAVED_KEY = 'vhd_qr_rooms';
  function renderRooms() {
    var saved = [];
    try { saved = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (e) {}
    $('rooms').innerHTML = state.rooms.map(function (r) {
      return '<label><input type="checkbox" value="' + esc(r.id) + '"' + (saved.indexOf(r.id) >= 0 ? ' checked' : '') + '>' + esc(r.name) + '</label>';
    }).join('') || '<span class="sub">還沒有場地，請先到儀表板的「場地設定」新增。</span>';
  }
  function selectedRooms() {
    return Array.prototype.slice.call($('rooms').querySelectorAll('input:checked')).map(function (i) { return i.value; });
  }
  function setMsg(text, cls) { var m = $('msg'); m.textContent = text || ''; m.className = 'msg ' + (cls || ''); }

  function serviceHours() { return state.serviceHours || { start: '08:00', end: '23:59' }; }
  function fillTomorrow() {
    $('f-date').value = addDays(taipeiParts(Date.now()).date, 1);
    $('f-start').value = serviceHours().start;
    $('f-end').value = serviceHours().end;
    $('f-days').value = 1;
  }
  function fillToday() {
    var now = taipeiParts(Date.now());
    var mins = parseInt(now.time.slice(0, 2), 10) * 60 + parseInt(now.time.slice(3), 10);
    mins = Math.floor(mins / 5) * 5;
    $('f-date').value = now.date;
    $('f-start').value = ('0' + Math.floor(mins / 60)).slice(-2) + ':' + ('0' + (mins % 60)).slice(-2);
    $('f-end').value = serviceHours().end;
    $('f-days').value = 1;
  }

  function generate() {
    setMsg('');
    var roomIds = selectedRooms();
    var date = $('f-date').value, start = $('f-start').value, end = $('f-end').value;
    var days = parseInt($('f-days').value, 10);
    if (!roomIds.length) return setMsg('請至少選擇一個場地。', 'err');
    if (!date || !start || !end) return setMsg('請填寫使用日期與開始、結束時間。', 'err');
    if (!(days >= 1 && days <= 14)) return setMsg('連續天數請輸入 1 到 14。', 'err');
    var from = toMs(date, start);
    // the end minute itself counts as valid (consistent with the service-hours rule), hence +59.999 s
    var until = toMs(addDays(date, days - 1), end) + 59999;
    if (until <= from) return setMsg('結束時間必須晚於開始時間。', 'err');
    if (until <= Date.now()) return setMsg('這個結束時間已經過了。', 'err');
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(roomIds)); } catch (e) {}
    var actor = '';
    try { actor = localStorage.getItem('vhd_staff_name') || ''; } catch (e) {}
    $('go').disabled = true;
    api('POST', '/api/passes', { roomIds: roomIds, validFrom: from, validUntil: until, actor: actor }).then(function (d) {
      showCards(d.passes);
      setMsg('已產生 ' + d.passes.length + ' 張，請檢查預覽後按「列印」。', 'ok');
      return loadPasses();
    }).catch(function (e) {
      setMsg(e.message, 'err');
    }).then(function () { $('go').disabled = false; });
  }

  function renderRequireBox() {
    $('require-pass').checked = !!state.qrRequirePass;
    $('require-warn').hidden = !!state.qrRequirePass;
  }

  function init() {
    fillTomorrow();
    renderRooms();
    renderRequireBox();
    $('main').hidden = false;
    loadPasses().catch(function () { $('passes-empty').textContent = '無法讀取，請重新整理。'; });

    $('q-tomorrow').addEventListener('click', fillTomorrow);
    $('q-today').addEventListener('click', fillToday);
    $('r-all').addEventListener('click', function () { $('rooms').querySelectorAll('input').forEach(function (i) { i.checked = true; }); });
    $('r-none').addEventListener('click', function () { $('rooms').querySelectorAll('input').forEach(function (i) { i.checked = false; }); });
    $('go').addEventListener('click', generate);
    $('print').addEventListener('click', function () { window.print(); });

    $('passes').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      var p = passes.filter(function (x) { return x.id === id; })[0];
      if (!p) return;
      if (btn.getAttribute('data-act') === 'reprint') {
        showCards([p]);
      } else if (window.confirm('確定要停用「' + p.roomName + '」的這張 QR code 嗎？已經印出去的就無法再使用。')) {
        api('DELETE', '/api/passes/' + encodeURIComponent(id)).then(loadPasses).catch(function (err) { window.alert(err.message); });
      }
    });

    $('require-pass').addEventListener('change', function () {
      var want = $('require-pass').checked;
      var msg = $('require-msg');
      msg.textContent = '';
      if (want && !window.confirm('啟用後，現場所有舊的（沒有日期的）QR code 會立刻失效。\n請確認現場已經換成新印的 QR code。\n\n確定要啟用嗎？')) {
        $('require-pass').checked = false;
        return;
      }
      api('PATCH', '/api/qr-mode', { requirePass: want }).then(function (s) {
        state.qrRequirePass = !!s.qrRequirePass;
        renderRequireBox();
        msg.className = 'msg ok';
        msg.textContent = state.qrRequirePass ? '已啟用：只接受有日期的 QR code。' : '已關閉：舊的場地 QR code 恢復可用。';
      }).catch(function (err) {
        $('require-pass').checked = !want;
        msg.className = 'msg err';
        msg.textContent = err.message;
      });
    });
  }

  // staff only: the page works once logged in on the dashboard (same cookie)
  api('GET', '/api/state').then(function (s) {
    state = s;
    init();
  }).catch(function (e) {
    var gate = $('gate');
    gate.hidden = false;
    gate.innerHTML = (e.status === 401 || e.status === 503)
      ? '請先到<a href="/">儀表板</a>登入，再回到這個頁面。'
      : '無法載入：' + esc(e.message);
  });
})();

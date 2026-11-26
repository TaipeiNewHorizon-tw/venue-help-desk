(function () {
  'use strict';

  var TZ = 'Asia/Taipei';
  var $ = function (id) { return document.getElementById(id); };
  var WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  var loadTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- Taipei date helpers ----
  function todayStr() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
  }
  function addDays(dateStr, n) {
    var d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function monthStart(dateStr) { return dateStr.slice(0, 8) + '01'; }

  function fmtDur(sec) {
    if (sec == null) return '—';
    if (sec < 60) return sec + ' 秒';
    if (sec < 3600) { var m = Math.floor(sec / 60), s = sec % 60; return m + ' 分' + (s ? ' ' + s + ' 秒' : ''); }
    var h = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60);
    return h + ' 小時' + (mm ? ' ' + mm + ' 分' : '');
  }
  function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 + '%' : '—'; }

  // ---- charts (plain HTML/CSS, no library) ----
  function vbars(values, labelFn, titleFn, labelEvery) {
    var max = Math.max.apply(null, values.concat([1]));
    var peak = values.indexOf(Math.max.apply(null, values));
    var hasData = values.some(function (v) { return v > 0; });
    var cols = values.map(function (v, i) {
      return '<div class="col" title="' + esc(titleFn(i, v)) + '"><div class="val">' + (v ? v : '') + '</div>' +
        '<div class="bar' + (hasData && i === peak ? ' peak' : '') + '" style="height:' + Math.round((v / max) * 112) + 'px"></div></div>';
    }).join('');
    var labels = values.map(function (v, i) { return '<span>' + (i % (labelEvery || 1) === 0 ? esc(labelFn(i)) : '') + '</span>'; }).join('');
    return '<div class="bars">' + cols + '</div><div class="labels">' + labels + '</div>';
  }

  function hbars(list, total) {
    if (!list.length) return '<div class="empty">沒有資料</div>';
    var max = Math.max.apply(null, list.map(function (x) { return x.count; }).concat([1]));
    return list.map(function (x) {
      return '<div class="hbar"><div>' + esc(x.label) + '</div><div class="track"><div class="fill" style="width:' + Math.round((x.count / max) * 100) + '%"></div></div>' +
        '<div class="n">' + x.count + ' 件（' + pct(x.count, total) + '）　等待 ' + esc(fmtDur(x.medianWaitSec)) + '</div></div>';
    }).join('');
  }

  function render(data) {
    var s = data.summary;
    var html = '';
    if (!s.total) {
      $('content').innerHTML = '<div class="panel"><div class="empty">這段期間沒有資料。可以改選日期範圍或篩選條件。</div></div>';
      return;
    }
    var open = s.pending + s.inProgress;
    html += '<div class="kpis">' +
      kpi(s.total, '總件數') +
      kpi(s.done, '已完成', pct(s.done, s.total)) +
      kpi(open, '未完成', '待處理 ' + s.pending + '／處理中 ' + s.inProgress) +
      kpi(fmtDur(s.response.medianSec), '接單等待（中位數）', s.response.count ? 'P90 ' + fmtDur(s.response.p90Sec) + '，共 ' + s.response.count + ' 件' : '還沒有接單紀錄') +
      kpi(s.response.withinTargetPct == null ? '—' : s.response.withinTargetPct + '%', Math.round(s.response.targetSec / 60) + ' 分鐘內接單', s.response.count ? s.response.withinTarget + '／' + s.response.count + ' 件' : '') +
      kpi(fmtDur(s.handling.medianSec), '處理時間（中位數）', s.handling.count ? '接單到完成，共 ' + s.handling.count + ' 件' : '') +
      kpi(s.reopened, '曾重新開啟', pct(s.reopened, s.total)) +
      '</div>';
    if (s.withoutAcceptTime > 0) {
      html += '<div class="note">其中 <b>' + s.withoutAcceptTime + '</b> 件是舊資料（當時還沒有記錄接單時間），不列入「接單等待」與「處理時間」統計，但有列入件數、類別、時段等統計。</div>';
    }

    var days = s.byDay;
    var every = days.length > 62 ? 14 : days.length > 31 ? 7 : days.length > 14 ? 2 : 1;
    html += '<div class="panel"><h2>每日件數</h2>' +
      vbars(days.map(function (d) { return d.count; }), function (i) { return days[i].date.slice(5); },
        function (i, v) { return days[i].date + '：' + v + ' 件'; }, every) + '</div>';

    html += '<div class="grid2">' +
      '<div class="panel"><h2>一天中的時段（臺北時間）</h2>' +
        vbars(s.byHour, function (i) { return i + '時'; }, function (i, v) { return i + ':00–' + i + ':59：' + v + ' 件'; }, 3) + '</div>' +
      '<div class="panel"><h2>星期</h2>' +
        vbars(s.byWeekday, function (i) { return '週' + WEEKDAYS[i]; }, function (i, v) { return '週' + WEEKDAYS[i] + '：' + v + ' 件'; }, 1) + '</div>' +
      '</div>';

    html += '<div class="grid2">' +
      '<div class="panel"><h2>類別</h2>' + hbars(s.byCategory, s.total) + '</div>' +
      '<div class="panel"><h2>場地</h2>' + roomTable(s.byRoom, s.total) + '</div>' +
      '</div>';

    html += '<div class="panel"><h2>人員</h2>' + staffTable(s.byStaff) +
      '<p class="sub" style="margin:8px 0 0">人員是值班人員在儀表板自己填寫的名字（不是帳號驗證）。「接單」＝第一個接下的人，「完成」＝按下完成的人。</p></div>';

    html += '<div class="panel"><h2>處理結果彙整（改進參考）</h2>' + resolutionTable(s.resolutions, s.resolutionCount) + '</div>';

    $('content').innerHTML = html;
  }

  function fmtTime(ms) {
    if (!ms) return '—';
    return new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  }
  function resolutionTable(list, total) {
    if (!list || !list.length) return '<div class="empty">這段期間還沒有處理結果紀錄。工作人員按「標記完成」時填寫的結果會彙整在這裡。</div>';
    return '<p class="sub" style="margin:0 0 8px">工作人員結案時寫下的處理結果，新的在上面（共 ' + total + ' 筆' + (total > list.length ? '，只列最近 ' + list.length + ' 筆，完整內容請匯出 CSV' : '') + '）。</p>' +
      '<table class="tbl tbl-res"><thead><tr><th>完成時間</th><th>場地</th><th>類別</th><th>客戶反映</th><th>處理結果</th><th>人員</th></tr></thead><tbody>' +
      list.map(function (r) {
        return '<tr><td>' + esc(fmtTime(r.at)) + '</td><td>' + esc(r.room) + '</td><td>' + esc(r.category) + '</td><td>' + esc(r.note || '—') + '</td><td class="res">' + esc(r.resolution) + '</td><td>' + esc(r.by || '—') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function kpi(value, label, small) {
    return '<div class="kpi"><b>' + esc(value) + '</b><span>' + esc(label) + '</span>' + (small ? '<small>' + esc(small) + '</small>' : '') + '</div>';
  }
  function roomTable(list, total) {
    if (!list.length) return '<div class="empty">沒有資料</div>';
    return '<table class="tbl"><thead><tr><th>場地</th><th class="num">件數</th><th class="num">占比</th><th class="num">接單等待（中位數）</th></tr></thead><tbody>' +
      list.map(function (r) {
        return '<tr><td>' + esc(r.label) + '</td><td class="num">' + r.count + '</td><td class="num">' + pct(r.count, total) + '</td><td class="num">' + esc(fmtDur(r.medianWaitSec)) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function staffTable(list) {
    if (!list.length) return '<div class="empty">這段期間沒有人員紀錄（舊資料沒有記錄人員）。</div>';
    return '<table class="tbl"><thead><tr><th>姓名</th><th class="num">接單</th><th class="num">完成</th><th class="num">處理時間（中位數）</th></tr></thead><tbody>' +
      list.map(function (p) {
        return '<tr><td>' + esc(p.name) + '</td><td class="num">' + p.accepted + '</td><td class="num">' + p.resolved + '</td><td class="num">' + esc(fmtDur(p.medianHandlingSec)) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  // ---- filters / loading ----
  function query() {
    var q = new URLSearchParams();
    q.set('from', $('f-from').value);
    q.set('to', $('f-to').value);
    if ($('f-room').value) q.set('room', $('f-room').value);
    if ($('f-cat').value) q.set('category', $('f-cat').value);
    return q;
  }
  function updateLinks(q) {
    $('x-requests').href = '/api/reports/export.csv?type=requests&' + q.toString();
    $('x-events').href = '/api/reports/export.csv?type=events&' + q.toString();
  }
  function setError(msg) { $('err').hidden = !msg; $('err').textContent = msg || ''; }

  function fillSelect(sel, items, current, allLabel) {
    var keep = current || sel.value;
    sel.innerHTML = '<option value="">' + allLabel + '</option>' + items.map(function (x) {
      return '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>';
    }).join('');
    sel.value = keep;
    if (sel.value !== keep) sel.value = '';
  }

  var filtersLoaded = false;
  var loadSeq = 0;   // only the newest request may draw: a slow, older answer must not overwrite a newer one
  function load() {
    var mySeq = ++loadSeq;
    var q = query();
    if (!$('f-from').value || !$('f-to').value) return;
    if ($('f-from').value > $('f-to').value) { setError('開始日期不能晚於結束日期。'); return; }
    setError('');
    updateLinks(q);
    try { history.replaceState(null, '', '?' + q.toString()); } catch (e) {}
    fetch('/api/reports/summary?' + q.toString()).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var err = new Error(data.error || ('發生錯誤 (' + res.status + ')')); err.status = res.status; throw err; }
        return data;
      });
    }).then(function (data) {
      if (mySeq !== loadSeq) return;
      if (!filtersLoaded) {
        filtersLoaded = true;
        fillSelect($('f-room'), data.filters.rooms, new URLSearchParams(location.search).get('room') || '', '全部場地');
        fillSelect($('f-cat'), data.filters.categories, new URLSearchParams(location.search).get('category') || '', '全部類別');
      }
      render(data);
    }).catch(function (e) {
      if (mySeq !== loadSeq) return;
      if (e.status === 401 || e.status === 503) return showGate(e);
      setError(e.message);
    });
  }
  function loadSoon() { clearTimeout(loadTimer); loadTimer = setTimeout(load, 150); }

  function setRange(kind) {
    var today = todayStr();
    var from = today, to = today;
    if (kind === '7') from = addDays(today, -6);
    else if (kind === '30') from = addDays(today, -29);
    else if (kind === 'month') from = monthStart(today);
    else if (kind === 'lastmonth') {
      var firstThis = monthStart(today);
      to = addDays(firstThis, -1);
      from = monthStart(to);
    }
    $('f-from').value = from;
    $('f-to').value = to;
    loadSoon();
  }

  function showGate(e) {
    $('main').hidden = true;
    var gate = $('gate');
    gate.hidden = false;
    gate.innerHTML = (e.status === 401 || e.status === 503)
      ? '請先到<a href="/">儀表板</a>登入，再回到這個頁面。'
      : '無法載入：' + esc(e.message);
  }

  function init() {
    var p = new URLSearchParams(location.search);
    var today = todayStr();
    $('f-from').value = /^\d{4}-\d{2}-\d{2}$/.test(p.get('from') || '') ? p.get('from') : addDays(today, -29);
    $('f-to').value = /^\d{4}-\d{2}-\d{2}$/.test(p.get('to') || '') ? p.get('to') : today;
    $('main').hidden = false;
    ['f-from', 'f-to', 'f-room', 'f-cat'].forEach(function (id) { $(id).addEventListener('change', loadSoon); });
    document.querySelectorAll('[data-range]').forEach(function (b) {
      b.addEventListener('click', function () { setRange(b.getAttribute('data-range')); });
    });
    load();
  }

  init();
})();

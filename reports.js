'use strict';

// reports.js — pure functions for the staff reports page and the CSV export.
// Input is the list of requests (shape from store.toRequest) already filtered by date/room/category.
// All "day / hour / weekday" bucketing uses Asia/Taipei (UTC+8, no DST).

const DAY = 86400000;
const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;
const DEFAULT_TARGET_SEC = 300; // "accepted within 5 minutes" (same as the dashboard's red-light threshold)

function pad2(n) { return n < 10 ? '0' + n : String(n); }

// 'YYYY-MM-DD HH:mm:ss' in Taipei time
function fmtTaipei(ms) {
  if (ms == null) return '';
  const d = new Date(ms + TAIPEI_OFFSET_MS);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' +
    pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
}
function taipeiDate(ms) { return fmtTaipei(ms).slice(0, 10); }

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Parse a YYYY-MM-DD range (inclusive both ends, Taipei days) into [fromMs, toMs).
// Returns { error } when invalid.
function parseRange(from, to, nowMs) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!to) to = taipeiDate(nowMs);
  if (!from) from = addDaysStr(to, -29);
  if (!re.test(from) || !re.test(to) || Number.isNaN(Date.parse(from + 'T00:00:00Z')) || Number.isNaN(Date.parse(to + 'T00:00:00Z'))) {
    return { error: '日期格式不正確（請用 YYYY-MM-DD）' };
  }
  if (from > to) return { error: '開始日期不能晚於結束日期' };
  const fromMs = Date.parse(from + 'T00:00:00+08:00');
  const toMs = Date.parse(to + 'T00:00:00+08:00') + DAY;
  if ((toMs - fromMs) / DAY > 366) return { error: '日期範圍最長 366 天' };
  return { from, to, fromMs, toMs };
}

function sortedNumbers(list) { return list.slice().sort(function (a, b) { return a - b; }); }
function median(sorted) {
  if (!sorted.length) return null;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
}
function percentile(sorted, p) {                     // nearest-rank
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
function stats(list) {
  const s = sortedNumbers(list);
  if (!s.length) return { count: 0, medianSec: null, p90Sec: null, avgSec: null };
  const sum = s.reduce(function (a, b) { return a + b; }, 0);
  return { count: s.length, medianSec: median(s), p90Sec: percentile(s, 0.9), avgSec: Math.round(sum / s.length) };
}
const secs = function (a, b) { return Math.max(0, Math.round((b - a) / 1000)); };

function buildSummary(requests, range, opts) {
  const targetSec = (opts && opts.targetSec) || DEFAULT_TARGET_SEC;
  const total = requests.length;
  const count = function (st) { return requests.filter(function (r) { return r.status === st; }).length; };

  // response time = accepted_at - created_at. Only requests that have an accept time can be measured:
  // requests imported from the old storage (finished before accepts were recorded) are excluded.
  const waits = requests.filter(function (r) { return r.acceptedAt != null; }).map(function (r) { return secs(r.createdAt, r.acceptedAt); });
  const response = stats(waits);
  response.targetSec = targetSec;
  response.withinTarget = waits.filter(function (w) { return w <= targetSec; }).length;
  response.withinTargetPct = waits.length ? Math.round((response.withinTarget / waits.length) * 1000) / 10 : null;

  const handling = stats(requests.filter(function (r) { return r.status === 'done' && r.acceptedAt != null && r.resolvedAt != null && r.resolvedAt >= r.acceptedAt; })
    .map(function (r) { return secs(r.acceptedAt, r.resolvedAt); }));
  const totalTime = stats(requests.filter(function (r) { return r.status === 'done' && r.resolvedAt != null; })
    .map(function (r) { return secs(r.createdAt, r.resolvedAt); }));

  function groupBy(keyFn, labelFn) {
    const map = new Map();
    requests.forEach(function (r) {
      const k = keyFn(r);
      if (!map.has(k)) map.set(k, { id: k, label: labelFn(r), count: 0, waits: [], _t: 0 });
      const g = map.get(k);
      g.count += 1;
      if (r.createdAt >= g._t) { g._t = r.createdAt; g.label = labelFn(r); }      // newest name wins
      if (r.acceptedAt != null) g.waits.push(secs(r.createdAt, r.acceptedAt));
    });
    return Array.from(map.values()).map(function (g) {
      return { id: g.id, label: g.label, count: g.count, medianWaitSec: median(sortedNumbers(g.waits)) };
    }).sort(function (a, b) { return b.count - a.count || String(a.label).localeCompare(String(b.label)); });
  }

  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);          // 0 = Sunday ... 6 = Saturday
  const dayCounts = new Map();
  requests.forEach(function (r) {
    const d = new Date(r.createdAt + TAIPEI_OFFSET_MS);
    byHour[d.getUTCHours()] += 1;
    byWeekday[d.getUTCDay()] += 1;
    const key = taipeiDate(r.createdAt);
    dayCounts.set(key, (dayCounts.get(key) || 0) + 1);
  });
  const byDay = [];
  for (let day = range.from; day <= range.to; day = addDaysStr(day, 1)) byDay.push({ date: day, count: dayCounts.get(day) || 0 });

  // per person: "accepted" counts who took the request first, "resolved" who closed it (honour-system names)
  const staff = new Map();
  const person = function (name) {
    if (!staff.has(name)) staff.set(name, { name: name, accepted: 0, resolved: 0, handling: [] });
    return staff.get(name);
  };
  requests.forEach(function (r) {
    if (r.acceptedBy) person(r.acceptedBy).accepted += 1;
    if (r.resolvedBy && r.status === 'done') {
      const p = person(r.resolvedBy);
      p.resolved += 1;
      if (r.acceptedAt != null && r.resolvedAt != null && r.resolvedAt >= r.acceptedAt) p.handling.push(secs(r.acceptedAt, r.resolvedAt));
    }
  });
  const byStaff = Array.from(staff.values()).map(function (p) {
    return { name: p.name, accepted: p.accepted, resolved: p.resolved, medianHandlingSec: median(sortedNumbers(p.handling)) };
  }).sort(function (a, b) { return (b.accepted + b.resolved) - (a.accepted + a.resolved) || a.name.localeCompare(b.name); });

  return {
    total: total,
    done: count('done'),
    inProgress: count('in_progress'),
    pending: count('pending'),
    reopened: requests.filter(function (r) { return r.reopenCount > 0; }).length,
    // finished before accept times were recorded (or accepted time otherwise unknown): excluded from response/handling figures
    withoutAcceptTime: requests.filter(function (r) { return r.acceptedAt == null && r.status !== 'pending'; }).length,
    response: response,
    handling: handling,
    totalTime: totalTime,
    byCategory: groupBy(function (r) { return r.category; }, function (r) { return r.categoryLabel; }),
    byRoom: groupBy(function (r) { return r.roomId; }, function (r) { return r.roomName; }),
    byHour: byHour,
    byWeekday: byWeekday,
    byDay: byDay,
    byStaff: byStaff,
  };
}

// ---- CSV ---------------------------------------------------------------------------------------
// Excel opens UTF-8 CSV correctly only with a BOM. Free text (customer notes, staff names) can start with
// = + - @ and be run as a formula by Excel (CSV injection), so text cells like that get a leading apostrophe.
function csvCell(v) {
  if (v == null) return '';
  let s = typeof v === 'number' ? String(v) : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCsv(headers, rows) {
  const lines = [headers].concat(rows).map(function (r) { return r.map(csvCell).join(','); });
  return '﻿' + lines.join('\r\n') + '\r\n';
}

const STATUS_ZH = { pending: '待處理', in_progress: '處理中', done: '已完成' };
const EVENT_ZH = { created: '送出', accepted: '接單', resolved: '完成', reopened: '重新開啟', reverted: '退回待處理' };

function requestsCsv(requests) {
  const headers = ['案件編號', '建立時間(臺北)', '場地', '場地代碼', '類別', '類別代碼', '備註', '狀態', '接單時間', '接單人員', '完成時間', '完成人員',
    '重新開啟次數', '接單等待秒數', '處理秒數', '總耗時秒數', '通行碼編號'];
  const rows = requests.map(function (r) {
    return [
      r.id, fmtTaipei(r.createdAt), r.roomName, r.roomId, r.categoryLabel, r.category, r.note, STATUS_ZH[r.status] || r.status,
      fmtTaipei(r.acceptedAt), r.acceptedBy, fmtTaipei(r.status === 'done' ? r.resolvedAt : null), r.status === 'done' ? r.resolvedBy : null,
      r.reopenCount,
      r.acceptedAt != null ? secs(r.createdAt, r.acceptedAt) : null,
      r.status === 'done' && r.acceptedAt != null && r.resolvedAt != null && r.resolvedAt >= r.acceptedAt ? secs(r.acceptedAt, r.resolvedAt) : null,
      r.status === 'done' && r.resolvedAt != null ? secs(r.createdAt, r.resolvedAt) : null,
      r.passId,
    ];
  });
  return toCsv(headers, rows);
}

// events: rows from store.queryEvents (snake_case columns + room_name / category_label of the request)
function eventsCsv(events) {
  const headers = ['事件編號', '案件編號', '時間(臺北)', '事件', '人員', '前狀態', '後狀態', '場地', '類別'];
  const rows = events.map(function (e) {
    return [e.id, e.request_id, fmtTaipei(e.at), EVENT_ZH[e.type] || e.type, e.actor, STATUS_ZH[e.from_status] || e.from_status,
      STATUS_ZH[e.to_status] || e.to_status, e.room_name, e.category_label];
  });
  return toCsv(headers, rows);
}

module.exports = { buildSummary, parseRange, requestsCsv, eventsCsv, toCsv, csvCell, fmtTaipei, median, percentile, DEFAULT_TARGET_SEC };

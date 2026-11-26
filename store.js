'use strict';

// store.js — permanent storage for help requests (SQLite, Node's built-in node:sqlite).
//
// Every request and every status change is kept forever:
//   requests        one row per request (convenient for queries; names are snapshots)
//   request_events  append-only log (created / accepted / resolved / reopened / reverted)
// All times are UTC milliseconds; "today" and reports use Asia/Taipei (UTC+8, no DST).
// See docs/data-and-analytics-design.md.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DAY = 86400000;
const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;

function taipeiDateStr(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(ts)); // YYYY-MM-DD
}

// Start of the Taipei calendar day that contains ts (UTC ms).
function taipeiDayStartMs(ts) {
  const day = new Date(ts + TAIPEI_OFFSET_MS);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - TAIPEI_OFFSET_MS;
}

function cleanActor(v) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
  return s || null;
}

// DB row -> the request shape the dashboard already uses (camelCase).
function toRequest(r) {
  return {
    id: r.id,
    roomId: r.room_id,
    roomName: r.room_name,
    category: r.category_id,
    categoryLabel: r.category_label,
    categoryIcon: r.category_icon || 'other',
    note: r.note,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    acceptedAt: r.accepted_at,
    acceptedBy: r.accepted_by,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    reopenCount: r.reopen_count,
  };
}

function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'helpdesk.db');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      room_name TEXT NOT NULL,
      category_id TEXT NOT NULL,
      category_label TEXT NOT NULL,
      category_icon TEXT,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      accepted_at INTEGER,
      accepted_by TEXT,
      resolved_at INTEGER,
      resolved_by TEXT,
      reopen_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_category ON requests(category_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_room ON requests(room_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

    CREATE TABLE IF NOT EXISTS request_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL REFERENCES requests(id),
      at INTEGER NOT NULL,
      type TEXT NOT NULL,
      actor TEXT,
      from_status TEXT,
      to_status TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique ON request_events(request_id, type, at);
    CREATE INDEX IF NOT EXISTS idx_events_at ON request_events(at);
  `);

  const insertReq = db.prepare(
    'INSERT OR IGNORE INTO requests (id, room_id, room_name, category_id, category_label, category_icon, note, status, ' +
    'created_at, accepted_at, accepted_by, resolved_at, resolved_by, reopen_count, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertEvent = db.prepare(
    'INSERT OR IGNORE INTO request_events (request_id, at, type, actor, from_status, to_status) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const getReq = db.prepare('SELECT * FROM requests WHERE id = ?');
  const updateReq = db.prepare(
    'UPDATE requests SET status = ?, updated_at = ?, accepted_at = ?, accepted_by = ?, resolved_at = ?, resolved_by = ?, reopen_count = ? WHERE id = ?'
  );

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }

  // A brand-new request from a customer.
  function createRequest(r) {
    tx(function () {
      insertReq.run(r.id, r.roomId, r.roomName, r.category, r.categoryLabel, r.categoryIcon || 'other', r.note || '',
        'pending', r.createdAt, null, null, null, null, 0, r.createdAt);
      insertEvent.run(r.id, r.createdAt, 'created', null, null, 'pending');
    });
  }

  // Staff moves a request to a new status. Returns null if unknown, {changed:false} if nothing to do.
  function changeStatus(id, to, actorRaw, now) {
    const actor = cleanActor(actorRaw);
    return tx(function () {
      const row = getReq.get(id);
      if (!row) return null;
      const from = row.status;
      if (from === to) return { changed: false, request: toRequest(row) };

      let acceptedAt = row.accepted_at, acceptedBy = row.accepted_by;
      let resolvedAt = row.resolved_at, resolvedBy = row.resolved_by;
      let reopen = row.reopen_count;

      if (to === 'in_progress' && from === 'pending') {
        insertEvent.run(id, now, 'accepted', actor, from, to);
        if (acceptedAt == null) { acceptedAt = now; acceptedBy = actor; }
      } else if (to === 'done') {
        if (acceptedAt == null) {           // closed straight from "pending": count it as accepted too
          insertEvent.run(id, now, 'accepted', actor, from, 'in_progress');
          acceptedAt = now; acceptedBy = actor;
        }
        insertEvent.run(id, now, 'resolved', actor, from, to);
        resolvedAt = now; resolvedBy = actor;
      } else if (from === 'done') {         // done -> pending / in_progress
        insertEvent.run(id, now, 'reopened', actor, from, to);
        reopen += 1;
      } else {                               // in_progress -> pending
        insertEvent.run(id, now, 'reverted', actor, from, to);
      }
      updateReq.run(to, now, acceptedAt, acceptedBy, resolvedAt, resolvedBy, reopen, id);
      return { changed: true, request: toRequest(getReq.get(id)) };
    });
  }

  // What the staff dashboard shows: everything still open, plus recently finished work.
  function loadLive(now) {
    const open = db.prepare("SELECT * FROM requests WHERE status != 'done' ORDER BY created_at ASC").all();
    const done = db.prepare(
      "SELECT * FROM requests WHERE status = 'done' AND updated_at > ? ORDER BY updated_at DESC LIMIT 150"
    ).all(now - 7 * DAY);
    return open.concat(done).map(toRequest);
  }

  // Counters for the aggregate dashboard (tnh-hub). "Today" = Taipei calendar day.
  function metrics(now) {
    const start = taipeiDayStartMs(now), end = start + DAY;
    const one = function (sql, ...p) { return db.prepare(sql).get(...p).n; };
    const unresolved = db.prepare("SELECT created_at FROM requests WHERE status != 'done'").all();
    return {
      calls_today: one('SELECT COUNT(*) AS n FROM requests WHERE created_at >= ? AND created_at < ?', start, end),
      pending: one("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'"),
      in_progress: one("SELECT COUNT(*) AS n FROM requests WHERE status = 'in_progress'"),
      resolved_today: one("SELECT COUNT(*) AS n FROM requests WHERE status = 'done' AND resolved_at >= ? AND resolved_at < ?", start, end),
      unresolved: unresolved.length,
      unresolved_ages_sec: unresolved
        .map(function (r) { return Math.max(0, Math.round((now - r.created_at) / 1000)); })
        .sort(function (a, b) { return b - a; }),
    };
  }

  function counts() {
    return {
      requests: db.prepare('SELECT COUNT(*) AS n FROM requests').get().n,
      events: db.prepare('SELECT COUNT(*) AS n FROM request_events').get().n,
    };
  }

  // One-time (and safe to repeat) import of the old storage: requests in state.json and the old
  // archive.db. Existing rows are never overwritten (INSERT OR IGNORE by id). Legacy rows have no
  // accepted_at / accepted_by (that was never recorded), so reports must ignore those fields for them.
  function importLegacy(stateRequests, archiveFile) {
    const legacy = [];
    (stateRequests || []).forEach(function (r) { legacy.push(r); });
    if (archiveFile && fs.existsSync(archiveFile)) {
      let arch = null;
      try {
        arch = new DatabaseSync(archiveFile);
        const rows = arch.prepare('SELECT * FROM archived_requests').all();
        rows.forEach(function (a) {
          legacy.push({
            id: a.id, roomId: a.room_id, roomName: a.room_name, category: a.category,
            categoryLabel: a.category_label, categoryIcon: a.category_icon, note: a.note,
            status: a.status, createdAt: a.created_at, updatedAt: a.updated_at,
          });
        });
      } catch (e) {
        console.error('[store] could not read legacy archive.db (' + e.message + ') - skipping it');
      } finally {
        if (arch) { try { arch.close(); } catch (_) {} }
      }
    }
    let imported = 0;
    tx(function () {
      legacy.forEach(function (r) {
        if (!r || !r.id || !r.createdAt) return;
        const status = ['pending', 'in_progress', 'done'].indexOf(r.status) >= 0 ? r.status : 'done';
        const updatedAt = r.updatedAt || r.createdAt;
        const res = insertReq.run(r.id, r.roomId || '', r.roomName || '', r.category || '', r.categoryLabel || r.category || '',
          r.categoryIcon || 'other', r.note || '', status, r.createdAt, null, null,
          status === 'done' ? updatedAt : null, null, 0, updatedAt);
        if (res.changes) {
          imported += 1;
          insertEvent.run(r.id, r.createdAt, 'created', null, null, 'pending');
          if (status === 'done') insertEvent.run(r.id, updatedAt, 'resolved', null, null, 'done');
        }
      });
    });
    return imported;
  }

  // Daily consistent snapshot into <dataDir>/backups (same Volume: protects against mistakes and
  // file corruption, NOT against losing the whole Volume - see the design doc for off-Volume copies).
  function ensureDailySnapshot(now, keep) {
    const dir = path.join(dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = taipeiDateStr(now).replace(/-/g, '');
    const target = path.join(dir, 'helpdesk-' + stamp + '.db');
    let created = null;
    if (!fs.existsSync(target)) {
      const tmp = target + '.tmp';
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
      db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'");
      fs.renameSync(tmp, target);
      const stateFile = path.join(dataDir, 'state.json');
      if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, path.join(dir, 'state-' + stamp + '.json'));
      created = target;
    }
    const limit = keep > 0 ? keep : 14;
    ['helpdesk-', 'state-'].forEach(function (prefix) {
      const files = fs.readdirSync(dir).filter(function (f) { return f.startsWith(prefix) && /\d{8}\.(db|json)$/.test(f); }).sort();
      files.slice(0, Math.max(0, files.length - limit)).forEach(function (f) { try { fs.rmSync(path.join(dir, f)); } catch (_) {} });
    });
    return created;
  }

  function close() { db.close(); }

  return { db, dbFile, createRequest, changeStatus, loadLive, metrics, counts, importLegacy, ensureDailySnapshot, close };
}

module.exports = { openStore, taipeiDateStr, taipeiDayStartMs, cleanActor };

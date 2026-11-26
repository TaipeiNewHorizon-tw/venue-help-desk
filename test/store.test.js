'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { openStore, taipeiDayStartMs, cleanActor } = require('../store');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vhd-store-')); }
function sample(id, createdAt, extra) {
  return Object.assign({
    id, roomId: 'room-1', roomName: '場地 1', category: 'sound', categoryLabel: '音響',
    categoryIcon: 'sound', note: '', createdAt,
  }, extra || {});
}
function events(store, id) {
  return store.db.prepare('SELECT type, actor, from_status, to_status, at FROM request_events WHERE request_id = ? ORDER BY id').all(id)
    .map(function (e) { return Object.assign({}, e); });
}

test('create -> accept -> resolve records fields and an event for each step', () => {
  const s = openStore(tmpDir());
  s.createRequest(sample('r1', 1000));
  let r = s.changeStatus('r1', 'in_progress', '  王小明  ', 2000);
  assert.equal(r.changed, true);
  assert.equal(r.request.status, 'in_progress');
  assert.equal(r.request.acceptedAt, 2000);
  assert.equal(r.request.acceptedBy, '王小明');
  r = s.changeStatus('r1', 'done', '李小華', 5000);
  assert.equal(r.request.resolvedAt, 5000);
  assert.equal(r.request.resolvedBy, '李小華');
  assert.equal(r.request.acceptedBy, '王小明'); // first accepter is kept
  assert.deepEqual(events(s, 'r1').map(e => e.type), ['created', 'accepted', 'resolved']);
  s.close();
});

test('closing straight from pending counts as accepted and resolved', () => {
  const s = openStore(tmpDir());
  s.createRequest(sample('r1', 1000));
  const r = s.changeStatus('r1', 'done', 'A', 3000).request;
  assert.equal(r.acceptedAt, 3000);
  assert.equal(r.resolvedAt, 3000);
  assert.deepEqual(events(s, 'r1').map(e => e.type), ['created', 'accepted', 'resolved']);
  s.close();
});

test('reopen increments the counter and keeps the first accept time', () => {
  const s = openStore(tmpDir());
  s.createRequest(sample('r1', 1000));
  s.changeStatus('r1', 'in_progress', 'A', 2000);
  s.changeStatus('r1', 'done', 'A', 3000);
  let r = s.changeStatus('r1', 'pending', 'B', 4000).request;
  assert.equal(r.reopenCount, 1);
  assert.equal(r.acceptedAt, 2000);
  r = s.changeStatus('r1', 'in_progress', 'B', 5000).request;
  assert.equal(r.acceptedAt, 2000);
  assert.deepEqual(events(s, 'r1').map(e => e.type), ['created', 'accepted', 'resolved', 'reopened', 'accepted']);
  s.close();
});

test('reverting in_progress -> pending is logged; same status and unknown id are no-ops', () => {
  const s = openStore(tmpDir());
  s.createRequest(sample('r1', 1000));
  s.changeStatus('r1', 'in_progress', 'A', 2000);
  s.changeStatus('r1', 'pending', 'A', 2500);
  assert.equal(events(s, 'r1').pop().type, 'reverted');
  assert.equal(s.changeStatus('r1', 'pending', 'A', 3000).changed, false);
  assert.equal(s.changeStatus('nope', 'done', 'A', 3000), null);
  assert.equal(events(s, 'r1').length, 3);
  s.close();
});

test('actor is optional and sanitised', () => {
  assert.equal(cleanActor(undefined), null);
  assert.equal(cleanActor('   '), null);
  assert.equal(cleanActor('a\u0000b\nc'), 'abc');
  assert.equal(cleanActor('x'.repeat(100)).length, 40);
});

test('taipei day boundaries (UTC+8)', () => {
  const midnightTaipei = Date.UTC(2026, 10, 25, 16, 0, 0); // 2026-11-26 00:00 Taipei
  assert.equal(taipeiDayStartMs(midnightTaipei), midnightTaipei);
  assert.equal(taipeiDayStartMs(midnightTaipei - 1), midnightTaipei - 86400000);
  assert.equal(taipeiDayStartMs(midnightTaipei + 86399999), midnightTaipei);
});

test('metrics: counts today (Taipei), open statuses and ages of unresolved requests', () => {
  const s = openStore(tmpDir());
  const now = Date.UTC(2026, 10, 26, 4, 0, 0); // 12:00 Taipei on 11-26
  const yesterday = Date.UTC(2026, 10, 25, 15, 0, 0); // 23:00 Taipei on 11-25
  s.createRequest(sample('old', yesterday));
  s.createRequest(sample('a', now - 7 * 60000));
  s.createRequest(sample('b', now - 2 * 60000));
  s.createRequest(sample('c', now - 30 * 60000));
  s.changeStatus('b', 'in_progress', 'X', now - 60000);
  s.changeStatus('c', 'done', 'X', now - 10 * 60000);
  const m = s.metrics(now);
  assert.equal(m.calls_today, 3);          // 'old' was yesterday in Taipei
  assert.equal(m.pending, 2);              // old + a
  assert.equal(m.in_progress, 1);
  assert.equal(m.resolved_today, 1);
  assert.equal(m.unresolved, 3);
  assert.equal(m.unresolved_ages_sec[0], Math.round((now - yesterday) / 1000)); // oldest first
  assert.ok(m.unresolved_ages_sec.includes(420));
  s.close();
});

test('loadLive: all open requests, plus only recent (<7 days) finished ones', () => {
  const s = openStore(tmpDir());
  const now = Date.UTC(2026, 10, 26, 4, 0, 0);
  const day = 86400000;
  s.createRequest(sample('open', now - 20 * day));
  s.createRequest(sample('recent', now - 2 * day));
  s.createRequest(sample('ancient', now - 30 * day));
  s.changeStatus('recent', 'done', 'A', now - day);
  s.changeStatus('ancient', 'done', 'A', now - 29 * day);
  const ids = s.loadLive(now).map(r => r.id).sort();
  assert.deepEqual(ids, ['open', 'recent']);
  assert.equal(s.counts().requests, 3); // the ancient one is still stored permanently
  s.close();
});

test('importLegacy: state.json requests + old archive.db, idempotent, never overwrites', () => {
  const dir = tmpDir();
  const archFile = path.join(dir, 'archive.db');
  const arch = new DatabaseSync(archFile);
  arch.exec('CREATE TABLE archived_requests (id TEXT PRIMARY KEY, room_id TEXT, room_name TEXT, category TEXT, category_label TEXT, category_icon TEXT, note TEXT, status TEXT, created_at INTEGER, updated_at INTEGER, archived_at INTEGER)');
  arch.prepare('INSERT INTO archived_requests VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('arc1', 'room-2', '場地 2', 'network', '網路', 'network', '連不上', 'done', 1000, 4000, 9000);
  arch.close();

  const s = openStore(dir);
  const live = [
    Object.assign(sample('live1', 5000), { status: 'pending', updatedAt: 5000 }),
    Object.assign(sample('live2', 6000), { status: 'done', updatedAt: 8000 }),
  ];
  assert.equal(s.importLegacy(live, archFile), 3);
  assert.equal(s.counts().requests, 3);
  const arc = s.db.prepare("SELECT * FROM requests WHERE id = 'arc1'").get();
  assert.equal(arc.category_id, 'network');
  assert.equal(arc.note, '連不上');
  assert.equal(arc.resolved_at, 4000);
  assert.equal(arc.accepted_at, null);                // never recorded for legacy rows
  assert.deepEqual(events(s, 'live2').map(e => e.type), ['created', 'resolved']);

  s.changeStatus('live1', 'in_progress', 'Z', 7000);  // new data must survive a repeated import
  assert.equal(s.importLegacy(live, archFile), 0);
  assert.equal(s.db.prepare("SELECT status FROM requests WHERE id = 'live1'").get().status, 'in_progress');
  assert.equal(s.counts().requests, 3);
  s.close();
});

test('importLegacy tolerates a missing or broken archive file', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'archive.db'), 'this is not a sqlite file');
  const s = openStore(dir);
  assert.equal(s.importLegacy([], path.join(dir, 'archive.db')), 0);
  assert.equal(s.importLegacy([], path.join(dir, 'does-not-exist.db')), 0);
  s.close();
});

test('daily snapshot: created once per Taipei day, readable, old ones pruned', () => {
  const dir = tmpDir();
  const s = openStore(dir);
  s.createRequest(sample('r1', 1000));
  fs.writeFileSync(path.join(dir, 'state.json'), '{"rooms":[]}');
  const day = 86400000;
  const base = Date.UTC(2026, 10, 1, 4, 0, 0);
  const first = s.ensureDailySnapshot(base, 3);
  assert.ok(first && fs.existsSync(first));
  assert.equal(s.ensureDailySnapshot(base + 3600000, 3), null);  // same day: nothing new
  for (let i = 1; i <= 4; i++) s.ensureDailySnapshot(base + i * day, 3);
  const dbs = fs.readdirSync(path.join(dir, 'backups')).filter(f => f.startsWith('helpdesk-')).sort();
  const states = fs.readdirSync(path.join(dir, 'backups')).filter(f => f.startsWith('state-'));
  assert.equal(dbs.length, 3);
  assert.equal(states.length, 3);
  assert.equal(dbs[0], 'helpdesk-20261103.db');                  // the two oldest were removed
  const snap = new DatabaseSync(path.join(dir, 'backups', dbs[2]));
  assert.equal(snap.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 1);
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).some(f => f.endsWith('.tmp')), false);
  snap.close();
  s.close();
});

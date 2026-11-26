'use strict';

// End-to-end: start the real server against a temporary data directory and use it over HTTP.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'test-only-password';
const TOKEN = 'test-only-token';

function freePort() {
  return new Promise(function (resolve, reject) {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', function () { const p = srv.address().port; srv.close(function () { resolve(p); }); });
    srv.on('error', reject);
  });
}

async function startServer(dataDir, extraEnv) {
  const port = await freePort();
  const env = Object.assign({}, process.env, {
    PORT: String(port), DATA_DIR: dataDir, STAFF_PASSWORD: PASSWORD, METRICS_TOKEN: TOKEN,
  }, extraEnv || {});
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) return { base, child, log: function () { return log; } }; } catch (_) {}
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  child.kill();
  throw new Error('server did not start:\n' + log);
}

function stop(srv) {
  return new Promise(function (resolve) { srv.child.once('exit', resolve); srv.child.kill(); });
}

async function login(base) {
  const r = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

const json = { 'Content-Type': 'application/json' };
function seedConfig(dir, requests) {
  const rooms = [1, 2].map(function (i) { return { id: 'room-' + i, name: '場地 ' + i }; });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    venueName: '測試', rooms, requests: requests || [], serviceHours: { start: '00:00', end: '23:59' },
    categories: [{ id: 'sound', label: '音響', icon: 'sound', requireNote: false }],
  }));
}

test('full flow: legacy import, create, accept, resolve, metrics, backup, restart keeps everything', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhd-e2e-'));
  const now = Date.now();
  seedConfig(dir, [{
    id: 'legacy-live', roomId: 'room-1', roomName: '場地 1', category: 'sound', categoryLabel: '音響',
    categoryIcon: 'sound', note: '舊資料', status: 'pending', createdAt: now - 3600000, updatedAt: now - 3600000,
  }]);
  const arch = new DatabaseSync(path.join(dir, 'archive.db'));
  arch.exec('CREATE TABLE archived_requests (id TEXT PRIMARY KEY, room_id TEXT, room_name TEXT, category TEXT, category_label TEXT, category_icon TEXT, note TEXT, status TEXT, created_at INTEGER, updated_at INTEGER, archived_at INTEGER)');
  arch.prepare('INSERT INTO archived_requests VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('legacy-arch', 'room-2', '場地 2', 'sound', '音響', 'sound', '', 'done', now - 40 * 86400000, now - 39 * 86400000, now - 30 * 86400000);
  arch.close();

  let srv = await startServer(dir);
  try {
    assert.match(srv.log(), /2 imported from legacy storage/);
    assert.equal((await fetch(srv.base + '/healthz')).status, 200);
    assert.equal(fs.readdirSync(path.join(dir, 'backups')).filter(f => f.startsWith('helpdesk-')).length, 1);

    // customer creates a request (no login needed) and only sees their own room
    let r = await fetch(srv.base + '/api/requests', { method: 'POST', headers: json, body: JSON.stringify({ roomId: 'room-1', category: 'sound', note: 'x' }) });
    assert.equal(r.status, 200);
    const pub = await r.json();
    assert.equal(pub.rooms.length, 1);
    const created = pub.requests.find(function (q) { return q.note === 'x'; });
    assert.ok(created);

    // staff endpoints need the password
    assert.equal((await fetch(srv.base + '/api/state')).status, 401);
    assert.equal((await fetch(srv.base + '/api/requests/' + created.id, { method: 'PATCH', headers: json, body: '{"status":"done"}' })).status, 401);
    const cookie = await login(srv.base);

    r = await fetch(srv.base + '/api/requests/' + created.id, { method: 'PATCH', headers: Object.assign({ Cookie: cookie }, json), body: JSON.stringify({ status: 'in_progress', actor: '王小明' }) });
    assert.equal(r.status, 200);
    let st = await r.json();
    let mine = st.requests.find(q => q.id === created.id);
    assert.equal(mine.acceptedBy, '王小明');
    r = await fetch(srv.base + '/api/requests/' + created.id, { method: 'PATCH', headers: Object.assign({ Cookie: cookie }, json), body: JSON.stringify({ status: 'done', actor: '李小華' }) });
    st = await r.json();
    mine = st.requests.find(q => q.id === created.id);
    assert.equal(mine.resolvedBy, '李小華');
    assert.equal((await fetch(srv.base + '/api/requests/nope', { method: 'PATCH', headers: Object.assign({ Cookie: cookie }, json), body: '{"status":"done"}' })).status, 404);

    // metrics read from the permanent store: legacy-live (pending) + this one (done) are today/open as expected
    assert.equal((await fetch(srv.base + '/api/metrics')).status, 401);
    const m = await (await fetch(srv.base + '/api/metrics', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
    assert.equal(m.calls_today >= 1, true);
    assert.equal(m.resolved_today, 1);
    assert.equal(m.pending, 1);               // the legacy pending one
    assert.equal(m.unresolved_ages_sec.length, 1);
  } finally {
    await stop(srv);
  }

  // restart: remove the requests from state.json to prove the database (not the JSON) is the source of truth
  const stateFile = path.join(dir, 'state.json');
  const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  parsed.requests = [];
  fs.writeFileSync(stateFile, JSON.stringify(parsed));
  srv = await startServer(dir);
  try {
    assert.match(srv.log(), /3 requests, \d+ events, 0 imported/);   // legacy-live, legacy-arch, and the new one
    const cookie = await login(srv.base);
    const st = await (await fetch(srv.base + '/api/state', { headers: { Cookie: cookie } })).json();
    const notes = st.requests.map(q => q.note).sort();
    assert.deepEqual(notes, ['x', '舊資料']);   // 40-day-old finished request is stored, not on the live dashboard
  } finally {
    await stop(srv);
  }
  const db = new DatabaseSync(path.join(dir, 'helpdesk.db'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 3);
  const types = db.prepare("SELECT e.type FROM request_events e JOIN requests r ON r.id = e.request_id WHERE r.note = 'x' ORDER BY e.id").all().map(e => e.type);
  assert.deepEqual(types, ['created', 'accepted', 'resolved']);
  db.close();
});

test('rate limit: 6th request from one room is rejected, other rooms are unaffected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhd-rl-'));
  seedConfig(dir);
  const srv = await startServer(dir);
  try {
    const send = function (room) {
      return fetch(srv.base + '/api/requests', { method: 'POST', headers: json, body: JSON.stringify({ roomId: room, category: 'sound' }) }).then(r => r.status);
    };
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push(await send('room-1'));
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
    assert.equal(await send('room-2'), 200);
  } finally {
    await stop(srv);
  }
});

test('refuses to start (instead of silently losing data) when the database cannot be opened', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhd-bad-'));
  seedConfig(dir);
  fs.mkdirSync(path.join(dir, 'helpdesk.db'));   // a directory where the database file should be
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, STAFF_PASSWORD: PASSWORD }), stdio: 'ignore',
  });
  const code = await new Promise(function (resolve) { child.once('exit', resolve); });
  assert.equal(code, 1);
});

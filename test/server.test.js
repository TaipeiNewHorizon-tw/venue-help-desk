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

test('qr passes: issue, time windows, revoke, and the "dated QR required" switch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhd-pass-'));
  seedConfig(dir);
  const srv = await startServer(dir);
  try {
    const now = Date.now(), MIN = 60000, HOUR = 3600000;
    const cookie = await login(srv.base);
    const staff = Object.assign({ Cookie: cookie }, json);
    const post = (p, body, headers) => fetch(srv.base + p, { method: 'POST', headers: headers || json, body: JSON.stringify(body) });

    // issuing needs staff login and sane input
    assert.equal((await post('/api/passes', { roomIds: ['room-1'], validFrom: now, validUntil: now + HOUR })).status, 401);
    const bad = async body => (await post('/api/passes', body, staff)).status;
    assert.equal(await bad({ roomIds: [], validFrom: now, validUntil: now + HOUR }), 400);
    assert.equal(await bad({ roomIds: ['room-1'], validFrom: now, validUntil: now - 1 }), 400);          // ends before it starts
    assert.equal(await bad({ roomIds: ['room-1'], validFrom: now - 2 * HOUR, validUntil: now - HOUR }), 400); // already over
    assert.equal(await bad({ roomIds: ['room-1'], validFrom: now, validUntil: now + 15 * 24 * HOUR }), 400);  // longer than 14 days
    assert.equal(await bad({ roomIds: ['nope'], validFrom: now, validUntil: now + HOUR }), 400);
    assert.equal(await bad({ roomIds: ['room-1'], validFrom: 'x', validUntil: now + HOUR }), 400);

    const issue = async (roomIds, from, until) => (await (await post('/api/passes', { roomIds, validFrom: from, validUntil: until, actor: '王小明' }, staff)).json()).passes;
    const [active] = await issue(['room-1'], now - MIN, now + HOUR);
    const [future] = await issue(['room-2'], now + HOUR, now + 2 * HOUR);
    assert.equal(active.status, 'active');
    assert.equal(future.status, 'not_started');
    assert.match(active.id, /^[A-Z2-9]{10}$/);
    // an already-ended pass (can only exist from earlier days): insert it directly
    const db = new DatabaseSync(path.join(dir, 'helpdesk.db'));
    db.prepare("INSERT INTO qr_passes (id, room_id, room_name, valid_from, valid_until, created_at) VALUES ('EXPAREDAAA','room-1','場地 1',?,?,?)").run(now - 3 * HOUR, now - HOUR, now - 4 * HOUR);

    // what a customer sees at each stage
    const pub = q => fetch(srv.base + '/api/public?' + q);
    let r = await pub('p=' + active.id);
    assert.equal(r.status, 200);
    let body = await r.json();
    assert.equal(body.rooms[0].id, 'room-1');
    assert.equal(body.pass.validUntil, active.validUntil);
    assert.equal((await pub('p=' + active.id.toLowerCase())).status, 200);          // lower-case typing is fine
    r = await pub('p=' + future.id); body = await r.json();
    assert.deepEqual([r.status, body.code, body.validFrom], [403, 'pass_not_started', future.validFrom]);
    assert.ok(!JSON.stringify(body).includes('場地 2'));                              // does not reveal the room
    r = await pub('p=EXPAREDAAA'); body = await r.json();
    assert.deepEqual([r.status, body.code], [403, 'pass_expired']);
    r = await pub('p=ZZZZZZZZZZ'); assert.equal((await r.json()).code, 'pass_invalid');
    r = await pub('p=short'); assert.equal((await r.json()).code, 'pass_invalid');

    // submitting: through a pass the room comes from the pass, not from the request
    r = await post('/api/requests', { p: active.id, roomId: 'room-2', category: 'sound' });
    assert.equal(r.status, 200);
    assert.equal(db.prepare("SELECT room_id, pass_id FROM requests").get().room_id, 'room-1');
    assert.equal(db.prepare("SELECT pass_id FROM requests").get().pass_id, active.id);
    assert.equal((await post('/api/requests', { p: future.id, category: 'sound' })).status, 403);
    assert.equal((await post('/api/requests', { p: 'EXPAREDAAA', category: 'sound' })).status, 403);

    // listing
    const listed = (await (await fetch(srv.base + '/api/passes', { headers: { Cookie: cookie } })).json()).passes;
    assert.equal(listed.length, 3);
    assert.equal((await fetch(srv.base + '/api/passes')).status, 401);

    // while passes are optional the old room link still works; turning the switch on kills it
    assert.equal((await pub('room=room-1')).status, 200);
    assert.equal((await fetch(srv.base + '/api/qr-mode', { method: 'PATCH', headers: json, body: '{"requirePass":true}' })).status, 401);
    r = await fetch(srv.base + '/api/qr-mode', { method: 'PATCH', headers: staff, body: '{"requirePass":true}' });
    assert.equal((await r.json()).qrRequirePass, true);
    r = await pub('room=room-1'); body = await r.json();
    assert.deepEqual([r.status, body.code], [403, 'pass_required']);
    r = await post('/api/requests', { roomId: 'room-1', category: 'sound' });
    assert.equal(r.status, 403);
    assert.equal((await post('/api/requests', { p: active.id, category: 'sound' })).status, 200); // a valid pass still works

    // revoking
    assert.equal((await fetch(srv.base + '/api/passes/' + active.id, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(srv.base + '/api/passes/' + active.id, { method: 'DELETE', headers: { Cookie: cookie } })).status, 200);
    r = await pub('p=' + active.id); assert.equal((await r.json()).code, 'pass_revoked');
    assert.equal((await post('/api/requests', { p: active.id, category: 'sound' })).status, 403);
    assert.equal((await fetch(srv.base + '/api/passes/' + active.id, { method: 'DELETE', headers: { Cookie: cookie } })).status, 404);

    // switching it back off restores plain room links
    await fetch(srv.base + '/api/qr-mode', { method: 'PATCH', headers: staff, body: '{"requirePass":false}' });
    assert.equal((await pub('room=room-1')).status, 200);
    db.close();
  } finally {
    await stop(srv);
  }
});

test('reports API: staff only, summary, filters, validation, CSV export', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhd-rep-'));
  seedConfig(dir);
  const srv = await startServer(dir);
  try {
    const cookie = await login(srv.base);
    const staff = Object.assign({ Cookie: cookie }, json);
    const H = { Cookie: cookie };
    const get = (p, headers) => fetch(srv.base + p, { headers: headers || H });

    // two requests today (one with a formula-looking note), one accepted and resolved by a named person
    const mk = async (room, note) => (await (await fetch(srv.base + '/api/requests', { method: 'POST', headers: json, body: JSON.stringify({ roomId: room, category: 'sound', note }) })).json()).requests.slice(-1)[0];
    const r1 = await mk('room-1', '=HYPERLINK("http://x")');
    await mk('room-2', '普通備註');
    for (const [st, who] of [['in_progress', '王小明'], ['done', '李小華']]) {
      await fetch(srv.base + '/api/requests/' + r1.id, { method: 'PATCH', headers: staff, body: JSON.stringify({ status: st, actor: who }) });
    }

    // staff only
    for (const p of ['/api/reports/summary', '/api/reports/export.csv?type=requests']) assert.equal((await get(p, {})).status, 401);

    // summary (default range = last 30 days, so today's requests are inside)
    let r = await get('/api/reports/summary');
    assert.equal(r.status, 200);
    let body = await r.json();
    assert.equal(body.summary.total, 2);
    assert.equal(body.summary.done, 1);
    assert.equal(body.summary.pending, 1);
    assert.equal(body.summary.response.count, 1);
    assert.equal(body.summary.byStaff.length, 2);
    assert.deepEqual(body.filters.rooms.map(x => x.id).sort(), ['room-1', 'room-2']);
    assert.equal(body.range.to.length, 10);

    body = await (await get('/api/reports/summary?room=room-2')).json();
    assert.equal(body.summary.total, 1);
    body = await (await get('/api/reports/summary?category=nope')).json();
    assert.equal(body.summary.total, 0);
    body = await (await get('/api/reports/summary?from=2020-01-01&to=2020-01-31')).json();
    assert.equal(body.summary.total, 0);                                   // a past month with no data
    assert.equal(body.summary.byDay.length, 31);

    // bad input
    assert.equal((await get('/api/reports/summary?from=abc')).status, 400);
    assert.equal((await get('/api/reports/summary?from=2026-12-01&to=2026-11-01')).status, 400);
    assert.equal((await get('/api/reports/summary?from=2020-01-01&to=2026-11-26')).status, 400);   // > 366 days
    assert.equal((await get('/api/reports/export.csv?type=hack')).status, 400);

    // CSV: requests
    r = await get('/api/reports/export.csv?type=requests');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv; charset=utf-8/);
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="helpdesk-requests-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"$/);
    let csv = Buffer.from(await r.arrayBuffer()).toString('utf8');
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    const lines = csv.slice(1).trim().split('\r\n');
    assert.equal(lines.length, 3);                                         // header + 2 requests
    assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`));               // formula neutralised
    assert.ok(csv.includes('王小明') && csv.includes('李小華'));
    assert.ok(csv.includes('已完成') && csv.includes('待處理'));

    // CSV: events (+ filter)
    csv = Buffer.from(await (await get('/api/reports/export.csv?type=events')).arrayBuffer()).toString('utf8');
    assert.equal(csv.slice(1).trim().split('\r\n').length, 1 + 4);        // header + 2 created + accepted + resolved
    csv = Buffer.from(await (await get('/api/reports/export.csv?type=events&room=room-2')).arrayBuffer()).toString('utf8');
    assert.equal(csv.slice(1).trim().split('\r\n').length, 2);             // header + the single 'created' of room-2
  } finally {
    await stop(srv);
  }
});

test('venue rooms: the 14 venues are seeded (ids kept), names come from the fixed list, no duplicates, metrics show where help is needed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhd-rooms-'));
  seedConfig(dir);                                     // two placeholder rooms: 場地 1, 場地 2
  const srv = await startServer(dir);
  try {
    const cookie = await login(srv.base);
    const get = async () => (await (await fetch(srv.base + '/api/state', { headers: { Cookie: cookie } })).json());
    let st = await get();
    const names = st.rooms.map(r => r.name);
    assert.equal(st.rooms.length, 14);
    assert.deepEqual(names.slice(0, 3), ['601會議室', '602會議室', '603會議室']);   // placeholders renamed in place
    assert.equal(st.rooms[0].id, 'room-1');                                          // ids (printed QR codes) unchanged
    assert.ok(names.includes('F廳') && names.includes('608會議室'));

    const patch = (id, name) => fetch(srv.base + '/api/rooms/' + id, { method: 'PATCH', headers: Object.assign({ Cookie: cookie }, json), body: JSON.stringify({ name }) });
    assert.equal((await patch('room-1', '605-6')).status, 400);                     // not in the list
    assert.equal((await patch('room-1', '602會議室')).status, 409);                  // already used by another room
    assert.equal((await patch('room-1', '601會議室')).status, 200);                  // same name again is fine
    const add = (name) => fetch(srv.base + '/api/rooms', { method: 'POST', headers: Object.assign({ Cookie: cookie }, json), body: JSON.stringify({ name }) });
    assert.equal((await add('9樓')).status, 400);
    assert.equal((await add('A廳')).status, 409);

    // a customer asks for help in 場地 → the metrics say which venue and which category (no note)
    const room = st.rooms.find(r => r.name === 'B廳');
    const r = await fetch(srv.base + '/api/requests', { method: 'POST', headers: json, body: JSON.stringify({ roomId: room.id, category: 'sound', note: '私人備註' }) });
    assert.equal(r.status, 200);
    const m = await (await fetch(srv.base + '/api/metrics', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
    assert.equal(m.active.length, 1);
    assert.equal(m.active[0].room, 'B廳');
    assert.equal(m.active[0].category, '音響');
    assert.ok(!JSON.stringify(m).includes('私人備註'));
  } finally {
    await stop(srv);
  }
});

'use strict';
 
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
 
const PORT = process.env.PORT || 3000;
// Point RAILWAY_VOLUME_MOUNT_PATH (or DATA_DIR) at a Railway Volume so data
// survives redeploys. Falls back to a local folder for quick local testing.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
// Completed requests that age out of the live dashboard get archived here
// instead of being thrown away, so history stays available for later
// date/category analysis without bloating the live state file.
const ARCHIVE_FILE = path.join(DATA_DIR, 'archive.db');
 
const STATUS_ORDER = ['pending', 'in_progress', 'done'];
const DAY = 86400000;
 
function defaultCategories() {
  return [
    { id: 'sound', label: '音響', icon: 'sound', requireNote: false },
    { id: 'network', label: '網路', icon: 'network', requireNote: false },
    { id: 'clean', label: '清潔', icon: 'clean', requireNote: false },
    { id: 'catering', label: '餐飲', icon: 'catering', requireNote: false },
    { id: 'other', label: '其他', icon: 'other', requireNote: true },
  ];
}
 
function defaultState() {
  const rooms = [];
  for (let i = 1; i <= 12; i++) rooms.push({ id: 'room-' + i, name: '場地 ' + i });
  return {
    venueName: '活動場地',
    rooms,
    requests: [],
    serviceHours: { start: '08:00', end: '23:59' },
    categories: defaultCategories(),
  };
}
 
function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.rooms) && Array.isArray(parsed.requests)) {
      if (!parsed.serviceHours || !parsed.serviceHours.start || !parsed.serviceHours.end) {
        parsed.serviceHours = { start: '08:00', end: '23:59' };
      }
      if (!Array.isArray(parsed.categories) || !parsed.categories.length) {
        parsed.categories = defaultCategories();
      }
      return parsed;
    }
  } catch (e) {
    // no file yet, or corrupt — fall back to defaults
  }
  return defaultState();
}
 
// --- service-hours check (always evaluated in Asia/Taipei time, regardless
// of the server's own timezone, since the venue and its clients are there) ---
function minutesFromHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
 
function taipeiNowMinutes() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());
  let h = parseInt(parts.find(function (p) { return p.type === 'hour'; }).value, 10);
  const min = parseInt(parts.find(function (p) { return p.type === 'minute'; }).value, 10);
  if (h === 24) h = 0;
  return h * 60 + min;
}
 
function isWithinServiceHours() {
  const sh = state.serviceHours || { start: '08:00', end: '23:59' };
  const startM = minutesFromHHMM(sh.start);
  const endM = minutesFromHHMM(sh.end);
  if (startM == null || endM == null) return true;
  const nowM = taipeiNowMinutes();
  if (startM <= endM) return nowM >= startM && nowM <= endM;
  return nowM >= startM || nowM <= endM; // window wraps past midnight
}
 
let state = loadState();
let saveTimer = null;
function persist() {
  // debounce writes slightly in case of rapid successive mutations
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(state), 'utf8');
    } catch (e) {
      console.error('[persist] failed to write state file:', e.message);
    }
  }, 150);
}
 
// --- archive: completed requests that would otherwise be deleted by
// prune() are saved here first, in a small SQLite file on the same
// Volume as state.json (so it survives redeploys too). Kept separate
// from the live JSON state so the dashboard never has to read/write
// archived history — this file is only ever appended to. If SQLite
// fails to initialise for any reason, the app logs it and keeps
// running without archiving (same behaviour as before this feature).
let archiveDb = null;
let archiveInsertStmt = null;
try {
  const Database = require('better-sqlite3');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  archiveDb = new Database(ARCHIVE_FILE);
  archiveDb.pragma('journal_mode = WAL');
  archiveDb.exec(
    'CREATE TABLE IF NOT EXISTS archived_requests (' +
    'id TEXT PRIMARY KEY, ' +
    'room_id TEXT, room_name TEXT, ' +
    'category TEXT, category_label TEXT, category_icon TEXT, ' +
    'note TEXT, status TEXT, ' +
    'created_at INTEGER, updated_at INTEGER, archived_at INTEGER)'
  );
  archiveDb.exec('CREATE INDEX IF NOT EXISTS idx_archived_created_at ON archived_requests(created_at)');
  archiveDb.exec('CREATE INDEX IF NOT EXISTS idx_archived_category ON archived_requests(category)');
  archiveInsertStmt = archiveDb.prepare(
    'INSERT OR REPLACE INTO archived_requests ' +
    '(id, room_id, room_name, category, category_label, category_icon, note, status, created_at, updated_at, archived_at) ' +
    'VALUES (@id, @roomId, @roomName, @category, @categoryLabel, @categoryIcon, @note, @status, @createdAt, @updatedAt, @archivedAt)'
  );
  console.log('[archive] SQLite archive ready: ' + ARCHIVE_FILE);
} catch (e) {
  console.error('[archive] disabled — could not initialise SQLite archive:', e.message);
}
 
function archiveRequests(list) {
  if (!archiveInsertStmt || !list.length) return;
  const archivedAt = Date.now();
  try {
    const insertMany = archiveDb.transaction(function (rows) {
      rows.forEach(function (r) {
        archiveInsertStmt.run({
          id: r.id,
          roomId: r.roomId,
          roomName: r.roomName,
          category: r.category,
          categoryLabel: r.categoryLabel || r.category,
          categoryIcon: r.categoryIcon || 'other',
          note: r.note || '',
          status: r.status,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          archivedAt: archivedAt,
        });
      });
    });
    insertMany(list);
  } catch (e) {
    console.error('[archive] failed to archive ' + list.length + ' request(s):', e.message);
  }
}
 
function prune() {
  const now = Date.now();
  const done = [];
  const others = [];
  state.requests.forEach(function (r) {
    (r.status === 'done' ? done : others).push(r);
  });
  done.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  const keptDone = [];
  const toArchive = [];
  done.forEach(function (r, i) {
    if (i < 150 && (now - r.updatedAt) < 7 * DAY) keptDone.push(r);
    else toArchive.push(r);
  });
  if (toArchive.length) archiveRequests(toArchive);
  state.requests = others.concat(keptDone);
}
 
// --- rate limit for customer help requests (in memory: resets on restart, per instance) ---
function positiveInt(v, fallback) { const n = parseInt(v, 10); return n > 0 ? n : fallback; }
const RATE_WINDOW_MS = positiveInt(process.env.RATE_LIMIT_WINDOW_MIN, 10) * 60 * 1000;
const RATE_ROOM_MAX = positiveInt(process.env.RATE_LIMIT_ROOM_MAX, 5);   // requests per room per window
const RATE_IP_MAX = positiveInt(process.env.RATE_LIMIT_IP_MAX, 30);      // requests per IP per window
const roomHits = new Map();
const ipHits = new Map();

function recentHits(map, key) {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  const list = (map.get(key) || []).filter(function (t) { return t > cutoff; });
  if (list.length) map.set(key, list); else map.delete(key);
  return list;
}
function rateLimitAllows(map, key, max) { return recentHits(map, key).length < max; }
function rateLimitRecord(map, key) {
  const list = recentHits(map, key);
  list.push(Date.now());
  map.set(key, list);
}

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
 
// --- staff authentication -------------------------------------------------
// One shared password (env STAFF_PASSWORD) protects the dashboard and every
// write API except the customer help request. Customers only ever see their
// own room's data (see publicState). If STAFF_PASSWORD is not set, staff
// access is refused (fail closed) instead of silently leaving the site open.
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || '';
const SESSION_COOKIE = 'vhd_staff';
const SESSION_TTL_MS = 7 * DAY;
const SESSION_KEY = crypto.createHash('sha256').update('vhd-session:' + STAFF_PASSWORD).digest();
if (!STAFF_PASSWORD) {
  console.warn('[auth] STAFF_PASSWORD is not set — staff dashboard is locked until it is configured.');
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function passwordMatches(input) {
  if (!STAFF_PASSWORD) return false;
  return crypto.timingSafeEqual(sha256(input), sha256(STAFF_PASSWORD));
}

function signSession(expiry) {
  return crypto.createHmac('sha256', SESSION_KEY).update(String(expiry)).digest('hex');
}

function makeSessionToken() {
  const expiry = Date.now() + SESSION_TTL_MS;
  return expiry + '.' + signSession(expiry);
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function isStaffCookie(cookieHeader) {
  if (!STAFF_PASSWORD) return false;
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const expiry = Number(parts[0]);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
  const expected = Buffer.from(signSession(expiry), 'utf8');
  const given = Buffer.from(parts[1], 'utf8');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function requireStaff(req, res, next) {
  if (!STAFF_PASSWORD) return res.status(503).json({ error: '伺服器尚未設定 STAFF_PASSWORD，儀表板已鎖定' });
  if (!isStaffCookie(req.headers.cookie)) return res.status(401).json({ error: '請先登入' });
  next();
}

// Simple in-memory throttle for failed logins: 10 failures per IP per 15 min.
const loginFails = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) { loginFails.delete(ip); return false; }
  return rec.count >= LOGIN_MAX_FAILS;
}
function recordLoginFail(ip) {
  const rec = loginFails.get(ip);
  if (!rec || Date.now() > rec.resetAt) loginFails.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  else rec.count++;
}

// What a customer scanning a room QR code may see: venue name, categories,
// service hours, and only their own room with that room's requests.
function publicState(roomId) {
  const room = state.rooms.find(function (r) { return r.id === roomId; });
  if (!room) return null;
  return {
    venueName: state.venueName,
    rooms: [{ id: room.id, name: room.name }],
    requests: state.requests.filter(function (r) { return r.roomId === room.id; }),
    serviceHours: state.serviceHours,
    categories: state.categories,
  };
}

const app = express();
app.set('trust proxy', 1); // behind Railway's proxy: correct client IP and https detection
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server); // same-origin only (no CORS)

function broadcast() {
  io.to('staff').emit('state', state);
  state.rooms.forEach(function (r) {
    io.to('room:' + r.id).emit('state', publicState(r.id));
  });
}

io.on('connection', function (socket) {
  const roomId = socket.handshake.query && socket.handshake.query.room;
  if (roomId) {
    const pub = publicState(String(roomId));
    if (!pub) return socket.disconnect(true);
    socket.join('room:' + pub.rooms[0].id);
    return socket.emit('state', pub);
  }
  if (isStaffCookie(socket.handshake.headers.cookie)) {
    socket.join('staff');
    return socket.emit('state', state);
  }
  socket.emit('auth-required');
  socket.disconnect(true);
});

app.post('/api/login', function (req, res) {
  if (!STAFF_PASSWORD) return res.status(503).json({ error: '伺服器尚未設定 STAFF_PASSWORD，儀表板已鎖定' });
  if (loginBlocked(req.ip)) return res.status(429).json({ error: '嘗試次數過多，請 15 分鐘後再試' });
  const pwd = req.body && req.body.password;
  if (typeof pwd !== 'string' || !passwordMatches(pwd)) {
    recordLoginFail(req.ip);
    return res.status(401).json({ error: '密碼錯誤' });
  }
  loginFails.delete(req.ip);
  res.cookie(SESSION_COOKIE, makeSessionToken(), {
    httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge: SESSION_TTL_MS,
  });
  res.json({ ok: true });
});

app.post('/api/logout', function (req, res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// Staff dashboard data.
app.get('/api/state', requireStaff, function (req, res) {
  res.json(state);
});

// Read-only counters for the aggregate dashboard (tnh-hub). Numbers and ages
// only: no request notes, room names or any other content. Requires
// "Authorization: Bearer <METRICS_TOKEN>"; refused entirely if METRICS_TOKEN is
// not set. "Today" is Asia/Taipei.
function metricsAuth(req, res, next) {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) return res.status(503).json({ error: '尚未設定 METRICS_TOKEN' });
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!crypto.timingSafeEqual(sha256(m ? m[1] : ''), sha256(expected))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function taipeiDateStr(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(ts)); // YYYY-MM-DD
}

app.get('/api/metrics', metricsAuth, function (req, res) {
  res.set('Cache-Control', 'no-store');
  const now = Date.now();
  const today = taipeiDateStr(now);
  const reqs = state.requests;
  const unresolved = reqs.filter(function (r) { return r.status !== 'done'; });
  res.json({
    system: 'help-desk',
    now: new Date(now).toISOString(),
    calls_today: reqs.filter(function (r) { return taipeiDateStr(r.createdAt) === today; }).length,
    pending: reqs.filter(function (r) { return r.status === 'pending'; }).length,
    in_progress: reqs.filter(function (r) { return r.status === 'in_progress'; }).length,
    resolved_today: reqs.filter(function (r) { return r.status === 'done' && taipeiDateStr(r.updatedAt) === today; }).length,
    unresolved: unresolved.length,
    // age in seconds of every unresolved request (oldest first), so the hub can apply its own alert threshold
    unresolved_ages_sec: unresolved
      .map(function (r) { return Math.max(0, Math.round((now - r.createdAt) / 1000)); })
      .sort(function (a, b) { return b - a; }),
    service_open: isWithinServiceHours(),
  });
});

// Customer room page data.
app.get('/api/public', function (req, res) {
  const pub = publicState(String(req.query.room || ''));
  if (!pub) return res.status(404).json({ error: '找不到此場地' });
  res.json(pub);
});
 
app.post('/api/requests', function (req, res) {
  const body = req.body || {};
  const room = state.rooms.find(function (r) { return r.id === body.roomId; });
  if (!room) return res.status(400).json({ error: '找不到此場地' });
  if (!isWithinServiceHours()) {
    const sh = state.serviceHours || { start: '08:00', end: '23:59' };
    return res.status(403).json({ error: '目前非服務時段（開放時間 ' + sh.start + '–' + sh.end + '），請於服務時段內送出，或聯絡工作人員' });
  }
  const cat = (state.categories || []).find(function (c) { return c.id === body.category; });
  if (!cat) return res.status(400).json({ error: '問題類別不正確' });
  const note = String(body.note || '').trim().slice(0, 300);
  if (cat.requireNote && !note) return res.status(400).json({ error: '請簡述問題內容' });

  // Anti-flood: this endpoint is public. Limit per room (so one person spamming
  // doesn't affect other rooms) and, more loosely, per IP (guests at a venue often
  // share one Wi-Fi/IP, so the IP cap is much higher than the room cap).
  if (!rateLimitAllows(roomHits, room.id, RATE_ROOM_MAX) || !rateLimitAllows(ipHits, req.ip, RATE_IP_MAX)) {
    return res.status(429).json({ error: '送出太頻繁了，請稍候幾分鐘再試；如有緊急狀況請直接聯絡工作人員' });
  }
  rateLimitRecord(roomHits, room.id);
  rateLimitRecord(ipHits, req.ip);

  const now = Date.now();
  const request = {
    id: uid('req'),
    roomId: room.id,
    roomName: room.name,
    category: cat.id,
    categoryLabel: cat.label,
    categoryIcon: cat.icon,
    note: note,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  state.requests.push(request);
  prune();
  persist();
  broadcast();
  res.json(publicState(room.id)); // customers get only their own room's data back
});

app.patch('/api/requests/:id', requireStaff, function (req, res) {
  const status = req.body && req.body.status;
  if (STATUS_ORDER.indexOf(status) === -1) return res.status(400).json({ error: '狀態不正確' });
  const r = state.requests.find(function (x) { return x.id === req.params.id; });
  if (!r) return res.status(404).json({ error: '找不到此請求' });
  r.status = status;
  r.updatedAt = Date.now();
  prune();
  persist();
  broadcast();
  res.json(state);
});
 
app.post('/api/rooms', requireStaff, function (req, res) {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: '請輸入場地名稱' });
  state.rooms.push({ id: uid('room'), name: name });
  persist();
  broadcast();
  res.json(state);
});
 
app.patch('/api/rooms/:id', requireStaff, function (req, res) {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: '請輸入場地名稱' });
  const room = state.rooms.find(function (r) { return r.id === req.params.id; });
  if (!room) return res.status(404).json({ error: '找不到此場地' });
  room.name = name;
  persist();
  broadcast();
  res.json(state);
});
 
app.delete('/api/rooms/:id', requireStaff, function (req, res) {
  state.rooms = state.rooms.filter(function (r) { return r.id !== req.params.id; });
  persist();
  broadcast();
  res.json(state);
});
 
app.post('/api/categories', requireStaff, function (req, res) {
  const label = String((req.body && req.body.label) || '').trim().slice(0, 20);
  if (!label) return res.status(400).json({ error: '請輸入類別名稱' });
  const icon = String((req.body && req.body.icon) || 'other').slice(0, 30);
  const requireNote = !!(req.body && req.body.requireNote);
  state.categories.push({ id: uid('cat'), label: label, icon: icon, requireNote: requireNote });
  persist();
  broadcast();
  res.json(state);
});
 
app.patch('/api/categories/:id', requireStaff, function (req, res) {
  const cat = state.categories.find(function (c) { return c.id === req.params.id; });
  if (!cat) return res.status(404).json({ error: '找不到此類別' });
  if (req.body && req.body.label !== undefined) {
    const label = String(req.body.label).trim().slice(0, 20);
    if (!label) return res.status(400).json({ error: '請輸入類別名稱' });
    cat.label = label;
  }
  if (req.body && req.body.icon !== undefined) {
    cat.icon = String(req.body.icon).slice(0, 30);
  }
  if (req.body && req.body.requireNote !== undefined) {
    cat.requireNote = !!req.body.requireNote;
  }
  persist();
  broadcast();
  res.json(state);
});
 
app.delete('/api/categories/:id', requireStaff, function (req, res) {
  if (state.categories.length <= 1) return res.status(400).json({ error: '至少需保留一個類別' });
  state.categories = state.categories.filter(function (c) { return c.id !== req.params.id; });
  persist();
  broadcast();
  res.json(state);
});
 
app.patch('/api/venue', requireStaff, function (req, res) {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60) || '活動場地';
  state.venueName = name;
  persist();
  broadcast();
  res.json(state);
});
 
app.patch('/api/service-hours', requireStaff, function (req, res) {
  const start = String((req.body && req.body.start) || '');
  const end = String((req.body && req.body.end) || '');
  if (minutesFromHHMM(start) == null || minutesFromHHMM(end) == null) {
    return res.status(400).json({ error: '時間格式不正確' });
  }
  state.serviceHours = { start: start, end: end };
  persist();
  broadcast();
  res.json(state);
});
 
server.listen(PORT, '0.0.0.0', function () {
  console.log('venue-help-desk listening on port ' + PORT);
  console.log('data file: ' + DATA_FILE);
});
 

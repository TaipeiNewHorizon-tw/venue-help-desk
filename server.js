'use strict';
 
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
 
const PORT = process.env.PORT || 3000;
// Point RAILWAY_VOLUME_MOUNT_PATH (or DATA_DIR) at a Railway Volume so data
// survives redeploys. Falls back to a local folder for quick local testing.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
 
const CATEGORY_IDS = ['sound', 'network', 'clean', 'catering', 'other'];
const STATUS_ORDER = ['pending', 'in_progress', 'done'];
const DAY = 86400000;
 
function defaultState() {
  const rooms = [];
  for (let i = 1; i <= 12; i++) rooms.push({ id: 'room-' + i, name: '場地 ' + i });
  return { venueName: '活動場地', rooms, requests: [], serviceHours: { start: '08:00', end: '23:59' } };
}
 
function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.rooms) && Array.isArray(parsed.requests)) {
      if (!parsed.serviceHours || !parsed.serviceHours.start || !parsed.serviceHours.end) {
        parsed.serviceHours = { start: '08:00', end: '23:59' };
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
 
function prune() {
  const now = Date.now();
  const done = [];
  const others = [];
  state.requests.forEach(function (r) {
    (r.status === 'done' ? done : others).push(r);
  });
  done.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  const keptDone = done.filter(function (r, i) { return i < 150 && (now - r.updatedAt) < 7 * DAY; });
  state.requests = others.concat(keptDone);
}
 
function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
 
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));
 
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
 
function broadcast() {
  io.emit('state', state);
}
 
app.get('/api/state', function (req, res) {
  res.json(state);
});
 
app.post('/api/requests', function (req, res) {
  const body = req.body || {};
  const room = state.rooms.find(function (r) { return r.id === body.roomId; });
  if (!room) return res.status(400).json({ error: '找不到此場地' });
  if (!isWithinServiceHours()) {
    const sh = state.serviceHours || { start: '08:00', end: '23:59' };
    return res.status(403).json({ error: '目前非服務時段（開放時間 ' + sh.start + '–' + sh.end + '），請於服務時段內送出，或聯絡工作人員' });
  }
  if (CATEGORY_IDS.indexOf(body.category) === -1) return res.status(400).json({ error: '問題類別不正確' });
  const note = String(body.note || '').trim().slice(0, 300);
  if (body.category === 'other' && !note) return res.status(400).json({ error: '請簡述問題內容' });
 
  const now = Date.now();
  const request = {
    id: uid('req'),
    roomId: room.id,
    roomName: room.name,
    category: body.category,
    note: note,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  state.requests.push(request);
  prune();
  persist();
  broadcast();
  res.json(state);
});
 
app.patch('/api/requests/:id', function (req, res) {
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
 
app.post('/api/rooms', function (req, res) {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: '請輸入場地名稱' });
  state.rooms.push({ id: uid('room'), name: name });
  persist();
  broadcast();
  res.json(state);
});
 
app.patch('/api/rooms/:id', function (req, res) {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: '請輸入場地名稱' });
  const room = state.rooms.find(function (r) { return r.id === req.params.id; });
  if (!room) return res.status(404).json({ error: '找不到此場地' });
  room.name = name;
  persist();
  broadcast();
  res.json(state);
});
 
app.delete('/api/rooms/:id', function (req, res) {
  state.rooms = state.rooms.filter(function (r) { return r.id !== req.params.id; });
  persist();
  broadcast();
  res.json(state);
});
 
app.patch('/api/venue', function (req, res) {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60) || '活動場地';
  state.venueName = name;
  persist();
  broadcast();
  res.json(state);
});
 
app.patch('/api/service-hours', function (req, res) {
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
 
io.on('connection', function (socket) {
  socket.emit('state', state);
});
 
server.listen(PORT, '0.0.0.0', function () {
  console.log('venue-help-desk listening on port ' + PORT);
  console.log('data file: ' + DATA_FILE);
});
 

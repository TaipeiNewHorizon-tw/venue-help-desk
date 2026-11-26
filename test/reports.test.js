'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../reports');

const MIN = 60000;
const t = (iso) => Date.parse(iso);      // helper: ISO string -> ms
function req(id, createdAt, extra) {
  return Object.assign({
    id, roomId: 'room-1', roomName: '場地 1', category: 'sound', categoryLabel: '音響', note: '', status: 'pending',
    createdAt, updatedAt: createdAt, acceptedAt: null, acceptedBy: null, resolvedAt: null, resolvedBy: null, reopenCount: 0, passId: null,
  }, extra || {});
}
const range = (from, to) => R.parseRange(from, to, t('2026-11-26T04:00:00Z'));

test('median and percentile', () => {
  assert.equal(R.median([]), null);
  assert.equal(R.median([5]), 5);
  assert.equal(R.median([1, 3, 9]), 3);
  assert.equal(R.median([1, 3, 4, 10]), 4);          // (3+4)/2 rounded
  assert.equal(R.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(R.percentile([7], 0.9), 7);
  assert.equal(R.percentile([], 0.9), null);
});

test('parseRange: defaults to the last 30 Taipei days, both ends inclusive, validates input', () => {
  const r = range();
  assert.equal(r.to, '2026-11-26');
  assert.equal(r.from, '2026-10-28');
  assert.equal(r.toMs - r.fromMs, 30 * 86400000);
  const one = range('2026-11-26', '2026-11-26');
  assert.equal(one.fromMs, t('2026-11-25T16:00:00Z'));        // 00:00 Taipei
  assert.equal(one.toMs, t('2026-11-26T16:00:00Z'));          // exclusive end = next midnight
  assert.ok(range('2026/11/26', '2026-11-26').error);
  assert.ok(range('2026-13-40', '2026-11-26').error);
  assert.ok(range('2026-11-27', '2026-11-26').error);          // from after to
  assert.ok(range('2025-01-01', '2026-11-26').error);          // more than 366 days
  assert.equal(range('2026-01-01', '2026-12-31').error, undefined);
});

test('summary: response time uses accept times only and excludes old imported requests', () => {
  const base = t('2026-11-25T02:00:00Z');
  const list = [
    req('a', base, { status: 'done', acceptedAt: base + 2 * MIN, acceptedBy: '甲', resolvedAt: base + 12 * MIN, resolvedBy: '甲' }),
    req('b', base, { status: 'done', acceptedAt: base + 10 * MIN, acceptedBy: '乙', resolvedAt: base + 40 * MIN, resolvedBy: '丙' }),
    req('c', base, { status: 'in_progress', acceptedAt: base + 4 * MIN, acceptedBy: '甲' }),
    req('legacy', base, { status: 'done', resolvedAt: base + 99 * MIN }),     // finished before accepts were recorded
    req('waiting', base, { status: 'pending' }),                               // not accepted yet: not "legacy"
  ];
  const s = R.buildSummary(list, range('2026-11-25', '2026-11-26'));
  assert.equal(s.total, 5);
  assert.equal(s.done, 3);
  assert.equal(s.inProgress, 1);
  assert.equal(s.pending, 1);
  assert.equal(s.withoutAcceptTime, 1);                          // only 'legacy'
  assert.deepEqual([s.response.count, s.response.medianSec, s.response.p90Sec], [3, 240, 600]);  // 120, 240, 600 s
  assert.equal(s.response.withinTarget, 2);                      // <= 300 s
  assert.equal(s.response.withinTargetPct, 66.7);
  assert.equal(s.handling.count, 2);                              // a: 600 s, b: 1800 s
  assert.equal(s.handling.medianSec, 1200);
  assert.equal(s.totalTime.count, 3);                             // includes the legacy one: created -> resolved
  const names = s.byStaff.map(p => p.name + ':' + p.accepted + '/' + p.resolved);
  assert.deepEqual(names.sort(), ['丙:0/1', '乙:1/0', '甲:2/1'].sort());
});

test('summary: hour, weekday and day buckets are in Taipei time', () => {
  // 2026-11-25 16:30 UTC = 2026-11-26 00:30 Taipei (a Thursday); 2026-11-25 15:59 UTC = 2026-11-25 23:59 Taipei (Wednesday)
  const list = [req('x', t('2026-11-25T16:30:00Z')), req('y', t('2026-11-25T15:59:00Z')), req('z', t('2026-11-25T16:10:00Z'))];
  const s = R.buildSummary(list, range('2026-11-24', '2026-11-27'));
  assert.equal(s.byHour[0], 2);
  assert.equal(s.byHour[23], 1);
  assert.equal(s.byWeekday[4], 2);                                // Thursday
  assert.equal(s.byWeekday[3], 1);                                // Wednesday
  assert.deepEqual(s.byDay.map(d => d.date + ':' + d.count), ['2026-11-24:0', '2026-11-25:1', '2026-11-26:2', '2026-11-27:0']);
});

test('summary: categories and rooms are grouped, sorted by volume, newest name wins', () => {
  const base = t('2026-11-25T02:00:00Z');
  const list = [
    req('1', base, { category: 'net', categoryLabel: '網路', roomId: 'r2', roomName: '舊名', acceptedAt: base + MIN }),
    req('2', base + 5 * MIN, { category: 'net', categoryLabel: '網路', roomId: 'r2', roomName: '新名', acceptedAt: base + 8 * MIN }),
    req('3', base + 6 * MIN, { category: 'sound', categoryLabel: '音響' }),
    req('4', base + 7 * MIN, { category: 'net', categoryLabel: '網路', roomId: 'r3', roomName: '場地 3' }),
  ];
  const s = R.buildSummary(list, range('2026-11-25', '2026-11-25'));
  assert.deepEqual(s.byCategory.map(c => c.id + ':' + c.count), ['net:3', 'sound:1']);
  assert.equal(s.byCategory[0].medianWaitSec, 120);               // 60 s and 180 s
  assert.equal(s.byRoom.find(r => r.id === 'r2').label, '新名');
});

test('summary of nothing is empty but well-formed', () => {
  const s = R.buildSummary([], range('2026-11-25', '2026-11-26'));
  assert.equal(s.total, 0);
  assert.equal(s.response.medianSec, null);
  assert.equal(s.response.withinTargetPct, null);
  assert.deepEqual(s.byHour, new Array(24).fill(0));
  assert.equal(s.byDay.length, 2);
  assert.deepEqual(s.byCategory, []);
});

test('csv: BOM, CRLF, quoting, empty cells and formula-injection protection', () => {
  const csv = R.toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['line1\nline2', null], ['=1+1', '+SUM(A1)'], ['-5', '@cmd'], [-5, 7]]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.ok(csv.includes('\r\n'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'a,b');
  assert.equal(lines[1], '"x,y","say ""hi"""');
  assert.equal(lines[2], '"line1\nline2",');
  assert.equal(lines[3], "'=1+1,'+SUM(A1)");                      // would otherwise run as a formula in Excel
  assert.equal(lines[4], "'-5,'@cmd");                             // text that looks like a formula is neutralised...
  assert.equal(lines[5], '-5,7');                                  // ...real negative numbers are untouched
});

test('requests csv: one column per header, times in Taipei, durations filled only when known', () => {
  const base = t('2026-11-25T02:00:00Z');
  const done = req('r1', base, { note: '=HYPERLINK("x")', status: 'done', acceptedAt: base + 2 * MIN, acceptedBy: '王小明', resolvedAt: base + 12 * MIN, resolvedBy: '李小華', passId: 'ABCDEFGHJK' });
  const legacy = req('r2', base, { status: 'done', resolvedAt: base + 30 * MIN });
  const open = req('r3', base);
  const csv = R.requestsCsv([done, legacy, open]);
  const lines = csv.slice(1).trim().split('\r\n');
  const cols = line => { let n = 1, q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) n++; } return n; };   // columns, counting a trailing empty one
  assert.equal(lines.length, 4);
  assert.match(lines[1], /2026-11-25 10:00:00/);                    // 02:00 UTC = 10:00 Taipei
  assert.match(lines[1], /,120,600,720,ABCDEFGHJK,$/);          // last column = resolution note (empty here)
  assert.ok(lines[1].includes(`"'=HYPERLINK(""x"")"`));
  assert.match(lines[2], /,0,,,1800,,$/);                             // legacy: no accept time -> blank wait/handling, total known
  assert.match(lines[3], /,0,,,,,$/);                                 // still open: nothing to measure
  assert.equal(cols(lines[1]), cols(lines[0]));
});

test('events csv translates event and status names', () => {
  const csv = R.eventsCsv([{ id: 1, request_id: 'r1', at: t('2026-11-25T02:00:00Z'), type: 'accepted', actor: '王小明', from_status: 'pending', to_status: 'in_progress', room_name: '場地 1', category_label: '音響' }]);
  assert.match(csv, /1,r1,2026-11-25 10:00:00,接單,王小明,待處理,處理中,場地 1,音響/);
});

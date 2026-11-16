// End-to-end test: real Chromium + the BlindReplay extension + Dhan's real TradingView
// library (fetched live from tv.dhan.co, never stored) + a fake datafeed that also pushes
// "live" sentinel prices (99999) which must never appear on a replayed chart.
//
//   cd test/e2e && npm install && xvfb-run -a node e2e.mjs      (Linux)
//   cd test/e2e && npm install && node e2e.mjs                  (macOS/Windows)
//   SITE=scalper node e2e.mjs   runs the same checks as scalper.dhan.co: library v30
//   from scalper.dhan.co, chart not fullscreen, widget not published on window.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../../extension');
const SITE = process.env.SITE === 'scalper' ? 'scalper' : 'tv';
const ORIGIN = SITE === 'scalper' ? 'https://scalper.dhan.co' : 'https://tv.dhan.co';
const OUT = process.env.OUT || path.join(os.tmpdir(), 'blindreplay-e2e' + (SITE === 'tv' ? '' : '-' + SITE));
fs.mkdirSync(OUT, { recursive: true });
const MIN = 60000, DAY = 86400000, IST = 330 * MIN;

function lastSessionStart() {
  let d = Math.floor((Date.now() + IST) / DAY) * DAY - IST; // IST midnight (UTC ms)
  if (Date.now() < d + (9 * 60 + 40) * MIN) d -= DAY;
  for (;;) {
    const dow = new Date(d + IST).getUTCDay();
    if (dow !== 0 && dow !== 6) break;
    d -= DAY;
  }
  return d;
}
function prevSession(d) {
  d -= DAY;
  for (;;) {
    const dow = new Date(d + IST).getUTCDay();
    if (dow !== 0 && dow !== 6) return d;
    d -= DAY;
  }
}
const day = lastSessionStart();
const start = day + (9 * 60 + 15) * MIN;
const prevClose = prevSession(day) + (15 * 60 + 29) * MIN;
const iso = (t) => new Date(t + IST).toISOString().slice(0, 16) + ' IST';

let failures = 0;
function check(name, ok, info) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? '  ' + JSON.stringify(info) : ''}`);
  if (!ok) failures++;
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blindreplay-profile-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  headless: false,
  viewport: { width: 1500, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
});
await ctx.route('**/*', async (route) => {
  const url = route.request().url();
  if (url === ORIGIN + '/' || url === ORIGIN + '/index.html') {
    return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(HERE, SITE === 'tv' ? 'index.html' : 'index-scalper.html'), 'utf8') });
  }
  if (url.endsWith('/dhan/dist/fake-feed.js') || url.endsWith('/chunk-FAKEFEED.js')) {
    return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(HERE, 'fake-feed.js'), 'utf8') });
  }
  if (url.startsWith(ORIGIN + '/charting_library')) return route.continue();
  if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('chrome-extension:')) return route.continue();
  return route.abort();
});

const page = ctx.pages()[0] || (await ctx.newPage());
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || /BlindReplay/.test(m.text())) consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
await page.goto(ORIGIN + '/');
await page.waitForFunction(() => window.__blindReplayDebug && window.__blindReplayDebug.state().ready, null, { timeout: 90000 });
await page.waitForTimeout(2500);
check('extension attached to widget and patched datafeed', await page.evaluate(() => window.__blindReplayDebug.state().patched));
if (SITE === 'scalper') check('scalper: widget was found without window.dhan_tvWidget', await page.evaluate(() => window.dhan_tvWidget === undefined));

// ---- Panel layout: grows to fit wider controls (macOS fonts) instead of overflowing ----
for (const minW of [0, 240]) {
  const L = await page.evaluate((m) => window.__blindReplayDebug.panelLayout(m), minW);
  check(`panel: every control inside the panel border (date field ${minW || 'default'})`, L && L.maxChildRight <= L.wrapRight - 0.5 && L.bodyScroll <= L.bodyClient && L.wrapRight <= 1500, L);
}
await page.screenshot({ path: `${OUT}/panel-wide.png`, clip: { x: 1000, y: 0, width: 500, height: 560 } });
await page.reload();
await page.waitForFunction(() => window.__blindReplayDebug && window.__blindReplayDebug.state().ready, null, { timeout: 90000 });
await page.waitForTimeout(2500);

// Is the point covered by a BlindReplay strip (outside the chart frame)?
const outsideCovered = (x, y) => page.evaluate(([x, y]) => {
  const el = document.elementFromPoint(x, y);
  return !!(el && el.closest('.blindreplay-outside'));
}, [x, y]);
const outsideStrips = () => page.evaluate(() => [...document.querySelectorAll('.blindreplay-outside')].filter((e) => getComputedStyle(e).display !== 'none').length);

const exportChart = (i) =>
  page.evaluate(async (i) => {
    const r = await window.__testWidget.chart(i).exportData({ includeTime: true, includeSeries: true, includedStudies: [] });
    const rows = r.data.map((row) => Array.from(row));
    return { schema: r.schema.map((s) => s.type + ':' + (s.sourceType || '') + ':' + (s.plotTitle || '')), first: rows[0], last: rows[rows.length - 1], n: rows.length, hasLive: rows.some((row) => row.slice(1, 5).includes(99999)), maxTime: Math.max(...rows.map((x) => x[0])) };
  }, i);

const live = await exportChart(0);
check('before replay: chart shows live data (sentinel arrives)', live.n > 100, { n: live.n, last: live.last && iso(live.last[0] * 1000) });
await page.screenshot({ path: `${OUT}/0-live.png` });

const viewBefore = await page.evaluate(() => {
  const ts = window.__testWidget.chart(0).getTimeScale();
  ts.setBarSpacing(9);
  ts.setRightOffset(4);
  return { b: ts.barSpacing(), r: ts.rightOffset() };
});

// ---- Start replay at last session 09:15 ----
await page.evaluate((t) => window.__blindReplayDebug.start(t), start);
await page.waitForTimeout(3500);
let d = await exportChart(0);
check('start: last visible candle is the previous session close', d.last && d.last[0] * 1000 === prevClose, { last: d.last && iso(d.last[0] * 1000), expected: iso(prevClose) });
check('start: nothing at/after the start time', d.maxTime * 1000 < start);
check('start: no live sentinel', !d.hasLive);
await page.screenshot({ path: `${OUT}/1-start.png` });

for (let i = 0; i < 5; i++) await page.evaluate(() => window.__blindReplayDebug.step(1));
await page.waitForTimeout(2000); // live ticks fire every 700ms; they must stay hidden
d = await exportChart(0);
check('step x5: last candle 09:19', d.last && d.last[0] * 1000 === start + 4 * MIN, { last: d.last && iso(d.last[0] * 1000) });
check('step x5: no live sentinel after live ticks', !d.hasLive);
const cover = await page.evaluate(() => {
  const doc = window.__testWidget._iFrame.contentDocument;
  const c = doc.querySelector('.blindreplay-cover');
  const pane = doc.querySelector('.chart-markup-table.pane');
  if (!c || !pane) return null;
  const cr = c.getBoundingClientRect(), pr = pane.getBoundingClientRect();
  return { display: getComputedStyle(c).display, bg: getComputedStyle(c).backgroundColor, coverLeftPct: (cr.left - pr.left) / pr.width, coverRight: cr.right, paneRight: pr.right, h: cr.height, ph: pr.height };
});
check('cover: opaque black, starts near the 75% anchor, reaches pane right edge', cover && cover.display === 'block' && cover.bg === 'rgb(0, 0, 0)' && Math.abs(cover.coverLeftPct - 0.75) < 0.03 && Math.abs(cover.coverRight - cover.paneRight) < 2, cover);
await page.screenshot({ path: `${OUT}/2-step5.png` });

await page.evaluate(() => window.__blindReplayDebug.step(-2));
await page.waitForTimeout(2500);
d = await exportChart(0);
check('step back x2: last candle 09:17', d.last && d.last[0] * 1000 === start + 2 * MIN, { last: d.last && iso(d.last[0] * 1000) });
check('step back: no live sentinel', !d.hasLive);

// Jump
await page.evaluate(() => window.__blindReplayDebug.step(10));
await page.waitForTimeout(1200);
d = await exportChart(0);
check('jump +10: last candle 09:27', d.last && d.last[0] * 1000 === start + 12 * MIN, { last: d.last && iso(d.last[0] * 1000) });

// Keyboard shortcut inside the chart iframe
await page.mouse.click(500, 400);
await page.keyboard.press('Alt+ArrowRight');
await page.waitForTimeout(1000);
d = await exportChart(0);
check('Alt+→ in chart: last candle 09:28', d.last && d.last[0] * 1000 === start + 13 * MIN, { last: d.last && iso(d.last[0] * 1000) });
// Shift + arrows are Dhan's order hotkeys on scalper.dhan.co: never used or swallowed.
const orderKeysBefore = await page.evaluate(() => window.__orderKeys || 0);
await page.keyboard.press('Shift+ArrowRight');
await page.waitForTimeout(800);
d = await exportChart(0);
check('Shift+→ is left alone: no replay step', d.last && d.last[0] * 1000 === start + 13 * MIN, { last: d.last && iso(d.last[0] * 1000) });
if (SITE === 'scalper') check('Shift+→ still reaches the page (order hotkey not blocked)', (await page.evaluate(() => window.__orderKeys)) === orderKeysBefore + 1);
if (SITE === 'scalper') {
  await page.evaluate(() => window.__blindReplayDebug.focusPanelField());
  await page.keyboard.press('Shift+ArrowUp');
  await page.waitForTimeout(300);
  check('Shift+↑ typed in a panel field does not reach the page', (await page.evaluate(() => window.__orderKeys)) === orderKeysBefore + 1);
  await page.mouse.click(500, 400);
}

// Zoom while running keeps the anchor
await page.evaluate(() => {
  const ts = window.__testWidget.chart(0).getTimeScale();
  ts.setBarSpacing(ts.barSpacing() * 1.6);
});
await page.waitForTimeout(800);
const anchorAfterZoom = await page.evaluate(() => {
  const ts = window.__testWidget.chart(0).getTimeScale();
  const lastX = ts.width() - (ts.rightOffset() + 0.5) * ts.barSpacing();
  return lastX / ts.width();
});
check('zoom: latest candle stays at ~75%', Math.abs(anchorAfterZoom - 0.75) < 0.03, anchorAfterZoom);

// ---- Two charts: 1m + 5m, synced ----
await page.evaluate(() => window.__testWidget.setLayout('2h'));
await page.waitForTimeout(2500);
await page.evaluate(() => new Promise((res) => window.__testWidget.chart(1).setResolution('5', { dataReady: res })));
await page.waitForTimeout(2500);
await page.evaluate(() => window.__testWidget.setActiveChart(0));
await page.evaluate((t) => window.__blindReplayDebug.start(t), start);
await page.waitForTimeout(4000);
for (let i = 0; i < 7; i++) await page.evaluate(() => window.__blindReplayDebug.step(1));
await page.waitForTimeout(2000);
const a = await exportChart(0);
const b = await exportChart(1);
check('sync 1m: last 09:21', a.last && a.last[0] * 1000 === start + 6 * MIN, { last: a.last && iso(a.last[0] * 1000) });
check('sync 5m: last bar is the forming 09:20 candle', b.last && b.last[0] * 1000 === start + 5 * MIN, { last: b.last && iso(b.last[0] * 1000) });
check('sync 5m: forming candle close = latest 1m close (no future)', b.last && a.last && Math.abs(b.last[4] - a.last[4]) < 1e-6, { c5: b.last && b.last[4], c1: a.last && a.last[4] });
check('sync: no live sentinel in either chart', !a.hasLive && !b.hasLive);
await page.screenshot({ path: `${OUT}/3-sync.png` });

// ---- Independent mode ----
await page.evaluate(() => window.__blindReplayDebug.setMode('independent'));
await page.waitForTimeout(3000);
await page.evaluate(() => window.__testWidget.setActiveChart(1));
await page.evaluate(() => window.__blindReplayDebug.step(2));
await page.waitForTimeout(2500);
const a2 = await exportChart(0);
const b2 = await exportChart(1);
check('independent: stepping the 5m chart leaves the 1m chart alone', a2.last && a2.last[0] === a.last[0], { a: a2.last && iso(a2.last[0] * 1000) });
check('independent: 5m advanced (09:25 complete, 09:30 hidden)', b2.last && b2.last[0] * 1000 >= start + 10 * MIN, { b: b2.last && iso(b2.last[0] * 1000) });
await page.screenshot({ path: `${OUT}/4-independent.png` });
await page.evaluate(() => window.__blindReplayDebug.setMode('sync'));

// ---- Masks ----
const masks = await page.evaluate(() => {
  const doc = window.__testWidget._iFrame.contentDocument;
  const right = doc.querySelector('.layout__area--right');
  return { htmlClass: doc.documentElement.classList.contains('blindreplay-mask'), rightAfter: right ? getComputedStyle(right, '::after').backgroundColor : null, rightW: right ? right.getBoundingClientRect().width : 0 };
});
check('masks: live-price side panel covered', masks.htmlClass && (masks.rightW === 0 || masks.rightAfter === 'rgb(0, 0, 0)'), masks);
if (SITE === 'scalper') {
  check('masks: page header and side panel around the chart covered', (await outsideCovered(300, 20)) && (await outsideCovered(1470, 700)) && !(await outsideCovered(500, 400)));
} else {
  check('masks: nothing covered outside a fullscreen chart', (await outsideStrips()) === 0);
}

// ---- Stop: restore ----
await page.evaluate(() => window.__blindReplayDebug.stop());
await page.waitForTimeout(4000);
const r0 = await exportChart(0);
check('stop: live data back (sentinel visible again)', r0.hasLive || r0.maxTime * 1000 > start + 60 * MIN, { last: r0.last && iso(r0.last[0] * 1000) });
const viewAfter = await page.evaluate(() => {
  const ts = window.__testWidget.chart(0).getTimeScale();
  return { b: ts.barSpacing(), r: ts.rightOffset() };
});
check('stop: zoom and scroll position restored', Math.abs(viewAfter.b - viewBefore.b) < 0.01 && Math.abs(viewAfter.r - viewBefore.r) < 0.01, { viewBefore, viewAfter });
const coverGone = await page.evaluate(() => [...window.__testWidget._iFrame.contentDocument.querySelectorAll('.blindreplay-cover')].every((c) => getComputedStyle(c).display === 'none'));
check('stop: covers hidden', coverGone);
check('stop: page around the chart uncovered', (await outsideStrips()) === 0);
await page.screenshot({ path: `${OUT}/5-stopped.png` });

// ---- Pick mode ----
await page.evaluate(() => window.__testWidget.setLayout('s'));
await page.waitForTimeout(2000);
await page.evaluate(() => window.__blindReplayDebug.pick());
await page.mouse.move(700, 400);
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/6-pick-hover.png` });
const pickCover = await page.evaluate(() => {
  const doc = window.__testWidget._iFrame.contentDocument;
  const c = doc.querySelector('.blindreplay-cover');
  const axis = [...doc.querySelectorAll('.chart-markup-table.price-axis-container')].map((a) => a.getBoundingClientRect()).filter((r) => r.width > 0).sort((a, b) => b.left - a.left)[0];
  const r = c.getBoundingClientRect();
  return { coverRight: r.right, axisRight: axis && axis.right, left: r.left, masked: doc.documentElement.classList.contains('blindreplay-mask') };
});
check('pick: cover starts at cursor and hides the price axis too; panels masked', Math.abs(pickCover.left - 700) < 3 && pickCover.coverRight >= pickCover.axisRight - 1 && pickCover.masked, pickCover);
await page.mouse.click(700, 400);
await page.waitForTimeout(3500);
const st = await page.evaluate(() => window.__blindReplayDebug.state());
check('pick: clicking a candle starts the replay', st.active && st.clock != null, { clock: st.clock && iso(st.clock) });
const p = await exportChart(0);
check('pick: nothing at/after the picked candle', p.maxTime * 1000 < st.clock && !p.hasLive);
await page.screenshot({ path: `${OUT}/7-picked.png` });
await page.evaluate(() => window.__blindReplayDebug.stop());

// ---- Replay switched off and on quickly: never live candles while active ----
{
  const bad = [];
  for (let i = 0; i < 12; i++) {
    await page.evaluate((t) => { window.__blindReplayDebug.stop(); window.__blindReplayDebug.start(t); }, start);
    await page.waitForTimeout(i % 3 === 0 ? 0 : 150 * i);
  }
  await page.waitForTimeout(3500);
  const s1 = await page.evaluate(() => window.__blindReplayDebug.state());
  const e1 = await exportChart(0);
  if (!s1.active || e1.maxTime * 1000 >= start || e1.hasLive) bad.push({ active: s1.active, msg: s1.message, last: e1.last && iso(e1.last[0] * 1000) });
  check('quick off/on x12: replay active and nothing at/after start', bad.length === 0, bad);
  await page.evaluate(() => window.__blindReplayDebug.stop());
  await page.waitForTimeout(2500);
}

// ---- Multi-day 1m replay from ~15 days back (chunked history loading) ----
let far = day - 15 * DAY;
while ([0, 6].includes(new Date(far + IST).getUTCDay())) far -= DAY;
const farStart = far + (9 * 60 + 15) * MIN;
const reqBefore = await page.evaluate(() => window.__feedLog.length);
await page.evaluate((t) => window.__blindReplayDebug.start(t), farStart);
await page.waitForTimeout(5000);
let f = await exportChart(0);
check('15 days back: nothing at/after start', f.maxTime * 1000 < farStart && f.n > 50, { last: f.last && iso(f.last[0] * 1000), n: f.n, state: await page.evaluate(() => window.__blindReplayDebug.state()) });
await page.evaluate(() => window.__blindReplayDebug.step(400)); // past the first day's close
await page.waitForTimeout(1500);
f = await exportChart(0);
const nextDay = (() => { let d2 = far + DAY; while ([0, 6].includes(new Date(d2 + IST).getUTCDay())) d2 += DAY; return d2; })();
check('15 days back: stepping 400 x 1m crosses into the next session', f.last && f.last[0] * 1000 === nextDay + (9 * 60 + 15 + 24) * MIN, { last: f.last && iso(f.last[0] * 1000) });
const chunkReqs = await page.evaluate((n) => window.__feedLog.slice(n).filter((r) => r.res === '1'), reqBefore);
check('15 days back: history loaded in <= 8-day requests', chunkReqs.length >= 2 && chunkReqs.every((r) => r.to - r.from <= 8 * 86400 + 60), chunkReqs.map((r) => ((r.to - r.from) / 86400).toFixed(1) + 'd' + (r.first ? '*' : '')));
await page.evaluate(() => window.__blindReplayDebug.stop());
await page.waitForTimeout(2500);

// ---- Teardown (what happens when the extension is disabled with the tab open) ----
await page.evaluate((t) => window.__blindReplayDebug.start(t), start);
await page.waitForTimeout(3000);
await page.evaluate(() => document.dispatchEvent(new CustomEvent('blindreplay:to-page', { detail: JSON.stringify({ type: 'teardown' }) })));
await page.waitForTimeout(4000);
const td = await page.evaluate(() => {
  const df = window.__testWidget._options.datafeed;
  const doc = window.__testWidget._iFrame.contentDocument;
  return {
    unpatched: !Object.prototype.hasOwnProperty.call(df, 'getBars'),
    panel: !!document.getElementById('blindreplay-panel-host'),
    covers: doc.querySelectorAll('.blindreplay-cover').length,
    style: !!doc.getElementById('blindreplay-style'),
    mask: doc.documentElement.classList.contains('blindreplay-mask'),
    trap: !!(Object.getOwnPropertyDescriptor(window, 'dhan_tvWidget') || {}).get,
    strips: document.querySelectorAll('.blindreplay-outside').length,
  };
});
check('teardown: datafeed, widget global, panel, covers and styles all restored', td.unpatched && !td.panel && td.covers === 0 && !td.style && !td.mask && !td.trap && td.strips === 0, td);
const t0 = await exportChart(0);
check('teardown: chart back to live data', t0.maxTime * 1000 > start + 60 * MIN, { last: t0.last && iso(t0.last[0] * 1000) });

// ---- Toolbar button toggles the panel (via the extension service worker) ----
{
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
  const clickIcon = () => sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' });
  });
  // Re-attach after the teardown test: reload gives a fresh extension instance.
  await page.reload();
  await page.waitForFunction(() => window.__blindReplayDebug && window.__blindReplayDebug.state().ready, null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  // The panel lives in a closed shadow root, so compare screenshots of its corner.
  const shot = async () => (await page.screenshot({ clip: { x: 1100, y: 40, width: 400, height: 80 } })).length;
  const before = await shot();
  if (sw) await clickIcon();
  await page.waitForTimeout(500);
  const hiddenSize = await shot();
  if (sw) await clickIcon();
  await page.waitForTimeout(500);
  const after = await shot();
  check('toolbar button hides and shows the panel', !!sw && hiddenSize !== before && Math.abs(after - before) < before * 0.05, { sw: !!sw, before, hiddenSize, after });
}

// ---- "Start blind when the page loads" ----
await page.evaluate(() => document.dispatchEvent(new CustomEvent('blindreplay:to-ext', { detail: JSON.stringify({ type: 'save', settings: { autoStart: true, start: '2026-01-01T09:15' } }) })));
await page.waitForTimeout(800);
await page.reload();
await page.waitForFunction(() => window.__blindReplayDebug && window.__blindReplayDebug.state().ready, null, { timeout: 90000 });
await page.waitForTimeout(4000);
const auto = await page.evaluate(() => window.__blindReplayDebug.state());
const ad = await exportChart(0);
check('auto-start: replay active right after load, at the latest session 09:15', auto.active && auto.clock === start, { clock: auto.clock && iso(auto.clock) });
check('auto-start: chart never received the live day (gated from the first request)', !auto.servedLive && ad.maxTime * 1000 < start && !ad.hasLive, { last: ad.last && iso(ad.last[0] * 1000) });
await page.screenshot({ path: `${OUT}/8-autostart.png` });

console.log('feed requests:', JSON.stringify((await page.evaluate(() => window.__feedLog.length))));
if (consoleErrors.length) console.log('console:', consoleErrors.slice(0, 10).join('\n'));
await ctx.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

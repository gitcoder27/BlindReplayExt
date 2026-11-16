'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, normRes, resDurMs, parseSession, MIN, IST_OFFSET } = require('../extension/src/engine.js');

// 2026-11-16 in IST, as UTC ms.
const D16 = Date.UTC(2026, 10, 16) - IST_OFFSET;
const D17 = D16 + 24 * 60 * MIN;
const at = (day, hh, mm) => day + (hh * 60 + mm) * MIN;
const si = (ticker) => ({ ticker, name: ticker, full_name: 'NSE:' + ticker, session: '0915-1530', timezone: 'Asia/Kolkata' });

function minuteBars(day, fromHHMM, toHHMM, step = 1, base = 100) {
  const out = [];
  for (let m = fromHHMM; m <= toHHMM; m += step) {
    const t = at(day, Math.floor(m / 60), m % 60);
    const i = out.length;
    out.push({ time: t, open: base + i, high: base + i + 2, low: base + i - 1, close: base + i + 1, volume: 10 });
  }
  return out;
}

function addSeries(e, ticker, res, bars, live = true) {
  const S = e.seriesFor(si(ticker), res);
  S.merge(bars);
  if (live) S.subs.set(ticker + res, { onTick() {}, onReset() {} });
  return S;
}

test('resolution helpers', () => {
  assert.equal(normRes('D'), '1D');
  assert.equal(normRes('1d'), '1D');
  assert.equal(normRes('5'), '5');
  assert.equal(resDurMs('15'), 15 * MIN);
  assert.equal(resDurMs('1T'), null);
  assert.deepEqual(parseSession('0915-1530:23456'), { start: 555, end: 930 });
  assert.equal(parseSession('1800-0500'), null);
});

test('single series: start hides the start candle, step reveals one at a time', () => {
  const e = new Engine();
  const S = addSeries(e, 'NIFTY', '1', [...minuteBars(D16 - 24 * 60 * MIN, 9 * 60 + 15, 15 * 60 + 29), ...minuteBars(D16, 9 * 60 + 15, 9 * 60 + 40)]);
  e.setStart(at(D16, 9, 15));
  let v = e.visibleBars(S);
  assert.equal(v[v.length - 1].time, at(D16 - 24 * 60 * MIN, 15, 29), 'previous day close is last visible');
  assert.ok(e.step(1, 1, S.key).changed);
  v = e.visibleBars(S);
  assert.equal(v[v.length - 1].time, at(D16, 9, 15));
  e.step(5, 1, S.key);
  assert.equal(e.lastVisibleTime(S), at(D16, 9, 20));
  e.step(2, -1, S.key);
  assert.equal(e.lastVisibleTime(S), at(D16, 9, 18));
  // nothing at or after the clock is ever visible
  assert.ok(e.visibleBars(S).every((b) => b.time < e.clock));
});

test('end of data stops stepping', () => {
  const e = new Engine();
  const S = addSeries(e, 'X', '1', minuteBars(D16, 9 * 60 + 15, 9 * 60 + 17));
  e.setStart(at(D16, 9, 15));
  const r = e.step(10, 1, S.key);
  assert.equal(r.moved, 3);
  assert.equal(e.step(1, 1, S.key).changed, false);
});

test('sync: 5m shows only completed candles, or a forming candle rebuilt from 1m', () => {
  const e = new Engine();
  const one = addSeries(e, 'NIFTY', '1', minuteBars(D16, 9 * 60 + 15, 10 * 60));
  const fiveBars = [];
  for (let m = 9 * 60 + 15; m <= 10 * 60; m += 5) {
    const slice = one.bars.filter((b) => b.time >= at(D16, 0, m) && b.time < at(D16, 0, m + 5));
    fiveBars.push({ time: at(D16, 0, m), open: slice[0].open, high: Math.max(...slice.map((b) => b.high)), low: Math.min(...slice.map((b) => b.low)), close: slice[slice.length - 1].close, volume: 50 });
  }
  const five = addSeries(e, 'NIFTY', '5', fiveBars);
  e.setStart(at(D16, 9, 15));
  e.step(7, 1, one.key); // revealed 09:15..09:21, clock 09:22
  assert.equal(e.clock, at(D16, 9, 22));
  const v5 = e.visibleBars(five);
  assert.equal(v5.length, 2);
  assert.equal(v5[0].time, at(D16, 9, 15));
  assert.equal(v5[0].close, fiveBars[0].close, 'completed 09:15 bar is the real one');
  const forming = v5[1];
  assert.equal(forming.time, at(D16, 9, 20));
  assert.ok(forming.synthetic);
  assert.equal(forming.close, one.bars[6].close, 'forming close = last revealed 1m close');
  assert.ok(forming.high <= fiveBars[1].high);
  assert.equal(forming.volume, 20);

  // Without a 1m series for this symbol the forming candle stays hidden.
  const e2 = new Engine();
  const one2 = addSeries(e2, 'BANK', '1', minuteBars(D16, 9 * 60 + 15, 10 * 60));
  const five2 = addSeries(e2, 'NIFTY', '5', fiveBars);
  e2.setStart(at(D16, 9, 15));
  e2.step(7, 1, one2.key);
  assert.equal(e2.visibleBars(five2).length, 1);
});

test('hourly last bar of the day completes at session close', () => {
  const e = new Engine();
  const one = addSeries(e, 'A', '1', minuteBars(D16, 9 * 60 + 15, 15 * 60 + 29));
  const hourly = addSeries(e, 'B', '60', [9 * 60 + 15, 10 * 60 + 15, 11 * 60 + 15, 12 * 60 + 15, 13 * 60 + 15, 14 * 60 + 15, 15 * 60 + 15].map((m, i) => ({ time: at(D16, 0, m), open: i, high: i, low: i, close: i })));
  e.setStart(at(D16, 9, 15));
  e.step(10000, 1, one.key);
  assert.equal(e.clock, at(D16, 15, 30));
  assert.equal(e.visibleBars(hourly).length, 7);
});

test('daily candle forms from 1m and completes at 15:30', () => {
  const e = new Engine();
  const one = addSeries(e, 'N', '1', [...minuteBars(D16, 9 * 60 + 15, 15 * 60 + 29), ...minuteBars(D17, 9 * 60 + 15, 9 * 60 + 20)]);
  one.noteCovered(D16 - 24 * 60 * MIN); // the 1m request started the day before
  const daily = addSeries(e, 'N', '1D', [{ time: D16 - 24 * 60 * MIN, open: 1, high: 1, low: 1, close: 1 }, { time: D16, open: 1, high: 999, low: 1, close: 2 }, { time: D17, open: 3, high: 3, low: 3, close: 3 }]);
  e.setStart(at(D16, 9, 15));
  assert.equal(e.visibleBars(daily).length, 1);
  e.step(3, 1, one.key);
  let v = e.visibleBars(daily);
  assert.equal(v.length, 2);
  assert.ok(v[1].synthetic);
  assert.notEqual(v[1].high, 999, 'future high not leaked');
  e.step(10000, 1, one.key); // through the next day
  v = e.visibleBars(daily);
  assert.equal(v[1].high, 999);
  assert.ok(v[2].synthetic);
});

test('independent mode: stepping one chart does not move another', () => {
  const e = new Engine();
  e.setMode('independent');
  const a = addSeries(e, 'A', '1', minuteBars(D16, 9 * 60 + 15, 10 * 60));
  const b = addSeries(e, 'B', '5', minuteBars(D16, 9 * 60 + 15, 10 * 60, 5));
  e.setStart(at(D16, 9, 15));
  e.freezeKeys([a.key, b.key]);
  e.step(3, 1, a.key);
  assert.equal(e.lastVisibleTime(a), at(D16, 9, 17));
  assert.equal(e.visibleBars(b).length, 0);
  e.step(2, 1, b.key);
  assert.equal(e.lastVisibleTime(b), at(D16, 9, 20));
  assert.equal(e.lastVisibleTime(a), at(D16, 9, 17));
});

test('replay quote reflects the clock, not the live price', () => {
  const e = new Engine();
  const S = addSeries(e, 'Q', '1', [...minuteBars(D16 - 24 * 60 * MIN, 15 * 60 + 28, 15 * 60 + 29, 1, 50), ...minuteBars(D16, 9 * 60 + 15, 9 * 60 + 30)]);
  e.setStart(at(D16, 9, 15));
  e.step(2, 1, S.key);
  const q = e.replayQuote('Q');
  assert.equal(q.lp, S.bars[3].close);
  assert.equal(q.prev_close_price, S.bars[1].close);
  assert.equal(q.open_price, S.bars[2].open);
});

test('merge dedupes and absorb only touches the right edge', () => {
  const e = new Engine();
  const S = addSeries(e, 'M', '1', minuteBars(D16, 9 * 60 + 15, 9 * 60 + 20));
  S.merge(minuteBars(D16, 9 * 60 + 18, 9 * 60 + 25));
  assert.equal(S.bars.length, 11);
  S.absorb({ time: at(D16, 9, 26), open: 1, high: 1, low: 1, close: 1 });
  S.absorb({ time: at(D16, 9, 10), open: 1, high: 1, low: 1, close: 1 });
  assert.equal(S.bars.length, 12);
});

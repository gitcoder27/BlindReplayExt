/*
 * BlindReplay engine: pure replay logic, no DOM and no network.
 *
 * Holds a cache of bars per series (symbol + resolution), the replay clock(s),
 * and decides which bars are visible at a given clock. Loaded into the page's
 * MAIN world before page.js; also loadable from Node for unit tests.
 *
 * Time model
 *   clock = a UTC millisecond timestamp. Everything that happened strictly
 *   before the clock is revealed. A bar is "complete" when its end <= clock,
 *   "forming" when start < clock < end, and hidden when start >= clock.
 *   A forming bar is shown only when it can be rebuilt from complete bars of a
 *   finer series of the same symbol; otherwise it stays hidden.
 */
(function (root) {
  'use strict';

  const MIN = 60 * 1000;
  const DAY = 24 * 60 * MIN;
  const IST_OFFSET = 330 * MIN; // Asia/Kolkata, no DST

  function normRes(resolution) {
    const r = String(resolution == null ? '' : resolution).trim().toUpperCase();
    if (/^\d+$/.test(r)) return r; // minutes
    const m = r.match(/^(\d*)([SDWM])$/);
    if (m) return (m[1] || '1') + m[2];
    return r; // ticks ("1T"), ranges, etc. Unsupported.
  }

  function resDurMs(resolution) {
    const r = normRes(resolution);
    if (/^\d+$/.test(r)) return Number(r) * MIN;
    const m = r.match(/^(\d+)([SDWM])$/);
    if (!m) return null;
    const n = Number(m[1]);
    switch (m[2]) {
      case 'S': return n * 1000;
      case 'D': return n * DAY;
      case 'W': return n * 7 * DAY;
      case 'M': return n * 31 * DAY; // upper bound; the next bar caps it
      default: return null;
    }
  }

  // "0915-1530", "0915-1530:23456", "0915-1200,1300-1530" -> minutes of day.
  function parseSession(session) {
    if (!session || typeof session !== 'string') return null;
    let start = Infinity;
    let end = -Infinity;
    const re = /(\d{2})(\d{2})-(\d{2})(\d{2})/g;
    let m;
    while ((m = re.exec(session))) {
      const s = Number(m[1]) * 60 + Number(m[2]);
      const e = Number(m[3]) * 60 + Number(m[4]);
      if (e <= s) return null; // overnight session: do not cap
      start = Math.min(start, s);
      end = Math.max(end, e);
    }
    return Number.isFinite(start) ? { start, end } : null;
  }

  function istDayStart(t) {
    return Math.floor((t + IST_OFFSET) / DAY) * DAY - IST_OFFSET;
  }

  // First index whose time >= t.
  function lowerBound(bars, t) {
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (bars[mid].time < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function cleanBar(b) {
    const out = {
      time: Number(b.time),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    };
    if (b.volume != null && !Number.isNaN(Number(b.volume))) out.volume = Number(b.volume);
    return out;
  }

  function copyBar(b) {
    const out = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close };
    if (b.volume != null) out.volume = b.volume;
    return out;
  }

  function tickerOf(symbolInfo) {
    if (!symbolInfo) return '';
    return String(symbolInfo.ticker || symbolInfo.full_name || symbolInfo.name || '');
  }

  class Series {
    constructor(key, ticker, resolution, symbolInfo) {
      this.key = key;
      this.ticker = ticker;
      this.resolution = normRes(resolution);
      this.dur = resDurMs(resolution);
      this.symbolInfo = symbolInfo || null;
      this.bars = [];
      this.subs = new Map(); // listenerGuid -> { onTick, onReset }
      this.initialLoaded = false;
      this.noOlderData = false;
      this.coveredFrom = null; // earliest requested time (ms) of the loaded range
      this.delivered = false; // library has received a first response from us
      this.sentLastTime = null; // time of the newest bar the library has
      this.queue = Promise.resolve();
      this.setSymbolInfo(symbolInfo);
    }

    setSymbolInfo(symbolInfo) {
      if (!symbolInfo) return;
      this.symbolInfo = symbolInfo;
      const tz = symbolInfo.timezone || 'Asia/Kolkata';
      this.session = tz === 'Asia/Kolkata' ? parseSession(symbolInfo.session) : null;
    }

    clearData() {
      this.bars = [];
      this.initialLoaded = false;
      this.noOlderData = false;
      this.coveredFrom = null;
      this.delivered = false;
      this.sentLastTime = null;
    }

    noteCovered(fromMs) {
      if (Number.isFinite(fromMs)) this.coveredFrom = this.coveredFrom == null ? fromMs : Math.min(this.coveredFrom, fromMs);
    }

    merge(incoming) {
      if (!incoming || !incoming.length) return;
      const clean = [];
      for (const b of incoming) {
        if (b && Number.isFinite(Number(b.time))) clean.push(cleanBar(b));
      }
      if (!clean.length) return;
      clean.sort((a, b) => a.time - b.time);
      if (!this.bars.length) {
        this.bars = dedupe(clean);
        return;
      }
      const map = new Map();
      for (const b of this.bars) map.set(b.time, b);
      for (const b of clean) map.set(b.time, b); // incoming wins
      this.bars = Array.from(map.values()).sort((a, b) => a.time - b.time);
    }

    // Upsert a live tick into the cache (only at the right edge).
    absorb(bar) {
      if (!this.bars.length || !bar) return;
      const b = cleanBar(bar);
      const last = this.bars[this.bars.length - 1];
      if (b.time > last.time) this.bars.push(b);
      else if (b.time === last.time) this.bars[this.bars.length - 1] = b;
    }

    // End time of bar i: start + duration, capped by the next bar's start and
    // by the session close of that day (so the 15:15 hourly bar ends at 15:30).
    barEnd(i) {
      const bar = this.bars[i];
      let end = bar.time + this.dur;
      const next = this.bars[i + 1];
      if (next && next.time < end) end = next.time;
      if (this.session && this.dur <= DAY) {
        const close = istDayStart(bar.time) + this.session.end * MIN;
        if (bar.time < close && close < end) end = close;
      }
      return end;
    }

    // Index of the last bar whose start < clock, or -1.
    lastStartedIndex(clock) {
      return lowerBound(this.bars, clock) - 1;
    }
  }

  function dedupe(sorted) {
    const out = [];
    for (const b of sorted) {
      if (out.length && out[out.length - 1].time === b.time) out[out.length - 1] = b;
      else out.push(b);
    }
    return out;
  }

  class Engine {
    constructor() {
      this.series = new Map();
      this.aliases = new Map(); // symbol string -> ticker
      this.mode = 'sync'; // 'sync' | 'independent'
      this.startTime = null;
      this.clock = null; // global clock
      this.clocks = new Map(); // independent mode: key -> clock
    }

    static key(ticker, resolution) {
      return ticker + '|' + normRes(resolution);
    }

    addAlias(name, symbolInfo) {
      const t = tickerOf(symbolInfo);
      if (!t) return;
      for (const n of [name, symbolInfo.ticker, symbolInfo.full_name, symbolInfo.name, symbolInfo.pro_name]) {
        if (n) this.aliases.set(String(n), t);
      }
    }

    tickerForName(name) {
      if (name == null) return null;
      const s = String(name);
      if (this.aliases.has(s)) return this.aliases.get(s);
      for (const S of this.series.values()) {
        const si = S.symbolInfo || {};
        if ([si.ticker, si.full_name, si.name, si.pro_name].some((n) => n && String(n) === s)) return S.ticker;
      }
      return null;
    }

    seriesFor(symbolInfo, resolution) {
      const ticker = tickerOf(symbolInfo);
      const key = Engine.key(ticker, resolution);
      let S = this.series.get(key);
      if (!S) {
        S = new Series(key, ticker, resolution, symbolInfo);
        this.series.set(key, S);
      } else {
        S.setSymbolInfo(symbolInfo);
      }
      return S;
    }

    clearData() {
      for (const S of this.series.values()) S.clearData();
    }

    setStart(t) {
      this.startTime = t;
      this.clock = t;
      this.clocks.clear();
    }

    resetToStart() {
      if (this.startTime == null) return;
      this.setStart(this.startTime);
    }

    setMode(mode) {
      const m = mode === 'independent' ? 'independent' : 'sync';
      if (m === this.mode) return false;
      this.mode = m;
      this.clocks.clear(); // both modes restart from the global clock
      return true;
    }

    clockFor(S) {
      if (this.mode === 'independent' && S && this.clocks.has(S.key)) return this.clocks.get(S.key);
      return this.clock;
    }

    // Independent mode: give each chart's main series its own frozen clock so
    // stepping one chart does not move the others.
    freezeKeys(keys) {
      if (this.mode !== 'independent') return;
      for (const k of keys) if (k && !this.clocks.has(k)) this.clocks.set(k, this.clock);
    }

    // Bars the library may see for series S at the given clock.
    visibleBars(S, clock) {
      const c = clock == null ? this.clockFor(S) : clock;
      if (c == null || !S.bars.length) return [];
      const j = S.lastStartedIndex(c);
      if (j < 0) return [];
      const out = S.bars.slice(0, j);
      if (S.barEnd(j) <= c) {
        out.push(S.bars[j]);
      } else {
        const f = this.synthesize(S, j, c);
        if (f) out.push(f);
      }
      return out;
    }

    // Rebuild a forming bar from complete bars of a finer series of the same
    // symbol. Returns null when no finer data covers it.
    synthesize(S, j, clock) {
      const bar = S.bars[j];
      let best = null;
      for (const F of this.series.values()) {
        if (F === S || F.ticker !== S.ticker || !F.dur || F.dur >= S.dur || !F.bars.length) continue;
        // The finer series must cover the bar from its start.
        const coveredFrom = F.coveredFrom != null ? Math.min(F.coveredFrom, F.bars[0].time) : F.bars[0].time;
        if (coveredFrom > bar.time) continue;
        if (!best || F.dur > best.dur) best = F; // coarsest finer series = fewer bars
      }
      if (!best) return null;
      const from = lowerBound(best.bars, bar.time);
      let to = best.lastStartedIndex(clock);
      if (to >= 0 && best.barEnd(to) > clock) to -= 1;
      if (to < from) return null;
      const agg = { time: bar.time, open: best.bars[from].open, high: -Infinity, low: Infinity, close: best.bars[to].close };
      let vol = 0;
      let hasVol = false;
      for (let k = from; k <= to; k++) {
        const b = best.bars[k];
        if (b.high > agg.high) agg.high = b.high;
        if (b.low < agg.low) agg.low = b.low;
        if (b.volume != null) {
          vol += b.volume;
          hasVol = true;
        }
      }
      if (hasVol) agg.volume = vol;
      agg.synthetic = true;
      return agg;
    }

    // Series that drives the clock in sync mode: the finest live series.
    driver(preferKey) {
      let best = null;
      for (const S of this.series.values()) {
        if (!S.dur || !S.bars.length || !S.subs.size) continue;
        if (!best || S.dur < best.dur || (S.dur === best.dur && S.key === preferKey)) best = S;
      }
      if (!best) {
        // Fall back to any loaded series (e.g. expired contracts have no realtime subscription).
        for (const S of this.series.values()) {
          if (!S.dur || !S.bars.length) continue;
          if (!best || S.dur < best.dur || (S.dur === best.dur && S.key === preferKey)) best = S;
        }
      }
      return best;
    }

    nextClock(D, c) {
      const j = D.lastStartedIndex(c);
      if (j >= 0 && D.barEnd(j) > c) return D.barEnd(j);
      if (j + 1 < D.bars.length) return D.barEnd(j + 1);
      return null;
    }

    prevClock(D, c) {
      let k = D.lastStartedIndex(c);
      if (k >= 0 && D.barEnd(k) > c) k -= 1; // forming bar: already hidden
      if (k - 1 < 0) return null;
      return D.barEnd(k - 1);
    }

    _move(S, c, n, dir) {
      let moved = 0;
      for (; moved < n; moved++) {
        const nc = dir > 0 ? this.nextClock(S, c) : this.prevClock(S, c);
        if (nc == null) break;
        c = nc;
      }
      return { c, moved };
    }

    // dir = +1 forward, -1 back. Returns { changed, affected, moved, reason }.
    step(n, dir, activeKey) {
      if (this.clock == null) return { changed: false, reason: 'Replay is not started' };
      if (this.mode === 'sync') {
        const D = this.driver(activeKey);
        if (!D) return { changed: false, reason: 'Waiting for chart data' };
        const { c, moved } = this._move(D, this.clock, n, dir);
        if (!moved) return { changed: false, reason: dir > 0 ? 'End of data' : 'Start of data' };
        this.clock = c;
        return { changed: true, moved, affected: Array.from(this.series.keys()), driver: D.key };
      }
      const S = this.series.get(activeKey);
      if (!S || !S.bars.length) return { changed: false, reason: 'Active chart has no replay data yet' };
      const { c, moved } = this._move(S, this.clockFor(S), n, dir);
      if (!moved) return { changed: false, reason: dir > 0 ? 'End of data' : 'Start of data' };
      this.clocks.set(S.key, c);
      this.clock = c; // series without their own clock (compare symbols) follow
      const affected = [S.key];
      for (const k of this.series.keys()) if (!this.clocks.has(k)) affected.push(k);
      return { changed: true, moved, affected, driver: S.key };
    }

    // Start time of the newest visible bar of S (for display).
    lastVisibleTime(S) {
      const v = this.visibleBars(S);
      return v.length ? v[v.length - 1].time : null;
    }

    // Quote values consistent with the replay for a ticker, or null.
    replayQuote(ticker) {
      let S = null;
      for (const X of this.series.values()) {
        if (X.ticker !== ticker || !X.dur || !X.bars.length) continue;
        if (!S || X.dur < S.dur) S = X;
      }
      if (!S) return null;
      const vis = this.visibleBars(S);
      if (!vis.length) return null;
      const last = vis[vis.length - 1];
      let open;
      let high = -Infinity;
      let low = Infinity;
      let volume = 0;
      let prevClose = null;
      if (S.dur < DAY) {
        const dayStart = istDayStart(last.time);
        let i = vis.length - 1;
        while (i >= 0 && vis[i].time >= dayStart) i--;
        prevClose = i >= 0 ? vis[i].close : null;
        const day = vis.slice(i + 1);
        open = day[0].open;
        for (const b of day) {
          high = Math.max(high, b.high);
          low = Math.min(low, b.low);
          volume += b.volume || 0;
        }
      } else {
        open = last.open;
        high = last.high;
        low = last.low;
        volume = last.volume || 0;
        prevClose = vis.length > 1 ? vis[vis.length - 2].close : null;
      }
      const v = {
        lp: last.close,
        open_price: open,
        high_price: high,
        low_price: low,
        volume,
        bid: last.close,
        ask: last.close,
      };
      if (prevClose != null) {
        v.prev_close_price = prevClose;
        v.ch = +(last.close - prevClose).toFixed(4);
        v.chp = prevClose ? +(((last.close - prevClose) / prevClose) * 100).toFixed(2) : 0;
      }
      return v;
    }
  }

  const api = { Engine, Series, normRes, resDurMs, parseSession, istDayStart, lowerBound, copyBar, tickerOf, IST_OFFSET, DAY, MIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__blindReplayEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

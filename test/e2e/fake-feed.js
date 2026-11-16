// Deterministic fake datafeed for BlindReplay end-to-end tests.
// Served at https://tv.dhan.co/dhan/dist/fake-feed.js (so it looks like Dhan's code).
(function () {
  const MIN = 60000, DAY = 86400000, IST = 330 * MIN;
  const LIVE = 99999; // sentinel "live" price: must never appear on a replayed chart
  window.__feedLog = [];
  function px(t) {
    const k = t / MIN;
    return 100 + 8 * Math.sin(k / 97) + 3 * Math.sin(k / 13) + ((Math.sin(k * 12.9898) * 43758.5453) % 1) * 0.6;
  }
  function minuteBar(t) {
    const o = px(t), c = px(t + MIN - 1);
    return { time: t, open: o, high: Math.max(o, c) + 0.3, low: Math.min(o, c) - 0.3, close: c, volume: 100 + Math.round(50 * Math.abs(Math.sin(t / MIN))) };
  }
  function isTradingDay(dayStartIst) {
    const dow = new Date(dayStartIst + IST).getUTCDay();
    return dow !== 0 && dow !== 6;
  }
  function minutes(fromMs, toMs, endMs) {
    const out = [];
    let d = Math.floor((fromMs + IST) / DAY) * DAY - IST;
    for (; d <= toMs; d += DAY) {
      if (!isTradingDay(d)) continue;
      for (let m = 9 * 60 + 15; m < 15 * 60 + 30; m++) {
        const t = d + m * MIN;
        if (t < fromMs || t > toMs || t > endMs) continue;
        out.push(minuteBar(t));
      }
    }
    return out;
  }
  function resMin(r) {
    r = String(r).toUpperCase();
    if (/^\d+$/.test(r)) return +r;
    if (/^1?D$/.test(r)) return 'D';
    return null;
  }
  function bars(res, fromMs, toMs) {
    const endMs = Date.now() - MIN; // completed minutes only
    const rm = resMin(res);
    if (rm === 'D') {
      const out = [];
      const ms = minutes(fromMs - DAY, toMs + DAY, endMs);
      let cur = null;
      for (const b of ms) {
        const day = Math.floor((b.time + IST) / DAY) * DAY; // UTC midnight of IST date
        if (!cur || cur.time !== day) { cur && out.push(cur); cur = { time: day, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }; }
        else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
      }
      cur && out.push(cur);
      return out.filter((b) => b.time >= fromMs - DAY && b.time <= toMs);
    }
    const ms = minutes(fromMs - rm * MIN, toMs, endMs);
    if (rm === 1) return ms;
    const out = [];
    let cur = null;
    for (const b of ms) {
      const d = Math.floor((b.time + IST) / DAY) * DAY - IST;
      const slot = d + 555 * MIN + Math.floor((b.time - d - 555 * MIN) / (rm * MIN)) * rm * MIN;
      if (!cur || cur.time !== slot) { cur && out.push(cur); cur = { time: slot, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }; }
      else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
    }
    cur && out.push(cur);
    return out.filter((b) => b.time >= fromMs && b.time <= toMs);
  }
  const symbols = { 'NSE:TEST': 'TEST', 'NSE:OTHER': 'OTHER' };
  class FakeFeed {
    onReady(cb) { setTimeout(() => cb({ supported_resolutions: ['1', '5', '15', '60', '1D'], supports_marks: false, supports_timescale_marks: false, supports_time: true }), 0); }
    searchSymbols(q, ex, type, cb) { cb([]); }
    resolveSymbol(name, onResolve) {
      const n = String(name).replace(/^.*?(NSE:\w+).*$/, '$1');
      const short = symbols[n] || 'TEST';
      setTimeout(() => onResolve({ name: short, ticker: 'NSE:' + short, full_name: 'NSE:' + short, description: short + ' test', type: 'stock', session: '0915-1530', timezone: 'Asia/Kolkata', exchange: 'NSE', listed_exchange: 'NSE', format: 'price', minmov: 1, pricescale: 100, has_intraday: true, has_daily: true, supported_resolutions: ['1', '5', '15', '60', '1D'], intraday_multipliers: ['1', '5', '15', '60'], volume_precision: 0, data_status: 'streaming' }), 0);
    }
    getBars(si, res, pp, onResult) {
      window.__feedLog.push({ fn: 'getBars', res, from: pp.from, to: pp.to, first: pp.firstDataRequest, countBack: pp.countBack });
      const b = bars(res, pp.from * 1000, pp.to * 1000);
      setTimeout(() => onResult(b, { noData: b.length === 0 && pp.from * 1000 < Date.now() - 400 * DAY }), 5);
    }
    subscribeBars(si, res, onTick, guid) {
      const rm = resMin(res);
      const step = rm === 'D' ? DAY : rm * MIN;
      const t = setInterval(() => {
        const nowMs = Date.now();
        const tt = rm === 'D' ? Math.floor((nowMs + IST) / DAY) * DAY : Math.floor(nowMs / step) * step;
        onTick({ time: tt, open: LIVE, high: LIVE, low: LIVE, close: LIVE, volume: 1 });
      }, 700);
      (this._t || (this._t = {}))[guid] = t;
    }
    unsubscribeBars(guid) { clearInterval(this._t && this._t[guid]); }
    getQuotes(symbols, onData) { setTimeout(() => onData(symbols.map((n) => ({ n, s: 'ok', v: { lp: LIVE, ch: 1, chp: 1, bid: LIVE, ask: LIVE, short_name: n, exchange: 'NSE', description: n } }))), 0); }
    subscribeQuotes(symbols, fast, onRealtime, guid) {
      window.__quoteSubs = (window.__quoteSubs || 0) + 1;
      const t = setInterval(() => onRealtime([...symbols, ...fast].map((n) => ({ n, s: 'ok', v: { lp: LIVE, bid: LIVE, ask: LIVE } }))), 900);
      (this._q || (this._q = {}))[guid] = t;
    }
    unsubscribeQuotes(guid) { clearInterval(this._q && this._q[guid]); }
  }
  window.FakeFeed = FakeFeed;
  window.__LIVE = LIVE;
})();

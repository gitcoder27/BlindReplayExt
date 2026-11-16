/*
 * BlindReplay page script. Runs in the page's MAIN world on tv.dhan.co and scalper.dhan.co.
 *
 * How hiding works
 *   Dhan's page builds the TradingView library widget as window.dhan_tvWidget
 *   with a JS datafeed. While a replay runs, BlindReplay wraps that datafeed:
 *   the chart only ever receives bars that started before the replay clock.
 *   Future bars never reach the chart, so the price scale, last-price line,
 *   legend, indicators and crosshair cannot show them. Revealing a candle
 *   feeds it to the chart as a realtime bar; stepping back reloads the series.
 *   An opaque cover is also drawn over the empty area right of the last
 *   revealed candle, and over side panels that show live prices.
 *
 * Nothing is sent anywhere. The only network requests are the chart-history
 * requests Dhan's own datafeed makes, exactly as when you scroll the chart.
 */
(function () {
  'use strict';

  const E = globalThis.__blindReplayEngine;
  if (!E) return;
  try {
    delete globalThis.__blindReplayEngine;
  } catch (_) {
    globalThis.__blindReplayEngine = undefined;
  }
  if (window.top !== window) return;
  if (window.__blindReplayLoaded) return;
  Object.defineProperty(window, '__blindReplayLoaded', { value: true });

  const { Engine, copyBar, lowerBound, IST_OFFSET, normRes } = E;
  const engine = new Engine();
  const PATCHED = Symbol('blindReplayPatched');

  const DEFAULTS = {
    anchor: 75,
    speedIdx: 2,
    jump: 10,
    mode: 'sync',
    follow: true,
    mask: true,
    autoStart: false,
    start: '',
    panel: { x: null, y: null, collapsed: false, hidden: false },
  };
  const ALT = /Mac|iPhone|iPad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '') ? 'Option' : 'Alt';
  const SPEEDS = [0.5, 1, 2, 3, 5, 8, 12, 20]; // candles per second

  const settings = JSON.parse(JSON.stringify(DEFAULTS));

  const R = {
    widget: null,
    datafeed: null,
    orig: null,
    ready: false,
    active: false,
    playing: false,
    playTimer: 0,
    picking: false,
    pointer: null,
    hover: null,
    swallowUntil: 0,
    gen: 0,
    raf: 0,
    message: '',
    messageKind: '',
    views: [],
    chartStates: new Map(),
    quoteSubs: new Map(),
    quoteTimer: 0,
    stepQuietUntil: 0,
    tornDown: false,
    hookedWindows: new WeakSet(),
    styledDocs: new WeakSet(),
    trapValue: undefined,
    trapInstalled: false,
    servedLive: false, // the chart already received ungated bars
    autoTried: false,
    autoPending: false,
  };

  // ---------------------------------------------------------------------------
  // Messaging with the extension's isolated-world bridge (settings storage)
  // ---------------------------------------------------------------------------

  function toExt(msg) {
    document.dispatchEvent(new CustomEvent('blindreplay:to-ext', { detail: JSON.stringify(msg) }));
  }

  function onFromExt(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.detail);
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'settings' && msg.settings) {
      mergeSettings(msg.settings);
      if (!R.active) engine.mode = settings.mode;
      maybeEarlyStart();
      UI.sync();
    } else if (msg.type === 'toggle-panel') {
      settings.panel.hidden = !settings.panel.hidden;
      saveSettings();
      UI.mount();
      UI.sync();
    } else if (msg.type === 'teardown') {
      teardown();
    }
  }
  document.addEventListener('blindreplay:to-page', onFromExt);

  function mergeSettings(s) {
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in s)) continue;
      if (k === 'panel') Object.assign(settings.panel, s.panel || {});
      else settings[k] = s[k];
    }
    settings.anchor = clamp(Number(settings.anchor) || 75, 50, 95);
    settings.speedIdx = clamp(Math.round(Number(settings.speedIdx)), 0, SPEEDS.length - 1);
    if (!Number.isFinite(settings.speedIdx)) settings.speedIdx = DEFAULTS.speedIdx;
    settings.jump = clamp(Math.round(Number(settings.jump) || 10), 2, 500);
    settings.mode = settings.mode === 'independent' ? 'independent' : 'sync';
    settings.autoStart = !!settings.autoStart;
  }

  let saveTimer = 0;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => toExt({ type: 'save', settings }), 250);
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (_) {
      return fallback;
    }
  }

  function now() {
    return performance.now();
  }

  const fmtFull = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const fmtSec = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  function fmtTime(t, res) {
    if (t == null) return '—';
    const r = res ? normRes(res) : '';
    if (/S$/.test(r)) return fmtSec.format(t);
    if (/[DWM]$/.test(r)) {
      return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(t);
    }
    return fmtFull.format(t);
  }

  function fmtShort(t, res) {
    const parts = {};
    for (const p of fmtFull.formatToParts(t)) parts[p.type] = p.value;
    const date = `${parts.weekday} ${parts.day} ${parts.month}`;
    return /[DWM]$/.test(normRes(res || '')) ? date : `${date} ${parts.hour}:${parts.minute}`;
  }

  function resLabel(res) {
    const r = normRes(res);
    if (/^\d+$/.test(r)) {
      const n = Number(r);
      return n % 60 === 0 ? n / 60 + 'h' : n + 'm';
    }
    return r;
  }

  // "YYYY-MM-DDTHH:MM" in IST -> UTC ms
  function parseIST(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - IST_OFFSET;
  }

  function toISTInput(t) {
    return new Date(t + IST_OFFSET).toISOString().slice(0, 16);
  }

  // Today 09:15 IST, or the previous weekday if the market has not opened yet.
  function defaultStart() {
    const DAY = 86400000;
    let d = Math.floor((Date.now() + IST_OFFSET) / DAY) * DAY; // IST midnight as fake-UTC
    const nowIST = Date.now() + IST_OFFSET;
    if (nowIST < d + (9 * 60 + 16) * 60000) d -= DAY;
    let dow = new Date(d).getUTCDay();
    while (dow === 0 || dow === 6) {
      d -= DAY;
      dow = new Date(d).getUTCDay();
    }
    return toISTInput(d - IST_OFFSET + (9 * 60 + 15) * 60000);
  }

  // Start field on page load: the latest session, at the time of day used last.
  function initialStart() {
    const def = defaultStart();
    const m = /T(\d{2}:\d{2})/.exec(settings.start || '');
    if (!m) return def;
    const candidate = def.slice(0, 11) + m[1];
    const t = parseIST(candidate);
    return t != null && t <= Date.now() ? candidate : def;
  }

  // Who called the datafeed? Dhan's own code calls some datafeed methods for
  // trading features (order window prices etc.); those always get live data.
  function callerIsDhanApp() {
    const stack = String(new Error().stack || '').split('\n').slice(1);
    for (const line of stack) {
      if (line.includes('chrome-extension://') || line.includes('/src/page.js')) continue;
      if (/\/bundles\/|charting_library/.test(line)) return false;
      if (/\/dhan\/dist\/|\/dhanfeeds\//.test(line)) return true;
      if (/^\s*Error\s*$/.test(line) || !line.trim()) continue;
      return false;
    }
    return false;
  }

  function asyncCall(fn) {
    setTimeout(fn, 0);
  }

  // ---------------------------------------------------------------------------
  // Widget detection
  // ---------------------------------------------------------------------------

  function installTrap() {
    let desc = Object.getOwnPropertyDescriptor(window, 'dhan_tvWidget');
    if (desc && !desc.configurable) return;
    R.trapValue = window.dhan_tvWidget;
    try {
      Object.defineProperty(window, 'dhan_tvWidget', {
        configurable: true,
        enumerable: true,
        get() {
          return R.trapValue;
        },
        set(v) {
          R.trapValue = v;
          try {
            onWidget(v);
          } catch (e) {
            console.warn('[BlindReplay]', e);
          }
        },
      });
      R.trapInstalled = true;
    } catch (_) {
      /* polling below still finds it */
    }
    if (R.trapValue) onWidget(R.trapValue);
  }

  function removeTrap() {
    if (!R.trapInstalled) return;
    const v = R.trapValue;
    try {
      Object.defineProperty(window, 'dhan_tvWidget', { configurable: true, enumerable: true, writable: true, value: v });
    } catch (_) {
      /* ignore */
    }
    R.trapInstalled = false;
  }

  // Pages that keep the widget private (scalper.dhan.co bundles the library and
  // stores the widget inside its own code). The library always registers its
  // options as window[<iframe id>] and inserts <iframe id="tradingview_…">
  // synchronously, before any chart code loads, so finding that iframe gives
  // us the datafeed in time to gate the first request. A small stand-in object
  // provides the few widget calls BlindReplay uses, through the library's API.
  function widgetFromIframe(iframe) {
    if (!iframe || iframe.tagName !== 'IFRAME' || !/^tradingview_/.test(iframe.id || '')) return null;
    if (R.widget && R.widget._iFrame === iframe) return null;
    const real = safe(() => window.dhan_tvWidget, null);
    if (real && real._iFrame === iframe) return null;
    const cfg = safe(() => window[iframe.id], null);
    if (!cfg || typeof cfg !== 'object' || !cfg.datafeed || typeof cfg.datafeed.getBars !== 'function') return null;
    const api = () => iframe.contentWindow.tradingViewApi;
    let readyFired = false;
    const f = {
      _iFrame: iframe,
      _options: { datafeed: cfg.datafeed },
      _standIn: true,
      get _ready() {
        return readyFired;
      },
      chart: (i) => api().chart(i),
      activeChart: () => api().activeChart(),
      chartsCount: () => api().chartsCount(),
      setActiveChart: (i) => api().setActiveChart(i),
      resetCache: () => api().resetCache(),
      onChartReady(cb) {
        // The library's own ready event, subscribed to alongside the app's.
        let subscribed = false;
        const once = () => {
          if (readyFired) return;
          readyFired = true;
          cb();
        };
        const tick = () => {
          if (R.tornDown || R.widget !== f || readyFired || !iframe.isConnected) return;
          const cw = safe(() => iframe.contentWindow, null);
          if (!subscribed && cw && typeof cw.widgetReady === 'function') {
            subscribed = true;
            safe(() => cw.widgetReady(once));
          }
          // Missed the event (attached late): ready once the API has charts.
          if (subscribed && safe(() => api().chartsCount() > 0 && !!api().activeChart().getTimeScale(), false)) {
            setTimeout(() => {
              if (R.widget === f) once();
            }, 1500);
          }
          setTimeout(tick, 250);
        };
        tick();
      },
    };
    return f;
  }

  function scanForIframes(nodes) {
    if (R.tornDown) return;
    for (const n of nodes) {
      if (!n || n.nodeType !== 1) continue;
      const list = n.tagName === 'IFRAME' ? [n] : n.getElementsByTagName ? n.getElementsByTagName('iframe') : [];
      for (const fr of list) {
        const w = widgetFromIframe(fr);
        if (w) onWidget(w);
      }
    }
  }

  let iframeObserver = null;

  function installIframeWatch() {
    try {
      iframeObserver = new MutationObserver((records) => {
        for (const rec of records) if (rec.addedNodes.length) scanForIframes(rec.addedNodes);
      });
      iframeObserver.observe(document, { childList: true, subtree: true });
    } catch (_) {
      /* polling below still finds it */
    }
  }

  function onWidget(w) {
    if (!w || typeof w !== 'object' || R.tornDown) return;
    if (w === R.widget) {
      patchDatafeed(w._options && w._options.datafeed);
      return;
    }
    // The page published the real widget for an iframe we already attached to
    // through the stand-in: switch over without resetting anything.
    if (R.widget && R.widget._standIn && !w._standIn && w._iFrame && w._iFrame === R.widget._iFrame) {
      R.widget = w;
      patchDatafeed(w._options && w._options.datafeed);
      if (!R.ready) watchReady(w);
      return;
    }
    if (R.widget && R.active) hardStop();
    R.widget = w;
    R.ready = false;
    R.chartStates.clear();
    patchDatafeed(w._options && w._options.datafeed);
    maybeEarlyStart();
    watchReady(w);
  }

  function watchReady(w) {
    try {
      w.onChartReady(() => {
        if (R.widget !== w || R.ready) return;
        R.ready = true;
        hookWindows();
        UI.mount();
        onReadyAutoStart();
        UI.sync();
      });
    } catch (_) {
      /* not a TradingView widget */
    }
  }

  // "Start blind when the page loads": gate the chart's very first data request
  // so the day's candles are never drawn.
  function maybeEarlyStart() {
    if (!settings.autoStart || R.active || R.autoTried || !R.widget || !(R.datafeed && R.datafeed[PATCHED])) return;
    R.autoTried = true;
    if (R.servedLive || R.ready) {
      R.autoPending = true; // too late to gate silently; start normally once ready
      if (R.ready) onReadyAutoStart();
      return;
    }
    const t = parseIST(initialStart());
    if (t == null) return;
    R.gen++;
    engine.mode = settings.mode;
    engine.setStart(t);
    engine.clearData();
    R.active = true;
    settings.start = toISTInput(t);
    R.message = `Started blind on page load. ${ALT}+→ reveals the next candle.`;
    R.messageKind = 'ok';
  }

  function onReadyAutoStart() {
    if (R.active && R.autoTried && !R.autoPending) {
      // Already gated from the first request: finish setting up.
      R.views = [];
      applyMasks();
      followAll(6);
      scheduleQuotes();
      ensureLoop();
      return;
    }
    if (R.autoPending) {
      R.autoPending = false;
      startReplay(parseIST(initialStart()));
    }
  }

  const pollTimer = setInterval(() => {
    if (R.tornDown) return;
    const w = window.dhan_tvWidget;
    if (w && (w !== R.widget || !(R.datafeed && R.datafeed[PATCHED]))) onWidget(w);
    if (R.widget && R.widget._standIn && !R.widget._iFrame.isConnected) {
      // The page removed its chart (for example on navigation inside the app).
      R.ready = false;
      if (R.active) hardStop();
      R.widget = null;
      R.chartStates.clear();
    }
    if (!w) scanForIframes(document.querySelectorAll('iframe[id^="tradingview_"]'));
    if (R.ready) {
      hookWindows();
      if (!R.widget._ready && safe(() => R.widget.chartsCount(), 0) === 0) R.ready = false;
    }
  }, 1000);

  // ---------------------------------------------------------------------------
  // Datafeed wrapping
  // ---------------------------------------------------------------------------

  const WRAPPED = ['getBars', 'subscribeBars', 'unsubscribeBars', 'resolveSymbol', 'getQuotes', 'subscribeQuotes', 'unsubscribeQuotes', 'getMarks', 'getTimescaleMarks'];

  function patchDatafeed(df) {
    if (!df || typeof df !== 'object' || typeof df.getBars !== 'function') return;
    if (df[PATCHED]) {
      R.datafeed = df;
      R.orig = df[PATCHED].orig;
      return;
    }
    const orig = {};
    const hadOwn = {};
    for (const name of WRAPPED) {
      if (typeof df[name] === 'function') {
        orig[name] = df[name];
        hadOwn[name] = Object.prototype.hasOwnProperty.call(df, name);
      }
    }
    const wrappers = makeWrappers(orig);
    for (const name of Object.keys(orig)) {
      Object.defineProperty(df, name, { configurable: true, writable: true, enumerable: false, value: wrappers[name] });
    }
    Object.defineProperty(df, PATCHED, { configurable: true, value: { orig, hadOwn } });
    R.datafeed = df;
    R.orig = orig;
  }

  function unpatchDatafeed(df) {
    if (!df || !df[PATCHED]) return;
    const { orig, hadOwn } = df[PATCHED];
    for (const name of Object.keys(orig)) {
      if (hadOwn[name]) df[name] = orig[name];
      else delete df[name];
    }
    delete df[PATCHED];
  }

  function makeWrappers(orig) {
    const w = {};

    w.resolveSymbol = function (name, onResolve, onError, extension) {
      const args = Array.prototype.slice.call(arguments);
      args[1] = function (info) {
        try {
          engine.addAlias(name, info);
        } catch (_) {
          /* ignore */
        }
        return onResolve.apply(this, arguments);
      };
      return orig.resolveSymbol.apply(this, args);
    };

    w.getBars = function (symbolInfo, resolution, periodParams, onResult, onError) {
      if (callerIsDhanApp()) return orig.getBars.apply(this, arguments);
      if (!R.active) {
        R.servedLive = true;
        // A live request still in flight when a replay starts must not slip
        // through: trim its answer to the replay point.
        const args = Array.prototype.slice.call(arguments);
        const cb = args[3];
        if (typeof cb === 'function') {
          args[3] = function (bars, meta) {
            if (R.active && Array.isArray(bars)) {
              const clock = engine.clock;
              bars = clock == null ? [] : bars.filter((b) => b && b.time < clock);
            }
            return cb.call(this, bars, meta);
          };
        }
        return orig.getBars.apply(this, args);
      }
      const S = engine.seriesFor(symbolInfo, resolution);
      S.rawResolution = resolution;
      if (!S.dur) {
        asyncCall(() => onResult([], { noData: true }));
        return;
      }
      const gen = R.gen;
      const p = periodParams && periodParams.firstDataRequest ? serveFirst(S, periodParams) : serveOlder(S, periodParams);
      p.then(
        (res) => {
          if (gen !== R.gen) {
            // Replay restarted/stopped while loading: answer from the new state.
            if (!R.active) return orig.getBars.call(R.datafeed, symbolInfo, resolution, periodParams, onResult, onError);
            return w.getBars.call(R.datafeed, symbolInfo, resolution, periodParams, onResult, onError);
          }
          onResult(res.bars, res.meta);
          UI.sync();
        },
        (err) => {
          setMessage('Could not load bars: ' + (err && err.message ? err.message : err), 'warn');
          if (typeof onError === 'function') onError(String((err && err.message) || err));
        },
      );
    };

    w.subscribeBars = function (symbolInfo, resolution, onTick, guid, onReset) {
      if (callerIsDhanApp()) return orig.subscribeBars.apply(this, arguments);
      const S = engine.seriesFor(symbolInfo, resolution);
      S.rawResolution = resolution;
      S.subs.set(guid, { onTick, onReset });
      const args = Array.prototype.slice.call(arguments);
      args[2] = function (bar) {
        if (R.active) {
          S.absorb(bar); // keep the cache current; never show it
          return;
        }
        return onTick.apply(this, arguments);
      };
      const r = orig.subscribeBars.apply(this, args);
      if (R.active) asyncCall(() => pushIncremental([S.key]));
      return r;
    };

    w.unsubscribeBars = function (guid) {
      for (const S of engine.series.values()) S.subs.delete(guid);
      return orig.unsubscribeBars.apply(this, arguments);
    };

    if (orig.getQuotes) {
      w.getQuotes = function (symbols, onData, onError) {
        if (callerIsDhanApp()) return orig.getQuotes.apply(this, arguments);
        const args = Array.prototype.slice.call(arguments);
        args[1] = function (data) {
          return onData.call(this, R.active ? sanitizeQuotes(data) : data);
        };
        return orig.getQuotes.apply(this, args);
      };
    }

    if (orig.subscribeQuotes) {
      w.subscribeQuotes = function (symbols, fastSymbols, onRealtime, guid) {
        if (callerIsDhanApp()) return orig.subscribeQuotes.apply(this, arguments);
        const all = [].concat(symbols || [], fastSymbols || []);
        R.quoteSubs.set(guid, { symbols: all, onRealtime });
        const args = Array.prototype.slice.call(arguments);
        args[2] = function (data) {
          if (R.active) return; // live quotes are withheld during a replay
          return onRealtime.apply(this, arguments);
        };
        const r = orig.subscribeQuotes.apply(this, args);
        if (R.active) scheduleQuotes();
        return r;
      };
    }

    if (orig.unsubscribeQuotes) {
      w.unsubscribeQuotes = function (guid) {
        R.quoteSubs.delete(guid);
        return orig.unsubscribeQuotes.apply(this, arguments);
      };
    }

    if (orig.getMarks) {
      w.getMarks = function (symbolInfo, from, to, onData, resolution) {
        if (!R.active || callerIsDhanApp()) return orig.getMarks.apply(this, arguments);
        const args = Array.prototype.slice.call(arguments);
        args[3] = function (marks) {
          return onData.call(this, filterMarks(marks, symbolInfo, resolution));
        };
        return orig.getMarks.apply(this, args);
      };
    }

    if (orig.getTimescaleMarks) {
      w.getTimescaleMarks = function (symbolInfo, from, to, onData, resolution) {
        if (!R.active || callerIsDhanApp()) return orig.getTimescaleMarks.apply(this, arguments);
        const args = Array.prototype.slice.call(arguments);
        args[3] = function (marks) {
          return onData.call(this, filterMarks(marks, symbolInfo, resolution));
        };
        return orig.getTimescaleMarks.apply(this, args);
      };
    }

    return w;
  }

  function filterMarks(marks, symbolInfo, resolution) {
    if (!R.active || !Array.isArray(marks)) return marks;
    const S = engine.series.get(Engine.key(E.tickerOf(symbolInfo), resolution));
    const clock = S ? engine.clockFor(S) : engine.clock;
    if (clock == null) return [];
    return marks.filter((m) => m && Number(m.time) * 1000 < clock);
  }

  const LIVE_QUOTE_FIELDS = ['lp', 'ch', 'chp', 'bid', 'ask', 'spread', 'open_price', 'high_price', 'low_price', 'prev_close_price', 'volume', 'rtc', 'rch', 'rchp', 'rtc_time', 'bid_size', 'ask_size', 'trade_loaded', 'ltp'];

  function sanitizeQuotes(data) {
    if (!Array.isArray(data)) return data;
    return data.map((q) => {
      if (!q || q.s !== 'ok' || !q.v) return q;
      const v = Object.assign({}, q.v);
      for (const f of LIVE_QUOTE_FIELDS) delete v[f];
      const ticker = engine.tickerForName(q.n) || q.n;
      const rq = engine.replayQuote(ticker);
      if (rq) Object.assign(v, rq);
      return Object.assign({}, q, { v });
    });
  }

  function scheduleQuotes() {
    if (R.quoteTimer) return;
    R.quoteTimer = setTimeout(() => {
      R.quoteTimer = 0;
      pushReplayQuotes();
    }, 150);
  }

  function pushReplayQuotes() {
    if (!R.active) return;
    for (const sub of R.quoteSubs.values()) {
      const out = [];
      for (const name of sub.symbols) {
        const ticker = engine.tickerForName(name) || name;
        const v = engine.replayQuote(ticker);
        if (v) out.push({ n: name, s: 'ok', v });
      }
      if (out.length) {
        try {
          sub.onRealtime(out);
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  // After a replay, put live quotes back immediately rather than on the next tick.
  function refreshLiveQuotes() {
    if (!R.orig || !R.orig.getQuotes) return;
    for (const sub of R.quoteSubs.values()) {
      try {
        R.orig.getQuotes.call(
          R.datafeed,
          sub.symbols,
          (data) => {
            try {
              sub.onRealtime(data);
            } catch (_) {
              /* ignore */
            }
          },
          () => {},
        );
      } catch (_) {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Serving bars while a replay is active
  // ---------------------------------------------------------------------------

  function fetchRange(S, from, to, countBack, first) {
    const gen = R.gen;
    const run = () =>
      new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => finish(new Error('timed out')), 45000);
        function finish(err, bars, meta) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (err) return reject(err);
          if (gen === R.gen) {
            S.merge(bars || []);
            S.noteCovered(from * 1000);
          }
          resolve({ count: (bars || []).length, meta: meta || {} });
        }
        try {
          R.orig.getBars.call(
            R.datafeed,
            S.symbolInfo,
            S.rawResolution || S.resolution,
            { from: Math.floor(from), to: Math.floor(to), countBack: countBack || 0, firstDataRequest: !!first },
            (bars, meta) => finish(null, bars, meta),
            (err) => finish(new Error(String(err || 'no data'))),
          );
        } catch (e) {
          finish(e);
        }
      });
    const p = S.queue.then(run, run);
    S.queue = p.catch(() => {});
    return p;
  }

  async function serveFirst(S, pp) {
    const span = Math.max((pp.to || 0) - (pp.from || 0), 2 * 86400);
    if (!S.initialLoaded) {
      const clockSec = Math.floor(engine.clockFor(S) / 1000);
      const from = Math.min(pp.from, clockSec - span);
      const to = Math.max(pp.to, Math.floor(Date.now() / 1000));
      // Intraday ranges are loaded newest-first in 7-day pieces, the same size
      // the chart itself asks for when you scroll back.
      const CHUNK = 7 * 86400;
      const chunked = S.dur < 86400000 && to - from > CHUNK * 1.5;
      let hi = to;
      let first = true;
      let lastErr = null;
      while (hi > from) {
        const lo = chunked ? Math.max(from, hi - CHUNK) : from;
        try {
          await fetchRange(S, lo, hi, first ? pp.countBack : 0, first);
        } catch (e) {
          lastErr = e;
        }
        first = false;
        hi = lo;
      }
      if (!S.bars.length && lastErr) throw lastErr;
      S.initialLoaded = true;
    }
    // Make sure there is some history before the clock.
    for (let k = 0; k < 3 && !S.noOlderData && engine.visibleBars(S).length < 2; k++) {
      const clockSec = Math.floor(engine.clockFor(S) / 1000);
      const earliest = S.bars.length ? Math.floor(S.bars[0].time / 1000) : clockSec;
      const to = Math.min(earliest, clockSec);
      const from = to - span * (k + 2);
      try {
        const r = await fetchRange(S, from, to, pp.countBack, false);
        if (r.count === 0 && r.meta && r.meta.noData) S.noOlderData = true;
      } catch (_) {
        break;
      }
    }
    const vis = engine.visibleBars(S);
    S.delivered = true;
    S.sentLastTime = vis.length ? vis[vis.length - 1].time : null;
    if (!vis.length) return { bars: [], meta: { noData: true } };
    return { bars: vis.map(copyBar), meta: { noData: false } };
  }

  async function serveOlder(S, pp) {
    const fromMs = pp.from * 1000;
    const toMs = pp.to * 1000;
    if (!S.noOlderData && (!S.bars.length || S.bars[0].time > fromMs)) {
      const to = S.bars.length ? Math.min(pp.to, Math.floor(S.bars[0].time / 1000)) : pp.to;
      try {
        const r = await fetchRange(S, pp.from, to, pp.countBack, false);
        if (r.count === 0 && r.meta && r.meta.noData) S.noOlderData = true;
      } catch (e) {
        if (!S.bars.length) throw e;
      }
    }
    const clock = engine.clockFor(S);
    const end = lowerBound(S.bars, Math.min(toMs, clock));
    let start = lowerBound(S.bars, fromMs);
    if (end - start < (pp.countBack || 0)) start = Math.max(0, end - pp.countBack);
    const out = S.bars.slice(start, end);
    if (!out.length) return { bars: [], meta: { noData: true } };
    return { bars: out.map(copyBar), meta: { noData: false } };
  }

  // Feed newly revealed bars to the chart as realtime updates.
  function pushIncremental(keys) {
    const reload = [];
    for (const k of keys) {
      const S = engine.series.get(k);
      if (!S || !S.delivered || !S.dur) continue;
      const vis = engine.visibleBars(S);
      if (!vis.length) continue;
      if (!S.subs.size || S.sentLastTime == null) {
        reload.push(k);
        continue;
      }
      const idx = lowerBound(vis, S.sentLastTime);
      if (idx >= vis.length || vis[idx].time !== S.sentLastTime) {
        reload.push(k);
        continue;
      }
      for (let i = idx; i < vis.length; i++) {
        for (const sub of S.subs.values()) {
          try {
            sub.onTick(copyBar(vis[i]));
          } catch (_) {
            /* ignore */
          }
        }
      }
      S.sentLastTime = vis[vis.length - 1].time;
    }
    if (reload.length) reloadKeys(reload);
  }

  // ---------------------------------------------------------------------------
  // Charts
  // ---------------------------------------------------------------------------

  function chartsList() {
    const w = R.widget;
    if (!w || !R.ready) return [];
    const n = safe(() => w.chartsCount(), 0);
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = safe(() => w.chart(i), null);
      if (c) out.push(c);
    }
    return out;
  }

  function chartIdentity(chart) {
    return safe(() => chart.chartWidget(), null) || chart;
  }

  function chartKey(chart) {
    const sym = safe(() => chart.symbol(), null);
    const res = safe(() => chart.resolution(), null);
    if (!sym || !res) return null;
    let ticker = engine.tickerForName(sym);
    if (!ticker) {
      const ext = safe(() => chart.symbolExt(), null) || {};
      for (const n of [ext.ticker, ext.full_name, ext.symbol, ext.pro_name]) {
        ticker = engine.tickerForName(n);
        if (ticker) break;
      }
    }
    return ticker ? Engine.key(ticker, res) : null;
  }

  function activeChart() {
    return safe(() => R.widget.activeChart(), null);
  }

  function chartState(chart) {
    const id = chartIdentity(chart);
    let st = R.chartStates.get(id);
    if (st) {
      st.chart = chart;
      return st;
    }
    st = { chart, token: {}, subs: [], detached: false, selfSetUntil: 0, zoomAt: 0, follow: 0, cover: null, blind: false, blindSince: 0 };
    R.chartStates.set(id, st);
    const sub = (s, cb) => {
      try {
        s.subscribe(st.token, cb);
        st.subs.push(s);
      } catch (_) {
        /* older library */
      }
    };
    safe(() =>
      sub(chart.crossHairMoved(), (p) => {
        R.hover = { st, time: p && p.time != null ? p.time : null };
      }),
    );
    safe(() =>
      sub(chart.onDataLoaded(), () => {
        if (!R.active) return;
        st.follow = Math.max(st.follow, 3);
        if (st.blind && now() - st.blindSince > 30) st.blind = false;
      }),
    );
    const ts = safe(() => chart.getTimeScale(), null);
    if (ts) {
      safe(() =>
        sub(ts.barSpacingChanged(), () => {
          st.zoomAt = now();
          if (R.active && settings.follow && !st.detached) st.follow = Math.max(st.follow, 1);
        }),
      );
      safe(() =>
        sub(ts.rightOffsetChanged(), () => {
          const t = now();
          if (!R.active || t < st.selfSetUntil || t < R.stepQuietUntil || t - st.zoomAt < 200) return;
          st.detached = true; // the user scrolled away; the next step brings it back
        }),
      );
    }
    return st;
  }

  function unhookCharts() {
    for (const st of R.chartStates.values()) {
      for (const s of st.subs) safe(() => s.unsubscribeAll(st.token));
      if (st.cover) st.cover.remove();
    }
    R.chartStates.clear();
  }

  function applyFollow(st) {
    const ts = safe(() => st.chart.getTimeScale(), null);
    if (!ts) return;
    const w = safe(() => ts.width(), 0);
    const b = safe(() => ts.barSpacing(), 0);
    if (!(w > 0 && b > 0) || safe(() => ts.isEmpty(), false)) return;
    const target = ((1 - settings.anchor / 100) * w) / b - 0.5;
    st.selfSetUntil = now() + 250;
    st.detached = false;
    safe(() => ts.setRightOffset(target));
  }

  function followAll(frames) {
    if (!settings.follow) return;
    for (const c of chartsList()) {
      const st = chartState(c);
      st.detached = false;
      st.follow = Math.max(st.follow, frames || 3);
    }
  }

  function captureViews() {
    R.views = chartsList().map((c) => {
      const ts = safe(() => c.getTimeScale(), null);
      return { st: chartState(c), barSpacing: ts ? safe(() => ts.barSpacing(), null) : null, rightOffset: ts ? safe(() => ts.rightOffset(), null) : null };
    });
  }

  function restoreViews() {
    const views = R.views;
    R.views = [];
    const apply = () => {
      for (const v of views) {
        const ts = safe(() => v.st.chart.getTimeScale(), null);
        if (!ts) continue;
        if (v.barSpacing) safe(() => ts.setBarSpacing(v.barSpacing));
        if (v.rightOffset != null) safe(() => ts.setRightOffset(v.rightOffset));
      }
    };
    setTimeout(apply, 300);
    setTimeout(apply, 1200);
  }

  function resetAllData() {
    let viaWidget = false;
    try {
      R.widget.resetCache();
      viaWidget = true;
    } catch (_) {
      /* fall back to per-feed callbacks */
    }
    if (!viaWidget) {
      const seen = new Set();
      for (const S of engine.series.values()) {
        for (const sub of S.subs.values()) {
          if (sub.onReset && !seen.has(sub.onReset)) {
            seen.add(sub.onReset);
            safe(() => sub.onReset());
          }
        }
      }
    }
    for (const c of chartsList()) safe(() => c.resetData());
  }

  function reloadAll() {
    for (const S of engine.series.values()) {
      S.delivered = false;
      S.sentLastTime = null;
    }
    resetAllData();
    followAll(4);
  }

  function reloadKeys(keys) {
    const set = new Set(keys);
    const charts = chartsList();
    const mainKeys = new Set(charts.map(chartKey).filter(Boolean));
    for (const k of set) {
      if (!mainKeys.has(k)) return reloadAll(); // compare/indicator symbol: reload everything
    }
    for (const k of set) {
      const S = engine.series.get(k);
      if (!S) continue;
      S.delivered = false;
      S.sentLastTime = null;
      for (const sub of S.subs.values()) safe(() => sub.onReset && sub.onReset());
    }
    for (const c of charts) {
      if (set.has(chartKey(c))) {
        safe(() => c.resetData());
        const st = chartState(c);
        st.follow = Math.max(st.follow, 4);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Replay control
  // ---------------------------------------------------------------------------

  function setMessage(text, kind) {
    R.message = text || '';
    R.messageKind = kind || '';
    UI.sync();
  }

  function startReplay(t) {
    if (!R.widget || !R.ready) return setMessage('Chart is not ready yet.', 'warn');
    if (!R.datafeed || !R.datafeed[PATCHED]) return setMessage('Could not attach to the chart data feed. Reload the page.', 'warn');
    if (t == null || !Number.isFinite(t)) return setMessage('Pick a valid start date and time.', 'warn');
    if (t > Date.now()) return setMessage('Start time is in the future.', 'warn');
    stopPlay();
    R.gen++;
    engine.mode = settings.mode;
    engine.setStart(t);
    engine.clearData();
    if (!R.active) {
      captureViews();
      R.active = true;
      R.outsideRevealed = false;
    }
    for (const c of chartsList()) {
      const st = chartState(c);
      st.blind = true;
      st.blindSince = now();
    }
    settings.start = toISTInput(t);
    saveSettings();
    applyMasks();
    reloadAll();
    scheduleQuotes();
    ensureLoop();
    setMessage(`Replay started. ${ALT}+→ reveals the next candle.`, 'ok');
  }

  function stopReplay() {
    if (!R.active) return;
    hardStop();
    setMessage('Replay off. Chart restored.', '');
  }

  function hardStop() {
    stopPlay();
    endPick(true);
    R.active = false;
    R.gen++;
    engine.clearData();
    engine.clock = null;
    engine.clocks.clear();
    if (R.widget && R.ready) {
      resetAllData();
      restoreViews();
    }
    refreshLiveQuotes();
    applyMasks();
    for (const st of R.chartStates.values()) {
      if (st.cover) st.cover.style.display = 'none';
      st.blind = false;
    }
  }

  function step(n) {
    if (!R.active) return false;
    if (!n) return false;
    const charts = chartsList();
    const ac = activeChart();
    const activeKey = ac ? chartKey(ac) : null;
    if (engine.mode === 'independent') engine.freezeKeys(charts.map(chartKey));
    const res = engine.step(Math.abs(n), n > 0 ? 1 : -1, activeKey);
    if (!res.changed) {
      setMessage(res.reason, 'warn');
      return false;
    }
    R.stepQuietUntil = now() + 300;
    if (n > 0) pushIncremental(res.affected);
    else reloadKeys(res.affected);
    if (settings.follow) {
      if (engine.mode === 'independent' && ac) {
        const st = chartState(ac);
        st.detached = false;
        st.follow = Math.max(st.follow, 3);
      } else followAll(3);
    }
    scheduleQuotes();
    R.message = res.moved < Math.abs(n) ? (n > 0 ? 'End of data.' : 'Start of data.') : '';
    UI.sync();
    return true;
  }

  function resetReplay() {
    if (!R.active || engine.startTime == null) return;
    stopPlay();
    engine.resetToStart();
    reloadAll();
    scheduleQuotes();
    setMessage('Back to the start point.', '');
  }

  function play() {
    if (!R.active) return;
    if (R.playing) return;
    R.playing = true;
    UI.sync();
    const tick = () => {
      if (!R.playing) return;
      if (!step(1)) return stopPlay();
      R.playTimer = setTimeout(tick, 1000 / SPEEDS[settings.speedIdx]);
    };
    R.playTimer = setTimeout(tick, 1000 / SPEEDS[settings.speedIdx]);
  }

  function stopPlay() {
    R.playing = false;
    clearTimeout(R.playTimer);
    R.playTimer = 0;
    UI.sync();
  }

  function togglePlay() {
    if (R.playing) stopPlay();
    else play();
  }

  function setMode(mode) {
    settings.mode = mode === 'independent' ? 'independent' : 'sync';
    saveSettings();
    if (engine.setMode(settings.mode) && R.active) {
      stopPlay();
      reloadAll();
      scheduleQuotes();
    }
    UI.sync();
  }

  // Summary of the replay position for the panel.
  function replayStatus() {
    if (!R.active) return null;
    let S = null;
    if (engine.mode === 'independent') {
      const ac = activeChart();
      const k = ac ? chartKey(ac) : null;
      S = k ? engine.series.get(k) : null;
    }
    if (!S) S = engine.driver(safe(() => chartKey(activeChart()), null));
    if (!S) return { time: null, res: null, count: 0 };
    const t = engine.lastVisibleTime(S);
    const clock = engine.clockFor(S);
    const from = lowerBound(S.bars, engine.startTime);
    const to = lowerBound(S.bars, clock);
    return { time: t, res: S.resolution, count: Math.max(0, to - from), symbol: S.ticker };
  }

  // ---------------------------------------------------------------------------
  // Picking a start candle on the chart
  // ---------------------------------------------------------------------------

  function beginPick() {
    if (!R.widget || !R.ready) return setMessage('Chart is not ready yet.', 'warn');
    stopPlay();
    R.picking = true;
    R.pointer = null;
    hookWindows();
    applyMasks();
    ensureLoop();
    setMessage('Click the candle to start from (it will be hidden first). Esc cancels.', 'ok');
  }

  function endPick(silent) {
    if (!R.picking) return;
    R.picking = false;
    R.pointer = null;
    applyMasks();
    if (!silent) setMessage('', '');
    UI.sync();
  }

  function stateForElement(el) {
    for (const st of R.chartStates.values()) {
      const root = chartElement(st);
      if (root && root.contains(el)) return st;
    }
    return null;
  }

  function onPointerMove(e) {
    if (!R.picking) return;
    const el = e.target && e.target.closest ? e.target.closest('.chart-widget') : null;
    R.pointer = { x: e.clientX, y: e.clientY, el };
  }

  function onPointerDown(e) {
    if (!R.picking) return;
    const pane = e.target && e.target.closest ? e.target.closest('.chart-markup-table.pane') : null;
    if (!pane) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    R.swallowUntil = now() + 800;
    const st = stateForElement(pane);
    let t = null;
    if (st && R.hover && R.hover.st === st && R.hover.time != null) t = R.hover.time;
    if (t == null && st) {
      const ts = safe(() => st.chart.getTimeScale(), null);
      const x = e.clientX - pane.getBoundingClientRect().left;
      t = ts ? safe(() => ts.coordinateToTime(x), null) : null;
    }
    endPick(true);
    if (t == null) return setMessage('Could not read the time under the cursor. Try again or type a start time.', 'warn');
    if (st) safe(() => R.widget.setActiveChart(chartsList().indexOf(st.chart)));
    startReplay(Number(t) * 1000);
  }

  function swallow(e) {
    if (now() < R.swallowUntil) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  // ---------------------------------------------------------------------------
  // Covers (drawn inside each chart's DOM, in the library iframe)
  // ---------------------------------------------------------------------------

  function iframeDoc() {
    return safe(() => R.widget._iFrame.contentDocument, null);
  }

  function chartElement(st) {
    const el = safe(() => st.chart.chartWidget()._mainDiv, null);
    if (el && el.isConnected) return el;
    const doc = iframeDoc();
    if (!doc) return null;
    const idx = chartsList().indexOf(st.chart);
    const all = doc.querySelectorAll('.chart-widget');
    return idx >= 0 && all[idx] ? all[idx] : null;
  }

  function ensureLoop() {
    if (!R.raf) R.raf = requestAnimationFrame(frame);
  }

  function frame() {
    R.raf = 0;
    if (R.tornDown) return;
    if (!R.active && !R.picking) {
      for (const st of R.chartStates.values()) if (st.cover) st.cover.style.display = 'none';
      renderOutsideMask();
      return;
    }
    try {
      renderCovers();
    } catch (e) {
      /* keep going */
    }
    try {
      renderOutsideMask();
    } catch (e) {
      /* keep going */
    }
    R.raf = requestAnimationFrame(frame);
  }

  function renderCovers() {
    const charts = chartsList();
    const live = new Set();
    for (const chart of charts) {
      const st = chartState(chart);
      live.add(st);
      if (R.active && st.follow > 0) {
        if (st.follow === 1 || st.follow === 3) applyFollow(st);
        st.follow -= 1;
      }
      const el = chartElement(st);
      if (!el) continue;
      const panes = el.querySelectorAll('.chart-markup-table.pane');
      if (!panes.length) continue;
      const er = el.getBoundingClientRect();
      let top = Infinity;
      let bottom = -Infinity;
      let left = null;
      let width = 0;
      for (const p of panes) {
        const r = p.getBoundingClientRect();
        if (r.height <= 0 || r.width <= 0) continue;
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
        if (left == null) {
          left = r.left;
          width = r.width;
        }
      }
      if (left == null) continue;

      let x;
      if (R.picking) {
        x = R.pointer && R.pointer.el === el ? R.pointer.x - left : 0;
      } else {
        const key = chartKey(chart);
        const S = key ? engine.series.get(key) : null;
        if (st.blind && S && S.delivered) st.blind = false;
        // Symbol not recognised: data is gated anyway, so stop blanking after a while.
        if (st.blind && !key && now() - st.blindSince > 8000) st.blind = false;
        if (S && !S.dur) x = 0; // unsupported resolution: hide everything
        else if (st.blind) x = 0; // still loading after start: old data may be on screen
        else {
          const ts = safe(() => chart.getTimeScale(), null);
          if (!ts || safe(() => ts.isEmpty(), true)) x = width;
          else x = safe(() => ts.width() - ts.rightOffset() * ts.barSpacing(), 0);
        }
      }
      // While picking, the chart still holds live data: also hide the price
      // axis (last-price label) to the right of the cursor.
      const span = R.picking ? er.right - left : width;
      x = clamp(Math.round(x), 0, span);

      let cover = st.cover;
      if (!cover || cover.ownerDocument !== el.ownerDocument) {
        cover = el.ownerDocument.createElement('div');
        cover.className = 'blindreplay-cover';
        cover.setAttribute('aria-hidden', 'true');
        cover.innerHTML = '<span>BlindReplay · hidden</span>';
        st.cover = cover;
      }
      if (cover.parentNode !== el) el.appendChild(cover);
      const w = span - x;
      const style = cover.style;
      if (w < 1) {
        if (style.display !== 'none') style.display = 'none';
        continue;
      }
      const l = left - er.left + x + 'px';
      const t = top - er.top + 'px';
      const ww = w + 'px';
      const h = bottom - top + 'px';
      if (style.display !== 'block') style.display = 'block';
      if (style.left !== l) style.left = l;
      if (style.top !== t) style.top = t;
      if (style.width !== ww) style.width = ww;
      if (style.height !== h) style.height = h;
      cover.classList.toggle('blindreplay-picking', R.picking);
    }
    for (const [id, st] of R.chartStates) {
      if (!live.has(st)) {
        if (st.cover) st.cover.remove();
        for (const s of st.subs) safe(() => s.unsubscribeAll(st.token));
        R.chartStates.delete(id);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Masks for live-price areas
  // ---------------------------------------------------------------------------

  const IFRAME_CSS = `
.blindreplay-cover{position:absolute;display:none;z-index:40;pointer-events:none;background:#000;
  box-shadow:inset 2px 0 0 #f5a524;overflow:hidden}
.blindreplay-cover span{position:absolute;right:10px;bottom:8px;white-space:nowrap;font:500 10px/1 system-ui,sans-serif;
  letter-spacing:.06em;text-transform:uppercase;color:#3a3a3a}
.blindreplay-cover.blindreplay-picking{box-shadow:inset 1px 0 0 #f5a524}
html.blindreplay-mask .layout__area--right::after,
html.blindreplay-mask .layout__area--bottom::after,
html.blindreplay-mask .layout__area--tradingpanel::after{
  content:"Hidden during BlindReplay";position:absolute;inset:0;z-index:1000;background:#000;color:#555;
  display:flex;align-items:center;justify-content:center;text-align:center;font:12px system-ui,sans-serif;pointer-events:auto}`;

  const PAGE_CSS = `
.blindreplay-modal-mask{position:absolute;inset:0;z-index:2147483000;background:#000;color:#bbb;display:flex;
  flex-direction:column;gap:10px;align-items:center;justify-content:center;text-align:center;
  font:13px/1.4 system-ui,sans-serif;border-radius:inherit;padding:16px}
.blindreplay-outside{position:fixed;z-index:2147482000;display:none;background:#000;color:#8a8a8a;flex-direction:column;
  gap:10px;align-items:center;justify-content:center;text-align:center;font:13px/1.4 system-ui,sans-serif;padding:12px;overflow:hidden}
.blindreplay-outside button,
.blindreplay-modal-mask button{font:inherit;color:#111;background:#f5a524;border:0;border-radius:6px;padding:6px 12px;cursor:pointer}`;

  const MODAL_ALLOW = new Set([
    'user-settings',
    'createLayout-modal',
    'feedback-modal',
    'createGroupWatch-modal',
    'betaPreview-modal',
    'indicatorMarketplace-modal',
    'indicatorSubscribeConfirm-modal',
    'wlimport-modal',
    'consentPage-modal',
    'ddpiRedirect-modal',
    'redirect-modal',
    'dhanWifi-modal',
    'tradeMode-modal',
    'orderMode-modal',
  ]);

  function ensureStyle(doc, id, css) {
    if (!doc || !doc.documentElement) return;
    if (doc.getElementById(id)) return;
    const s = doc.createElement('style');
    s.id = id;
    s.textContent = css;
    (doc.head || doc.documentElement).appendChild(s);
  }

  let modalObserver = null;

  function applyMasks() {
    const on = (R.active || R.picking) && settings.mask;
    const doc = iframeDoc();
    if (doc && doc.documentElement) {
      ensureStyle(doc, 'blindreplay-style', IFRAME_CSS);
      doc.documentElement.classList.toggle('blindreplay-mask', on);
    }
    ensureStyle(document, 'blindreplay-page-style', PAGE_CSS);
    if (on) {
      if (!modalObserver && document.body) {
        modalObserver = new MutationObserver(scanModals);
        modalObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
      }
      scanModals();
    } else {
      if (modalObserver) modalObserver.disconnect();
      modalObserver = null;
      for (const m of document.querySelectorAll('.blindreplay-modal-mask')) m.remove();
      for (const m of document.querySelectorAll('[data-blindreplay-revealed]')) delete m.dataset.blindreplayRevealed;
    }
  }

  // Live prices on the page around the chart (scalper.dhan.co's option chain,
  // positions and spot price). Four strips cover everything outside the chart
  // frame. On tv.dhan.co the chart fills the window, so they cover nothing.
  const OUT = { els: null, key: '' };

  function hideOutsideMask() {
    if (!OUT.els) return;
    for (const el of OUT.els) el.style.display = 'none';
    OUT.key = '';
  }

  function renderOutsideMask() {
    const fr = R.widget && R.widget._iFrame;
    const on = (R.active || R.picking) && settings.mask && !R.outsideRevealed && fr && fr.isConnected;
    let r = on ? fr.getBoundingClientRect() : null;
    if (r && (r.width < 50 || r.height < 50)) r = null; // chart not on screen
    if (!r || !document.documentElement) return hideOutsideMask();
    const W = window.innerWidth;
    const H = window.innerHeight;
    const L = clamp(Math.floor(r.left), 0, W);
    const T = clamp(Math.floor(r.top), 0, H);
    const Rt = clamp(Math.ceil(r.right), 0, W);
    const B = clamp(Math.ceil(r.bottom), 0, H);
    const rects = [
      [0, 0, W, T],
      [0, B, W, H - B],
      [0, T, L, B - T],
      [Rt, T, W - Rt, B - T],
    ];
    const key = rects.join(';');
    if (key === OUT.key && OUT.els && OUT.els[0].isConnected) return;
    OUT.key = key;
    if (!OUT.els || !OUT.els[0].isConnected) {
      OUT.els = rects.map(() => {
        const el = document.createElement('div');
        el.className = 'blindreplay-outside';
        document.documentElement.appendChild(el);
        return el;
      });
    }
    let biggest = -1;
    let area = 0;
    rects.forEach(([, , w, h], i) => {
      if (w >= 160 && h >= 60 && w * h > area) {
        area = w * h;
        biggest = i;
      }
    });
    rects.forEach(([x, y, w, h], i) => {
      const el = OUT.els[i];
      if (w < 2 || h < 2) {
        el.style.display = 'none';
        return;
      }
      el.style.cssText = `display:flex;left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
      if (i === biggest) {
        if (!el.firstChild) {
          el.innerHTML = '<div>Live prices around the chart are hidden while BlindReplay is running.</div><button type="button">Show it anyway</button>';
          el.querySelector('button').addEventListener('click', (ev) => {
            ev.stopPropagation();
            R.outsideRevealed = true;
            hideOutsideMask();
          });
        }
      } else if (el.firstChild) {
        el.textContent = '';
      }
    });
  }

  function scanModals() {
    if (!((R.active || R.picking) && settings.mask)) return;
    for (const modal of document.querySelectorAll('.modal')) {
      const shown = modal.classList.contains('show');
      if (!shown) {
        if (modal.dataset.blindreplayRevealed) delete modal.dataset.blindreplayRevealed;
        continue;
      }
      if (MODAL_ALLOW.has(modal.id) || modal.dataset.blindreplayRevealed) continue;
      const content = modal.querySelector('.modal-content:not(.tfdHide)') || modal.querySelector('.modal-dialog');
      if (!content || content.querySelector(':scope > .blindreplay-modal-mask')) continue;
      const mask = document.createElement('div');
      mask.className = 'blindreplay-modal-mask';
      mask.innerHTML = '<div>This window can show live prices.<br>It is hidden while BlindReplay is running.</div><button type="button">Show it anyway</button>';
      mask.querySelector('button').addEventListener('click', (ev) => {
        ev.stopPropagation();
        modal.dataset.blindreplayRevealed = '1';
        mask.remove();
      });
      if (getComputedStyle(content).position === 'static') content.style.position = 'relative';
      content.appendChild(mask);
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard and pointer hooks (page and library iframe)
  // ---------------------------------------------------------------------------

  function isTyping(t) {
    if (!t || !t.tagName) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') {
      const type = (t.type || 'text').toLowerCase();
      return !['checkbox', 'radio', 'range', 'button', 'submit'].includes(type);
    }
    return false;
  }

  function onKey(e) {
    if (R.tornDown) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (isTyping(path[0] || e.target)) return;
    const consume = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyB') {
      consume();
      settings.panel.hidden = !settings.panel.hidden;
      saveSettings();
      UI.sync();
      return;
    }
    if (R.picking && e.key === 'Escape') {
      consume();
      endPick();
      return;
    }
    if (!R.active || e.ctrlKey || e.metaKey) return;
    // Stepping uses Option/Alt + arrows. Shift + arrows are never touched: on
    // scalper.dhan.co they are Dhan's order hotkeys (buy / sell).
    const arrows = e.altKey && !e.shiftKey;
    const shiftOnly = e.shiftKey && !e.altKey;
    if (!(arrows && e.code.startsWith('Arrow')) && !(shiftOnly && (e.code === 'Space' || e.code === 'KeyR'))) return;
    switch (e.code) {
      case 'ArrowRight':
        consume();
        stopPlay();
        step(1);
        break;
      case 'ArrowLeft':
        consume();
        stopPlay();
        step(-1);
        break;
      case 'ArrowUp':
        consume();
        stopPlay();
        step(settings.jump);
        break;
      case 'ArrowDown':
        consume();
        stopPlay();
        step(-settings.jump);
        break;
      case 'Space':
        consume();
        togglePlay();
        break;
      case 'KeyR':
        consume();
        resetReplay();
        break;
      default:
    }
  }

  function hookWindow(win) {
    if (!win || R.hookedWindows.has(win)) return;
    R.hookedWindows.add(win);
    win.addEventListener('keydown', onKey, true);
    win.addEventListener('pointermove', onPointerMove, true);
    win.addEventListener('pointerdown', onPointerDown, true);
    for (const type of ['mousedown', 'mouseup', 'pointerup', 'click', 'touchstart', 'touchend']) win.addEventListener(type, swallow, true);
  }

  function unhookWindow(win) {
    if (!win) return;
    safe(() => {
      win.removeEventListener('keydown', onKey, true);
      win.removeEventListener('pointermove', onPointerMove, true);
      win.removeEventListener('pointerdown', onPointerDown, true);
      for (const type of ['mousedown', 'mouseup', 'pointerup', 'click', 'touchstart', 'touchend']) win.removeEventListener(type, swallow, true);
    });
  }

  function hookWindows() {
    hookWindow(window);
    const doc = iframeDoc();
    if (doc && doc.defaultView) {
      hookWindow(doc.defaultView);
      if (!R.styledDocs.has(doc)) {
        R.styledDocs.add(doc);
        ensureStyle(doc, 'blindreplay-style', IFRAME_CSS);
      }
      if (R.active) applyMasks();
    }
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------

  const PANEL_CSS = `
:host{all:initial}
*{box-sizing:border-box}
.wrap{position:fixed;z-index:2147483600;font:12px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#d8d8d8;
  background:#121315;border:1px solid #2a2c31;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.45);user-select:none;
  width:max-content;min-width:276px;max-width:min(420px,calc(100vw - 8px))}
.wrap.hidden{display:none}
.head{display:flex;align-items:center;gap:8px;padding:7px 8px 7px 10px;cursor:grab;border-bottom:1px solid #222429}
.head:active{cursor:grabbing}
.dot{width:8px;height:8px;border-radius:50%;background:#555;flex:none}
.dot.on{background:#f5a524;box-shadow:0 0 0 3px rgba(245,165,36,.18)}
.title{font-weight:600;letter-spacing:.01em;color:#f1f1f1}
.clock{margin-left:auto;font-variant-numeric:tabular-nums;color:#c9c9c9;white-space:nowrap}
.iconbtn{background:none;border:0;color:#9a9a9a;cursor:pointer;padding:2px 4px;border-radius:4px;font:inherit;line-height:1}
.iconbtn:hover{color:#fff;background:#24262b}
.body{padding:10px;display:grid;grid-template-columns:minmax(0,1fr);gap:9px}
/* Sized by the controls; long text wraps instead of widening the panel. */
.status,.msg,.keys{contain:inline-size;overflow-wrap:anywhere}
.row>*{flex-shrink:0}
.row>input[type=datetime-local],.row>input[type=range]{flex-shrink:1}
.row.date{flex-wrap:wrap}
.row.date input{flex:1 1 150px}
.wrap.collapsed .body{display:none}
.wrap.collapsed{width:auto;min-width:180px}
.wrap.collapsed .head{border-bottom:0}
.row{display:flex;align-items:center;gap:6px}
.row.split{justify-content:space-between}
label{color:#a5a5a5}
.switch{display:flex;align-items:center;gap:8px;cursor:pointer;color:#eee;font-weight:500;white-space:nowrap}
.switch input{appearance:none;width:30px;height:17px;border-radius:9px;background:#3a3c42;position:relative;margin:0;cursor:pointer;transition:background .15s}
.switch input::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#ddd;transition:transform .15s}
.switch input:checked{background:#f5a524}
.switch input:checked::after{transform:translateX(13px);background:#111}
.seg{display:inline-flex;border:1px solid #2f3137;border-radius:6px;overflow:hidden}
.seg button{background:#191a1d;color:#aaa;border:0;padding:4px 8px;font:inherit;cursor:pointer;white-space:nowrap}
.seg button.sel{background:#2d2f35;color:#fff}
input[type=datetime-local],input[type=number]{background:#1b1c20;color:#eee;border:1px solid #2f3137;border-radius:6px;padding:4px 6px;font:inherit;
  font-variant-numeric:tabular-nums;color-scheme:dark;min-width:0}
input[type=datetime-local]{flex:1}
input[type=number]{width:52px}
input[type=range]{flex:1;accent-color:#f5a524;min-width:0}
.btn{background:#24262b;color:#e6e6e6;border:1px solid #31333a;border-radius:6px;padding:4px 8px;font:inherit;cursor:pointer;white-space:nowrap}
.btn:hover{background:#2d3036}
.btn:disabled{opacity:.4;cursor:default}
.btn.primary{background:#f5a524;border-color:#f5a524;color:#111;font-weight:600}
.btn.primary:hover{background:#ffb83d}
.btn.on{border-color:#f5a524;color:#f5a524}
.transport{display:grid;grid-template-columns:repeat(6,1fr);gap:4px}
.transport .btn{padding:5px 0;font-size:13px;text-align:center}
.val{min-width:42px;text-align:right;font-variant-numeric:tabular-nums;color:#ddd}
.status{background:#0c0d0e;border:1px solid #1f2125;border-radius:6px;padding:6px 8px;font-variant-numeric:tabular-nums}
.status b{color:#fff;font-weight:600}
.msg{color:#9a9a9a}
.msg:empty{display:none}
.msg.warn{color:#f0b05a}
.msg.ok{color:#8fcf9b}
.keys{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;color:#7d8086;font-size:11px;line-height:1.45;
  border-top:1px solid #1f2125;padding-top:8px}
.keys span:nth-child(odd){white-space:nowrap}
.keys kbd{font:inherit;color:#a0a0a0;background:#1c1d21;border:1px solid #2a2c31;border-radius:3px;padding:0 3px}
.check{display:flex;align-items:center;gap:6px;cursor:pointer;color:#bdbdbd;white-space:nowrap}
.check input{accent-color:#f5a524;margin:0}
`;

  const PANEL_HTML = `
<div class="wrap" part="panel">
  <div class="head" data-drag>
    <span class="dot"></span><span class="title">BlindReplay</span>
    <span class="clock" data-clock></span>
    <button class="iconbtn" data-act="collapse" title="Collapse / expand">–</button>
  </div>
  <div class="body">
    <div class="row split">
      <label class="switch"><input type="checkbox" data-act="enable"> Replay</label>
      <div class="seg" title="Time-synced: one clock drives every chart. Independent: each chart steps on its own (the active chart).">
        <button data-mode="sync">Synced</button><button data-mode="independent">Independent</button>
      </div>
    </div>
    <div class="row date">
      <input type="datetime-local" data-start title="Replay start, IST. The candle at this time is the first hidden one.">
      <button class="btn primary" data-act="go" title="Start the replay at this time">Start</button>
      <button class="btn" data-act="pick" title="Click a candle on the chart to start from it">Pick</button>
    </div>
    <div class="transport">
      <button class="btn" data-act="reset" title="Back to start (Shift+R)">⟲</button>
      <button class="btn" data-act="jback" title="Back N candles (${ALT}+↓)">«</button>
      <button class="btn" data-act="back" title="Back one candle (${ALT}+←)">‹</button>
      <button class="btn" data-act="play" title="Play / pause (Shift+Space)">▶</button>
      <button class="btn" data-act="fwd" title="Next candle (${ALT}+→)">›</button>
      <button class="btn" data-act="jfwd" title="Forward N candles (${ALT}+↑)">»</button>
    </div>
    <div class="row">
      <label style="min-width:46px">Speed</label><input type="range" min="0" max="${SPEEDS.length - 1}" step="1" data-speed>
      <span class="val" data-speedval></span>
    </div>
    <div class="row">
      <label style="min-width:46px">Anchor</label><input type="range" min="50" max="95" step="1" data-anchor>
      <span class="val" data-anchorval></span>
    </div>
    <div class="row split">
      <label class="check"><input type="checkbox" data-follow> Follow latest</label>
      <span class="row"><label>Jump</label><input type="number" min="2" max="500" data-jump></span>
    </div>
    <label class="check" title="Covers the watchlist/details panel, account manager, order panel and Dhan pop-ups that show live prices"><input type="checkbox" data-mask> Hide live-price panels</label>
    <label class="check" title="Next time this site loads (set separately for each Dhan site), start the replay before any candle is drawn (latest session, at the start time used last). Leave off on days you trade live."><input type="checkbox" data-autostart> Start blind when the page loads</label>
    <div class="status" data-status></div>
    <div class="msg" data-msg></div>
    <div class="keys">
      <span><kbd>${ALT}</kbd> <kbd>→</kbd> <kbd>←</kbd></span><span>next / previous candle</span>
      <span><kbd>${ALT}</kbd> <kbd>↑</kbd> <kbd>↓</kbd></span><span>jump forward / back</span>
      <span><kbd>Shift</kbd> <kbd>Space</kbd></span><span>play / pause</span>
      <span><kbd>Shift</kbd> <kbd>R</kbd></span><span>back to start</span>
      <span><kbd>${ALT}</kbd> <kbd>Shift</kbd> <kbd>B</kbd></span><span>show / hide this panel</span>
    </div>
  </div>
</div>`;

  const UI = {
    host: null,
    root: null,
    els: {},
    mounted: false,

    mount() {
      if (this.mounted || R.tornDown) return;
      if (!document.body) {
        document.addEventListener('DOMContentLoaded', () => this.mount(), { once: true });
        return;
      }
      const host = document.createElement('div');
      host.id = 'blindreplay-panel-host';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>${PANEL_CSS}</style>${PANEL_HTML}`;
      // Keys typed in the panel stay in the panel. The page only sees the
      // shadow host as the target, so its own "ignore keys typed in a field"
      // checks can't apply (on Scalper, Shift + arrows would place an order).
      for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());
      document.documentElement.appendChild(host);
      this.host = host;
      this.root = root;
      const q = (s) => root.querySelector(s);
      this.els = {
        wrap: q('.wrap'),
        dot: q('.dot'),
        clock: q('[data-clock]'),
        enable: q('[data-act=enable]'),
        start: q('[data-start]'),
        speed: q('[data-speed]'),
        speedVal: q('[data-speedval]'),
        anchor: q('[data-anchor]'),
        anchorVal: q('[data-anchorval]'),
        follow: q('[data-follow]'),
        jump: q('[data-jump]'),
        mask: q('[data-mask]'),
        autoStart: q('[data-autostart]'),
        status: q('[data-status]'),
        msg: q('[data-msg]'),
        play: q('[data-act=play]'),
        pick: q('[data-act=pick]'),
        collapse: q('[data-act=collapse]'),
        modes: root.querySelectorAll('[data-mode]'),
        transport: root.querySelectorAll('.transport .btn'),
      };
      this.bind();
      this.mounted = true;
      this.place();
      this.sync();
      window.addEventListener('resize', this.onResize);
    },

    onResize: () => UI.place(),

    unmount() {
      if (this.host) this.host.remove();
      window.removeEventListener('resize', this.onResize);
      this.mounted = false;
    },

    bind() {
      const els = this.els;
      // Keep keystrokes typed in the panel away from the chart's hotkeys.
      for (const type of ['keydown', 'keyup', 'keypress']) {
        els.wrap.addEventListener(type, (e) => {
          const t = e.composedPath()[0];
          if (isTyping(t)) e.stopPropagation();
        });
      }
      els.wrap.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act],[data-mode]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (btn.dataset.mode) return setMode(btn.dataset.mode);
        switch (act) {
          case 'collapse':
            settings.panel.collapsed = !settings.panel.collapsed;
            saveSettings();
            this.sync();
            this.place();
            break;
          case 'go':
            startReplay(parseIST(els.start.value));
            break;
          case 'pick':
            if (R.picking) endPick();
            else beginPick();
            break;
          case 'reset':
            resetReplay();
            break;
          case 'back':
            stopPlay();
            step(-1);
            break;
          case 'fwd':
            stopPlay();
            step(1);
            break;
          case 'jback':
            stopPlay();
            step(-settings.jump);
            break;
          case 'jfwd':
            stopPlay();
            step(settings.jump);
            break;
          case 'play':
            togglePlay();
            break;
          default:
        }
      });
      els.enable.addEventListener('change', () => {
        if (els.enable.checked) startReplay(parseIST(els.start.value));
        else stopReplay();
        this.sync();
      });
      els.start.addEventListener('change', () => {
        settings.start = els.start.value;
        saveSettings();
      });
      els.speed.addEventListener('input', () => {
        settings.speedIdx = Number(els.speed.value);
        saveSettings();
        this.sync();
      });
      els.anchor.addEventListener('input', () => {
        settings.anchor = Number(els.anchor.value);
        saveSettings();
        if (R.active && settings.follow) followAll(3);
        this.sync();
      });
      els.follow.addEventListener('change', () => {
        settings.follow = els.follow.checked;
        saveSettings();
        if (R.active && settings.follow) followAll(3);
      });
      els.jump.addEventListener('change', () => {
        settings.jump = clamp(Math.round(Number(els.jump.value) || 10), 2, 500);
        saveSettings();
        this.sync();
      });
      els.autoStart.addEventListener('change', () => {
        settings.autoStart = els.autoStart.checked;
        saveSettings();
      });
      els.mask.addEventListener('change', () => {
        settings.mask = els.mask.checked;
        saveSettings();
        applyMasks();
      });
      this.bindDrag();
    },

    bindDrag() {
      const head = this.root.querySelector('[data-drag]');
      let start = null;
      head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        const r = this.els.wrap.getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
        head.setPointerCapture(e.pointerId);
      });
      head.addEventListener('pointermove', (e) => {
        if (!start) return;
        settings.panel.x = start.left + e.clientX - start.x;
        settings.panel.y = start.top + e.clientY - start.y;
        this.place();
      });
      const end = () => {
        if (!start) return;
        start = null;
        saveSettings();
      };
      head.addEventListener('pointerup', end);
      head.addEventListener('pointercancel', end);
      head.addEventListener('dblclick', (e) => {
        if (e.target.closest('button')) return;
        settings.panel.collapsed = !settings.panel.collapsed;
        saveSettings();
        this.sync();
        this.place();
      });
    },

    place() {
      if (!this.mounted) return;
      const wrap = this.els.wrap;
      const w = wrap.offsetWidth || 276;
      const h = wrap.offsetHeight || 40;
      let x = settings.panel.x;
      let y = settings.panel.y;
      if (x == null || y == null) {
        x = window.innerWidth - w - 70;
        y = 52;
      }
      x = clamp(x, 0, Math.max(0, window.innerWidth - w));
      y = clamp(y, 0, Math.max(0, window.innerHeight - h));
      wrap.style.left = x + 'px';
      wrap.style.top = y + 'px';
    },

    sync() {
      if (!this.mounted) return;
      const els = this.els;
      els.wrap.classList.toggle('hidden', !!settings.panel.hidden);
      els.wrap.classList.toggle('collapsed', !!settings.panel.collapsed);
      els.collapse.textContent = settings.panel.collapsed ? '+' : '–';
      els.dot.classList.toggle('on', R.active);
      els.enable.checked = R.active;
      if (!els.start.value) els.start.value = initialStart();
      else if (R.active && settings.start && els.start.value !== settings.start && this.root.activeElement !== els.start) els.start.value = settings.start;
      els.speed.value = String(settings.speedIdx);
      els.speedVal.textContent = SPEEDS[settings.speedIdx] + '/s';
      els.anchor.value = String(settings.anchor);
      els.anchorVal.textContent = settings.anchor + '%';
      els.follow.checked = !!settings.follow;
      if (this.root.activeElement !== els.jump) els.jump.value = String(settings.jump);
      els.mask.checked = !!settings.mask;
      els.autoStart.checked = !!settings.autoStart;
      for (const b of els.modes) b.classList.toggle('sel', b.dataset.mode === settings.mode);
      for (const b of els.transport) b.disabled = !R.active;
      els.play.textContent = R.playing ? '❚❚' : '▶';
      els.pick.classList.toggle('on', R.picking);

      const st = replayStatus();
      if (!R.widget || !R.ready) {
        els.status.textContent = 'Waiting for the chart to load…';
        els.clock.textContent = '';
      } else if (!st) {
        els.status.textContent = 'Replay is off. The chart shows live data.';
        els.clock.textContent = '';
      } else if (st.time == null) {
        els.status.innerHTML = 'Loading candles…';
        els.clock.textContent = '…';
      } else {
        const when = fmtTime(st.time, st.res);
        els.status.innerHTML = `Last candle: <b>${escapeHtml(when)}</b><br>${escapeHtml(st.symbol || '')} · ${escapeHtml(resLabel(st.res))} · ${st.count} revealed · ${settings.mode === 'sync' ? 'synced' : 'independent'}`;
        els.clock.textContent = fmtShort(st.time, st.res);
      }
      els.msg.textContent = R.message;
      els.msg.className = 'msg' + (R.messageKind ? ' ' + R.messageKind : '');
    },
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // ---------------------------------------------------------------------------
  // Teardown (extension disabled, removed or reloaded)
  // ---------------------------------------------------------------------------

  function teardown() {
    if (R.tornDown) return;
    try {
      if (R.active) hardStop();
    } catch (_) {
      /* keep going */
    }
    R.tornDown = true;
    clearInterval(pollTimer);
    if (R.raf) cancelAnimationFrame(R.raf);
    unhookCharts();
    if (R.datafeed) unpatchDatafeed(R.datafeed);
    removeTrap();
    if (iframeObserver) iframeObserver.disconnect();
    unhookWindow(window);
    unhookWindow(safe(() => iframeDoc().defaultView, null));
    const doc = iframeDoc();
    if (doc) {
      safe(() => doc.documentElement.classList.remove('blindreplay-mask'));
      safe(() => doc.getElementById('blindreplay-style').remove());
    }
    if (modalObserver) modalObserver.disconnect();
    for (const m of document.querySelectorAll('.blindreplay-modal-mask')) m.remove();
    if (OUT.els) for (const el of OUT.els) el.remove();
    OUT.els = null;
    safe(() => document.getElementById('blindreplay-page-style').remove());
    UI.unmount();
    document.removeEventListener('blindreplay:to-page', onFromExt);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  installTrap();
  installIframeWatch();
  toExt({ type: 'hello' });
  // Test hook (no effect in normal use): lets automated tests read state.
  Object.defineProperty(window, '__blindReplayDebug', {
    configurable: true,
    value: Object.freeze({
      state: () => ({ active: R.active, servedLive: R.servedLive, playing: R.playing, picking: R.picking, clock: engine.clock, mode: engine.mode, message: R.message, ready: R.ready, patched: !!(R.datafeed && R.datafeed[PATCHED]) }),
      start: (t) => startReplay(t),
      stop: () => stopReplay(),
      step: (n) => step(n),
      pick: () => beginPick(),
      setMode: (m) => setMode(m),
      status: () => replayStatus(),
      focusPanelField: () => UI.mounted && UI.els.jump.focus(),
      // Panel layout check. Optionally widens the date field first, the way
      // macOS fonts do, to test that the panel grows instead of overflowing.
      panelLayout: (dateMinWidth) => {
        if (!UI.mounted) return null;
        if (dateMinWidth) UI.els.start.style.minWidth = dateMinWidth + 'px';
        const wrap = UI.els.wrap;
        const wr = wrap.getBoundingClientRect();
        let maxRight = 0;
        for (const el of wrap.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width) maxRight = Math.max(maxRight, r.right);
        }
        const body = wrap.querySelector('.body');
        return { wrapLeft: wr.left, wrapRight: wr.right, width: wr.width, maxChildRight: maxRight, bodyScroll: body.scrollWidth, bodyClient: body.clientWidth };
      },
    }),
  });
})();

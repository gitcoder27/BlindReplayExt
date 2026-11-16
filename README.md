# BlindReplay

BlindReplay is a manual candle replay for Dhan's TradingView charts at <https://tv.dhan.co/> and <https://scalper.dhan.co/>. Future candles are hidden behind an opaque cover, and you reveal them one at a time, so you can decide entries and exits without seeing what happens next.

It runs entirely in your browser. It does not change anything on Dhan's servers, does not place, modify or cancel orders, and does not send any data anywhere.

## Install (Chrome, Edge, Brave and other Chromium browsers)

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the **`extension`** folder inside this project.
4. Open or reload <https://tv.dhan.co/> or <https://scalper.dhan.co/>. The BlindReplay panel appears at the top right once the chart has loaded.

You need Chrome 111 or newer. After updating the files, click the reload icon on the extension card, then reload the Dhan tab.

## Using it

1. Before you start, set the zoom and layout you like, including the number of charts, the timeframes and the candle spacing.
2. In the panel, set the **start** date and time (IST) and click **Start**. The candle at that time becomes the first hidden candle. For example, `09:15` shows everything up to the previous session's close, and the first step reveals the 09:15 candle.
   - Or click **Pick** and then click a candle on the chart. That candle becomes the first hidden one. While you pick, everything to the right of the mouse is covered, including the price axis.
3. Reveal candles with the buttons or the keyboard:

| Keys | Action |
|---|---|
| `Option` (Mac) / `Alt` + `→` / `←` | next / previous candle |
| `Option` / `Alt` + `↑` / `↓` | jump forward / back by *Jump* candles (default 10) |
| `Shift` + `Space` | play / pause (speed slider: 0.5 to 20 candles a second) |
| `Shift` + `R` | back to the start point |
| `Option` / `Alt` + `Shift` + `B` | show / hide the panel (clicking the toolbar icon also works) |
| `Esc` | cancel Pick |

The shortcuts are active only while a replay is running, and never while you are typing in a field.

**BlindReplay never uses `Shift` + arrow keys.** On scalper.dhan.co those are Dhan's order hotkeys (buy / sell), so BlindReplay leaves them alone on every site. Pressing them during a replay still places an order on Scalper.

4. Turn **Replay** off to end the replay. The chart reloads live data, and the zoom and scroll position you had before starting are restored.

### Panel settings (remembered on this device, separately for each Dhan site)

- **Synced / Independent**
  - **Synced:** one clock drives every chart. On a higher timeframe, a candle that is still forming appears only as far as time has advanced. It is rebuilt from the revealed candles of a lower timeframe of the same symbol, for example your 1m chart. If no such chart is open, only completed candles are shown. Steps follow the chart with the smallest timeframe.
  - **Independent:** each chart keeps its own position, and the buttons and keys step the active chart (the one you last clicked).
- **Anchor**: where the latest candle sits, as a percentage of the plot width (default 75%, range 50 to 95%). Everything to the right of it is solid black.
- **Follow latest**: after each step, the chart scrolls so the latest candle is back at the anchor. You can scroll left to study history; the next step brings the chart back. You can zoom while a replay runs: the anchor and the cover stay aligned.
- **Hide live-price panels**: while replaying, covers everything on the page around the chart (on Scalper: the option chain, positions, spot price and order controls; on tv.dhan.co the chart fills the window, so nothing extra), the TradingView watchlist, details, data window and news panel, the account manager (positions and P&L), the order panel, and Dhan pop-ups such as the option chain, order window and scanner. Each covered area has a **Show it anyway** button, so trading is never blocked.
- **Start blind when the page loads**: the next time tv.dhan.co loads, the replay starts before any candle is drawn, so you never see the day. It uses the latest session at the start time you used last. It is off by default and set separately for tv.dhan.co and Scalper; leave it off on days you trade live.

## How the hiding works, and what it covers

Dhan's page feeds the chart through a JavaScript datafeed. During a replay, BlindReplay sits between that datafeed and the chart: **the chart is never given any candle at or after the replay point.** To reveal the next candle, BlindReplay hands the chart that single candle; stepping back reloads the chart up to the earlier point.

Because the future candles are not in the chart at all, the following cannot leak them:

| Possible leak | Status |
|---|---|
| Hidden candles drawn, or inspectable by hovering | Not in the chart. The area is also covered in solid black. |
| Price axis auto-scaling to hidden candles | Scales only to revealed candles |
| Last-price label and line | Shows the latest revealed close |
| OHLC legend / data window | Shows revealed candles only |
| Indicators (including Dhan's chart scripts that read the chart's data) | Calculated from revealed candles only |
| Crosshair or tooltips over the hidden area | Nothing to show. The crosshair is drawn under the black cover. |
| Higher-timeframe candle still forming | Completed only, or rebuilt from revealed lower-timeframe candles |
| Live ticks during market hours | Held back while replaying (they still update the stored data, so a replay can catch up to now) |
| Quotes used by the chart (bid/ask, previous close, change %) | Replaced with values at the replay point |
| Marks on bars or the time axis | Only those before the replay point |
| Watchlist, details, account manager, order panel, Dhan pop-ups, Scalper's option chain and positions | Covered (see *Hide live-price panels*) |

Dhan's own trading code always gets live data. Requests for history or quotes that come from Dhan's scripts (the order window and so on) pass through untouched; only requests made by the chart are filtered.

## Limitations

- **Scalper is not tested while logged in.** It was tested with Scalper's own chart library (v30.0.0, loaded from scalper.dhan.co) in a page laid out like Scalper: the chart beside other panels, and the chart object kept inside Scalper's code. Things only a logged-in session shows, such as floating order buttons drawn over the chart, are not covered.
- **tv.dhan.co was not tested while logged in to Dhan either.** Testing used Dhan's real TradingView library (v31.2.0, loaded from tv.dhan.co) in Chromium, with simulated market data in place of Dhan's datafeed. The tests cover single and multi-chart layouts, both modes, the keyboard, Pick, zoom, start-blind-on-load, and restoring the chart. A few things depend on Dhan's live service and could behave differently:
  - **Long 1-minute replays:** history is requested in 7-day pieces, as when you scroll the chart back. If Dhan limits how far back 1m data goes, a replay starting before that limit has no candles.
  - **Symbol names:** each chart is matched to its data by symbol name. If a name does not match, Synced mode still works, but Independent mode cannot step that chart (the panel says so).
  - **Library updates:** if Dhan moves to a new TradingView library version, re-run the end-to-end test below.
- **Position and order lines on the chart** come from Dhan's broker connection, which BlindReplay does not touch. A position line can show live P&L. If you hold a position in the symbol you are replaying, turn off positions and orders in the chart settings, under the Trading tab.
- **Dhan indicators that fetch their own data** from Dhan servers, rather than from the chart (open-interest or option-chain based studies, the live scanner), can show values from after the replay point. Remove them during a replay.
- **When you click Start, the chart reloads.** For that split second the panes are blacked out, but the price axis can still show the old range. To avoid this, use *Start blind when the page loads*, or start before scrolling to the day you want to study.
- **Pick happens on the live chart.** The area right of the mouse is covered, but you can see the chart wherever the mouse has been. If you want to see nothing, type the start time instead.
- **The time axis** under the black area still shows time labels (times only, no prices).
- **Independent mode:**
  - Two charts with the same symbol and timeframe share one position.
  - Compare and overlay symbols follow the chart you stepped most recently.
- **Unsupported chart types:** tick-based and range-based charts are not supported; those charts are fully covered during a replay.
- **Hidden candles are still in memory.** They are held in the page's memory so the next step is instant. They are not visible on the page, but browser developer tools could read them.
- **IST only:** start times and displayed times are in IST (Asia/Kolkata), as on Dhan's charts.

## Privacy and permissions

- The only permission is `storage`, used to remember panel settings on your device.
- There are no external services, analytics or remote code.
- The extension makes no network requests of its own. The only requests during a replay are chart-history requests through Dhan's own datafeed, the same ones made when you scroll the chart.
- The extension runs only on `tv.dhan.co`, `scalper.dhan.co` (and `tradingview.dhan.co`).
- If you disable, remove or reload the extension while the tab is open, it restores the chart and its data feed and removes its panel, covers and styles.

## Project layout

```
extension/            load this folder in Chrome
  manifest.json
  src/engine.js       replay clock, candle visibility, forming-candle rebuild (pure logic)
  src/page.js         datafeed hooks, chart control, covers, masks, keyboard, panel
  src/bridge.js       settings storage; restores the page if the extension goes away
  src/background.js   toolbar button shows/hides the panel
test/engine.test.js   unit tests:  node --test test/engine.test.js
test/e2e/             browser test with Dhan's real chart library and a fake feed
```

To run the end-to-end test (it downloads Dhan's public chart library files from tv.dhan.co or scalper.dhan.co while it runs):

```
cd test/e2e
npm install
npx playwright install chromium   # first time only
node e2e.mjs                      # on a Linux server without a display: xvfb-run -a node e2e.mjs
SITE=scalper node e2e.mjs         # the same checks against scalper.dhan.co's library and layout
```

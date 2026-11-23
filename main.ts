// Cash-default momentum rider for the make.fun BTC race (bars-replay/v1, CBBTC/USDC, 1-minute bars).
//
// A full-size round trip costs about 26 bps once the 4 bps fee, 2 bps of modelled slippage and the
// constant-product price impact against the pool are all counted, so a trade only earns its keep
// when it rides a move several times that size. The bot therefore holds cash most of the day and
// buys only when the tape itself says a real thrust is under way, then banks the thrust instead of
// sitting through the fade. Every threshold below is a round number that sat on a flat plateau in
// local measurement, not a tuned spike.
//
// Entry, all judged on the same bar's close, while flat:
//   - short trend up: EMA(10) above EMA(60);
//   - the move is already material: trailing 60-bar return of at least +50 bps, more than twice
//     the cost of a round trip, so it is a move and not one-minute noise (returns run ~8 bps stdev);
//   - momentum is real but not a blow-off: RSI(14) between 45 and 78;
//   - not a pop inside a collapse: trailing 240-bar return no worse than -150 bps, once 240 bars
//     of history exist (before that the other four conditions carry the entry);
//   - the market is moving enough to clear costs: stdev of the last 60 one-minute returns at
//     least 6.5 bps.
// Size is 80% of cash, so a single stopped trade dents the account by well under 1% (the race
// guardrail is a 25% maximum drawdown; this bot's stops bind far earlier). Every order carries
// max_slippage_bps 300: wide enough that ordinary impact never rejects a fill, tight enough that a
// gap through the close refuses it.
//
// Exits, whole position, judged on the position's value at the latest close against its cost
// including fees, exactly as the account reports it:
//   - stop at -70 bps: a failed thrust is cut before it becomes a slide;
//   - take-profit at +90 bps: bank the thrust;
//   - trailing: once the peak gain reaches +60 bps, sell when the gain falls 35 bps under the peak;
//   - time stop: held 360 bars with less than +15 bps to show, the thesis did not play out.
// After any exit the bot rests for 30 bars, and it never opens more than 8 round trips in a window.
// No orders at all in the first 130 bars, while the indicators warm up.
//
// Deterministic by construction: float64 arithmetic only, no clock, no randomness, no environment.

import { runBars, type Bar, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const WARMUP = 130;
const FAST = 10;
const SLOW = 60;
const MOM_BARS = 60;
const MOM_MIN = 50;
const VETO_BARS = 240;
const VETO_MIN = -150;
const RSI_LOW = 45;
const RSI_HIGH = 78;
const VOL_BARS = 60;
const VOL_MIN = 6.5;
const SIZE = 0.8;
const STOP = -70;
const TAKE = 90;
const TRAIL_ARM = 60;
const TRAIL_GIVEBACK = 35;
const MAX_HOLD = 360;
const TIME_MIN = 15;
const COOLDOWN = 30;
const MAX_TRIPS = 8;
const SLIP = 300;
// The window is 1,440 bars and anything still held at its end is flattened at the last close,
// so a position opened in the final 90 bars has almost no time to reach a take-profit and mostly
// pays the flatten cost instead. No new entries from bar 1,350 on.
const LATE_CUTOFF = 1350;

// Indicator state, updated once per CBBTC bar, in batch order.
const closes: number[] = [];
let prevClose: number | null = null;
let emaFast: number | null = null;
let emaSlow: number | null = null;
let gainAvg: number | null = null;
let lossAvg: number | null = null;
let rsi: number | null = null;
const rsiSeed: number[] = [];
const rets: number[] = [];
let retsSum = 0;
let retsSq = 0;

// Position state, mirrored from the account the harness reports each batch.
let entrySeq: number | null = null;
let peakBps = 0;
let restUntil = -1;
let trips = 0;

function noteBar(bar: Bar): void {
  const c = Number(bar.c);
  if (prevClose !== null) {
    const change = c - prevClose;
    if (gainAvg === null || lossAvg === null) {
      rsiSeed.push(change);
      if (rsiSeed.length === 14) {
        gainAvg = rsiSeed.reduce((a, x) => a + (x > 0 ? x : 0), 0) / 14;
        lossAvg = rsiSeed.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / 14;
      }
    } else {
      gainAvg = (gainAvg * 13 + (change > 0 ? change : 0)) / 14;
      lossAvg = (lossAvg * 13 + (change < 0 ? -change : 0)) / 14;
    }
    if (gainAvg !== null && lossAvg !== null) {
      const moved = gainAvg + lossAvg;
      rsi = moved === 0 ? 50 : (100 * gainAvg) / moved;
    }
    const r = (c / prevClose - 1) * 10000;
    rets.push(r);
    retsSum += r;
    retsSq += r * r;
    if (rets.length > VOL_BARS) {
      const old = rets.shift()!;
      retsSum -= old;
      retsSq -= old * old;
    }
  }
  prevClose = c;
  emaFast = emaFast === null ? c : emaFast + (2 / (FAST + 1)) * (c - emaFast);
  emaSlow = emaSlow === null ? c : emaSlow + (2 / (SLOW + 1)) * (c - emaSlow);
  closes.push(c);
}

function pastReturn(bars: number): number | null {
  if (closes.length <= bars) return null;
  return (closes[closes.length - 1]! / closes[closes.length - 1 - bars]! - 1) * 10000;
}

function volNow(): number | null {
  if (rets.length < VOL_BARS) return null;
  const mean = retsSum / VOL_BARS;
  const variance = retsSq / VOL_BARS - mean * mean;
  return variance > 0 ? Math.sqrt(variance) : 0;
}

await runBars({
  onBatch(state, batch) {
    let sawBar = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      noteBar(bar);
      sawBar = true;
    }
    if (!sawBar || state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      if (entrySeq === null) {
        entrySeq = state.seq;
        peakBps = 0;
      }
      const gain = (Number(state.value(SYMBOL, held.qty)) / Number(held.cost) - 1) * 10000;
      if (gain > peakBps) peakBps = gain;
      const heldFor = state.seq - entrySeq;
      const shouldExit =
        gain <= STOP ||
        gain >= TAKE ||
        (peakBps >= TRAIL_ARM && gain <= peakBps - TRAIL_GIVEBACK) ||
        (heldFor >= MAX_HOLD && gain < TIME_MIN);
      if (!shouldExit) return [];
      entrySeq = null;
      peakBps = 0;
      trips++;
      restUntil = state.seq + COOLDOWN;
      const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SLIP };
      return [sell];
    }

    entrySeq = null;
    if (state.seq < WARMUP || state.seq >= LATE_CUTOFF || state.seq < restUntil || trips >= MAX_TRIPS) return [];
    const mom = pastReturn(MOM_BARS);
    const veto = pastReturn(VETO_BARS);
    const vol = volNow();
    if (mom === null || vol === null || rsi === null || emaFast === null || emaSlow === null) return [];
    const thrust =
      emaFast > emaSlow &&
      mom >= MOM_MIN &&
      (veto === null || veto >= VETO_MIN) &&
      rsi >= RSI_LOW &&
      rsi <= RSI_HIGH &&
      vol >= VOL_MIN;
    if (!thrust) return [];
    const notional = (state.cash * BigInt(Math.round(SIZE * 1000))) / 1000n;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: SLIP };
    return [buy];
  },
});

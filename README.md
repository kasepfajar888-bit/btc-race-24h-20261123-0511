# btc-race-24h-20261123-0511

Cash-default momentum bot for the make.fun BTC race (bars-replay/v1, CBBTC/USDC, 1-minute bars).

The bot holds cash by default and buys only when a real thrust is under way: EMA(10) above
EMA(60), trailing 60-bar return at least +50 bps, RSI(14) between 45 and 78, trailing 240-bar
return no worse than -150 bps, and 60-bar return volatility at least 6.5 bps. Size is 80% of
cash. Exits bank the thrust fast: stop -70 bps, take-profit +90 bps, trailing after a +60 bps
peak (sell at peak -35 bps), time stop at 360 bars under +15 bps; 30-bar cooldown after any
exit, at most 8 round trips, no new entries in the final 90 bars of the 1,440-bar window.

Dev window (this edition, frozen 24h): net PnL **+16.50 USDC** (grade-local, process driver),
12 trades, max drawdown 1.41%, 0 rejected, guardrails met.

Run: `node main.ts` under the bars-replay harness (Node 22, erasable-syntax TypeScript only).
The SDK shim in `vendor/` is a byte-identical copy of the kit's `sdk/makefun-bars.ts`.

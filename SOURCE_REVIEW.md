# BTC Window source review

Reviewed `src/components/btc/terminal.tsx` and its model, price feed, snapshot, chart, pulse, and evaluation dependencies. This is a source review and code change, not a review or deployment of a running website.

## Assessment of the original version

**7/10 as a research dashboard concept; 4/10 for prediction/evaluation engineering. Actual forecast accuracy is unknown.** These are subjective source-level ratings, not measured trading performance or a visual browser audit.

Strengths: clear live-price hierarchy, understandable movement intervals, independent spot feed, restrained dark palette, and honest statements that order flow and radar are contextual rather than trained model features.

Highest-impact weaknesses:

- The model used forming candles, all loaded history rather than a defined volatility horizon, and candle counts without continuity checks.
- The bounded tanh score was only loosely connected to distance and time remaining. Missing targets and stale inputs could still yield directional output.
- Comparable windows were selected by their eventual move, not features available at prediction time; the count did not actually contribute to the probability.
- The main start line could silently change from Coinbase open to a Kalshi strike. Saved calls were nevertheless scored using Coinbase candle closes.
- First-visit recording mixed predictions made early and late in the window. The probability score excluded WAIT observations and records lacked a model version.
- Cached Kalshi quotes received a fresh timestamp on each snapshot response. Sparse seeded candle prices could be presented as second-resolution moves.
- Acceleration compared overlapping intervals incorrectly; VWAP weighted by dollar notional instead of BTC volume; missing 15-minute history was labeled low volatility.

## Implemented changes

1. A transparent candidate baseline: normal-CDF terminal-price model using signed log distance, remaining time, 60 completed one-minute returns with a modest recent-volatility blend, and lightly weighted momentum. Probabilities shrink toward 50%. This is an unvalidated candidate, not a fitted or demonstrably superior model.
2. Historical analogs selected by signed normalized gap and volatility at the same elapsed-minute bucket, from earlier complete windows only. At least 20 matches are required to blend an empirical rate. Up to 900 candles are bootstrapped; older pages are reused between polls. Sparse or failed backfills do not create fake observations.
3. Explicit pause reasons for missing/stale spot timestamps, missing target, discontinuous/stale history, closed markets, and unavailable official BRTI inputs during the settlement minute. A stale book cannot generate a WATCH signal. Fee calculations retain an explicitly labeled 2-cent assumption plus 1-cent buffer, not a verified fee schedule.
4. The main forecast consistently targets **Coinbase close strictly above Coinbase window open**. Kalshi strike/rules and prices remain separately labeled context. No fee edge is inferred by comparing these different targets. No orders are sent.
5. Immutable, versioned local forecasts recorded only at T+30–60s. Late visits are skipped. Settlement proceeds even when the new window's model is paused. Exact touch is NO for this explicitly strict spot target. Old records remain in their old storage key and are excluded from v2 scoring.
6. Brier score and log loss include WAIT observations; directional accuracy states its denominator; calibration buckets show sample counts. Storage failure is visible. Model method, settlement distinction, feed ages, and a final-minute state are visible.
7. Corrected quote cache age, request timeouts, stale order-book handling, sub-minute seeded-history handling, acceleration, VWAP, and missing-history labels. The chart's previously unused shading overlay now renders.
8. Regression tests and a repaired dependency lockfile so a clean installation can succeed.

## Validation and limits

- BTC regression tests cover completed candles, continuity, missing inputs, stale feeds, expired markets, direction monotonicity, fee gates, settlement mode, frozen recording, exact touch, WAIT scoring, and corrupt/old records.
- Validation passed: 263 tests (including 13 BTC regressions), TypeScript typecheck, production build, and git whitespace checks. No hosted website was changed.
- Existing repository tests are also run. The execution sandbox initially hid subprocess output; running the tests outside that restriction resolved those failures.
- No out-of-sample market dataset or official second-by-second BRTI feed is included. **There is no evidence yet that v2 improves hit rate, calibration, or net returns.**
- Live provider availability, browser rendering, and production behavior have not been verified in a running application during this source-only review.
- Local browser records are user-editable, limited to 1,000 observations, and biased toward times the tab was open. They are not an audited track record or a complete market backtest.
- Historical analogs are approximate minute buckets; the model does not estimate an official 60-print BRTI settlement average. The 2-cent fee parameter is an assumption, and slippage is not modeled beyond the buffer.

## What would establish better accuracy

Keep v2 frozen, collect predictions before outcomes, and compare on a later held-out time range against 50/50, a no-momentum distance/volatility baseline, and a time-matched market midpoint for the **same target**. Report Brier/log loss, reliability buckets, directional coverage and confidence intervals, with results separated by hour and volatility regime. Tune on earlier data only. Official Kalshi validation needs recorded official strikes/rules, quotes and settlement results; spot closes cannot substitute for those labels. Promote an additional feature only after it improves held-out performance across more than one period.

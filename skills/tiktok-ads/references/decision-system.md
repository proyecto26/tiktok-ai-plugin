<!-- Adapted from marketingskills (MIT, (c) 2025 Corey Haines), skills/ads/references/meta-decision-system.md, through instagram-ai-plugin; retargeted to TikTok Ads Manager. -->

# Kill / keep / scale decision system (TikTok Ads Manager)

Dated 2026-11-22. Every number is a starting point taken from practitioner rules, **not a TikTok rule: verify it
against your own account and recalibrate after 30 days.** `decide --csv` applies exactly the numbers in
`thresholds.json`; this file explains them.

## The anchor: target CPA

Every rule is a multiple of one number, the **target cost per acquisition** (the most you can pay for the
conversion you optimise for and still profit). Set it from deal math (price x margin x expected repeat), or from
history (trailing 30-day CPA x 0.8). Without it `decide` can only judge delivery and fatigue, never cost.
Pass it as `--target-cpa`. It is the user's number: do not invent one.

## Thresholds used by `decide`

| Name | Value | Meaning |
|---|---|---|
| `gate_multiple` | 3 | spend under 3x the target CPA = `wait`: too early. At the true CPA 3x spend buys about 3 conversions; zero conversions at that spend is rare enough to act on |
| `kill_multiple` | 1.5 | CPA above 1.5x target = `kill`. Between 1x and 1.5x is normal variance: `keep` and watch another week |
| `scale_multiple` | 0.8 | CPA at or under 0.8x target = `scale` candidate |
| `scale_min_conversions` | 10 | a scale candidate needs at least this many conversions, or it stays `keep` (CPA on 3 conversions is noise) |
| `frequency_warning` | 2.5 | above this, scaling is blocked and `fatigue_warning` is flagged |
| `frequency_critical` | 4 | above this the concept is saturated: `kill`, brief a new concept |
| `ctr_floor_pct` | 0.4 | CTR under this is flagged `ctr_below_floor`: the hook is weak |
| `cpm_high_multiple` | 1.5 | CPM above 1.5x the batch median is flagged `cpm_high` (needs 3 or more ads) |
| `no_target_min_impressions` | 5000 | without a target, under this many impressions = `wait` |

Order of evaluation, first match wins: no spend column -> `unknown`; under the data gate -> `wait`; no
conversions and no CPA column (with a target) -> `unknown`; critical frequency -> `kill`; no target -> `keep`;
zero conversions at or past the gate -> `kill`; CPA ratio rules above.

Fatigue bands (cold prospecting; retargeting tolerates higher): safe up to 2.5, warning 2.5 to 4, critical above 4.
CTR falling 20% or more over 7 days, CPM rising 30% or more over 2 weeks, and CPA rising with stable targeting are
the other signs; the export is a snapshot, so ask for two periods when you need them.

## What a verdict means for the user

- **scale**: in Ads Manager raise the budget about 20% and wait 3 to 5 days before another step. A jump of 30% or
  more can restart learning. After a step, if CPA goes above 1.5x target, cut back 20 to 30% and hold two weeks.
- **keep**: change nothing. Never edit the creative of a performing ad (it restarts learning); add new ads beside it.
- **kill**: pause it in Ads Manager, but only with a replacement ready (never leave an ad group empty). What to
  change depends on the reason: saturated audience -> a new concept; no conversions -> the offer, landing page or
  audience before the hook; high CPA with a good CTR -> the landing page or offer.
- **wait**: leave it. Re-run after the spend passes the gate. An ad with almost no spend after 7 days was
  deprioritised by delivery: treat it as a creative verdict (hook and first frame), not a budget one.
- **unknown**: the export lacked what the rule needs. Read `missing` and ask for those columns.

## Learning phase

An ad group needs enough conversion events to stabilise; TikTok has described about 50 optimisation events within
7 days (verify, it varies by objective and region). If the budget cannot reach that at the target CPA, optimise a
higher-volume event (add to cart instead of purchase) and judge on the real one.

## Creative volume and weekly cadence

Ship many distinct concepts at low cost; variants of one idea count as one concept. Plan on roughly one winner in
six new concepts (a practitioner figure, verify on your own data). Monday: run `decide` on 14-day data. Midweek:
launch replacements into freed slots. Friday: apply scale steps or roll back. Monthly: review the target CPA.

## Export columns `decide` understands

Ad name (or Ad, Nombre del anuncio), Cost / Spend / Coste, Impressions, Clicks (destination) / Clicks, CTR, CPM,
Conversions / Results, CPA / Cost per conversion / Cost per result, Frequency. Other languages are reported under
`columns.missing`; rename the header and run again. Currency symbols, thousands separators (`1,234.50` and
`1.234,50`), percent signs and `-` for empty are handled; a total row is skipped; a daily breakdown (the same ad
on several rows) is added together, and CTR, CPM and CPA are then recomputed from the sums.

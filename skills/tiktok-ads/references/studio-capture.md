# Studio capture: endpoints, shapes and how each field is read

Seen live on 2026-11-22 (owner's account; one page load per page; shapes only). The hook
`skills/tiktok/scripts/browser/studio-capture.js` copies the answers of these requests that the Studio page
already makes, and writes `tt.studio-capture.v1`. All requests are GET. Nothing is sent by the hook.

## Allowlist

| Path | Page | Meaning |
|---|---|---|
| `/aweme/v2/data/insight/` | analytics | series and totals; the `type_requests` query lists what was asked |
| `/tiktok/v1/analytics/insights/` | analytics | overview blocks; `insight_type` 82 is the rewards overview, 126 was seen and is not interpreted |
| `/tiktok/v1/creator/m10n_center/all_programs` | monetization | programs in three groups |
| `/tiktok/v1/creator/m10n_center/settings` | monetization | currencies and the selected one |
| `/tiktok/v1/creator/m10n_center/reward_analytics` | both | shape not recorded: only its field names are listed |

Any other path is ignored. A 429 or "too many attempts" message marks `rateLimited`; a 401/403, a captcha or an
HTML answer marks `challenge`. The parser refuses both.

## What the capture keeps and drops

Kept: metric fields, program fields (`name`, `description`, `m10n_project`, `requirements_met`,
`total_requirements`, `is_access_restricted`, badge labels, list membership), amounts and currency, the route
(page path) each answer was seen on, and the `type_requests` query parsed as JSON (it names the metrics asked).
Dropped: every URL (apply, program, icon, restriction links), `logid`, `impr_id`, `log_pb`, `extra`, and every
other query parameter (`msToken`, `X-Bogus`, device ids). Identical requests keep only the latest answer.

## Insight answers

`type_requests` is a JSON list whose type key is misspelled by TikTok, `insigh_type`:
`[{"insigh_type":"vv_history","days":60,"end_days":1}, ...]` for `vv_history`, `pv_history`, `like_history`,
`comment_history`, `share_history`, `follower_num_history`, `reached_audience_history`. Each answer key holds
`[{status, value}]`, one point per day.

- **Two periods.** 122 points were seen for a 60-day request: `2 x days + 2`. The reader takes the first
  `days + 1` points as the previous period and the last `days + 1` as the current one (oldest first). Any other
  length is one period with no previous. This is an inference from the length, not documented: if a capture ever
  disagrees (for example a different length for a known range), say so.
- `status` values seen are reported as `status_values`; the reader does not filter on them.
- `follower_num_history` is read as a running follower count: reported as first, last and change, not summed.
- `vv_traffic_source` (7 days) and `user_search_terms` -> `{status, value:[{key, str_value, value}]}`.
- `unique_viewer_num`, `follower_num` (a range) -> `{status, value:number}`.
- `incentive_vv` answered `{status}` only on an account that is not eligible: reported as unavailable.
- Other keys in an answer are empty or unrequested objects and are dropped.

## Rewards overview (`insight_type` 82)

`analytics_overview_rewards{ total{amount, currency_code, currency_symbol}, delta_change, percent_change{value},
list:[{name, value{amount}}] }`. `amount` may be a string; it is read as a number. The list was 60 items long
(a daily series).

## Monetization

`all_programs` -> `active_m10n_programs[]`, `eligible_to_apply_m10n_programs[]`, `ineligible_to_apply_m10n_programs[]`.
`settings` -> `all_currencies[{code, display_name, symbol}]`, `selected_currency{code}`.

## Not exposed by these pages

Account age, region, per-policy qualified views, per-post Studio analytics. They are `unknown` or `unavailable`
in every command, with the reason.

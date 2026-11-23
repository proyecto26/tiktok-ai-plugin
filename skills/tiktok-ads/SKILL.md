---
name: tiktok-ads
description: Read-only strategist for TikTok monetization and paid promotion. It reads the owner's own TikTok Studio analytics and monetization pages (a capture of the owner's browser, no TikTok API app), checks Creator Rewards eligibility criterion by criterion, summarises overview metrics (current vs previous period, traffic sources, search terms, rewards), groups monetization programs, and makes kill, keep and scale decisions per ad from an exported Ads Manager CSV. It never creates, boosts, promotes or pauses anything. This skill should be used when the user asks "am I eligible for Creator Rewards", "why am I not monetized on TikTok", "what do my TikTok Studio analytics say", "which TikTok programs can I join", "which post should I promote or Spark Ad", "should I kill or scale this TikTok ad", "is my TikTok ad working", "write TikTok ad copy", "TikTok Shop affiliate", or shares an Ads Manager export.
---

# TikTok ads and monetization (the strategist)

Use the account's own numbers to say what is true, what is probably true, what is not known, and what to do. All
commands are offline CLI commands that read files and print JSON. Nothing here is a TikTok client.

## What this skill can and cannot do

- **Can:** read captures and exports you give it, compute eligibility, summarise analytics and monetization,
  decide kill/keep/scale per ad, write ad copy and briefs from `references/`.
- **Cannot, and never does:** create, edit, boost, promote, pause or fund anything. Promote (in the TikTok app or
  Studio), Spark Ads and Ads Manager use TikTok's business systems and payment methods. The user makes every
  change in the app or in Ads Manager; give them exact settings to enter.
- Never estimate a number that is not in the data. Say **unavailable** and the reason, or **unknown**.
- Policy figures (follower and view minimums, regions, thresholds) are dated 2026-11-22 and change often: say
  "verify" when quoting one.

Run every command from the plugin folder as `npx -y bun skills/tiktok-ads/scripts/main.ts <command> ...`.
Each prints one JSON object with `ok`. On failure it prints `{ok:false, error, message}` and exits 1; exit 2 is a
usage error. If a capture reports `rate_limited` or `challenge`, stop, tell the owner, and do not capture again
that day.

## 1. Capture the Studio pages (a browser tool that can run JavaScript in the page)

TikTok Studio signs its own API calls, so the data is read from the owner's normal, signed-in browser, never
fetched by a script.

1. Open `https://www.tiktok.com/tiktokstudio/analytics` in one tab. Wait for the charts to load (about 10 s).
2. Run the text of `skills/tiktok/scripts/browser/studio-capture.js` in the page. It installs a read-only hook
   (it never clicks, scrolls or sends a request) and returns a `tt.studio-capture.v1` JSON string. Run it once
   right after the load and once more after the charts have loaded: the second run collects the answers.
3. Save the returned JSON to a file in the owner's project folder, for example `studio-analytics.json`.
4. Repeat for `https://www.tiktok.com/tiktokstudio/monetization` -> `studio-monetization.json`.
5. For eligibility also save the profile read: `npx -y bun skills/tiktok/scripts/main.ts profile --capture <profile
   capture> > profile.json` (see the `tiktok` skill).

Pace: one tab, one page load at a time, at least 60 seconds between page loads. A captcha, a "Please wait" page,
HTTP 403 or 429 means stop. If the browser tool cuts a long returned string (some cut near 1,000 characters), read
it out in pieces and rebuild the file locally; say so. The capture keeps metric and program fields and drops every
URL, log id and signing token.

## 2. Commands

| Command | Input | Output (JSON) |
|---|---|---|
| `eligibility --profile profile.json [--studio f]... [--age N] [--region XX]` | profile read; optional Studio captures (repeat `--studio` or comma-separate) | `criteria[]` (`followers`, `views_30d`, `age`, `region`) each `met` / `not_met` / `unknown` with `actual`, `required`, `source`, `note`; `program` (listed, or `unavailable`); `verdict`; dated `policy` |
| `analytics --studio f` | analytics capture | `metrics` (views, profile_views, likes, comments, shares, follower_growth, reached_audience: `current`, `previous`, `change`), `traffic_sources`, `search_terms`, `unique_viewers`, `followers`, `incentive_views`, `rewards`, `per_post`; each missing part is `{unavailable, reason}` |
| `monetization --studio f` | monetization capture | `programs` grouped `active` / `eligible` / `ineligible` (name, `requirements_met` of `total_requirements`, `restricted`, badges), `counts`, `currency` |
| `decide --csv export.csv [--target-cpa N]` | Ads Manager CSV export | per ad `verdict` (`scale` / `keep` / `kill` / `wait` / `unknown`), `reasons`, `flags`, `missing`, `derived`; `summary`, `columns.missing`, `thresholds` |
| `report [--profile] [--studio]... [--csv] [--audit] [--target-cpa N] [--markdown]` | any of the above, plus `tiktok-audit ... --json` | `facts`, `hypotheses`, `missing`, `actions`, `markdown`; `--markdown` prints only the note |

Reading the output:

- **Creator Rewards** (`references/creator-rewards.md`): followers come from the profile read; 30-day views are
  the last 30 daily points of `vv_history` (all views, an upper bound: the program counts qualified views only);
  age and region are `unknown` unless the user states them. If the program is not in any list of the monetization
  page, `program` is `unavailable: not offered to this account or region` and `verdict` is `unavailable`. Do not
  promise eligibility on `met`: it means the numbers pass, TikTok decides.
- **Analytics**: `previous` exists only when the series holds two whole periods (2 x days + 2 points, previous
  period first); otherwise it is `unavailable` and there is no percentage. A percentage over a zero base is `null`.
- **decide**: exports vary. Headers are matched in English and Spanish; CTR, CPM and CPA are derived when absent
  (`derived`); rows with the same ad name are added together; total rows are skipped; currency strings such as
  `$1,234.50` and `1.234,50 EUR` and `1,50 %` parse. Without `--target-cpa` nothing is scaled or killed on cost
  (`missing: target_cpa`). Thresholds are in `references/decision-system.md` and `references/thresholds.json`.

## 3. Choose what to promote, then decide

1. Shortlist organic posts from the `tiktok-audit` skill (3x or more of the account's own median). A post that
   already beats the median organically is the cheapest creative test. Prefer hooks that work with the sound off.
2. For Spark Ads, Promote, campaign structure and creative rules read `references/tiktok-ads-playbook.md`; for
   copy `references/ad-copy-templates.md`; for audiences `references/audience-targeting.md`.
3. After 7 to 14 days of data, ask the user to export the ad level report from Ads Manager as CSV (spend,
   impressions, clicks, CTR, CPM, conversions, CPA, frequency) and a target CPA, then run `decide`.
4. For monetization beyond Creator Rewards (LIVE, subscriptions, Creator Marketplace, TikTok Shop affiliate) read
   `references/monetization-programs.md`.

## 4. Output format

End every recommendation with these four blocks (`report` writes them for you):

```
FACTS        what the numbers show, each with its source and date range
HYPOTHESES   what probably explains it, with a confidence (high, medium, low)
MISSING      inputs not provided or not visible, and what each would change
ACTIONS      exact changes for the user to make in the app or Ads Manager, in order
```

## References

- `references/creator-rewards.md`, `references/creator-rewards.json`: criteria, dated.
- `references/monetization-programs.md`: Studio programs and TikTok Shop affiliates, dated.
- `references/studio-capture.md`: endpoints, response shapes and how each field is read.
- `references/tiktok-ads-playbook.md`: Spark Ads, Promote, Ads Manager structure, creative-led delivery.
- `references/decision-system.md`, `references/thresholds.json`: kill / keep / scale rules and numbers.
- `references/ad-copy-templates.md`, `references/audience-targeting.md`: copy formulas and audiences.

Credits: the decision, copy and audience references are adapted from marketingskills `ads` (MIT, Corey Haines) through
instagram-ai-plugin; see the plugin's THIRD_PARTY_NOTICES.md.

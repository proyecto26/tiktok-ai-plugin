---
name: tiktok-audit
description: Audits a TikTok account from the tiktok skill's own reads (a capture of the owner's Chrome, no third-party scraping service, no API app), covering format mix, video length, cadence, hashtags, outlier and underperforming posts and a profile score, with an honest note on what only TikTok Studio analytics can show and on whether the read covers the whole account or a sample. This skill should be used when the user asks to "audit my TikTok", "why are my TikTok views down", "which TikTok videos performed best", "what length works on my TikTok", "how often should I post on TikTok", "score my TikTok profile", "analyze @someaccount on TikTok", or shares saved audit JSON and wants it interpreted.
---

# TikTok audit

Turn the account's own numbers into a short list of claims with evidence attached, each with a confidence and one
action. Compare each post with the account's own median, never raw plays across accounts.

This skill reads only the `tiktok` operator's output files. It makes no request of its own.

## 1. Read the data with the tiktok skill

Open the profile page in the owner's Chrome, scroll the grid as far as the audit should reach, and make a capture with
the `tiktok` skill (`scripts/browser/capture.js`). Then, from `../tiktok`:

```bash
npx -y bun scripts/main.ts videos  --capture <capture.json> --limit 200 --json > "<project-dir>/tiktok-videos.json"
npx -y bun scripts/main.ts profile --capture <capture.json> --json            > "<project-dir>/tiktok-profile.json"
```

`<project-dir>` is the owner's working folder, never the plugin folder. If the operator reports an account signal
(captcha, verification, rate limit), stop and report it; the owner resolves it in the browser and runs `resume`.

## 2. Audit

From this skill's directory:

```bash
npx -y bun scripts/main.ts audit --videos "<project-dir>/tiktok-videos.json" --profile "<project-dir>/tiktok-profile.json" [--json]
```

Read `coverage` first. `scope: "account"` only when the operator confirmed it read the whole list
(`exhausted: true`). Otherwise it is `"sample"` with the reason (the limit, more pages, an error page, dropped
items), and every finding says "in a sample of N posts", never "on this account". Duplicate posts count once.
An empty read stops with `no_posts`.

| Field | Use |
|---|---|
| `medians`, `engagementRate` | the baseline; saves appear only when the page showed them |
| `posts[].multiple` | plays over the median: 3x+ a hit, 0.5x or less underperformed |
| `byFormat`, `byDuration` | buckets with `n`; under 3 is insufficient data, never a finding |
| `cadence` | posts a week and the longest gap |
| `hashtags` | per tag, posts and median plays |

## 3. Find the pattern, in this order

1. **Hits vs misses.** Put the top 5 and bottom 5 by multiple side by side: the hook (first caption line, or the
   on-screen hook the owner describes), format, length, sound, theme. Score hooks with
   `npx -y bun ../tiktok-content/scripts/hook-score.ts --hook "<line>"` when useful; to see how a hit was built,
   `tiktok-video-breakdown`.
2. **Length and format**, by median rate and median plays.
3. **Cadence.** A long gap usually explains a "views drop" better than anything else.
4. **Hashtags**, last and only with solid n.

State each finding with its evidence (numbers, n, example posts) and a confidence (high, medium, low). A dozen posts
can hint at a pattern; three cannot, so say that instead of inventing one.

## 4. Score the profile

Score `tiktok-profile.json` (name, bio, verified, counts) against **`references/profile-rubric.json`** (12 items,
100 points). Items the read cannot show (pinned videos, playlists, covers, photo) are scored from a screenshot or the
owner's description, or marked "not checked". Score strictly. Write replacement copy for the 3 lowest items. Profile
edits happen in the app; this plugin does not change profiles.

## 5. Output

```
TIKTOK AUDIT · @handle · sample of 48 posts (limit) · 2026-08-01 to 2026-11-01
Baseline: median 3.2k plays, rate 6.1%
Profile score: 44/100

FINDINGS
1. Videos under 15 s outperform: median 5.9k plays (n=11) vs 2.4k (n=29) for 15-60 s. Confidence: medium.
   Action: four videos under 15 s in the next two weeks, then re-run this audit.

NOT VISIBLE FROM THE READ
watch time, retention, traffic source, followers per post -> paste TikTok Studio analytics to sharpen findings.
```

Keep it to 3 to 5 findings, one action each, and a re-audit date. Definitions: **`references/metrics.md`**.

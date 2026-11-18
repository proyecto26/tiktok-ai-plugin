<!-- Metric framework adapted from instagram-agent-skill (MIT, (c) 2026 Jake Schincariol), ig-audit, through
     instagram-ai-plugin. TikTok definitions by tiktok-ai-plugin. -->

# Metrics

## From the operator's read (`audit`)

| Metric | Definition | Notes |
|---|---|---|
| Plays | the post's play count as TikTok shows it | counts replays; not unique viewers |
| Engagement rate | (likes + comments + shares + saves) / plays, per post, then the median | posts with 0 plays are left out; saves only when the page shows them, never counted as 0 |
| Multiple | post plays / account median plays | 3x or more is a real hit; 0.5x or less underperformed |
| By format | videos vs photo posts | photo posts have no duration |
| By duration | videos under 15 s, 15-60 s, over 60 s | a bucket with n < 3 is "insufficient data" |
| Cadence | posts per week across the read; longest gap in days | |
| Hashtags | per tag: posts and median plays | usually minor |
| Coverage | `account` only when the operator read the whole list (`exhausted: true`), else `sample` with the reason | a sample never supports "the account" claims |

## Only in TikTok Studio analytics (ask the owner for screenshots)

| Metric | Why it matters |
|---|---|
| Average watch time and watched-full-video share | whether the middle worked |
| Retention graph | grades the hook: where viewers leave in the first seconds |
| Traffic source (For You, profile, search, sound, following) | whether a post travelled beyond followers |
| New followers per post | whether the profile converted the attention |
| Audience territories and active hours | when to post, from real data instead of guesses |

Rank by multiple and by what Studio shows for retention and shares, never by raw plays across accounts.

## Rough benchmarks (directional only)

Rates vary widely by niche and account size. The account's own median is the only reliable baseline; compare a post
with it, not with another account.

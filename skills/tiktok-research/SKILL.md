---
name: tiktok-research
description: Researches a TikTok niche from pages the owner opens in their own Chrome (a hashtag page, a sound page, a creator's profile), with no third-party scraping service and no API app, finding per-creator outlier videos (3x the creator's own median plays, at least 8 posts), the sounds and hashtags that recur across a niche, and the hooks and formats behind the winners, plus a fit check before riding a trend. This skill should be used when the user asks "what is working in my niche on TikTok", "analyze this TikTok hashtag", "which sounds are trending in [niche]", "what is @competitor posting that works", "find outlier TikTok videos", "should I ride this TikTok trend", or shares saved hashtag, sound or profile reads and wants them interpreted.
---

# TikTok research

Turn a few list reads into a short read of what travels in a niche, and why. A creator's video is a winner only
against that creator's own median, never against raw plays: a big account's ordinary video says nothing about the
format.

This skill reads only the `tiktok` operator's output files. It makes no request of its own and never likes, follows,
comments or saves anything.

## 1. Read the lists with the tiktok skill

The owner opens each page in Chrome and scrolls as far as the read should reach: a hashtag page, a sound page, or a
creator's profile. One capture per page, made with the `tiktok` skill (`scripts/browser/capture.js`). Then, from
`../tiktok`:

```bash
npx -y bun scripts/main.ts hashtag --capture <cap.json> --limit 100 --json > "<project-dir>/tt-tag-<tag>.json"
npx -y bun scripts/main.ts sound   --capture <cap.json> --limit 100 --json > "<project-dir>/tt-sound-<id>.json"
npx -y bun scripts/main.ts videos  --capture <cap.json> --limit 100 --json > "<project-dir>/tt-<creator>.json"
```

Pacing: a handful of pages per session, with a pause between them, read by a person scrolling at a normal speed. The
operator refuses a capture that mixes two lists (`mixed_lists`). If it reports an account signal (captcha,
verification, rate limit), stop everything and tell the owner; they resolve it in the browser and run `resume`. Never
retry in a loop.

## 2. Find the outliers and the recurring sounds

From this skill's directory:

```bash
npx -y bun scripts/main.ts outliers --input "<project-dir>"/tt-*.json
npx -y bun scripts/main.ts scan     --input "<project-dir>"/tt-*.json
```

Files are merged and each post counts once, however many lists it appears in.

- **`outliers`**, per creator (the handle from each post's link; posts with no handle are `unattributed`, never one creator): `median` plays and the `items` at 3x that median
  or more. A creator with fewer than 8 distinct posts in the reads is `sample_too_small`; a median of 0 is
  `zero_median`. Neither is a finding. To judge a creator, read their profile, not only the hashtag page.
- **`scan`**: hashtags and sounds (grouped by sound id, so retitled uploads of one sound count together) with posts
  and median plays. `sample.scope` is `partial` whenever any list was not read to its end, which on a hashtag or
  sound page is almost always; say "in the posts read", never "on TikTok".

## 3. Read the pattern

For the outliers, name what the winners share, and show the evidence (creator, plays, ratio, link):

1. **The hook**: the first second's shape (spoken line, on-screen text, visual). Score lines with
   `npx -y bun ../tiktok-content/scripts/hook-score.ts --hook "<line>" --on-screen "<text>" --visual "<shot>"`.
   To see a winner shot by shot, `tiktok-video-breakdown`.
2. **The sound**: recurring sounds across winners from different creators are a trend candidate.
3. **The format and length**: talking head, text over b-roll, skit, photo carousel; under 15 s, 15-60 s, longer.

Only patterns seen across several creators count. One creator's three hits are that creator's style.

## 4. Trend fit check

Before recommending a trend, all four must hold (method: **`references/method.md`**):

1. It fits the owner's niche: their audience can tell why they, specifically, did it.
2. It is still early: few posts in the reads use it, and recent ones.
3. It has a native beat to honour (the setup, the cut, the drop).
4. The owner can add a real twist only their niche would make.

If any fails, recommend skipping it. Never invent a trend's popularity; when the reads cannot show it, ask.

## 5. Output

```
TIKTOK RESEARCH · #tag + sound 7234… + 3 creators · 214 posts read (partial lists)
OUTLIERS (3x own median, n >= 8)
- @creator_a: 4 of 22 posts; best 9.1x — <link> — hook: "...", sound: ..., 12 s
SOUNDS RECURRING ACROSS WINNERS
- "Song name" (id 72...): 5 winners from 4 creators
PATTERN
1. Text-first hooks under 1 s with a hard cut at 0.5 s (4 creators, 7 winners). Confidence: medium.
TRY
- One video using that hook shape on the owner's topic, scripted with tiktok-content.
```

Keep it to 3 patterns at most, each with evidence, and one action each.

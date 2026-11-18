# Research method

## Outliers

| Rule | Value | Why |
|---|---|---|
| Baseline | the creator's own median plays over their distinct posts in the reads | raw plays measure follower count |
| Outlier | plays at 3x that median or more (exactly 3x counts) | a clear break from the creator's normal |
| Minimum sample | 8 distinct posts per creator | fewer posts give a median that one video can move |
| Median 0 | `zero_median`, no outliers | every ratio would be infinite |
| Dedupe | by post id across every input file | the same post on a hashtag page and a profile is one post |
| Creator | the handle in the post link | posts with no handle are grouped as `(unknown)` |

## Coverage

A hashtag or sound page keeps loading as long as someone scrolls, so a read of one is a sample of the posts TikTok
chose to show that person at that time. `scope: complete_lists` only when every input says it was read to the end
(`exhausted: true`); otherwise `partial`. Findings from partial lists say "in the posts read".

## Trend lifecycle

| Stage | What the reads show | Move |
|---|---|---|
| Emerging | a few recent winners from different creators, few posts overall | ride now, with a twist |
| Peaking | many posts, big accounts on it | ride only with a strong twist |
| Saturated | most posts in the reads use it, winners rare | skip or subvert it |
| Dead | recent posts with it underperform their creators' medians | skip |

The reads show counts and dates of the posts read, not TikTok's totals; when the stage is unclear, ask the owner what
they see in their feed.

## Pattern rules

- A pattern needs winners from at least 3 creators. One creator's hits are their style.
- Describe the hook as spoken line, on-screen text and visual, with the time of the first cut.
- Report each pattern with its count (winners, creators) and a confidence.
- Ideas for this method come from the tt-audience-insights and tt-trend-mapper skills reviewed during design; the text
  here is this plugin's own.

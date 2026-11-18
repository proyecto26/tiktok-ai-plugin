---
name: tiktok-content
description: Plans and writes TikTok content (the 1-3 second hook as spoken line, on-screen text and opening visual, video scripts timed to beats, captions and hashtags, photo post titles and descriptions, weekly plans, repurposing long-form into videos), checks it with bundled offline linters, and hands an approved post to the tiktok skill. This skill should be used when the user asks to "write a TikTok caption", "script a TikTok", "give me TikTok hooks", "what should I post on TikTok this week", "plan my TikTok content", "turn this into TikToks", "make this sound less AI", or wants TikTok copy checked before posting.
---

# TikTok content

Write TikTok content a person would stop for, check it with the offline linters, and publish only after the owner
approves the exact post. The story comes first. Tactics only amplify a specific, true story; they never replace one.

## Before writing

1. Read the product or brand context if present: `.agents/product-marketing.md`, `.claude/product-marketing.md`
   or `product-marketing-context.md`. Ask only for what is missing.
2. Read a voice file if present (`.agents/tiktok-voice.md`). If there is none and the account is the owner's own,
   read their recent captions through the `tiktok` skill: a capture of their profile page, then
   `npx -y bun ../tiktok/scripts/main.ts videos --capture <file> --limit 12`. Infer the voice: sentence length,
   vocabulary, emoji, the ask they repeat. Offer to save it as `.agents/tiktok-voice.md`.
3. If the idea is thin, ask one batched question: what happened, to whom, and what it cost or returned.
4. Never invent the specifics. A number, date or name the owner did not give becomes `{{your number}}`, and say so.

## Choose the format

| The idea has... | Format |
|---|---|
| motion, a face, a payoff that must be seen | Video |
| a sequence worth swiping (steps, before/after, a list) | Photo post (several images, title + description) |
| a reply to a comment, a trend, another video | Video (reply, stitch or duet are the owner's call in the app) |

One idea per post. If a draft holds two, split it and say so. Specs and safe zones: `references/formats.md`.

## Scripts (offline, no network)

Run from this skill's directory:

```bash
npx -y bun scripts/hook-score.ts --hook "spoken line" --on-screen "on-screen text" --visual "what frame one shows"
npx -y bun scripts/hook-score.ts hooks.txt              # rank spoken hooks, one per line
npx -y bun scripts/beats.ts script.txt --target 30      # timed beat sheet
npx -y bun scripts/caption-lint.ts caption.txt [--keywords "a,b"] [--json]
npx -y bun scripts/caption-lint.ts description.txt --kind photo --title "Photo post title"
npx -y bun scripts/ai-tells.ts detect draft.txt         # AI-tell score and flagged phrases
npx -y bun scripts/ai-tells.ts humanize draft.txt       # mechanical cleanup (--report shows what changed)
```

- `hook-score` scores a line on length, specificity, stakes, front-loading and direct address. With `--on-screen`
  and `--visual` it scores the TikTok triple (weights in `scripts/hooks.json`, `tiktok.triple`): a missing channel
  counts as zero, so an on-screen line with nothing spoken scores lower than both. Use it to kill weak hooks, not to
  crown winners; mechanical features predict hits poorly.
- `caption-lint` (video): 2,200 characters **including** hashtags and mentions is the limit (FAIL above it); the first
  line folds near 80 characters (editorial); more than 8 hashtags is a warning, not an error. Photo posts: title at
  most 90, description at most 4,000. Exit 0 means READY.
- `beats` times a script at 165 wpm and flags a slow hook, long beats, abstract runs and a missing loop.
- `ai-tells` uses `scripts/slop.json` (upstream lists plus a marked TikTok block). `humanize` edits mechanically and
  can leave broken punctuation: re-read and fix by hand. Structural tells are flagged, never rewritten.

## Workflow per post

1. **Hook first.** Pick the goal (completion, saves, comments, shares) and draft 3 hooks from different shapes
   (`references/hooks.md`). Each hook has three layers that fire at once: the spoken line, the on-screen text (3-7
   words, different from the spoken line, since many watch muted) and frame one (the result or the tension, never a
   greeting or a logo). Score them with the triple and show all three, word for word, with their scores. Score only
   once the numbers are filled in; a placeholder inflates the score.
2. **Script** the body in the owner's voice: short spoken lines, numbers over adjectives, one beat per idea, an end
   that loops back to the start. Run `beats` with the target length.
3. **Caption** (`references/captions.md`): it supports the video and adds what the video cannot show; the hook is in
   the video. One ask, 3 to 5 topical hashtags at the end, no links in the body. Run `caption-lint` and
   `ai-tells detect`; fix and re-run until clean, or explain the warnings that remain.
4. **Show the package:** hook layers, beat sheet, caption, lint verdicts.
5. **Publishing** goes through the `tiktok` skill's publish flow: its prepare step is a dry run that shows exactly
   what would be posted, private by default. Show that output, wait for an explicit yes for that exact post, then
   run the confirm step it prints. Never publish without that yes, and never approve several posts at once.

## Writing rules (no AI tells)

Never write contrast reveals ("It's not X, it's Y"), negation stacks ("No X. No Y. Just Z."), self-answered questions
("The result? 3x."), stock openers ("In today's fast-paced world", "This is your sign to"), engagement bait ("Follow
for part 2", "Read that again") or em dashes in captions. One fragment and one list of three per post at most.

## Planning and repurposing

- **Pillars:** 3 to 5, tied to what the owner knows and what the audience asks.
- **Cadence:** consistency beats volume. For the account's real best lengths, hours and formats, use `tiktok-audit`;
  for what is working in a niche or on a sound right now, `tiktok-research`.
- **Weekly plan:** a table of day, format, pillar, hook (all three layers), status. Save as `tiktok-plan.md` if wanted.
- **Repurposing:** take one atom per video from long-form (a quotable line, a story arc, a framework, a stat). Every
  video stands alone without the source. To rebuild a format seen elsewhere, `tiktok-video-breakdown`.

## Resources

- `references/formats.md`: video and photo post specs, safe zones, lengths.
- `references/hooks.md`: the hook triple, shapes by goal, what ruins each.
- `references/captions.md`: caption, hashtag and photo-post text rules.
- `references/short-form-video.md`: hook library, script templates, audio and iteration.
- `scripts/hooks.json`: hook formulas (upstream) and the TikTok triple weights (ours). `scripts/slop.json`: AI-tell
  lexicon.

Credits: the linters are ported from instagram-agent-skill (MIT, Jake Schincariol) through instagram-ai-plugin;
`references/short-form-video.md` is adapted from marketingskills (MIT, Corey Haines). See THIRD_PARTY_NOTICES.md.

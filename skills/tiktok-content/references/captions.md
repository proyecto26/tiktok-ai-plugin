# Captions, hashtags and photo-post text

On TikTok the caption supports the video; the hook is in the video. The caption adds what the video cannot show
(the number, the link to a pinned video, the question to answer in the comments) and gives search something to read.

## Video captions

- **Limit:** 2,200 characters, hashtags and mentions included. `caption-lint.ts` fails above it. Aim far under.
- **First line:** it is what shows over the video before "more". Put the reason to read or to comment there; the
  linter warns past about 80 characters (editorial, not a TikTok rule).
- **One ask**, tied to the goal: comments (end on one specific question about the video), saves (promise
  reference value), shares (a claim people will want to show someone), profile visits (an open loop another video
  pays off).
- **Search terms:** the words a viewer would type to find this, in plain language. `--keywords "a,b"` checks them.
- **No links** in the body: they are not clickable.
- Never repeat the spoken hook word for word.

## Hashtags

- 3 to 5 at the end: one broad, one or two that define the niche, one or two specific to this video.
- The linter warns above 8 (a tag dump), never fails: TikTok's limit is the character count, not a tag count.
- Generic tags (`#fyp`, `#viral`, `#foryou`) describe nothing; the linter flags them.

## Photo posts

- **Title:** at most 90 characters. It is the post's headline: the hook, in words.
- **Description:** at most 4,000 characters, linted like a caption:
  `caption-lint.ts description.txt --kind photo --title "<title>"`.

## Before posting

Run `caption-lint` and `ai-tells detect`. Fix and re-run until READY, or explain each remaining warning. Then hand
the post to the `tiktok` skill's publish flow, which shows the exact post as a dry run first and posts private by
default.

# TikTok formats: videos and photo posts

## Videos

Pick a video when the idea has motion, a face, or a payoff that has to be seen happening.

```
0:00 - 0:03   HOOK      three layers at once: the spoken line, the on-screen text, frame one.
0:03 - 0:08   STAKE     why this matters to the viewer, one line.
0:08 - ...    BODY      one idea per beat; the picture changes every beat.
LAST 3 s      PAYOFF    deliver what the hook promised, then the single ask.
LAST LINE     LOOP      end on something that makes the start make sense again, so a replay lands clean.
```

- Length: write to the story, not to a target. Most short explainers land between 15 and 60 s; a longer video
  needs a reason to keep watching at every beat. `beats.ts --target <s>` shows where it drags.
- Speech: about 165 wpm. Hook within 3 s, no beat over 4 s without a change on screen.
- On-screen text is its own script: a few words per card, the hook card in frame one, burned-in captions for the
  body (many start muted). TikTok's own auto captions can be turned on by the viewer; do not rely on them for the hook.
- Vertical 9:16 (1080x1920). The app draws over the frame: the action buttons on the right, the caption, account
  name and sound bar at the bottom, and the top bar. Keep text in the middle of the frame and away from the right
  edge, then check one frame against a screenshot of the app before rendering the rest.
- Rules: one idea per video, numbers over adjectives, no intro or greeting, change the frame every beat, one ask at
  the end. Never invent metrics; leave `{{your number}}` and flag it.

## Photo posts

Pick a photo post when the idea is a sequence worth swiping and re-reading: steps, a before/after, a list.

```
1         COVER    the hook in a few words, readable at thumbnail size.
2         STAKE    why it matters, one sentence. No setup.
3..N      ONE IDEA PER IMAGE: a short headline, a little text under it.
LAST      ASK      one action: save, comment a word, follow.
```

- A photo post has a **title** (at most 90 characters) and a **description** (at most 4,000). Lint both with
  `caption-lint.ts --kind photo --title "<title>"`.
- Keep every image the same aspect ratio; build them as one set.
- Optional sound: the owner picks it in the app.
- `tiktok-video-breakdown` does not take photo posts; it is for videos only.

## Replies, stitches and duets

These are made in the TikTok app. Plan them like any video (hook triple, beats, caption); the reply or stitch
setting itself is the owner's choice when posting.

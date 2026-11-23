---
name: tiktok-video-breakdown
description: Reverse-engineers a TikTok video (or any short vertical video) so a similar, original one can be made - takes the video from a capture of the user's own Chrome (or a local file), measures cuts, pacing and audio with ffmpeg, extracts per-shot frames and timelines, uses TikTok's caption track or the user's local speech model for the script, and produces a shot list, on-screen text timeline, script, asset list and a per-shot production plan (film it, local ComfyUI, code render, screen recording, ffmpeg). This skill should be used when the user asks to "break down this TikTok", "analyze this TikTok video", "how was this TikTok made", "recreate this TikTok", "make a video like this one", "extract the script / shots / captions from this TikTok", "reverse engineer this video", or pastes a tiktok.com/@user/video/ link and asks what makes it work or how to make their own version. Not for posting and not for photo posts.
---

# TikTok video breakdown

Turn one video into everything needed to make an original video in the same format: structure,
shot list, text timeline, script, pacing, assets and a production route per shot.

Scripts measure. You look at frames and describe. Nobody guesses: anything that was not observed
stays "unconfirmed". That rule is what makes the result trustworthy enough to produce from.

Run every command from this skill's directory:

```bash
npx -y bun scripts/main.ts <command>
```

Needs `ffmpeg` and `ffprobe` on PATH. A TikTok post needs a capture made with the **`tiktok` skill of this
plugin** (`skills/tiktok`, the operator): this skill reads the capture and downloads the video through the
operator's guarded downloader. A local file needs nothing else.

## Boundaries

- The goal is a new video in the same format. The breakdown downloads the video, extracts its frames and
  keeps the source audio (`source/audio.wav`, written by `analyze`). `tiktok-video-remake` reuses that
  audio by default, or replaces it with another file or with no sound when the user says so.
- **Local only.** Downloads stay in the output directory. Nothing is sent to any outside service:
  no cloud transcription, no cloud or paid generation. Transcripts come from TikTok's own caption track,
  a file the user has, or a recogniser on this machine.
- Read-only towards TikTok. The CDN download sends no cookies, follows only TikTok CDN hosts and obeys the
  account signal and pacing. On a 403, 429, captcha or verification page it writes the account signal and
  stops: report it, do not retry or work around it (the user resolves it and runs `resume` in the `tiktok`
  skill).
- Photo posts are out of scope: `fetch` refuses them with `photo_post`.
- One video per run.

## Workflow

### 1. Check the tools

```bash
npx -y bun scripts/main.ts doctor
```

If ffmpeg is missing, give the user the printed install command and stop. A missing speech
recogniser or `comfy` is fine: say what will be unavailable (script without captions, generate routes).

### 2. Fetch

Make a capture of the page that lists the post (the profile, a hashtag or sound page, or the post opened
from the profile) with the `tiktok` skill (`scripts/browser/capture.js`), save it, then:

```bash
npx -y bun scripts/main.ts fetch --capture <capture.json> --id <post id> -o <dir>
npx -y bun scripts/main.ts fetch --file <video.mp4> -o <dir>
```

The post id is the digits after `/video/` in the link. Use a new directory per video, in the user's
project (not a temp dir). The links in a capture expire: if every one is gone, `fetch` answers
`no_fetchable_url`; capture the page again, or have the user save the video themselves and use
`fetch --file`. A post TikTok marks sensitive or age-restricted is fetched like any other. If its capture
holds no video link at all, `fetch` answers `no_play_url`: open the post itself in the signed-in browser, let it
start, and capture again. When TikTok has a caption track for the post it is saved as
`source/captions.<lang>.vtt`.

### 3. Analyze

```bash
npx -y bun scripts/main.ts analyze <dir>
```

Writes `breakdown.json` plus, per shot, `shots/shot_NNN_first.jpg`, `_last.jpg`, a 3-frame
sheet `shot_NNN.jpg` and a dense timeline `shot_NNN_strip.jpg` (source time under each tile), and
`storyboard.jpg` for the whole video. Strips are 2 frames per second; videos longer than 90 s are
sampled more sparsely in proportion to length, and the hook (first 3 s) and shots with a text change get
double density, always under the same tile cap.

Frames are the unit. Every cut is the index of the first frame of the new shot, counted from 0 on
`timebase.file` in `breakdown.json`; the seconds shown next to it are derived (`frame / fps`, 3
decimals). A source with a variable frame rate (common in phone recordings) is analysed on a
constant-rate copy, `source/work_cfr.mp4`, and every frame number refers to that copy.

Open `storyboard.jpg` first. If the shot count looks wrong against it (animated transitions and
dissolves are easy to miss; fast action can add false cuts), fix it now:
`analyze <dir> --add-cut 5.1,9.4` moves each time to the strongest picture change within 2 frames
and reports where it landed (`snapped`); `--add-cut-frame 153` puts a cut exactly on that frame;
`--remove-cut 7.2` removes the cut within one frame of that time. A cut you add is never dropped by
the minimum shot length (a quarter of a second); a detected cut too close to it is. Corrections are
remembered per working file: if the source changes, they are dropped and analyze says so.

### 4. Transcript

The order is fixed: a file passed with `analyze --transcript <file>`; a transcript made earlier with
`transcribe`; TikTok's caption track saved by `fetch`; the user's local recogniser (`TT_ASR_CMD`); else
none, and the script stays unconfirmed. To set one by hand:

```bash
npx -y bun scripts/main.ts transcribe <dir> --import captions.srt
npx -y bun scripts/main.ts transcribe <dir> --cmd "<python> scripts/recipes/asr_whisper.py {audio} {out} en"
```

`references/transcription.md` has the recipes. TikTok's caption track is usually machine speech
recognition: treat it as a transcript, not as the creator's exact words. Ask before downloading any model.
Do not write spoken lines from what the on-screen text seems to say.

### 5. Review the frames

```bash
npx -y bun scripts/main.ts review <dir>
```

Read `review_tasks.json`, then open the images of every shot (first, last, sheet, strip) and
fill `review_answers.json`. For each shot:

- `type` from the taxonomy, a `confidence`, and `evidence`: what in the frames supports the
  type. Read `references/taxonomy.md` before typing shots; it lists the pairs that get confused.
- `description`, `camera`, `transition_in`.
- `on_screen_text`: every text with its role, position and start/end read from the strip
  timestamps. One item per distinct text state. TikTok's own interface (buttons, caption, sound
  bar) is not part of the video; ignore it.
- `layers`: stickers, picture-in-picture, screenshots, logos. Anything composited over the base
  picture that is not text.

For the whole video: `hook` (what the first seconds show and promise), `structure` (sections
with times), `cast`, `visual_style`, `assets` (each marked `user_must_supply`, `can_generate` or
`reference_only`), `sound_cues`.

How to look:

- `text_change_candidates` mark moments where a band of the frame changed while the rest stood
  still. Check each one. A shot with no candidates can still have changing text, so scan every strip.
- When a strip is too coarse to read or time something:
  `npx -y bun scripts/main.ts frames <dir> --from 3.0 --to 5.0 --fps 6`
- `low_motion: true` means the picture barely changes: probably a still or a hold. If you still
  type it as moving footage, say what moves in `motion_note`.
- If one detected shot contains two different shots, answer `{"id": N, "split_at": [t]}` for it;
  `apply-review` then prints the `analyze --add-cut` command to run before reviewing again.

Audio: you cannot hear it. `voice_present` and `music_present` stay `"unconfirmed"` unless there
is evidence: a transcript with speech (voice only), a file with no audio stream, or the user
telling you what they heard (`"source": "user_listened"` with their words in `note`). Tempo,
loudness and TikTok's sound credit are measurements and attributions, not proof of music. When
it matters for the remake, ask the user to listen and say whether there is music, a voice, and
any sound effects on the cuts or captions; record effects in `sound_cues`.

### 6. Apply and summarise

```bash
npx -y bun scripts/main.ts apply-review <dir>
npx -y bun scripts/main.ts summary <dir>
```

The answers are bound to the analysis they were written for (`analysis_id`): after any change of
cuts, run `review` again and answer from the new tasks. A new transcript clears the applied
review; run `apply-review` again. `apply-review` validates everything and writes nothing on error.
Pass its warnings and downgrades on to the user. `summary` prints the breakdown and writes `recreate.md`.

### 7. Report and plan the remake

Follow `references/output-template.md`. Show the storyboard, lead with the hook and structure,
then the shot table, then what is unconfirmed, then the production plan. Read
`references/recreate-routes.md` to turn each shot into concrete steps with the local tools the user
has (`doctor` says which). Adapt the format, not the content: new script, new footage, the
user's own subject. Offer to draft the new script to the same beat lengths
(`../tiktok-content` has the hook and caption tools).

## Files

| File | Purpose |
|---|---|
| `breakdown.json` | Everything measured and reviewed (`tt.breakdown.v1`) |
| `source/meta.json` | Caption, hashtags, metrics, sound credit, caption tracks (never the signed links) |
| `source/captions.<lang>.vtt` | TikTok's caption track, when the post has one |
| `transcript.json` | Normalised transcript, when one exists |
| `review_tasks.json`, `review_answers.json` | The review contract |
| `recreate.md` | The production plan |

## References

- `references/taxonomy.md`: shot types, what evidence supports each, confusable pairs.
- `references/recreate-routes.md`: production route per shot type, local tools and install notes.
- `references/transcription.md`: transcript formats, the command template, local model recipes.
- `references/output-template.md`: how to report the result.

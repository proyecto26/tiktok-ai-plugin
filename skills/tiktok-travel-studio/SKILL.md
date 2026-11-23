---
name: tiktok-travel-studio
description: Turns a folder of travel videos and photos into vertical TikTok cuts, photo-post sets and a local drafts.json - scans media (date, GPS, rotation, frame rate), groups trips, scores clips (sharpness, motion, exposure, length, faces only with a local detector), proposes a shortlist, renders 1080x1920 cuts with automatic or manual focus, adds the owner's own music at -14 LUFS without looping, builds 9:16 or 4:5 photo sets, and writes drafts with linted captions and the `publish prepare` command for each. This skill should be used when the user asks to "make TikToks from my travel footage", "turn this trip folder into videos", "pick the best clips from my holiday", "crop my videos to 9:16", "build a photo carousel from my trip", "prepare drafts from my camera roll", or "add my music to these clips". Never publishes and never runs unattended.
---

# TikTok travel studio

A backlog of travel footage in, a folder of finished vertical cuts, photo sets and a `drafts.json` out. Every step is a
command that prints JSON and writes a file the next step reads. Nothing is published, scheduled or sent anywhere: no
network is used at all, and nothing is downloaded (not even a model).

Run every command from this skill's directory:

```bash
npx -y bun scripts/main.ts <command> [options]
```

Needs `ffmpeg` and `ffprobe` on PATH (ffmpeg 7 or newer for sharpness scoring). The video work happens on this
machine; the files stay where they are and only copies are written to the output folders you name.

## Steps

Run these in order. Each prints one JSON object on stdout (progress goes to stderr); on failure it prints
`{"ok": false, "error": {"code", "message", "hint"}}` and exits 1 (usage errors exit 2). Read the `hint` and act on it.

### 1. Check the tools

```bash
npx -y bun scripts/main.ts doctor
```

Fix what `problems` lists (it prints the install command). `optional.face_detector` says whether faces can be scored.

### 2. Scan

```bash
npx -y bun scripts/main.ts scan <folder> [<folder>...] -o library.json
```

Walks the folders (hidden files skipped) and records for every photo (jpg, jpeg, png, webp) and video (mp4, mov,
m4v, mkv, webm, avi): date, GPS, duration, size, frame rate, whether the rate is variable, whether it has audio,
and the **displayed** orientation. Rotation is read from the video's display matrix or the photo's EXIF orientation,
so a phone clip stored landscape with rotation 90 is reported as portrait. Output: `library.json` (schema
`tt.travel.v1`). The reply lists `skipped` (HEIC must be converted to JPEG first) and `undated_fallbacks`: items with no
capture date use the file's modified time, which is wrong for copied files, so tell the user when it is non-zero.

### 3. Group into trips

```bash
npx -y bun scripts/main.ts group library.json [--gap-hours 36] [--max-km 150]
```

A new trip starts after a gap longer than `--gap-hours` or when GPS jumps more than `--max-km` from the trip so far.
Items without a date go to an `undated` group. The trips are written into `library.json`; the reply summarises them.

### 4. Score

```bash
npx -y bun scripts/main.ts score library.json [--length 15] [--force]
```

Per item: **sharpness** (ffmpeg `blurdetect`), **motion** (frame differences, plus the centroid of what moves),
**exposure** (`signalstats` mean luma), **duration fit** (full marks for 4 to 30 s) and **faces**. The total is a
weighted mean of the terms that exist (sharpness .35, motion .25, exposure .25, duration .15, faces .2), so a photo is
not penalised for having no motion.

**Faces are scored only when the user has a local face detector.** Set `TT_FACE_CMD` to a command that takes an image
path and prints boxes as JSON (`references/face-detector.md`). Without it the faces term is `null` for every item and
the reply says `not configured`; tell the user, and do not suggest installing or downloading a detector unless they ask.
With no faces the crop follows motion, else the centre.

The scores are measurements, not taste: look at the top picks (step 5 and the renders) before presenting them.

### 5. Shortlist

```bash
npx -y bun scripts/main.ts shortlist library.json [--n 10] [--kind video|photo] [--trip trip-1] [-o shortlist.json]
```

Top `n` by score. Each entry has `path`, `score`, `start` (the most active window of the target length), and
`focus: null`. To steer a clip, set `focus` to `[x, y]` (fractions of the displayed frame, 0 to 1) or change `start`
in the entry; `render` and `photos` read both.

### 6. Render vertical cuts

```bash
npx -y bun scripts/main.ts render --shortlist shortlist.json [--out-dir renders] [--length 15] [--keep-audio]
npx -y bun scripts/main.ts render <video> --focus 0.3,0.5 --start 4 --length 12
```

Writes 1080x1920 H.264 cuts, trimmed to `--length` seconds (a shorter clip is kept whole, never looped or padded).
Focus, in order: `--focus` or the entry's `focus` (source `override`), the faces' centre (`faces`), the motion centroid
(`motion`), else the centre (`centre`). The reply gives each clip's `focus`, `start`, `duration`, `fps`, `rotation`
and `cfr_copy`. Rotation metadata is honoured. A variable-frame-rate clip is first copied to a constant-rate file and
rendered from that (`cfr_copy: true`), so the output rate is exact. Source audio is dropped unless `--keep-audio`.
`--focus` and `--start` apply to one clip; use the shortlist for several.

### 7. Add music (optional, the user's own file)

```bash
npx -y bun scripts/main.ts music --video renders/clip_9x16.mp4 --file song.mp3 -o clip_music.mp4 [--start 12] [--fade 1]
```

The track is faded in and out, then loudness-normalised to -14 LUFS (two passes; `loudness.output_lufs` is measured
on the result), and the picture is copied untouched. **The music never loops.** Longer music is cut at the end of the
clip and fades out there. Shorter music fades out where it ends and the rest of the clip is silent: the reply then has
`music_ended_early_by` above 0 and a warning, so offer a longer track or an earlier `--start`.

### 8. Photo posts

```bash
npx -y bun scripts/main.ts photos --shortlist shortlist.json [--ratio 9:16|4:5|both] [--per-set 35] [--out-dir photos]
npx -y bun scripts/main.ts photos a.jpg b.jpg --ratio 4:5 --focus 0.7,0.4
```

Writes JPEG crops (9:16 is 1080x1920, 4:5 is 1080x1350) in sets, in capture order, and `photos/photosets.json`. A set
never exceeds the photo-post limit: **35 images**, the working number from recon (`PHOTO_POST_MAX` in
`scripts/photos.ts`) that **still has to be confirmed in TikTok's photo composer**; more photos are split into several
sets and `--per-set` above the limit is refused (`photo_limit`). The reply warns about crops upscaled from small
sources.

### 9. Drafts

```bash
npx -y bun scripts/main.ts drafts --videos renders/a_9x16.mp4,renders/b_9x16.mp4 --photosets photos/photosets.json \
  --place "Lisbon" --hook "The tram nobody tells you to take" [--caption "your own caption"] -o drafts.json
```

Writes `drafts.json`: one draft per video and per photo set, each with caption suggestions (template ones built from
`--place` and `--hook`, and any `--caption` you pass, listed first), a lint result for each, the best non-failing one
as `chosen`, and `prepare.argv` / `prepare.command`: the `tiktok publish prepare ...` call for that draft.
Statuses: `ready` and `review` (lint verdicts), `needs_edit` (every suggestion fails lint: write a better caption and
rerun with `--caption`), `unlinted` (see below). Write the real caption yourself when you can; the templates are
placeholders that keep the draft valid.

Captions are linted by the sibling `tiktok-content` skill's `scripts/caption-lint.ts`, found at
`../tiktok-content/scripts/caption-lint.ts` relative to this skill. **If that skill is not installed next to this
one**, `drafts` still writes the file but marks every draft `unlinted`, sets `lint.available: false` and adds a
warning; install `tiktok-content` and run `drafts` again before relying on the captions.

## Publishing

This skill stops at `drafts.json`. A draft is published only through the `tiktok` skill, one post at a time: run the
draft's `prepare.command` from the plugin root (a dry run that prints the exact post and its digest), show the draft to
the user, and continue with `publish begin` only after they say yes. The `tiktok` skill covers the approval, the
composer and `reconcile`. Nothing here schedules a post or loops unattended.

## Notes

- Outputs are plain files next to the paths you chose: `library.json`, `shortlist.json`, `renders/`, `photos/`,
  `drafts.json`. Re-running a step overwrites its own output only.
- Every manifest carries `schema: "tt.travel.v1"` and a `kind` (`library`, `shortlist`, `photosets`, `drafts`).
- Dates: EXIF has no time zone and video tags are UTC; trips are grouped at the scale of days, where that does not matter.
- Reference: `references/face-detector.md` (the `TT_FACE_CMD` contract).

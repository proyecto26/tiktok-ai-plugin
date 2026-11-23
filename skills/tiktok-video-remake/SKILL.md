---
name: tiktok-video-remake
description: This skill should be used when the user asks to "remake this TikTok with another person", "replace the woman/man in this video", "swap the person in a clip", "put me (or someone) in this video", "recreate this video with a different character", "extend / continue this shot", or wants a new 1080x1920 video that keeps the performance, camera, scene, bystanders and sound of an existing one while changing who appears. Works from one source video (or its breakdown) and one identity photo. Runs MiniMax H3 character swap and shot continuation in a local ComfyUI, puts the result back over the original, joins the timeline and keeps the original sound in sync. Local and free, with no paid service; nothing is published.
version: 0.1.0
---

# TikTok video remake

Replace ONE person in a video with the person in one photo, keep everything else (performance, camera,
scene, bystanders, sound), and deliver a 1080x1920 file. Generation is MiniMax H3 in the user's own
ComfyUI. The user supplies the source video (or its breakdown) and one identity photo. Everything else is
derived from the source: nobody types scene descriptions.

Every step is a command with JSON output, run from this skill's folder:

```bash
npx -y bun scripts/main.ts <command> [options] --json      # --help lists every command
```

State lives in `remake.json` (schema `tt.remake.v1`) in the run folder; a later session resumes from it.
You (the model) do two kinds of work: run commands, and LOOK at images listed in a JSON file and write
a JSON answer file. If you cannot view images, stop and say so: the identity card and the targets cannot be
guessed.

## Content limits

Never depict a minor, never undress or sexualise anyone beyond what the source shows, never make a real
person say words they did not say in order to deceive, never impersonate a public figure. A faithful recast of
an existing scene is in scope. This skill never publishes. The result is realistic AI video: recommend
labelling it as AI-generated when it is posted (`tiktok publish prepare --ai-generated`).

## What it needs

Run `doctor` first. It checks ffmpeg/ffprobe, the ComfyUI server (loopback only), the node classes and the seven
model files (about 45 GB). When something is missing read `references/setup.md`: it lists every file, its source
and licence, and the one node pack to install. Never download models without telling the user the size and source
and getting a yes. The kept runs used a 32 GB GPU; less memory is untested.

## The workflow

1. **Break the source down** with the sibling skill `tiktok-video-breakdown` (`fetch`, `analyze`, `review`; see its
   SKILL.md). That gives the working file, the frame-exact cuts and a review of each shot. Starting from a plain
   file works too (step 2 with `--source`).
2. **`init <run> --from-breakdown <breakdown folder> --identity <photo>`** (or `--source <video>`). It takes the
   breakdown's working file and cuts (measuring nothing again), the sound TikTok credits for the post, and the
   shot review. One photo for the whole remake: front or three-quarter view, face clear, the wardrobe wanted visible.
3. **`identity <run>`** writes `identity_task.json`. Look at the photo (`refs/identity.*`), write `identity_card.json`
   with the seven fields it lists (hair, face, skin, build, distinctive marks, jewellery, default wardrobe; "none"
   where there is nothing), then run `identity <run>` again: it checks the card and stores the text that every
   prompt repeats. `--photo <file>` replaces the photo.
4. **`targets <run>`** cuts the source into stretches (a shot over 10 s becomes stretches of at most 10 s that
   overlap by 8 frames) and writes `target_tasks.json`: for each stretch its first and last frame and a strip of
   the whole stretch at 4 or more frames per second, with times. Look at EVERY strip frame and write `targets.json`:
   - `subject`: a short description of the person being replaced, once.
   - per stretch: `present` (the subject appears in ANY strip frame) with `seen_at` (the strip times where they
     appear); or `present: false` with `absent_checked: true` when they are in none of it.
   - `seed`: `"first"` or `"last"` where the subject is clearly visible, with `point: [x, y]` on them in source
     pixels on THAT frame; or `{"t": a strip time, "point": [x, y], "box": [x, y, w, h]}` when they are clear only
     inside the stretch (the stretch is split there: before it runs backwards, after it forwards).
   - `box_first`, `box_last` (`[x, y, w, h]`, where visible), `others` (other people in the stretch), and the shot
     card read from the frames: `framing`, `camera_move`, `light`, `wardrobe` (of the subject), `action`.
   Then `targets <run> --check`: it names every missing or impossible answer; fix them and check again. A stretch
   without an answer is never planned.
5. **`plan <run>`** builds `plan.json`: swap or keep per stretch (swap where the subject is present), the point on
   the seed frame, `reverse` for a `"last"` seed, a 9:16 crop around both boxes at 2.5 times the subject's height
   with tier 480 (or the whole frame at tier 768 when the subject is large or moves across the frame) and the
   prompt, built only from the card and your targets. Read it, edit what is wrong, then `plan <run> --check`.
6. **`run <run>`** swaps and places every planned stretch, joins the stretches of a long shot with a crossfade (every
   source frame appears once), and stops at the first failure naming the shot. Minutes per shot. A stretch whose
   inputs (photo, card, targets, plan entry) have not changed is never generated again; `run --resume` collects a job
   that was left running instead of submitting it twice. The first frame the model sees is saved in
   `shots/<id>/first_frame.jpg`: the point must be on the subject there.
7. **Review the placed shots.** Look at `shots/<id>/placed.mp4` for each shot `run` lists (in motion, at full size,
   at least twice: the person, then everything else). `approve <run> --shot <id>` what is good. For what is not,
   change ONE thing (a target, a plan entry, `--seed`) and `run` again: only the affected shots are regenerated.
   `references/troubleshooting.md` maps each defect to a change. `run --auto-approve` approves and assembles for
   batch use. `continue` extends an approved shot past its end (see `references/workflow.md`).
8. **`assemble <run> --segments "<list>"`** (`run` prints the list): joins placed shots and stretches of the source.
9. **`audio <run>`** exports 1080x1920 and adds the sound. Default: the source's own sound, each piece of the
   timeline taking the sound of its own source time range (so trims and reorders stay in sync), with a short
   crossfade at each join. `--audio none` makes `final.mp4` silent too, to pick another sound in the app.
   `--file <recording> --match|--start <s>` is for a continued shot or a timeline that runs past the source's sound:
   sound is never looped. Writes `final.mp4` and `final_silent.mp4`, and records the credited TikTok sound
   (`musicId`, title) when the breakdown had one. A source that is not 9:16 goes over a blurred copy of itself
   (`--canvas fit`, default) or is cropped (`--canvas cover`).
10. **`compare <run>`** writes source and remake side by side; show the user frames and the video, then have them
    watch `final.mp4` with sound.

## Commands

| Command | Does |
|---|---|
| `doctor` | checks tools, server, nodes, models |
| `init <run> (--source \| --from-breakdown) --identity [--character]` | creates the run folder |
| `identity <run> [--photo]` | identity task, then validates and stores the character card |
| `targets <run> [--check]` | stretches, strips and `target_tasks.json`; validates `targets.json` |
| `plan <run> [--check]` | writes and validates `plan.json` |
| `run <run> [--resume] [--auto-approve]` | executes the plan (swap, place, join); resumable |
| `scenes <run> [--set f1,f2]` | the source's shots as exact frame ranges |
| `swap <run> [--shot] (--unit \| --scene \| --start --duration) [...]` | one stretch by hand; the plan's values are the defaults |
| `continue <run> --shot --after --seconds --prompt` | extends an approved shot |
| `place <run> --shot [--attempt] [--feather]` | fits a generated clip to the source frame (or joins a shot's parts) |
| `approve <run> --shot` | records that the placed shot was watched and accepted |
| `assemble <run> --segments "source:0-7.5,shot:far,..."` | joins the timeline |
| `audio <run> [--audio source\|none\|<file>] [--file --match\|--start] [--canvas fit\|cover]` | export and sound |
| `audio-offset --clip --track` | finds a clip's sound inside a longer recording |
| `compare <run>` / `status <run>` | side-by-side video / what exists and what is next |

If a command times out the job keeps running: run `run --resume` (or `swap ... --resume <prompt-id|last>`). Never
submit the same stretch twice to "retry". One command at a time per run folder.

## Rules that came from failures

- One identity photo and one card for every shot. Do not improve prompts between shots.
- Look at the whole strip before answering `present`. A person who walks through in half a second and was not in
  the first or last frame is the usual way a stretch is wrongly kept, and the original person then shows next to the
  new one.
- Never paste a generated face or body onto the original by hand; regenerate the stretch.
- Do not hand-edit ComfyUI graphs; change a target or a plan entry.
- Stretches end on the source's frame cuts; one frame of the original person at a cut is visible.
- 24 fps material carried at 30 fps repeats one frame in five; `swap` sends only the distinct frames and `place`
  restores the source's rhythm. Read `cadence` after `place`.
- Changing anything a shot was made from makes it out of date: its placement, approval, joined shots, the timeline,
  the sound and both finals are cleared. Redo them; do not reuse an old `final.mp4`.
- Report honestly what was not checked. Tempo, lip sync and likeness are judged by the user's eyes and ears.

## Additional resources

- **`references/workflow.md`** — decision rules, measured timings, what was tried and rejected.
- **`references/prompts.md`** — the character card, the shot card, the swap and continuation prompt structure.
- **`references/setup.md`** — models (files, sources, sizes, licences), the node pack, ComfyUI.
- **`references/troubleshooting.md`** — each visible defect or error and the one change to try.
- **`references/manifest.md`** — the `tt.remake.v1` record and the files of a run folder.
- **`assets/workflows/h3_swap.api.json`** — the character-swap graph (MIT, see its NOTICE).

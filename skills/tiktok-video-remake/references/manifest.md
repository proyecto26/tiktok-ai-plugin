# The run folder and `remake.json` (tt.remake.v1)

```
<run>/
  remake.json            the record below
  source.mp4             copy of the source
  refs/identity.jpg      the identity photo
  identity_task.json     what to look at in the photo (written by `identity`)
  identity_card.json     the card the model writes from the photo
  targets/<stretch>/     the strip frames and the full first and last frame of every stretch (written by `targets`)
  target_tasks.json      the stretches, their frames and the shape of the answer
  targets.json           the model's answers: per stretch, is the subject there, where, and what the shot looks like
  plan.json              per run: swap or keep, point, crop, tier, prompt (written by `plan`, may be edited)
  shots/<id>/
    driving.mp4          the stretch sent to the model (cropped / reversed as asked; distinct frames only, at 24 fps, for 24-in-30 material)
    first_frame.jpg      the first frame the model sees
    attempt<N>.raw.mp4   exactly what ComfyUI returned
    attempt<N>.mp4       the same, in forward order and without guide frames
    placed.mp4           the chosen attempt fitted to the source frame (for a shot of several runs: the runs joined)
    scene.png            (continuation) last frame of the shot it continues
  timeline.mp4           the joined picture, silent
  audio_source.wav       the sound cut from the source along the timeline
  final_silent.mp4       the timeline on the 1080x1920 canvas, no sound
  final.mp4              the same with the chosen sound (identical picture)
  compare.mp4            source | remake
```

`remake.json`:

| Field | Meaning |
|---|---|
| `source` | file, sha256, size, frame rate, duration, whether it has audio, exact frame count, `cuts` (first frame of each shot) and whether they were measured or set by hand |
| `source.sound`, `source.hints` | from a breakdown: the sound TikTok credits (`musicId`, title, artist) and its review of each shot |
| `references[]` | id, role (`identity`), file, sha256 |
| `character` | the character card (written by `identity`, or given with `init --character`) |
| `shots[]` | one per regenerated stretch or continuation |
| `shots[].start/duration/crop/reversed` | what was sent to the model (swap) |
| `shots[].after` | the shot a continuation extends |
| `shots[].frames`, `shots[].parts` | the source frames a run covers; for a shot of several runs, its parts in frame order (a run, or kept source frames) |
| `shots[].attempts[].settings.fresh` | hashes of the photo, the card, the target and the plan entry the attempt was made from; it is reused only while they all match |
| `shots[].attempts[]` | number, time, every setting, graph hash, ComfyUI prompt id, status (`submitted`, `done`, `failed`, `unknown`), output file and its sha256, frame count, seconds taken, `keep`: the frames of the stretch sent to the model when only its distinct frames were sent, and `alignment`: the measured shift between the generated frames and the frames sent (0 is right) |
| `shots[].selected` | attempt chosen with `place --attempt` (default: the last finished one) |
| `shots[].placed` | file, sha256, area and feather used, attempt it came from, `cadence` (repeats the source does not have, longest run) |
| `shots[].approved` | when it was approved and the sha256 it was approved for |
| `timeline` | segments, file, sha256, duration |
| `audio` | `source`, `none` or `file` (with its sha256), start, the match result, where the sound was measured in the finished file, and for `source` the credited TikTok sound |
| `final` | file, sha256, duration, time, the silent file and its sha256, the canvas mode |

## Resuming

A later session needs only this file: `status <run>` lists each shot's state and what is next.

- `unknown` attempt: the command timed out or lost the connection. The job may still be running
  or finished in ComfyUI. Run the same command with `--resume <prompt-id>`.
- An approval is tied to the sha256 of `placed.mp4`; the file on disk is re-hashed before it is
  used. Placing again, a new attempt or choosing another attempt clears the approval, any
  continuation of that shot, any joined shot it is part of, the timeline, the sound and both final files.
- A run made from the plan is out of date when its photo, the card, its target or its plan entry changes. `identity`,
  `targets --check`, `plan` and `run` clear what was built on it; `status` says which shots are out of date. The
  attempt stays as history and is never reused.
- `remake.lock` exists while a command is working. A second command is refused; a lock left by a
  command that exited is replaced. (`remake.lock.guard` exists for a few milliseconds while the
  lock is taken or released.)
- A continuation records which attempt of the previous shot it continued (`afterAttempt`,
  `afterSha256`). If that shot is regenerated, regenerate the continuation too.
- Nothing is overwritten by a new attempt; choose between attempts with `place --attempt <n>`.

## Privacy

The run folder holds a person's photo and unpublished video. Keep it out of repositories and
shared drives, and delete it (and ComfyUI's `input/remake_*`, `output/video/remake_*`) when the
remake is finished, unless the user wants to keep it.

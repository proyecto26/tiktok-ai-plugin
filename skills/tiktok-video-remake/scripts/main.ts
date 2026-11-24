#!/usr/bin/env bun
/**
 * tiktok-video-remake: remake a video, replacing one person with another
 * (and optionally continuing a shot), with MiniMax H3 running in a local ComfyUI.
 *
 *   bun scripts/main.ts <command> [options]     (see HELP below, and references/workflow.md)
 *
 * Nothing here publishes anything, and nothing leaves this computer unless --allow-remote-comfy is given.
 */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FINE_RATE, findOffset } from './audio.ts';
import { Comfy, ComfyError, DEFAULT_COMFY_URL, graphHash, pickVideo } from './comfy.ts';
import { MODEL_FPS, detectCuts, modelSeconds, distinctFrames, extraRepeats, frameMap, originalInSwappedScenes, scenes as sceneList, stretchProblems } from './cadence.ts';
import * as ff from './ff.ts';
import { CONTINUE_DEFAULTS, H3_FPS, MODELS, REQUIRED_NODES, SAVE_NODE, SWAP_DEFAULTS, SWAP_MAX_SECONDS, type Graph, type Rect, buildContinuation, continuationFrames, fillSwap, generatedArea, tierCanvas, toPreparedPoint } from './graphs.ts';
import { type Attempt, type Manifest, type Shot, SCHEMA, checkId, chosen, clearOutputs, invalidate, invalidateAll, load, lockRun, parseSegments, reference, save, sha256File, shot, staleContinuation, timelineGaps } from './manifest.ts';
import { CARD_FIELDS, type Fresh, type Plan, type PlanUnit, type Targets, buildCard, buildPlan, freshOf, sameFresh, stableHash, targetHash, unitsOf, validateCard, validatePlan, validateTargets } from './plan.ts';
import { OVERLAP_FRAMES, frameTime, sceneStretches, stripFrames, type Stretch } from './stretch.ts';

const HELP = `tiktok-video-remake — replace a person in a video, keep everything else

The usual order: doctor, init, identity, targets, plan, run, (review the placed shots), audio, compare.
Every command prints one JSON object with --json. Nothing here publishes anything.

  doctor [--comfy-url <url>]
      Check ffmpeg, the ComfyUI server, the node pack and the seven model files.

  init <run-folder> (--source <video> | --from-breakdown <breakdown-folder>) --identity <photo> [--character "<card>"]
      Start a remake from a video file or from the TikTok breakdown of it (its working file, frame cuts and
      credited sound).

  identity <run> [--photo <file>]
      Writes identity_task.json (what to look at in the photo). Once identity_card.json is filled in, checks it and
      stores the character card that every prompt repeats. Changing the card or the photo makes every swapped
      shot out of date.

  targets <run> [--check]
      Cuts the source into stretches (at most 10 s each; a longer shot is split into stretches that overlap by 8
      frames) and writes target_tasks.json: for every stretch its first and last frame and a strip of the whole
      stretch at 4 or more frames per second. Fill targets.json from it, then run targets --check.

  plan <run> [--check]
      From targets.json and the identity card writes plan.json: per stretch swap or keep, the point, the crop, the
      tier and the prompt. Edit plan.json if you must, then run plan --check.

  run <run> [--resume] [--auto-approve] [--timeout <s>]
      Executes the plan: swap and place every stretch with the person in it, join the stretches of a long shot,
      stop at the first failure. A run that was interrupted continues with --resume; a stretch whose inputs have
      not changed is never generated again. --auto-approve approves what it places and assembles the timeline.

  scenes <run> [--set <frame,frame,...>]
      List the shots of the source as exact frame ranges (measured from the picture at init). --set replaces
      the measured cuts with your own (the first frame of each new shot) when the measurement is wrong.

  swap <run> [--shot <id>] (--unit <id> | --scene <n> [--start <s>] | --start <s> --duration <s>) [--prompt "<text>" | --prompt-file <f>]
       [--tier 480|768] [--seed <n>] [--expand <px>] [--recover]
       [--point <x,y> | --point-prepared <x,y>] [--detect <word>] [--selection largest|leftmost|rightmost|index] [--index <n>]
       [--crop <w:h:x:y>] [--reverse] [--leave-original] [--all-frames] [--timeout <s>]
  swap <run> --shot <id> --resume <prompt-id|last>  collect a job that timed out or whose answer was lost
                                                    (same for continue); nothing is submitted again
      Regenerate one stretch of the source with the person replaced. With a plan, --unit <id> (or --scene <n>
      when that shot is one run) takes the plan's span, prompt, point, crop, tier and direction as defaults;
      the flags below override them.
      --crop     send only this area of the frame (for a small or distant subject); it is put back in place later
      --point     one click on the person to replace, in pixels of the source frame (needed when others are in
                  frame). --point-prepared gives it in pixels of the frame the model works at instead.
      --reverse   run the stretch backwards (when the subject is only clearly visible at its END), then flip the result
      --scene     the stretch is that shot of the source, cut to cut (see scenes); with --start it begins later and
                  still ends on the cut. A stretch that crosses a cut, or stops or starts within 8 frames of one, is
                  refused: those frames would show the original person. --leave-original accepts it anyway.
      --all-frames  send every frame even when the stretch is 24 fps material repeated up to the source rate
                  (by default only its distinct frames are sent, and place restores the source's rhythm)

  continue <run> --shot <id> --after <shot> --seconds <s> (--prompt "<text>" | --prompt-file <f>)
       [--guide-frames <n>] [--seed <n>] [--timeout <s>]
      Extend a shot past its end. The last frames of <shot> are anchored so the movement carries on.

  place <run> --shot <id> [--attempt <n>] [--feather <px>] [--allow-shift]
      Fit the generated clip to the source frame (a cropped shot is blended back over the original), with the
      source's own rhythm of repeated frames. Refuses an attempt whose frames are shifted against the stretch
      they replace (measured after swap); --allow-shift places it anyway. For a shot made of several stretches
      it joins them, crossfading the overlap, so every source frame of the shot appears once.

  approve <run> --shot <id> [--note "<text>"]
      Record that you watched the placed shot and accept it.

  assemble <run> --segments "source:0-7.5,shot:far,source:10-13,shot:close,shot:more" [--allow-unapproved] [--allow-original]
      Join stretches of the source and placed shots into the timeline. A stretch of the source of 8 frames or less
      taken from a shot in which the person is replaced is refused (it is a flash of the original person);
      longer ones are listed to check. --allow-original accepts them.

  audio <run> [--audio source|none|<file>] [--file <recording> (--start <s> | --match)] [--canvas fit|cover]
      Export the picture to 1080x1920 (final_silent.mp4) and add the sound (final.mp4). Default --audio source: the
      source's own sound, each piece of the timeline taking the sound of its own source time range, so trims and
      reorders stay in sync. --audio none: final.mp4 is silent too (pick a sound in the app). A continued shot, or a
      remake that runs past the source's sound, needs --file <recording of the same track> with --match or --start.
      Never loops. --canvas fit (default) puts a source that is not 9:16 over a blurred copy of itself; cover crops.

  audio-offset --clip <file> --track <file>
      Where does the clip's sound sit inside the longer recording?

  compare <run>        Side-by-side video: source | remake.
  status <run>         What exists, what is approved, what is next.

  Common: --comfy-url <url> (default ${DEFAULT_COMFY_URL}), --allow-remote-comfy, --json
`;

type Flags = Record<string, string | true>;

export function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Flags } {
    const [cmd = 'help', ...rest] = argv;
    const pos: string[] = [];
    const flags: Flags = {};
    const BOOL = ['json', 'reverse', 'recover', 'match', 'allow-remote-comfy', 'allow-unapproved', 'help', 'all-frames', 'leave-original', 'allow-original', 'allow-shift', 'check', 'auto-approve'];
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (!a.startsWith('--')) {
            pos.push(a);
            continue;
        }
        const eq = a.indexOf('=');
        const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
        // `swap --resume <prompt-id>` takes a value; `run --resume` is a switch.
        if (BOOL.includes(key) || (cmd === 'run' && key === 'resume')) flags[key] = true;
        else if (eq > 0) flags[key] = a.slice(eq + 1);
        else if (i + 1 < rest.length) flags[key] = rest[++i];
        else throw new Error(`--${key} needs a value.`);
    }
    return { cmd, pos, flags };
}

const str = (f: Flags, k: string): string | undefined => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
function need(f: Flags, k: string): string {
    const v = str(f, k);
    if (v === undefined || v === '') throw new Error(`--${k} is required.`);
    return v;
}
function num(f: Flags, k: string, fallback?: number): number {
    const v = str(f, k);
    if (v === undefined) {
        if (fallback === undefined) throw new Error(`--${k} is required.`);
        return fallback;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${k} must be a number; got "${v}".`);
    return n;
}
export function parseRect(v: string): Rect {
    const m = /^(\d+):(\d+):(\d+):(\d+)$/.exec(v);
    if (!m) throw new Error(`--crop must be w:h:x:y in pixels; got "${v}".`);
    return { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
}
export function parsePoint(v: string, flag: string): { x: number; y: number } {
    const m = /^(\d+),(\d+)$/.exec(v);
    if (!m) throw new Error(`--${flag} must be x,y in pixels; got "${v}".`);
    return { x: Number(m[1]), y: Number(m[2]) };
}

const log = (m: string) => process.stderr.write(`[remake] ${m}\n`);
let asJson = false;
function emit(data: Record<string, unknown>): void {
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: true, ...data })}\n`);
    else for (const [k, v] of Object.entries(data)) process.stdout.write(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
}

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function swapTemplate(): Promise<Graph> {
    return JSON.parse(await readFile(path.join(SKILL_DIR, 'assets', 'workflows', 'h3_swap.api.json'), 'utf8'));
}
const comfyOf = (f: Flags) => new Comfy(str(f, 'comfy-url') ?? process.env.COMFY_LOCAL_URL ?? DEFAULT_COMFY_URL, Boolean(f['allow-remote-comfy']));
async function promptOf(f: Flags, required: boolean): Promise<string | undefined> {
    const file = str(f, 'prompt-file');
    const text = file ? (await readFile(file, 'utf8')).trim() : str(f, 'prompt');
    if (required && !text) throw new Error('A prompt is required: --prompt "<text>" or --prompt-file <file>.');
    return text;
}

// ---------------------------------------------------------------- doctor

async function doctor(f: Flags): Promise<void> {
    const report: Record<string, unknown> = {};
    for (const tool of ['ffmpeg', 'ffprobe']) {
        try {
            const r = await ff.run(tool, ['-version']);
            report[tool] = r.code === 0 ? r.stdout.toString().split('\n')[0].slice(0, 60) : 'not working';
        } catch (e) {
            report[tool] = `MISSING: ${(e as Error).message}`;
        }
    }
    try {
        const comfy = comfyOf(f);
        const stats = await comfy.json('/system_stats');
        report.comfyui = `${comfy.base} (ComfyUI ${stats?.system?.comfyui_version ?? '?'})`;
        report.gpu = (stats?.devices ?? []).map((d: any) => `${d.name}: ${Math.round((d.vram_total ?? 0) / 2 ** 30)} GB`).join('; ') || 'none reported';
        const missing = await comfy.missingNodes(REQUIRED_NODES);
        report.nodes = missing.length ? `MISSING: ${missing.join(', ')} — see references/setup.md` : 'all present';
        const have = new Set<string>();
        for (const [cls, input] of [['UNETLoader', 'unet_name'], ['CLIPLoader', 'clip_name'], ['VAELoader', 'vae_name'], ['LoraLoaderModelOnly', 'lora_name'], ['CheckpointLoaderSimple', 'ckpt_name']] as const) {
            for (const c of await comfy.choices(cls, input).catch(() => [])) have.add(path.basename(c.replace(/\\/g, '/')));
        }
        const lacking = Object.values(MODELS).filter((m) => !have.has(m));
        report.models = lacking.length ? `MISSING: ${lacking.join(', ')} — see references/setup.md` : 'all seven present';
    } catch (e) {
        report.comfyui = `NOT READY: ${(e as Error).message}`;
    }
    report.ready = !Object.values(report).some((v) => /MISSING|NOT READY|not working/.test(String(v)));
    emit(report);
    if (!report.ready) process.exitCode = 1;
}

// ---------------------------------------------------------------- init

async function init(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    if (!run) throw new Error('Usage: init <run-folder> (--source <video> | --from-breakdown <breakdown-folder>) --identity <photo>');
    const given = str(f, 'source');
    const from = str(f, 'from-breakdown');
    if (Boolean(given) === Boolean(from)) throw new Error('init needs exactly one of --source or --from-breakdown: --source <video>, or --from-breakdown <breakdown folder> to start from a breakdown.');
    const identity = need(f, 'identity');
    const imported = from ? await breakdownSource(path.resolve(from)) : undefined;
    const source = imported ? imported.file : given!;
    await mkdir(run, { recursive: true });
    const release = await lockRun(run);
    try {
        await initLocked(run, f, source, identity, imported);
    } finally {
        await release();
    }
}

async function initLocked(run: string, f: Flags, source: string, identity: string, imported?: Imported): Promise<void> {
    if (await stat(path.join(run, 'remake.json')).catch(() => null)) throw new Error(`${run} already holds a remake. Use another folder.`);
    // An imported source already has its exact frame count: nothing is decoded to count or measure it again.
    const p = await ff.probe(source, { countFrames: !imported });
    // Every step counts frames and turns them into seconds with one frame rate. A variable frame rate (common in
    // phone recordings) breaks that silently: refuse it and say how to fix it.
    if (p.variableRate || (await ff.unevenFrames(source, p.fps)) > 0) {
        throw new Error(`${source} has a variable frame rate (${p.fps.toFixed(3)} fps on average): frame positions and times would not agree. Convert it to a constant rate first, e.g. ffmpeg -i "${source}" -fps_mode cfr -r ${Math.round(p.fps)} -c:v libx264 -crf 12 -c:a copy source_cfr.mp4`);
    }
    await mkdir(path.join(run, 'refs'), { recursive: true });
    await mkdir(path.join(run, 'shots'), { recursive: true });
    const src = `source${path.extname(source).toLowerCase() || '.mp4'}`;
    const idf = `refs/identity${path.extname(identity).toLowerCase() || '.jpg'}`;
    await copyFile(source, path.join(run, src));
    await copyFile(identity, path.join(run, idf));
    const copied = await sha256File(path.join(run, src));
    if (imported && copied !== imported.sha256) throw new Error(`${source} changed while it was copied. Run init again.`);
    const cuts = imported ? { frames: imported.frames, cuts: imported.cuts } : await measureCuts(path.join(run, src), p.fps);
    const m: Manifest = {
        schema: SCHEMA,
        createdAt: new Date().toISOString(),
        source: {
            file: src, sha256: copied, width: p.width, height: p.height, fps: imported?.fps ?? p.fps, duration: p.duration, hasAudio: p.hasAudio, frames: cuts.frames, cuts: cuts.cuts,
            cutsBy: imported ? 'imported' : 'measured', evenTiming: true,
            ...(imported ? { importedFrom: { breakdown: imported.dir, analysisId: imported.analysisId, sha256: imported.sha256 } } : {}),
            ...(imported?.sound ? { sound: imported.sound } : {}),
            ...(imported?.hints.length ? { hints: imported.hints } : {}),
        },
        references: [{ id: 'identity', role: 'identity', file: idf, sha256: await sha256File(path.join(run, idf)) }],
        ...(str(f, 'character') ? { character: str(f, 'character') } : {}),
        shots: [],
    };
    await save(run, m);
    emit({ run, source: `${p.width}x${p.height}, ${p.fps.toFixed(2)} fps, ${p.duration.toFixed(2)} s${p.hasAudio ? '' : ', no audio'}`, scenes: describeScenes(m), next: `check the scenes (scenes ${run}), then identity ${run}, targets ${run}, plan ${run}, run ${run}` });
}

interface Imported {
    dir: string;
    file: string;
    sha256: string;
    fps: number;
    frames: number;
    cuts: number[];
    analysisId: string;
    /** The sound TikTok credits for the post, when the breakdown's capture named one. */
    sound: Manifest['source']['sound'] | null;
    hints: NonNullable<Manifest['source']['hints']>;
}

/**
 * The source of a breakdown: its working file (the original, or the constant-rate copy it made) and the frame cuts
 * measured on it. Refuses when the breakdown predates frame cuts or the file is not the one it measured.
 */
async function breakdownSource(dir: string): Promise<Imported> {
    let b: any;
    try {
        b = JSON.parse(await readFile(path.join(dir, 'breakdown.json'), 'utf8'));
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No breakdown.json in ${dir}. Run the breakdown's analyze on it first, or run init with --source <video>.`);
        throw new Error(`${path.join(dir, 'breakdown.json')} is not valid JSON: ${(e as Error).message}`);
    }
    const tb = b?.timebase;
    const cuts = b?.cuts?.frames?.final;
    if (!tb || typeof tb.file !== 'string' || typeof tb.sha256 !== 'string' || !Array.isArray(cuts)) {
        throw new Error(`This breakdown predates frame cuts. Run analyze ${dir} again, or run init with --source <video>.`);
    }
    const [num, den] = String(tb.rate).split('/').map(Number);
    const frames = Number(tb.frames);
    if (!(num > 0) || !((den ?? 1) > 0) || !Number.isInteger(frames) || frames < 2) throw new Error(`The time base in ${dir}/breakdown.json is not valid. Run analyze ${dir} again.`);
    if (cuts.some((c: unknown) => !Number.isInteger(c) || (c as number) <= 0 || (c as number) >= frames)) throw new Error(`The frame cuts in ${dir}/breakdown.json are not valid. Run analyze ${dir} again.`);
    const file = path.resolve(dir, tb.file);
    if (path.relative(dir, file).startsWith('..')) throw new Error(`The breakdown's working file must be inside ${dir}.`);
    const sha = await sha256File(file).catch(() => null);
    if (sha !== tb.sha256) throw new Error(`${file} ${sha === null ? 'is missing' : 'changed since the breakdown measured it'}. Run init with --source <video> instead (or analyze the breakdown again).`);
    // The credited sound (an attribution, not proof of what is audible) and what the review said about each shot.
    const src = b?.source;
    const attribution = src?.audio_attribution;
    const sound = src?.music_id || attribution ? { musicId: src?.music_id ? String(src.music_id) : null, title: attribution?.title ?? null, artist: attribution?.artist ?? null, kind: attribution?.kind ?? null } : null;
    const hints = (Array.isArray(b?.shots) ? b.shots : [])
        .filter((s: any) => Number.isInteger(s?.first_frame) && Number.isInteger(s?.end_frame))
        .map((s: any) => ({ first: s.first_frame, end: s.end_frame, ...(s.review?.type ? { type: String(s.review.type) } : {}), ...(s.review?.description ? { description: String(s.review.description) } : {}), ...(s.review?.camera ? { camera: String(s.review.camera) } : {}) }));
    return { dir, file, sha256: tb.sha256, fps: num / (den ?? 1), frames, cuts: [...new Set<number>(cuts)].sort((x, y) => x - y), analysisId: String(b.analysis_id ?? ''), sound, hints };
}

/** Cuts of a video, measured from the picture: the first frame of every new shot. */
async function measureCuts(file: string, fps: number): Promise<{ frames: number; cuts: number[] }> {
    const d = await ff.frameDiffs(file, { fps });
    return { frames: d.length + 1, cuts: detectCuts(d) };
}

/** The source's cuts, measured now and recorded if this run predates them. */
async function sourceCuts(run: string, m: Manifest): Promise<{ frames: number; cuts: number[] }> {
    if (!m.source.evenTiming) {
        // Runs started before this check: frame numbers are turned into times with one rate, so it must hold.
        const uneven = await ff.unevenFrames(path.join(run, m.source.file), m.source.fps);
        if (uneven > 0) throw new Error(`The source has ${uneven} frame(s) off a constant ${m.source.fps.toFixed(3)} fps grid (variable frame rate): frame positions and times would not agree. Convert it to a constant rate and start a new run.`);
        m.source.evenTiming = true;
        await save(run, m);
    }
    if (!m.source.cuts || !m.source.frames) {
        const c = await measureCuts(path.join(run, m.source.file), m.source.fps);
        Object.assign(m.source, { frames: c.frames, cuts: c.cuts, cutsBy: 'measured' });
        await save(run, m);
    }
    return { frames: m.source.frames!, cuts: m.source.cuts! };
}

function describeScenes(m: Manifest): string[] {
    const fps = m.source.fps;
    return sceneList(m.source.cuts ?? [], m.source.frames ?? Math.round(m.source.duration * fps)).map(
        (sc) => `scene ${sc.n}: frames ${sc.first}-${sc.end - 1} (${(sc.first / fps).toFixed(3)}-${(sc.end / fps).toFixed(3)} s)`,
    );
}

async function scenesCmd(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const { frames } = await sourceCuts(run, m);
    if (str(f, 'set') !== undefined) {
        const cuts = str(f, 'set')!.split(',').map((x) => x.trim()).filter(Boolean).map(Number);
        if (cuts.some((c) => !Number.isInteger(c) || c <= 0 || c >= frames)) throw new Error(`--set takes whole frame numbers between 1 and ${frames - 1}: the first frame of each new shot.`);
        m.source.cuts = [...new Set(cuts)].sort((a, b) => a - b);
        m.source.cutsBy = 'hand';
        await save(run, m);
    }
    emit({ run, fps: m.source.fps, frames, cutsBy: m.source.cutsBy, scenes: describeScenes(m), next: 'swap <run> --shot <id> --scene <n> ...' });
}

// ---------------------------------------------------------------- generation

/** Waits for the attempt's job and downloads its video. `graph` is submitted first unless the attempt already has a job. */
async function generate(comfy: Comfy, graph: Graph | null, attempt: Attempt, run: string, m: Manifest, f: Flags, dest: string): Promise<void> {
    const timeoutMs = num(f, 'timeout', 1800) * 1000;
    const t0 = Date.now();
    try {
        if (!attempt.promptId) {
            if (!graph) throw new Error('This attempt was never submitted; run the command again without --resume.');
            // Saved BEFORE the request: if the answer is lost, the job is found again by this client id.
            await save(run, m);
            attempt.promptId = (await comfy.submit(graph, attempt.clientId)).promptId;
            await save(run, m);
            log(`submitted ${attempt.promptId}; waiting (this takes minutes)`);
        }
        let lastTick = 0;
        const entry = await comfy.wait(attempt.promptId, {
            timeoutMs,
            onTick: (_s, ms) => {
                if (ms - lastTick >= 30_000) {
                    lastTick = ms;
                    log(`still generating, ${Math.round(ms / 1000)} s`);
                }
            },
        });
        await comfy.download(pickVideo(entry, SAVE_NODE[attempt.kind]), dest);
        attempt.status = 'done';
        delete attempt.error;
        attempt.seconds = (attempt.seconds ?? 0) + Math.round((Date.now() - t0) / 1000);
    } catch (e) {
        attempt.status = e instanceof ComfyError && (e.kind === 'timeout' || e.kind === 'unknown_submit' || e.kind === 'unreachable') ? 'unknown' : 'failed';
        attempt.error = (e as Error).message;
        await save(run, m);
        throw e;
    }
}

/**
 * The attempt a --resume refers to. `--resume <prompt-id>` names a recorded job; `--resume last` takes the latest
 * unfinished attempt of the shot. An attempt whose submission was never confirmed has no job id yet: it is looked
 * up in ComfyUI by the client id that was saved before submitting. Nothing is prepared, uploaded or resubmitted.
 */
async function resumable(comfy: Comfy, s: Shot | undefined, id: string, promptId: string, kind: Attempt['kind']): Promise<Attempt> {
    if (!s) throw new Error(`There is no shot "${id}" to resume.`);
    const unfinished = s.attempts.filter((x) => x.status !== 'done' && x.kind === kind);
    let a = promptId === 'last' ? unfinished[unfinished.length - 1] : s.attempts.find((x) => x.promptId === promptId);
    if (!a && promptId !== 'last') {
        // A job id found by hand in ComfyUI: accept it only if ComfyUI says it was submitted with the client id
        // saved for one of this shot's unconfirmed attempts.
        const client = await comfy.clientOf(promptId);
        a = client ? unfinished.find((x) => !x.promptId && x.clientId === client) : undefined;
        if (a) a.promptId = promptId;
        else throw new Error(`Job ${promptId} does not belong to an unfinished ${kind} of shot "${id}"${client === null ? ' (ComfyUI does not know that job)' : ''}. status lists the unfinished attempts; --resume last looks the job up for you.`);
    }
    if (!a) throw new Error(`Shot "${id}" has no unfinished ${kind}.`);
    if (a.kind !== kind) throw new Error(`Job ${promptId} is a ${a.kind}, not a ${kind}.`);
    if (a.status === 'done') throw new Error(`Job ${promptId} was already collected (attempt ${a.n}).`);
    if (!a.promptId) {
        const found = await comfy.findByClient(a.clientId);
        if (!found) {
            throw new Error(`The job of attempt ${a.n} of shot "${id}" is not in ComfyUI's queue or in the history it still keeps. Either it never arrived or the history was cleared. Look in ComfyUI's output folder for files starting with "remake_${id}_${a.n}_" before making a new attempt; if you find the job id, pass it with --resume <prompt-id>.`);
        }
        a.promptId = found;
        log(`found the job of attempt ${a.n} in ComfyUI: ${found}`);
    }
    return a;
}

async function swap(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    // With a plan, --unit <id> (or --scene <n> when that shot is a single run) names a planned run: its span, prompt,
    // point, crop, tier and direction are the defaults, and any flag given still wins.
    const planned = str(f, 'resume') ? null : await plannedUnit(run, f);
    const id = checkId(str(f, 'shot') ?? planned?.id ?? need(f, 'shot'));
    const dir = path.join(run, 'shots', id);
    const comfy = comfyOf(f);
    let s = m.shots.find((x) => x.id === id);
    let attempt: Attempt;
    let graph: Graph | null = null;

    if (str(f, 'resume')) {
        // Collect a job that is already running or finished: nothing is prepared, uploaded or submitted again,
        // and the shot's own recorded settings decide how the result is treated.
        attempt = await resumable(comfy, s, id, str(f, 'resume')!, 'swap');
    } else {
        const fps = m.source.fps;
        const { frames: total, cuts } = await sourceCuts(run, m);
        let wantStart: number;
        let wantDuration: number;
        if (planned && !str(f, 'start') && !str(f, 'duration')) {
            wantStart = planned.first / fps;
            wantDuration = (planned.end - planned.first) / fps;
        } else if (str(f, 'scene')) {
            // The stretch ends ON the cut: a stretch that stops short leaves frames of the original person.
            const sc = sceneList(cuts, total).find((x) => x.n === num(f, 'scene'));
            if (!sc) throw new Error(`There is no scene ${str(f, 'scene')}. scenes ${run} lists them.`);
            if (str(f, 'duration')) throw new Error('--scene ends the stretch on the cut; give --start to begin later, not --duration.');
            const first = str(f, 'start') ? Math.round(num(f, 'start') * fps) : sc.first;
            if (first < sc.first || first >= sc.end) throw new Error(`--start must fall inside scene ${sc.n} (${(sc.first / fps).toFixed(3)}-${(sc.end / fps).toFixed(3)} s).`);
            wantStart = first / fps;
            wantDuration = (sc.end - first) / fps;
        } else {
            wantStart = num(f, 'start');
            wantDuration = num(f, 'duration');
        }
        // Snapped to whole frames of the source, so the stretch recorded is exactly the one cut.
        const span = ff.frameSpan(wantStart, wantDuration, fps);
        const problems = stretchProblems(span.first, span.first + span.frames, cuts);
        if (problems.length && !f['leave-original']) {
            throw new Error(`The stretch (source frames ${span.first}-${span.first + span.frames - 1}) does not fit the shots of the source: ${problems.join('; ')}. Use --scene <n> to cover a shot cut to cut (scenes ${run} lists them), or pass --leave-original if those frames really do not show the person.`);
        }
        const start = Number(span.start.toFixed(5));
        const duration = Number(span.duration.toFixed(5));
        if (start + duration > m.source.duration + 0.05) throw new Error(`The stretch ${start}–${(start + duration).toFixed(2)} s is outside the ${m.source.duration.toFixed(2)} s source.`);
        const tier = (str(f, 'tier') ?? planned?.tier ?? SWAP_DEFAULTS.tier) as '480' | '768';
        if (!['480', '768'].includes(tier)) throw new Error('--tier is 480 or 768.');
        const crop = str(f, 'crop') ? parseRect(str(f, 'crop')!) : planned ? planned.crop : undefined;
        if (crop) ff.checkRect(crop, m.source);
        const reversed = f.reverse ? true : Boolean(planned?.reverse);
        const sent: Rect = crop ?? { x: 0, y: 0, w: m.source.width, h: m.source.height };
        if (str(f, 'point') && str(f, 'point-prepared')) throw new Error('Give --point or --point-prepared, not both.');
        let point = str(f, 'point-prepared') ? parsePoint(str(f, 'point-prepared')!, 'point-prepared') : undefined;
        const plannedPoint = planned?.point ? `${planned.point[0]},${planned.point[1]}` : undefined;
        const pointFlag = str(f, 'point') ?? (!str(f, 'point-prepared') ? plannedPoint : undefined);
        if (pointFlag) {
            const canvas = tierCanvas(tier, sent);
            point = toPreparedPoint(parsePoint(pointFlag, 'point'), sent, canvas.w, canvas.h);
            log(`the model works at ${canvas.w}x${canvas.h}; the point is (${point.x}, ${point.y}) there`);
        }
        const selection = (str(f, 'selection') ?? SWAP_DEFAULTS.selection) as 'largest';
        if (!['largest', 'leftmost', 'rightmost', 'index'].includes(selection)) throw new Error('--selection is largest, leftmost, rightmost or index.');
        if (s && (s.kind !== 'swap' || s.start !== start || s.duration !== duration || JSON.stringify(s.crop) !== JSON.stringify(crop) || Boolean(s.reversed) !== reversed)) {
            throw new Error(`Shot "${id}" already exists with a different stretch, crop or direction. Use a new shot id.`);
        }
        if (!s) {
            s = { id, kind: 'swap', start, duration, frames: [span.first, span.first + span.frames], ...(crop ? { crop } : {}), ...(reversed ? { reversed } : {}), attempts: [] };
            m.shots.push(s);
        }
        const n = s.attempts.length + 1;
        await mkdir(dir, { recursive: true });
        const driving = path.join(dir, 'driving.mp4');
        // 24 fps material carried at a higher rate repeats frames. The model resamples to 24 fps on its own, and that
        // can keep the repeats and drop real frames (motion turns jerky). Send only the distinct frames instead.
        // A 24 fps source is sent frame for frame as well, so the same protections (exact length asked, frame count and
        // alignment checked) apply to it.
        const native = Math.abs(fps - MODEL_FPS) < 0.05; // 24 and 23.976
        const keep = native ? Array.from({ length: span.frames }, (_, i) => i) : f['all-frames'] ? null : distinctFrames(await ff.frameDiffs(path.join(run, m.source.file), { fps, first: span.first, frames: span.frames }), span.frames, fps);
        if (keep && !native) log(`the stretch is ${MODEL_FPS} fps material repeated to ${fps.toFixed(2)} fps: sending its ${keep.length} distinct frames of ${span.frames}`);
        if (keep && keep.length > SWAP_MAX_SECONDS * MODEL_FPS) throw new Error(`The stretch has ${keep.length} frames to send; a run takes up to ${SWAP_MAX_SECONDS * MODEL_FPS}. Split it at a cut or with --start.`);
        await ff.cut(path.join(run, m.source.file), driving, { start, duration, fps, crop, reverse: reversed, hasAudio: m.source.hasAudio, ...(keep ? { keep, keepFps: MODEL_FPS } : {}) });
        // The first frame the model sees: the detector's point or word must hit the subject HERE.
        const firstFrame = path.join(dir, 'first_frame.jpg');
        await ff.frameAt(driving, firstFrame, 'first');
        log(`stretch ${start.toFixed(4)}–${(start + duration).toFixed(4)} s (source frames ${span.first}–${span.first + span.frames - 1}); first frame the model sees: ${firstFrame}`);
        const prefix = `remake_${id}_${n}_${randomUUID().slice(0, 8)}`;
        const prompt = (await promptOf(f, false)) ?? planned?.prompt;
        const seed = num(f, 'seed', planned?.seed ?? SWAP_DEFAULTS.seed);
        const expand = num(f, 'expand', planned?.expand ?? SWAP_DEFAULTS.expand);
        const settings = {
            tier,
            seed,
            prompt,
            detect: str(f, 'detect') ?? SWAP_DEFAULTS.detect,
            selection,
            index: num(f, 'index', SWAP_DEFAULTS.index),
            point,
            expand,
            recover: Boolean(f.recover),
        };
        const identity = reference(m, 'identity');
        // An attempt made exactly as the plan says records what it was made from; one with any override does not, so
        // `run` never mistakes it for the planned one.
        let fresh: Fresh | undefined;
        if (planned && pointFlag === plannedPoint) {
            const effective: PlanUnit = { ...planned, first: span.first, end: span.first + span.frames, reverse: reversed, crop, tier, expand, prompt, seed };
            const now = await freshFor(run, m, planned);
            if (now && freshOf({ photoSha256: now.photoSha256, card: now.card, target: now.target, entry: effective }).plan === now.fresh.plan) fresh = now.fresh;
        }
        graph = fillSwap(await swapTemplate(), {
            ...settings,
            video: await comfy.upload(driving, `${prefix}_driving.mp4`),
            identity: await comfy.upload(path.join(run, identity.file), `${prefix}_identity${path.extname(identity.file)}`),
            start: 0,
            // Otherwise the model resamples to 24 fps; ask for the frames that gives, with the same margin.
            duration: modelSeconds(keep ? keep.length : Math.round(duration * MODEL_FPS)),
            prefix,
        });
        attempt = { n, at: new Date().toISOString(), kind: 'swap', settings: { ...settings, identitySha256: identity.sha256, drivingSha256: await sha256File(driving), ...(fresh ? { fresh } : {}) }, graphHash: graphHash(graph), clientId: randomUUID(), status: 'submitted', ...(keep ? { keep } : {}) };
        s.attempts.push(attempt);
        // A new attempt makes everything built on this shot out of date, whether or not it succeeds.
        invalidate(m, id, 'attempt');
    }
    const raw = path.join(dir, `attempt${attempt.n}.raw.mp4`);
    await generate(comfy, graph, attempt, run, m, f, raw);
    const out = path.join(dir, `attempt${attempt.n}.mp4`);
    if (s!.reversed) await ff.reverse(raw, out);
    else await copyFile(raw, out);
    const p = await ff.probe(out);
    Object.assign(attempt, { output: path.relative(run, out).replace(/\\/g, '/'), outputSha256: await sha256File(out), frames: p.frames });
    invalidate(m, id, 'attempt');
    await save(run, m);
    if (attempt.keep && p.frames !== attempt.keep.length) log(`warning: ${attempt.keep.length} frames were sent and ${p.frames} came back; place refuses this attempt.`);
    // The generated frames must line up with the frames they replace. A clip shifted by a frame (a frame lost at the
    // start) plays early against everything around it; measured on the picture, since outside the person the model
    // keeps what it was given. Only comparable when the clip sent is itself at 24 fps (distinct frames sent), and
    // only against the very clip this attempt was sent (driving.mp4 is rewritten by each new attempt).
    const driving = path.join(dir, 'driving.mp4');
    if (attempt.keep && (await stat(driving).catch(() => null)) && (await sha256File(driving)) === attempt.settings.drivingSha256) {
        const al = await ff.frameAlignment(out, driving, Boolean(s!.reversed));
        attempt.alignment = { shift: al.shift, error: Number(al.error.toFixed(2)), errorAtZero: Number(al.errorAtZero.toFixed(2)) };
        if (al.shift !== 0 && al.error < 0.8 * al.errorAtZero) log(`warning: the generated clip lines up best with the clip sent shifted by ${al.shift} frame(s) (error ${al.error.toFixed(1)} against ${al.errorAtZero.toFixed(1)} unshifted): it would play out of step. Do not place it; make a new attempt and report this.`);
    }
        await save(run, m);
    emit({ shot: id, attempt: attempt.n, output: out, size: `${p.width}x${p.height}`, frames: p.frames, ...(attempt.keep ? { sent: `${attempt.keep.length} distinct frames at ${MODEL_FPS} fps` } : {}), seconds: attempt.seconds, next: `place ${run} --shot ${id}   (then watch it, then approve)` });
}

async function continueShot(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const id = checkId(need(f, 'shot'));
    const dir = path.join(run, 'shots', id);
    const comfy = comfyOf(f);
    let s = m.shots.find((x) => x.id === id);
    let attempt: Attempt;
    let graph: Graph | null = null;

    if (str(f, 'resume')) {
        attempt = await resumable(comfy, s, id, str(f, 'resume')!, 'continue');
    } else {
        const after = shot(m, need(f, 'after'));
        if (after.crop) throw new Error(`Shot "${after.id}" was generated from a crop. Only a full-frame shot can be continued.`);
        const upstream = staleContinuation(m, after);
        if (upstream) throw new Error(`Shot "${after.id}" is out of date: ${upstream}. Regenerate it before continuing it.`);
        if (!after.approved || !after.placed || after.approved.sha256 !== after.placed.sha256) throw new Error(`Shot "${after.id}" is not approved. Place it, watch it and approve it first: the continuation is built on exactly that version.`);
        const seconds = num(f, 'seconds');
        if (!(seconds > 0) || seconds > 10) throw new Error('--seconds is the new material wanted, up to 10.');
        const guideFrames = num(f, 'guide-frames', CONTINUE_DEFAULTS.guideFrames);
        if (!Number.isInteger(guideFrames) || guideFrames < 1) throw new Error('--guide-frames is a whole number of frames, 1 or more.');
        // A shot joined from parts has no attempts of its own: it is continued from the file it was placed as.
        const prev = after.parts ? { n: undefined, output: after.placed.file, outputSha256: after.placed.sha256 } : chosen(after);
        const prevFile = path.join(run, prev.output!);
        if ((await sha256File(prevFile)) !== prev.outputSha256) throw new Error(`The file of shot "${after.id}" changed since it was generated. Generate it again.`);
        const pp = await ff.probe(prevFile);
        if (pp.width % 16 || pp.height % 16) throw new Error(`The shot to continue is ${pp.width}x${pp.height}; the model needs multiples of 16.`);
        if (s && (s.kind !== 'continue' || s.after !== after.id)) throw new Error(`Shot "${id}" already exists as something else. Use a new shot id.`);
        if (!s) {
            s = { id, kind: 'continue', after: after.id, attempts: [] };
            m.shots.push(s);
        }
        const n = s.attempts.length + 1;
        await mkdir(dir, { recursive: true });
        const scene = path.join(dir, 'scene.png');
        await ff.frameAt(prevFile, scene, 'last');
        const prefix = `remake_${id}_${n}_${randomUUID().slice(0, 8)}`;
        const identity = reference(m, 'identity');
        const settings = { seconds, guideFrames, seed: num(f, 'seed', CONTINUE_DEFAULTS.seed), steps: CONTINUE_DEFAULTS.steps, prompt: (await promptOf(f, true))!, width: pp.width, height: pp.height, afterAttempt: prev.n, afterSha256: prev.outputSha256, identitySha256: identity.sha256 };
        graph = buildContinuation({
            ...settings,
            scene: await comfy.upload(scene, `${prefix}_scene.png`),
            identity: await comfy.upload(path.join(run, identity.file), `${prefix}_identity${path.extname(identity.file)}`),
            previous: await comfy.upload(prevFile, `${prefix}_previous.mp4`),
            previousFrames: pp.frames,
            prefix,
        });
        attempt = { n, at: new Date().toISOString(), kind: 'continue', settings, graphHash: graphHash(graph), clientId: randomUUID(), status: 'submitted' };
        s.attempts.push(attempt);
        invalidate(m, id, 'attempt');
    }
    const guideFrames = Number(attempt.settings.guideFrames);
    const raw = path.join(dir, `attempt${attempt.n}.raw.mp4`);
    await generate(comfy, graph, attempt, run, m, f, raw);
    const expected = continuationFrames(Number(attempt.settings.seconds), guideFrames);
    const rp = await ff.probe(raw);
    if (rp.frames <= guideFrames) throw new Error(`The generated clip has ${rp.frames} frames, not more than the ${guideFrames} guide frames.`);
    const out = path.join(dir, `attempt${attempt.n}.mp4`);
    // This command owns the overlap: the guide frames repeat the end of the previous shot and are removed here, once.
    await ff.dropFrames(raw, out, guideFrames);
    const p = await ff.probe(out);
    Object.assign(attempt, { output: path.relative(run, out).replace(/\\/g, '/'), outputSha256: await sha256File(out), frames: p.frames });
    invalidate(m, id, 'attempt');
    await save(run, m);
    emit({ shot: id, attempt: attempt.n, output: out, generatedFrames: rp.frames, expectedFrames: expected.length, newFrames: p.frames, newSeconds: (p.frames / H3_FPS).toFixed(2), seconds: attempt.seconds, next: `place ${run} --shot ${id}` });
}

// ---------------------------------------------------------------- identity, targets, plan, run

const FILE = { card: 'identity_card.json', cardTask: 'identity_task.json', tasks: 'target_tasks.json', targets: 'targets.json', plan: 'plan.json' } as const;

async function readJson<T>(file: string): Promise<T | null> {
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
    }
    try {
        return JSON.parse(text) as T;
    } catch (e) {
        throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
    }
}

async function writeJson(file: string, data: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmp, file);
}

const frameOf = (m: Manifest) => ({ width: m.source.width, height: m.source.height });

async function stretchesOf(run: string, m: Manifest): Promise<Stretch[]> {
    const { frames, cuts } = await sourceCuts(run, m);
    return sceneStretches(cuts, frames, m.source.fps);
}

/** The planned run a swap refers to (`--unit <id>`, or `--scene <n>` when that shot is a single run), if there is a plan. */
async function plannedUnit(run: string, f: Flags): Promise<PlanUnit | null> {
    const want = str(f, 'unit');
    const scene = str(f, 'scene');
    if (!want && !scene) return null;
    const plan = await readJson<Plan>(path.join(run, FILE.plan));
    if (!plan) {
        if (want) throw new Error(`--unit needs a plan: run targets ${run}, fill targets.json, then plan ${run}.`);
        return null;
    }
    if (want) {
        const u = plan.units.find((x) => x.id === want);
        if (!u) throw new Error(`The plan has no run "${want}". Runs: ${plan.units.map((x) => x.id).join(', ')}.`);
        if (u.action !== 'swap') throw new Error(`The plan keeps "${want}" as it is: there is nothing to swap.`);
        return u;
    }
    const us = plan.units.filter((x) => x.scene === Number(scene));
    if (!us.length) return null;
    if (us.length > 1) throw new Error(`Scene ${scene} is planned as ${us.length} runs (${us.map((x) => x.id).join(', ')}); name one with --unit <id>.`);
    return us[0].action === 'swap' ? us[0] : null;
}

/** The hashes a plan-driven attempt is made from, now: the photo, the card, the target and the plan entry. */
async function freshFor(run: string, m: Manifest, unit: PlanUnit): Promise<{ fresh: Fresh; photoSha256: string; card: string; target: unknown } | null> {
    const t = await readJson<Targets>(path.join(run, FILE.targets));
    const entry = t?.stretches?.[unit.stretch];
    if (!t || !entry) return null;
    const photoSha256 = await sha256File(path.join(run, reference(m, 'identity').file));
    const card = m.character ?? '';
    const target = { subject: t.subject, entry };
    return { fresh: freshOf({ photoSha256, card, target, entry: unit }), photoSha256, card, target };
}

/**
 * Compares every plan-driven attempt with the inputs as they are now. A shot whose chosen attempt was made from
 * anything else is out of date: its placement, approval, joined shots, the timeline, the sound and both finals are
 * cleared (the attempt itself stays as history, and is never reused). Returns the shots it cleared.
 */
async function markStale(run: string, m: Manifest): Promise<string[]> {
    const id = reference(m, 'identity');
    const live = await sha256File(path.join(run, id.file)).catch(() => null);
    if (live && live !== id.sha256) id.sha256 = live;
    const plan = await readJson<Plan>(path.join(run, FILE.plan));
    const cleared: string[] = [];
    for (const s of m.shots) {
        if (s.kind !== 'swap' || s.parts) continue;
        const done = s.attempts.filter((a) => a.status === 'done' && a.output);
        const cur = s.selected !== undefined ? done.find((a) => a.n === s.selected) : done[done.length - 1];
        const was = cur?.settings.fresh as Fresh | undefined;
        const unit = plan?.units.find((u) => u.id === s.id);
        if (!was || !unit) continue;
        const now = await freshFor(run, m, unit);
        if (now && !sameFresh(was, now.fresh)) {
            invalidate(m, s.id, 'attempt');
            cleared.push(s.id);
        }
    }
    // A kept stretch has no attempt, but it was planned from its target too: when that changed, the joined shot it is
    // part of (if any), the timeline, the sound and both finals are cleared the same way.
    const targets = plan ? await readJson<Targets>(path.join(run, FILE.targets)) : null;
    for (const u of plan?.units ?? []) {
        if (u.action !== 'keep' || u.target_sha256 === undefined || !targets) continue;
        if (u.target_sha256 === targetHash(targets.subject, targets.stretches[u.stretch])) continue;
        const joined = m.shots.find((x) => x.id === `s${u.scene}` && x.parts);
        invalidate(m, joined?.id ?? u.id, 'attempt');
        if (joined && !cleared.includes(joined.id)) cleared.push(joined.id);
    }
    await save(run, m);
    return cleared;
}

/** The card as identity_card.json says it now, against the card the run was registered with: they must be the same. */
async function assertCardRegistered(run: string, m: Manifest): Promise<void> {
    const filled = await readJson<unknown>(path.join(run, FILE.card));
    if (filled === null || !m.character) return;
    const v = validateCard(filled);
    if (!v.ok) throw new Error(`${FILE.card} is not usable:\n- ${v.errors.join('\n- ')}\nFix it, then run identity ${run} again.`);
    if (buildCard(filled as Record<(typeof CARD_FIELDS)[number], string>) !== m.character) throw new Error(`${FILE.card} was edited after the card was registered, so the prompts and the freshness checks still use the old one. Run identity ${run} again.`);
}

async function identityCmd(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    let invalidated = false;
    if (str(f, 'photo')) {
        const photo = str(f, 'photo')!;
        const ref = reference(m, 'identity');
        const dest = `refs/identity${path.extname(photo).toLowerCase() || '.jpg'}`;
        await copyFile(photo, path.join(run, dest));
        if (dest !== ref.file) await rm(path.join(run, ref.file), { force: true });
        const sha = await sha256File(path.join(run, dest));
        if (sha !== ref.sha256 || dest !== ref.file) invalidated = true;
        ref.file = dest;
        ref.sha256 = sha;
        if (invalidated) invalidateAll(m);
    }
    const ref = reference(m, 'identity');
    ref.sha256 = await sha256File(path.join(run, ref.file));
    await writeJson(path.join(run, FILE.cardTask), {
        schema: 'tt.remake.identity_task.v1',
        photo: ref.file,
        photo_sha256: ref.sha256,
        instruction: 'Look at the photo. Describe only what it shows, in short concrete phrases, and write identity_card.json with exactly these fields. Do not describe the person in the source video. Use "none" when there is nothing to describe.',
        answer_file: FILE.card,
        fields: {
            hair: 'colour, length, how it is worn',
            face: 'face shape and the most recognisable features, in a few words',
            skin: 'skin tone and texture',
            build: 'body type and height impression',
            distinctive_marks: 'moles, freckles, scars, tattoos, glasses, anything that identifies this face',
            jewellery: 'earrings, necklaces, rings, or "none"',
            default_wardrobe: 'what the photo shows them wearing: garment, colour, material, cut',
        },
        example: { hair: 'long dark brown hair worn loose', face: 'an oval face with dark eyes', skin: 'light olive skin', build: 'slim build', distinctive_marks: 'a small mole under the left eye', jewellery: 'none', default_wardrobe: 'a black lace sleeveless mini dress' },
    });
    const filled = await readJson<unknown>(path.join(run, FILE.card));
    if (filled === null) {
        await save(run, m);
        emit({ run, task: path.join(run, FILE.cardTask), card_file: path.join(run, FILE.card), card: m.character ?? null, ...(invalidated ? { invalidated: 'every swapped shot (the photo changed)' } : {}), next: m.character ? 'the card was given at init; write identity_card.json to replace it' : `look at ${ref.file}, write ${FILE.card}, then run identity ${run} again` });
        return;
    }
    const v = validateCard(filled);
    if (!v.ok) throw new Error(`${FILE.card} is not usable:\n- ${v.errors.join('\n- ')}`);
    const text = buildCard(filled as Record<(typeof CARD_FIELDS)[number], string>);
    const changed = m.character !== text;
    m.character = text;
    if (changed) invalidateAll(m);
    await save(run, m);
    const cleared = await markStale(run, m);
    emit({ run, card: text, changed, ...(changed || invalidated ? { invalidated: 'every swapped shot, its placement and approval, the timeline, the sound and the finals' } : {}), ...(cleared.length ? { out_of_date: cleared } : {}), next: `targets ${run}` });
}

async function targetsCmd(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const stretches = await stretchesOf(run, m);
    const fps = m.source.fps;
    if (f.check) {
        const t = await readJson<Targets>(path.join(run, FILE.targets));
        if (!t) throw new Error(`There is no ${FILE.targets} in ${run}. Run targets ${run}, look at ${FILE.tasks} and the frames it lists, and write ${FILE.targets}.`);
        const v = validateTargets(t, stretches, frameOf(m), fps);
        if (!v.ok) throw new Error(`${FILE.targets} is not complete:\n- ${v.errors.join('\n- ')}`);
        const cleared = await markStale(run, m);
        emit({
            ok: true,
            run,
            stretches: stretches.length,
            present: stretches.filter((s) => t.stretches[s.id].present).map((s) => s.id),
            absent: stretches.filter((s) => !t.stretches[s.id].present).map((s) => s.id),
            ...(cleared.length ? { out_of_date: cleared } : {}),
            next: `plan ${run}`,
        });
        return;
    }
    const src = path.join(run, m.source.file);
    const items: Array<Record<string, unknown>> = [];
    let widest = 0;
    for (const s of stretches) {
        const dir = path.join(run, 'targets', s.id);
        await rm(dir, { recursive: true, force: true });
        const count = s.end - s.first;
        const picks = stripFrames(s.first, s.end, fps);
        await ff.extractFrames(src, dir, { first: s.first, count, fps, picks, maxSide: 512 });
        const full = await ff.extractFrames(src, path.join(dir, 'full'), { first: s.first, count, fps, picks: [s.first, s.end - 1] });
        for (let i = 1; i < picks.length; i++) widest = Math.max(widest, (picks[i] - picks[i - 1]) / fps);
        const rel = (p: string) => path.relative(run, p).replace(/\\/g, '/');
        const hint = m.source.hints?.find((h) => h.first <= s.first && s.first < h.end);
        items.push({
            id: s.id,
            scene: s.scene,
            first_frame: s.first,
            end_frame: s.end,
            start: Number(frameTime(s.first, fps).toFixed(4)),
            end: Number(frameTime(s.end, fps).toFixed(4)),
            first_frame_file: rel(full[0]),
            last_frame_file: rel(full[1]),
            strip: picks.map((p) => ({ frame: p, t: Number(frameTime(p, fps).toFixed(4)), file: `targets/${s.id}/f${p}.jpg` })),
            ...(hint && (hint.type || hint.description || hint.camera) ? { breakdown: { type: hint.type, description: hint.description, camera: hint.camera } } : {}),
        });
    }
    await writeJson(path.join(run, FILE.tasks), {
        schema: 'tt.remake.target_tasks.v1',
        created_at: new Date().toISOString(),
        source: { width: m.source.width, height: m.source.height, fps, frames: m.source.frames },
        strip_gap_max_seconds: Number(widest.toFixed(4)),
        instructions: [
            'First write "subject" in targets.json: a short visual description of the person being replaced (clothes, hair, position), the same for every stretch.',
            'Then, for each stretch, look at EVERY frame of its strip (they are at most 0.25 s apart, with times) and at its first and last frame.',
            'present: true if the subject appears in ANY strip frame, even briefly. Then seen_at lists the strip times where they appear.',
            'present: false only if they appear in none. Then set absent_checked: true. Never leave out a stretch.',
            'seed: "first" or "last" when the subject is clearly visible on that frame, with point [x, y] on the subject in source pixels on THAT frame. If they are clear only inside the stretch, seed: {"t": a strip time, "point": [x, y], "box": [x, y, w, h]} splits the stretch there.',
            'box_first / box_last: [x, y, w, h] around the subject on the first and last frame, where they are visible.',
            'others: short descriptions of the other people in the stretch. framing, camera_move, light, wardrobe (of the subject) and action: from what you see.',
        ],
        answer_file: FILE.targets,
        answer_shape: {
            subject: 'the woman in the red coat on the left',
            stretches: {
                [stretches[0]?.id ?? 's1']: { present: true, seen_at: [0, 0.25], seed: 'first', point: [320, 540], box_first: [250, 300, 140, 420], box_last: [260, 310, 140, 420], others: ['a man in a grey hoodie behind her'], framing: 'medium shot from head to hips', camera_move: 'static camera', light: 'soft daylight from the left', wardrobe: 'a red wool coat over a white top', action: 'walks towards the camera and turns her head' },
                ...(stretches[1] ? { [stretches[1].id]: { present: false, absent_checked: true } } : {}),
            },
        },
        stretches: items,
    });
    emit({ run, tasks: path.join(run, FILE.tasks), stretches: stretches.map((s) => s.id), strip_gap_max_seconds: Number(widest.toFixed(4)), next: `look at the frames listed in ${FILE.tasks}, write ${FILE.targets}, then targets ${run} --check` });
}

/** plan.json, checked against the source and the targets; refuses with the command that fixes what is wrong. */
async function loadPlan(run: string, m: Manifest): Promise<{ plan: Plan; targets: Targets; stale: string[]; disagree: string[] }> {
    const targets = await readJson<Targets>(path.join(run, FILE.targets));
    if (!targets) throw new Error(`There are no targets yet. Run targets ${run}, fill ${FILE.targets} from ${FILE.tasks}, then targets ${run} --check.`);
    const plan = await readJson<Plan>(path.join(run, FILE.plan));
    if (!plan) throw new Error(`There is no plan yet. Run plan ${run}.`);
    const stretches = await stretchesOf(run, m);
    const v = validatePlan(plan, stretches, frameOf(m), m.source.frames ?? 0);
    if (!v.ok) throw new Error(`${FILE.plan} is not usable:\n- ${v.errors.join('\n- ')}`);
    const stale = plan.units.filter((u) => u.target_sha256 !== targetHash(targets.subject, targets.stretches[u.stretch])).map((u) => u.id);
    // Swap where the subject is, keep where it is not: targets.json may now say the opposite of what the plan did.
    const disagree = [...new Set(plan.units.flatMap((u) => (targets.stretches[u.stretch] && Boolean(targets.stretches[u.stretch].present) !== (u.action === 'swap') ? [u.stretch] : [])))];
    return { plan, targets, stale, disagree };
}

async function planCmd(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const stretches = await stretchesOf(run, m);
    if (f.check) {
        const { plan, stale, disagree } = await loadPlan(run, m);
        const cleared = await markStale(run, m);
        const warnings = [...(stale.length ? [`the targets changed after these runs were planned: ${stale.join(', ')}; run plan ${run} again`] : []), ...(disagree.length ? [`the targets and the plan disagree about whether the person is in ${disagree.join(', ')}; run plan ${run} again`] : [])];
        emit({ ok: true, run, runs: plan.units.map((u) => `${u.id}: ${u.action}`), ...(warnings.length ? { warning: warnings.join('; ') } : {}), ...(cleared.length ? { out_of_date: cleared } : {}), next: `run ${run}` });
        return;
    }
    const targets = await readJson<Targets>(path.join(run, FILE.targets));
    if (!targets) throw new Error(`There are no targets yet, so there is nothing to plan. Run targets ${run}, fill ${FILE.targets} from ${FILE.tasks}, then targets ${run} --check, then plan ${run}.`);
    const v = validateTargets(targets, stretches, frameOf(m), m.source.fps);
    if (!v.ok) throw new Error(`${FILE.targets} is not complete:\n- ${v.errors.join('\n- ')}\nFix it, then run targets ${run} --check.`);
    if (!m.character) throw new Error(`There is no character card yet. Run identity ${run}, fill ${FILE.card}, then identity ${run} again.`);
    await assertCardRegistered(run, m);
    const plan = buildPlan({ stretches, targets, frame: frameOf(m), fps: m.source.fps, frames: m.source.frames!, card: m.character });
    await writeJson(path.join(run, FILE.plan), plan);
    const cleared = await markStale(run, m);
    const { groups, segments } = unitsOf(plan);
    emit({
        run,
        plan: path.join(run, FILE.plan),
        runs: plan.units.map((u) => `${u.id}: frames ${u.first}-${u.end - 1} ${u.action}${u.action === 'swap' ? `, ${u.reverse ? 'reversed, ' : ''}tier ${u.tier}${u.crop ? `, crop ${u.crop.w}x${u.crop.h}+${u.crop.x}+${u.crop.y}` : ', whole frame'}` : ''}`),
        joined_shots: groups.map((g) => `${g.id}: ${g.parts.length} parts`),
        segments: segmentText(segments, m.source.fps),
        ...(cleared.length ? { out_of_date: cleared } : {}),
        next: `read ${FILE.plan} (edit it if a run is wrong), plan ${run} --check, then run ${run}`,
    });
}

function segmentText(segments: ReturnType<typeof unitsOf>['segments'], fps: number): string {
    return segments.map((s) => ('shot' in s ? `shot:${s.shot}` : `source:${(s.source[0] / fps).toFixed(5)}-${(s.source[1] / fps).toFixed(5)}`)).join(',');
}

/** Brings the shot of a planned run in line with the plan (the plan is the authority on its span, crop and direction). */
async function syncGeometry(run: string, m: Manifest, u: PlanUnit): Promise<void> {
    const s = m.shots.find((x) => x.id === u.id);
    if (!s) return;
    const fps = m.source.fps;
    const span = ff.frameSpan(u.first / fps, (u.end - u.first) / fps, fps);
    const start = Number(span.start.toFixed(5));
    const duration = Number(span.duration.toFixed(5));
    const reversed = Boolean(u.reverse);
    if (s.start === start && s.duration === duration && JSON.stringify(s.crop) === JSON.stringify(u.crop) && Boolean(s.reversed) === reversed) return;
    s.start = start;
    s.duration = duration;
    s.frames = [span.first, span.first + span.frames];
    if (u.crop) s.crop = u.crop;
    else delete s.crop;
    if (reversed) s.reversed = true;
    else delete s.reversed;
    invalidate(m, s.id, 'attempt');
    await save(run, m);
}

/** The shot that stands for a scene made of several runs: their placed clips joined. Created or brought in line with the plan. */
async function ensureGroup(run: string, m: Manifest, g: ReturnType<typeof unitsOf>['groups'][number]): Promise<void> {
    const fps = m.source.fps;
    const parts = g.parts.map((p): NonNullable<Shot['parts']>[number] => ('unit' in p ? { shot: p.unit } : { source: p.source }));
    let s = m.shots.find((x) => x.id === g.id);
    const same = s && JSON.stringify(s.parts) === JSON.stringify(parts) && s.frames?.[0] === g.first && s.frames?.[1] === g.end;
    if (same) return;
    if (!s) {
        s = { id: g.id, kind: 'swap', attempts: [] };
        m.shots.push(s);
    }
    s.start = Number((g.first / fps).toFixed(5));
    s.duration = Number(((g.end - g.first) / fps).toFixed(5));
    s.frames = [g.first, g.end];
    s.parts = parts;
    invalidate(m, s.id, 'placement');
    await save(run, m);
}

async function runCmd(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    let m = await load(run);
    const resume = Boolean(f.resume);
    const auto = Boolean(f['auto-approve']);
    if (!m.character) throw new Error(`There is no character card yet. Run identity ${run}, fill ${FILE.card}, then identity ${run} again.`);
    await assertCardRegistered(run, m);
    const { plan, stale, disagree } = await loadPlan(run, m);
    if (stale.length || disagree.length) await markStale(run, m);
    if (disagree.length) throw new Error(`The targets and the plan disagree about whether the person is in ${disagree.join(', ')} (the plan keeps what the targets now say to swap, or the other way round). Run plan ${run} again; ${FILE.plan} is not rewritten for you, since you may have edited it.`);
    if (stale.length) throw new Error(`The targets changed after these runs were planned: ${stale.join(', ')}. Run plan ${run} again (it rebuilds ${FILE.plan} from the targets).`);
    if (plan.card_sha256 !== stableHash({ card: m.character })) throw new Error(`The character card changed after the plan was made. Run plan ${run} again (the prompts repeat the card).`);
    await markStale(run, m);
    const { groups, segments } = unitsOf(plan);
    const pass: Flags = {};
    for (const k of ['comfy-url', 'allow-remote-comfy', 'timeout']) if (f[k] !== undefined) pass[k] = f[k];
    const done: string[] = [];
    const reused: string[] = [];
    const generated: string[] = [];
    for (const u of plan.units) {
        if (u.action !== 'swap') continue;
        try {
            m = await load(run);
            await syncGeometry(run, m, u);
            m = await load(run);
            const now = await freshFor(run, m, u);
            if (!now) throw new Error(`${u.stretch} has no answer in ${FILE.targets}.`);
            const matching = (a: Attempt) => sameFresh(a.settings.fresh as Fresh | undefined, now.fresh);
            const latest = (list: Attempt[]) => list[list.length - 1];
            let s = m.shots.find((x) => x.id === u.id);
            let good = latest((s?.attempts ?? []).filter((a) => a.status === 'done' && a.output && matching(a)));
            if (good) reused.push(u.id);
            else {
                const pending = latest((s?.attempts ?? []).filter((a) => (a.status === 'unknown' || a.status === 'submitted') && matching(a)));
                if (pending && !resume) throw new Error(`Shot "${u.id}" has a job from an earlier run that never finished (attempt ${pending.n}${pending.promptId ? `, job ${pending.promptId}` : ''}). Run again with --resume to collect it; nothing is submitted twice.`);
                if (pending) {
                    const unfinished = (s?.attempts ?? []).filter((a) => a.status !== 'done' && a.kind === 'swap');
                    await swap([run], { ...pass, shot: u.id, resume: pending.promptId ?? (latest(unfinished) === pending ? 'last' : String(pending.n)) });
                } else await swap([run], { ...pass, shot: u.id, unit: u.id });
                generated.push(u.id);
                m = await load(run);
                s = m.shots.find((x) => x.id === u.id);
                good = latest((s?.attempts ?? []).filter((a) => a.status === 'done' && a.output && matching(a)));
                if (!good) throw new Error(`Shot "${u.id}" did not finish.`);
            }
            if (!s!.placed || s!.placed.fromAttempt !== good.n) await place([run], { shot: u.id, attempt: String(good.n) });
            done.push(u.id);
        } catch (e) {
            const msg = `Stopped at ${u.id}: ${(e as Error).message}\nDone so far: ${done.join(', ') || 'nothing'}. Fix the cause and run again${resume ? '' : ' (with --resume if a job was left running)'}; what is finished is kept and not generated again.`;
            throw Object.assign(new Error(msg), { cause: e });
        }
    }
    for (const g of groups) {
        m = await load(run);
        await ensureGroup(run, m, g);
        m = await load(run);
        if (!m.shots.find((x) => x.id === g.id)!.placed) await place([run], { shot: g.id });
    }
    const tops = segments.flatMap((s) => ('shot' in s ? [s.shot] : []));
    const text = segmentText(segments, m.source.fps);
    if (auto) {
        for (const id of tops) {
            m = await load(run);
            const s = shot(m, id);
            if (!s.approved || s.approved.sha256 !== s.placed?.sha256) await approve([run], { shot: id });
        }
        m = await load(run);
        if (!m.timeline || JSON.stringify(m.timeline.segments) !== JSON.stringify(parseSegments(text))) await assemble([run], { segments: text });
    }
    emit({
        run,
        generated,
        reused,
        placed: [...done, ...groups.map((g) => g.id)],
        segments: text,
        ...(auto ? { timeline: path.join(run, 'timeline.mp4') } : {}),
        next: auto ? `audio ${run}` : `watch each placed shot (${tops.map((t) => `shots/${t}/placed.mp4`).join(', ') || 'none: nothing is swapped'}) in motion and approve what is good (approve ${run} --shot <id>), then assemble ${run} --segments "${text}"`,
    });
}

// ---------------------------------------------------------------- place / approve / assemble / audio

/**
 * A shot made of several runs: their placed clips (and the kept stretches between or beside them) joined in frame
 * order, crossfading the frames two neighbours share, so the result has exactly the frames of the shot, each once.
 */
async function placeGroup(run: string, m: Manifest, s: Shot): Promise<void> {
    const [first, end] = s.frames ?? [0, 0];
    const frame = { width: m.source.width, height: m.source.height, fps: m.source.fps };
    const src = path.join(run, m.source.file);
    const dir = path.join(run, 'shots', s.id);
    await mkdir(dir, { recursive: true });
    const work = await mkdtemp(path.join(dir, 'join-'));
    try {
        const clips: Array<{ file: string; first: number; end: number }> = [];
        for (const [i, p] of (s.parts ?? []).entries()) {
            if ('shot' in p) {
                const ps = shot(m, p.shot);
                if (!ps.placed || !ps.frames) throw new Error(`Shot "${ps.id}", a part of "${s.id}", has not been placed yet. Run place for it first.`);
                const file = path.join(run, ps.placed.file);
                if ((await sha256File(file)) !== ps.placed.sha256) throw new Error(`The placed file of shot "${ps.id}" changed since it was written. Run place again.`);
                clips.push({ file, first: ps.frames[0], end: ps.frames[1] });
            } else {
                const file = path.join(work, `keep${i}.mp4`);
                await ff.copyFrames(src, file, { first: p.source[0], frames: p.source[1] - p.source[0], frame });
                clips.push({ file, first: p.source[0], end: p.source[1] });
            }
        }
        if (!clips.length) throw new Error(`Shot "${s.id}" has no parts.`);
        let cur = clips[0].file;
        let curFrames = clips[0].end - clips[0].first;
        let curEnd = clips[0].end;
        for (let i = 1; i < clips.length; i++) {
            const c = clips[i];
            const overlap = curEnd - c.first;
            if (overlap < 0) throw new Error(`Parts of shot "${s.id}" leave a gap before source frame ${c.first}.`);
            const out = path.join(work, `join${i}.mp4`);
            const n = c.end - c.first;
            if (overlap === 0) await ff.concat([{ file: cur }, { file: c.file }], out, frame);
            else await ff.joinOverlap({ file: cur, frames: curFrames }, { file: c.file, frames: n }, overlap, out);
            cur = out;
            curFrames += n - overlap;
            curEnd = c.end;
        }
        if (curFrames !== end - first) throw new Error(`The parts of shot "${s.id}" add up to ${curFrames} frames, not the ${end - first} of the shot.`);
        const final = path.join(dir, 'placed.mp4');
        await copyFile(cur, final);
        const p = await ff.probe(final);
        if (p.frames !== end - first) throw new Error(`The joined shot has ${p.frames} frames instead of ${end - first}. It was not accepted.`);
        invalidate(m, s.id, 'placement');
        s.placed = { file: path.relative(run, final).replace(/\\/g, '/'), sha256: await sha256File(final), fromAttempt: 0 };
        await save(run, m);
        emit({ shot: s.id, placed: final, frames: p.frames, parts: s.parts!.length, next: `watch ${final} in motion, then: approve ${run} --shot ${s.id}` });
    } finally {
        await rm(work, { recursive: true, force: true });
    }
}

async function place(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const s = shot(m, need(f, 'shot'));
    if (s.parts) return placeGroup(run, m, s);
    if (str(f, 'attempt')) {
        const n = num(f, 'attempt');
        if (!s.attempts.some((a) => a.n === n && a.status === 'done')) throw new Error(`Shot "${s.id}" has no finished attempt ${n}.`);
        if (s.selected !== n) {
            // Choosing another attempt changes what any continuation was built on.
            invalidate(m, s.id, 'attempt');
            s.selected = n;
        }
    }
    const a = chosen(s);
    const stale = staleContinuation(m, s);
    if (stale) throw new Error(`Shot "${s.id}" is out of date: ${stale}. Generate it again with continue.`);
    if (a.keep && a.frames !== undefined && a.frames !== a.keep.length && !f['allow-shift']) {
        throw new Error(`Attempt ${a.n} of shot "${s.id}" came back with ${a.frames} frames for the ${a.keep.length} sent: it cannot be lined up with the stretch frame for frame. Make a new attempt (or --allow-shift to place it anyway).`);
    }
    if (a.alignment && a.alignment.shift !== 0 && a.alignment.error < 0.8 * a.alignment.errorAtZero && !f['allow-shift']) {
        throw new Error(`Attempt ${a.n} of shot "${s.id}" is shifted by ${a.alignment.shift} frame(s) against the stretch it replaces and would play out of step. Make a new attempt (or --allow-shift to place it anyway).`);
    }
    const gen = path.join(run, a.output!);
    if ((await sha256File(gen)) !== a.outputSha256) throw new Error(`The generated file of attempt ${a.n} changed since it was made. Generate the shot again.`);
    const gp = await ff.probe(gen);
    await mkdir(path.join(run, 'shots', s.id), { recursive: true });
    const out = path.join(run, 'shots', s.id, 'placed.mp4');
    const frame = { width: m.source.width, height: m.source.height, fps: m.source.fps };
    let area: Rect | undefined;
    const feather = str(f, 'feather') ? num(f, 'feather') : undefined;
    // Exactly as many frames as the stretch it replaces (swap), or as its own length gives (continuation).
    const span = s.kind === 'swap' ? ff.frameSpan(s.start!, s.duration!, m.source.fps) : null;
    const frames = span ? span.frames : Math.round((gp.frames / H3_FPS) * m.source.fps);
    if (s.kind === 'swap' && s.crop) area = generatedArea(s.crop, gp.width, gp.height);
    let source = gen;
    let work: string | null = null;
    try {
        if (a.keep && span) {
            // Only the distinct frames were sent: show each generated frame where its source frame was, and repeat it
            // where the source repeats, so the shot keeps exactly the source's rhythm.
            work = await mkdtemp(path.join(run, 'shots', s.id, 'retime-'));
            source = path.join(work, 'retimed.mp4');
            await ff.retime(gen, source, frameMap(a.keep, frames, gp.frames, Boolean(s.reversed)), m.source.fps, work);
        }
        await ff.placeBack({ source: path.join(run, m.source.file), firstFrame: span?.first ?? 0, frames, generated: source, out, frame, area, feather });
    } finally {
        if (work) await rm(work, { recursive: true, force: true });
    }
    const pp = await ff.probe(out);
    if (pp.frames !== frames) throw new Error(`The placed clip has ${pp.frames} frames instead of ${frames}. It was not accepted.`);
    // Repeated frames the source does not have read as jumps once the clip plays. Measured inside the replaced area.
    let cadence: { extraRepeats: number; longestRun: number } | undefined;
    if (span) {
        const region = area ?? { x: 0, y: 0, w: m.source.width, h: m.source.height };
        const r = extraRepeats(await ff.frameDiffs(out, { fps: m.source.fps, area: region }), await ff.frameDiffs(path.join(run, m.source.file), { fps: m.source.fps, first: span.first, frames, area: region }));
        cadence = { extraRepeats: r.extra, longestRun: r.longestRun };
        if (r.extra > 2 || r.longestRun >= 2) log(`warning: the placed shot repeats ${r.extra} frame(s) the source does not${r.longestRun >= 2 ? `, up to ${r.longestRun} in a row` : ''}: motion will look jerky. Make a new attempt without --all-frames.`);
    }
    invalidate(m, s.id, 'placement');
    s.placed = { file: path.relative(run, out).replace(/\\/g, '/'), sha256: await sha256File(out), ...(area ? { area, feather: feather ?? 12 } : {}), fromAttempt: a.n, ...(cadence ? { cadence } : {}) };
    await save(run, m);
    emit({ shot: s.id, placed: out, frames, ...(area ? { area: `${area.w}x${area.h}+${area.x}+${area.y} (outside it the picture is the original)` } : { fit: 'whole frame' }), ...(cadence ? { cadence: `${cadence.extraRepeats} repeated frame(s) the source does not have, longest run ${cadence.longestRun}` } : {}), next: `watch ${out} in motion, then: approve ${run} --shot ${s.id}` });
}

async function approve(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const s = shot(m, need(f, 'shot'));
    if (!s.placed) throw new Error(`Shot "${s.id}" has not been placed yet. Run place first, and watch the result.`);
    const stale = staleContinuation(m, s);
    if (stale) throw new Error(`Shot "${s.id}" is out of date: ${stale}. Generate it again with continue.`);
    const sha = await sha256File(path.join(run, s.placed.file));
    if (sha !== s.placed.sha256) throw new Error('The placed file changed since it was written. Run place again.');
    s.approved = { at: new Date().toISOString(), sha256: sha, ...(str(f, 'note') ? { note: str(f, 'note') } : {}) };
    await save(run, m);
    emit({ shot: s.id, approved: s.placed.file });
}

async function assemble(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const segments = parseSegments(need(f, 'segments'));
    const src = path.join(run, m.source.file);
    if ((await sha256File(src)) !== m.source.sha256) throw new Error('The source file in the run folder changed since init.');
    const parts: ff.Segment[] = [];
    const notApproved: string[] = [];
    for (const seg of segments) {
        if ('source' in seg) {
            if (seg.source[1] > m.source.duration + 0.05) throw new Error(`source:${seg.source[0]}-${seg.source[1]} runs past the end of the source (${m.source.duration.toFixed(2)} s).`);
            const g = ff.frameSpan(seg.source[0], seg.source[1] - seg.source[0], m.source.fps);
            parts.push({ file: src, start: g.seek, frames: g.frames });
        } else {
            const s = shot(m, seg.shot);
            if (!s.placed) throw new Error(`Shot "${s.id}" has not been placed. Run place first.`);
            const stale = staleContinuation(m, s);
            if (stale) throw new Error(`Shot "${s.id}" is out of date: ${stale}. Generate it again with continue.`);
            // The file on disk, not the record: an edited file is not the one that was approved.
            if ((await sha256File(path.join(run, s.placed.file))) !== s.placed.sha256) throw new Error(`The placed file of shot "${s.id}" changed since it was written. Run place again.`);
            if (!s.approved || s.approved.sha256 !== s.placed.sha256) notApproved.push(s.id);
            // Placements made before the frame checks existed are checked here too.
            const a = s.attempts.find((x) => x.n === s.placed!.fromAttempt);
            const off = a?.keep && a.frames !== undefined && a.frames !== a.keep.length ? `came back with ${a.frames} frames for the ${a.keep.length} sent` : a?.alignment && a.alignment.shift !== 0 && a.alignment.error < 0.8 * a.alignment.errorAtZero ? `is shifted by ${a.alignment.shift} frame(s)` : '';
            if (off && !f['allow-shift']) throw new Error(`Shot "${s.id}" was placed from attempt ${a!.n}, which ${off}: it plays out of step. Make a new attempt (or --allow-shift).`);
            parts.push({ file: path.join(run, s.placed.file) });
        }
    }
    if (notApproved.length && !f['allow-unapproved']) throw new Error(`Not approved yet: ${notApproved.join(', ')}. Watch each placed shot and run approve, or pass --allow-unapproved for a draft.`);
    const leftovers = await originalLeftovers(run, m, segments);
    const slivers = leftovers.filter((x) => x.end - x.first <= SLIVER_FRAMES);
    if (slivers.length && !f['allow-original']) {
        throw new Error(`The timeline shows the original person: ${slivers.map((x) => `${x.label} takes source frames ${x.first}-${x.end - 1} from scene ${x.scene}, where shot ${x.shots.join('/')} replaces the person`).join('; ')}. Remake the shot so it reaches the cut (swap --scene) instead of filling the gap with the source, or pass --allow-original.`);
    }
    for (const x of leftovers.filter((y) => y.end - y.first > SLIVER_FRAMES)) log(`check: ${x.label} keeps source frames ${x.first}-${x.end - 1} of scene ${x.scene}, where shot ${x.shots.join('/')} replaces the person. Make sure the original person is not visible there.`);
    const gaps = timelineGaps(segments, m.shots, m.source.fps);
    for (const g of gaps) log(`warning: ${g}. The picture after it will be out of step with the source sound.`);
    const out = path.join(run, 'timeline.mp4');
    await ff.concat(parts, out, m.source);
    const p = await ff.probe(out);
    m.timeline = { segments, file: 'timeline.mp4', sha256: await sha256File(out), duration: p.duration, ...(notApproved.length ? { draft: true } : {}) };
    delete m.final;
    delete m.audio;
    await save(run, m);
    emit({ timeline: out, duration: p.duration.toFixed(2), frames: p.frames, sourceDuration: m.source.duration.toFixed(2), ...(notApproved.length ? { draft: `includes unapproved shots: ${notApproved.join(', ')}` } : {}), ...(gaps.length ? { gaps } : {}), next: `audio ${run}` });
}

/** A stretch of the original this short, in a shot where the person is replaced, is a leftover at a cut. */
const SLIVER_FRAMES = 8;

async function originalLeftovers(run: string, m: Manifest, segments: ReturnType<typeof parseSegments>): Promise<ReturnType<typeof originalInSwappedScenes>> {
    const fps = m.source.fps;
    const { frames, cuts } = await sourceCuts(run, m);
    const src = segments.flatMap((seg) => {
        if (!('source' in seg)) return [];
        const g = ff.frameSpan(seg.source[0], seg.source[1] - seg.source[0], fps);
        return [{ first: g.first, end: g.first + g.frames, label: `source:${seg.source[0]}-${seg.source[1]}` }];
    });
    const used = new Set(segments.flatMap((seg) => ('shot' in seg ? [seg.shot] : [])));
    const swaps = m.shots.filter((x) => x.kind === 'swap' && used.has(x.id)).map((x) => {
        const g = ff.frameSpan(x.start!, x.duration!, fps);
        return { id: x.id, first: g.first, end: g.first + g.frames };
    });
    return originalInSwappedScenes(src, swaps, sceneList(cuts, frames));
}

async function matchOffset(clip: string, track: string, clipSeconds: number): Promise<ReturnType<typeof findOffset>> {
    const [t, c] = await Promise.all([ff.decodeAudio(track, FINE_RATE), ff.decodeAudio(clip, FINE_RATE, { duration: Math.min(clipSeconds, 20) })]);
    return findOffset(t, c);
}

/**
 * Where the pieces of the source sound go: every segment of the timeline takes the source audio of its own source
 * time range (a kept stretch, or a swapped shot, which replaces the picture of its own stretch), in timeline order,
 * so trims and reorders keep the sound with the picture. Neighbouring segments that are neighbours in the source
 * are one piece. A continued shot has no source sound at all.
 */
export function audioPieces(m: Manifest, sourceAudioSeconds: number): ff.AudioPiece[] {
    const fps = m.source.fps;
    const pieces: ff.AudioPiece[] = [];
    let at = 0;
    for (const seg of m.timeline!.segments) {
        let g: ReturnType<typeof ff.frameSpan>;
        if ('source' in seg) g = ff.frameSpan(seg.source[0], seg.source[1] - seg.source[0], fps);
        else {
            const s = shot(m, seg.shot);
            if (s.kind !== 'swap' || s.start === undefined || s.duration === undefined) {
                throw new Error(`The timeline holds the continued shot "${s.id}", which the source has no sound for. Pass --file <a longer recording of the same track> with --match or --start (or --audio none to add a sound in the app). The audio is never looped.`);
            }
            g = ff.frameSpan(s.start, s.duration, fps);
        }
        const from = g.first / fps;
        const length = g.frames / fps;
        if (from + length > sourceAudioSeconds + 0.05) {
            throw new Error(`The timeline uses source time ${from.toFixed(2)}-${(from + length).toFixed(2)} s, but the source's sound ends at ${sourceAudioSeconds.toFixed(2)} s. Pass --file <a longer recording of the same track> with --match or --start (or --audio none). The audio is never looped.`);
        }
        const prev = pieces[pieces.length - 1];
        if (prev && Math.abs(prev.from + prev.length - from) < 0.5 / fps) prev.length += length;
        else pieces.push({ at, length, from });
        at += length;
    }
    return pieces;
}

async function audio(pos: string[], f: Flags): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    if (!m.timeline) throw new Error('Assemble the timeline first.');
    const video = path.join(run, m.timeline.file);
    if ((await sha256File(video)) !== m.timeline.sha256) throw new Error('timeline.mp4 changed since it was assembled. Run assemble again.');
    const canvas = (str(f, 'canvas') ?? 'fit') as 'fit' | 'cover';
    if (!['fit', 'cover'].includes(canvas)) throw new Error('--canvas is fit or cover.');
    const choice = str(f, 'audio');
    if (choice !== undefined && str(f, 'file') !== undefined) throw new Error('Give --audio <file> or --file <recording>, not both.');
    const file = str(f, 'file') ?? (choice !== undefined && !['source', 'none'].includes(choice) ? choice : undefined);
    const mode: 'source' | 'none' | 'file' = file ? 'file' : choice === 'none' ? 'none' : 'source';
    const src = path.join(run, m.source.file);
    const silent = path.join(run, 'final_silent.mp4');
    const out = path.join(run, 'final.mp4');
    // Every input is checked before anything is written, so a refusal leaves no half-made final_silent.mp4 behind.
    const sourceSound = mode === 'source' && m.source.hasAudio ? await ff.audioLength(src) : 0;
    const noSound = mode === 'source' && !sourceSound;
    const pieces = mode === 'source' && sourceSound ? audioPieces(m, sourceSound) : [];
    let start = 0;
    let match: Record<string, unknown> | undefined;
    let audioDuration = 0;
    if (mode === 'file') {
        audioDuration = await ff.audioLength(file!);
        if (f.match) {
            if (!m.source.hasAudio) throw new Error('--match compares with the source audio, and the source has none. Use --start.');
            const r = await matchOffset(src, file!, m.source.duration);
            match = { ...r };
            if (r.verdict !== 'match') throw new Error(`Could not place the source's sound inside that recording with confidence (waveform match ${r.score.toFixed(2)}, next best place ${r.runnerUp.toFixed(2)}). It may be a different version of the track. Give the position yourself with --start.`);
            start = r.offset;
        } else start = num(f, 'start', choice !== undefined ? 0 : undefined);
    }
    // The picture first: the finished video on the 1080x1920 canvas, without sound. Sound is added to this file.
    await ff.exportCanvas(video, silent, canvas, { width: m.source.width, height: m.source.height });
    const sp = await ff.probe(silent);
    const videoDuration = sp.frames / m.source.fps;
    let sound: NonNullable<Manifest['audio']>['sound'];
    if (mode === 'none' || noSound) {
        await copyFile(silent, out);
        m.audio = { mode: 'none', start: 0, ...(noSound ? { note: 'the source has no sound, so final.mp4 is the same silent picture as final_silent.mp4' } : {}) };
        if (noSound) log('warning: the source has no sound, so final.mp4 is the same silent picture as final_silent.mp4. Pass --file <recording> with --start to add one, or add a sound in the app.');
    } else if (mode === 'source') {
        const gaps = timelineGaps(m.timeline.segments, m.shots, m.source.fps);
        if (gaps.length) log(`note: the timeline skips or repeats source time (${gaps.length} place${gaps.length > 1 ? 's' : ''}); the sound follows the picture there, with a short crossfade at each join.`);
        const wav = path.join(run, 'audio_source.wav');
        await ff.audioFromPieces(src, wav, pieces, { total: videoDuration, sourceLength: sourceSound, eps: 0.5 / m.source.fps });
        await ff.addSound(silent, wav, out, videoDuration);
        const credited = m.source.sound ? { musicId: m.source.sound.musicId, title: m.source.sound.title, artist: m.source.sound.artist } : undefined;
        sound = credited;
        m.audio = { mode: 'source', start: 0, ...(credited ? { sound: credited } : {}) };
    } else {
        await ff.mux(silent, file!, out, { audioStart: start, videoDuration, audioDuration });
        // Measure where the sound of the finished file actually sits in the recording, instead of trusting the cut.
        const check = await matchOffset(out, file!, videoDuration);
        const placedAt = check.verdict === 'match' ? Number(check.offset.toFixed(4)) : null;
        if (placedAt === null) log('warning: the position of the sound in the finished file could not be measured (the track repeats, or is too quiet there). Check the sync by ear.');
        if (placedAt !== null && Math.abs(placedAt - start) > 0.02) throw new Error(`The sound ended up ${(1000 * (placedAt - start)).toFixed(0)} ms away from where it was meant to be. The file was not accepted.`);
        m.audio = { mode: 'file', file: path.resolve(file!), sha256: await sha256File(file!), start, ...(match ? { match } : {}), measuredStart: placedAt };
    }
    const p = await ff.probe(out);
    m.final = { file: 'final.mp4', sha256: await sha256File(out), duration: p.duration, at: new Date().toISOString(), ...(m.timeline.draft ? { draft: true } : {}), silent: { file: 'final_silent.mp4', sha256: await sha256File(silent) }, canvas };
    await save(run, m);
    emit({
        final: out,
        final_silent: silent,
        size: `${p.width}x${p.height}`,
        duration: p.duration.toFixed(2),
        audio: noSound ? 'none (the source has no sound; final.mp4 is silent)' : mode === 'source' ? 'source audio' : mode === 'none' ? 'none (silent master)' : `${path.basename(file!)} from ${m.audio.start.toFixed(3)} s (measured in the finished file: ${m.audio.measuredStart ?? 'could not be measured'})`,
        ...(sound ? { tiktok_sound: sound } : {}),
        ...(noSound ? { warning: 'The source has no sound, so final.mp4 is silent. Pass --file <recording> with --start to add one.' } : {}),
        ...(mode === 'file' ? { note: 'The recording replaces the whole soundtrack, including any voices or ambience of the source.' } : {}),
        next: `compare ${run}   then watch final.mp4 with sound. Label it as AI-generated when publishing (tiktok publish prepare --ai-generated).`,
    });
}

async function audioOffset(f: Flags): Promise<void> {
    const clip = need(f, 'clip');
    const p = await ff.probe(clip).catch(() => null);
    const r = await matchOffset(clip, need(f, 'track'), p?.duration ?? 20);
    emit({ ...r, offset: Number(r.offset.toFixed(4)) });
    if (r.verdict !== 'match') process.exitCode = 1;
}

async function compare(pos: string[]): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const result = m.final?.file ?? m.timeline?.file;
    if (!result) throw new Error('Nothing to compare yet: assemble the timeline first.');
    const want = m.final?.sha256 ?? m.timeline!.sha256;
    if ((await sha256File(path.join(run, result))) !== want) throw new Error(`${result} changed since it was made. Run assemble (and audio) again.`);
    const out = path.join(run, 'compare.mp4');
    await ff.sideBySide(path.join(run, m.source.file), path.join(run, result), out);
    emit({ compare: out, left: 'source', right: result });
}

async function status(pos: string[]): Promise<void> {
    const run = pos[0];
    const m = await load(run);
    const plan = await readJson<Plan>(path.join(run, FILE.plan)).catch(() => null);
    const targets = await readJson<Targets>(path.join(run, FILE.targets)).catch(() => null);
    const outOfDate = new Set<string>();
    for (const s of m.shots) {
        const done = s.attempts.filter((a) => a.status === 'done' && a.output);
        const cur = s.selected !== undefined ? done.find((a) => a.n === s.selected) : done[done.length - 1];
        const unit = plan?.units.find((u) => u.id === s.id);
        const now = unit && cur?.settings.fresh ? await freshFor(run, m, unit).catch(() => null) : null;
        if (now && !sameFresh(cur!.settings.fresh as Fresh, now.fresh)) outOfDate.add(s.id);
    }
    const shots = m.shots.map((s) => {
        const done = s.attempts.filter((a) => a.status === 'done').length;
        const unknown = s.attempts.filter((a) => a.status === 'unknown');
        let stale: string | null = null;
        try {
            stale = staleContinuation(m, s);
        } catch {
            stale = null;
        }
        const state = stale ? `out of date: ${stale}` : outOfDate.has(s.id) ? 'out of date: its card, photo, target or plan entry changed since it was generated (run will generate it again)' : s.parts ? (s.approved && s.placed && s.approved.sha256 === s.placed.sha256 ? 'approved' : s.placed ? 'joined, not approved' : 'parts not joined yet') : s.approved && s.placed && s.approved.sha256 === s.placed.sha256 ? 'approved' : s.placed ? 'placed, not approved' : done ? 'generated, not placed' : unknown.length ? `unfinished job ${unknown[unknown.length - 1].promptId ?? '(not submitted?)'}: re-run with --resume` : 'no finished attempt';
        return { id: s.id, kind: s.kind, attempts: s.attempts.length, state };
    });
    const stages = { identity: m.character ? 'card set' : 'no card yet (identity)', targets: targets ? 'targets.json present (targets --check)' : 'none yet (targets)', plan: plan ? `${plan.units.filter((u) => u.action === 'swap').length} runs to swap, ${plan.units.filter((u) => u.action === 'keep').length} kept` : 'none yet (plan)' };
    emit({ run, source: `${m.source.width}x${m.source.height} ${m.source.duration.toFixed(2)} s`, stages, shots, audio: m.audio ? m.audio.mode : 'not added', timeline: m.timeline ? `${m.timeline.duration.toFixed(2)} s${m.timeline.draft ? ' (draft: unapproved shots)' : ''}` : 'not assembled', final: m.final ? `${m.final.file}${m.final.draft ? ' (draft)' : ''}` : 'not made' });
}

// ---------------------------------------------------------------- entry

export async function main(argv: string[]): Promise<void> {
    const { cmd, pos, flags } = parseArgs(argv);
    asJson = Boolean(flags.json);
    for (const k of ['consent', 'rights']) {
        if (flags[k] !== undefined) throw new Error('--' + k + ' is not a flag of this skill: there is no consent or rights step.');
    }
    if (cmd === 'help' || cmd === '--help' || flags.help) {
        process.stdout.write(HELP);
        return;
    }
    const needsRun = ['scenes', 'identity', 'targets', 'plan', 'run', 'swap', 'continue', 'place', 'approve', 'assemble', 'audio', 'compare', 'status'];
    if (needsRun.includes(cmd) && !pos[0]) throw new Error(`Usage: ${cmd} <run-folder> ...`);
    const writers: Record<string, (pos: string[], f: Flags) => Promise<void>> = { scenes: scenesCmd, identity: identityCmd, targets: targetsCmd, plan: planCmd, run: runCmd, swap, continue: continueShot, place, approve, assemble, audio };
    if (writers[cmd]) {
        await load(pos[0]); // a clear error before locking when the folder is not a remake
        const release = await lockRun(pos[0]);
        try {
            return await writers[cmd](pos, flags);
        } finally {
            await release();
        }
    }
    switch (cmd) {
        case 'doctor':
            return doctor(flags);
        case 'init':
            return init(pos, flags);
        case 'audio-offset':
            return audioOffset(flags);
        case 'compare':
            return compare(pos);
        case 'status':
            return status(pos);
        default:
            throw new Error(`Unknown command "${cmd}". Run with --help.`);
    }
}

if (import.meta.main) {
    main(process.argv.slice(2)).catch((e) => {
        const message = (e as Error).message;
        if (asJson || process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ ok: false, error: message, kind: e instanceof ComfyError ? e.kind : e instanceof ff.ToolError ? 'tool' : 'error' })}\n`);
        else process.stderr.write(`Error: ${message}\n`);
        process.exitCode = 1;
    });
}

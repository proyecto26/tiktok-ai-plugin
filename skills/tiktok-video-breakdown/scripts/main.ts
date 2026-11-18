#!/usr/bin/env -S npx -y bun
// Ported from instagram-ai-plugin skills/instagram-video-breakdown (same author, MIT).
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { analyseAudio } from './audio.ts';
import { DETECTOR_VERSION, analysisId, answersTemplate, applyReview, buildScript, buildTasks, pacing, recreateMarkdown, summaryText, type Breakdown, type Shot } from './breakdown.ts';
import { DEFAULT_MAX_BYTES, scrubUrls } from './cdn.ts';
import { fetchFromCapture, fetchFromFile } from './fetch.ts';
import type { Meta } from './source.ts';
import { ToolError, installHint, majorOf, toolVersion } from './ff.ts';
import { applyFrameOverrides, detectCuts, diffCuts, exportShotImages, frameSpans, grayFrames, mergeFrameCuts, migrateOverrides, motionForShot, pairStats, probe, recordFrameOverrides, round3, sheet, storyboard, stripFps, textCandidates, type FrameOverrides } from './shots.ts';
import { cfrCopy, frameDiffsAround, frameToSec, minShotFrames, probeRate, secToFrame, sha256File, snapToChange, type Timebase } from './timebase.ts';
import { chooseTranscript, importTranscript, runRecogniser, type Transcript } from './transcript.ts';

const HELP = `TikTok video breakdown: reverse-engineer a TikTok so a similar one can be made

Usage: npx -y bun scripts/main.ts <command> [options]

  doctor                                   Check ffmpeg, ffprobe, Bun, the local speech recogniser setting and comfy
  fetch --capture <file> --id <post id> -o <dir>   Download one video from a capture made with the tiktok skill
        [--max-bytes N]                    (read-only; no cookies reach the CDN; captions are saved when TikTok has them)
  fetch --file <video> -o <dir>            Use a local video instead (no TikTok session needed)
  analyze <dir> [--scene 0.30]             Cuts, per-shot frames and strips, motion and text-change hints, audio facts
        [--transcript <file>]              Use this transcript (.srt, .vtt, .json); it overrides captions and the recogniser
        [--max-duration 900]               Refuse longer videos (frames and audio are decoded into memory)
        [--add-cut t1,t2] [--add-cut-frame n1,n2] [--remove-cut t] [--reset-cuts]
                                           Manual cut corrections in frames (remembered in cuts_override.json);
                                           --add-cut moves each time to the strongest change within 2 frames
        [--no-diff-cuts]                   Use only ffmpeg's scene score (skip the frame-difference cuts)
  frames <dir> --from <s> --to <s> [--fps 4]    Dense sheet of any time range, timestamps under each tile
  transcribe <dir> --import <file>         Use an existing transcript (.srt, .vtt, .json)
  transcribe <dir> --cmd "<template>"      Run your own local recogniser; template uses {audio} and {out} (and optional {lang})
        [--lang xx]                        Also read from TT_ASR_CMD. With neither, the saved TikTok captions are used
  review <dir>                             Write review_tasks.json and a review_answers.json template
  apply-review <dir> [--answers <file>]    Validate the answers and merge them into breakdown.json (alias: apply)
  summary <dir>                            Print the breakdown and write recreate.md

Transcript order: --transcript, then transcribe's transcript.json, then TikTok captions, then TT_ASR_CMD, else none.
Output is JSON on stdout unless noted; progress goes to stderr.`;

class UsageError extends Error {}
const log = (m: string) => process.stderr.write(`${m}\n`);
const print = (o: unknown) => process.stdout.write(`${typeof o === 'string' ? o : JSON.stringify(o, null, 2)}\n`);

interface Args {
    _: string[];
    flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(['o', 'out', 'capture', 'id', 'transcript', 'max-bytes', 'max-duration', 'file', 'scene', 'add-cut', 'add-cut-frame', 'remove-cut', 'from', 'to', 'fps', 'import', 'cmd', 'lang', 'answers']);

function parseArgs(argv: string[]): Args {
    const out: Args = { _: [], flags: {} };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--') || (a.startsWith('-') && a.length === 2 && !/\d/.test(a[1]))) {
            const name = a.replace(/^-+/, '');
            const eq = name.indexOf('=');
            if (eq > 0) out.flags[name.slice(0, eq)] = name.slice(eq + 1);
            else if (VALUE_FLAGS.has(name)) {
                if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value.`);
                out.flags[name] = argv[++i];
            } else out.flags[name] = true;
        } else out._.push(a);
    }
    return out;
}

const str = (a: Args, ...names: string[]) => {
    for (const n of names) if (typeof a.flags[n] === 'string') return a.flags[n] as string;
    return undefined;
};
function num(a: Args, name: string): number | undefined {
    const v = str(a, name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number.`);
    return n;
}
const list = (v: string | undefined) => (v ? v.split(',').map((x) => Number(x.trim())) : []);

function dirArg(a: Args): string {
    const d = a._[1];
    if (!d) throw new UsageError('Pass the breakdown directory (the -o directory used with fetch).');
    return path.resolve(d);
}

/**
 * The file every step reads and its exact time base. A variable-rate source gets a constant-rate copy
 * (source/work_cfr.mp4), remade whenever the source changes (work_cfr.json records which source it came from).
 */
async function workingTimebase(dir: string, source: string): Promise<Timebase> {
    const p = await probeRate(source);
    if (!p.variable) return { rate: p.rate, fps: p.fps, frames: p.frames, start_time: p.start_time, file: 'source/video.mp4', sha256: await sha256File(source), cfr_copy: false };
    const fromSha = await sha256File(source);
    const copy = path.join(dir, 'source', 'work_cfr.mp4');
    const record = path.join(dir, 'source', 'work_cfr.json');
    const prev = await readJson<{ from_sha256: string; sha256: string }>(record);
    let sha = prev && prev.from_sha256 === fromSha ? await sha256File(copy).catch(() => null) : null;
    if (!sha || sha !== prev?.sha256) {
        const fps = Math.round(p.avg_fps || p.fps);
        log(`[breakdown] the source has a variable frame rate: making a constant ${fps} fps working copy (source/work_cfr.mp4)`);
        await rm(copy, { force: true });
        await cfrCopy(source, copy, fps);
        sha = await sha256File(copy);
        await writeJson(record, { from_sha256: fromSha, sha256: sha });
    }
    const q = await probeRate(copy);
    return { rate: q.rate, fps: q.fps, frames: q.frames, start_time: q.start_time, file: 'source/work_cfr.mp4', sha256: sha, cfr_copy: true };
}

async function readJson<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
    }
}
const writeJson = (file: string, data: unknown) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);

async function loadBreakdown(dir: string): Promise<Breakdown> {
    const b = await readJson<Breakdown>(path.join(dir, 'breakdown.json'));
    if (!b) throw new UsageError(`No breakdown.json in ${dir}. Run: analyze ${dir}`);
    return b;
}

async function requireFf(): Promise<void> {
    for (const tool of ['ffmpeg', 'ffprobe']) {
        if (!(await toolVersion(tool))) throw new ToolError(`${tool} was not found on PATH.`, installHint(tool));
    }
}

async function doctor() {
    const [ff, fp, comfy] = await Promise.all([toolVersion('ffmpeg'), toolVersion('ffprobe'), toolVersion('comfy', '--version')]);
    const asr = process.env.TT_ASR_CMD?.trim() || null;
    const problems: string[] = [];
    if (!ff) problems.push(`ffmpeg missing. ${installHint('ffmpeg')}`);
    else if ((majorOf(ff) ?? 99) < 6) problems.push(`ffmpeg ${ff} is older than 6; update it.`);
    if (!fp) problems.push(`ffprobe missing. ${installHint('ffprobe')}`);
    const result = {
        ok: problems.length === 0,
        required: { ffmpeg: ff, ffprobe: fp, bun: typeof Bun !== 'undefined' ? Bun.version : null },
        optional: {
            speech_recogniser: asr ? 'configured (TT_ASR_CMD)' : 'not configured: the script will be "unconfirmed" until you run transcribe (references/transcription.md)',
            comfy: comfy ?? `not found. ${installHint('comfy')}`,
        },
        problems,
    };
    print(result);
    return problems.length ? 1 : 0;
}

async function cmdFetch(a: Args) {
    const out = str(a, 'o', 'out');
    if (!out) throw new UsageError('fetch needs -o <dir>.');
    const dir = path.resolve(out);
    const file = str(a, 'file');
    const capture = str(a, 'capture');
    const id = str(a, 'id');
    if (!file && !(capture && id)) throw new UsageError('fetch needs --capture <file> --id <post id> (a capture made with the tiktok skill) or --file <video>.');
    if (id && !/^\d{5,25}$/.test(id)) throw new UsageError('--id is the numeric post id (the digits after /video/ in the link).');
    await mkdir(dir, { recursive: true });
    let meta: Meta;
    if (file) meta = await fetchFromFile(path.resolve(file), dir);
    else meta = await fetchFromCapture(path.resolve(capture!), id!, dir, { maxBytes: num(a, 'max-bytes') ?? DEFAULT_MAX_BYTES, log });
    print({ ok: true, dir, video: meta.video, owner: meta.owner, duration_sec: meta.duration_sec, captions: meta.captions, audio_attribution: meta.audio_attribution, next: `analyze ${dir}` });
    return 0;
}

/** Captions fetched with the post become the transcript under the name tiktok_captions:<lang>. */
async function captionsTranscript(file: string, lang: string): Promise<Transcript> {
    const t = await importTranscript(file, lang);
    return { ...t, source: `tiktok_captions:${lang}` };
}

async function loadTranscript(dir: string): Promise<Transcript | null> {
    return readJson<Transcript>(path.join(dir, 'transcript.json'));
}

/** analyze's transcript, in the documented order; whatever it picks is written to transcript.json. */
async function resolveTranscript(dir: string, file: string | undefined, hasAudio: boolean): Promise<Transcript | null> {
    const captions = (await readJson<Meta>(path.join(dir, 'source', 'meta.json')))?.captions;
    const choice = await chooseTranscript(dir, { file: file ? path.resolve(file) : undefined, asrCmd: process.env.TT_ASR_CMD, captions });
    let t: Transcript | null = null;
    if (choice.kind === 'existing') return loadTranscript(dir);
    if (choice.kind === 'file') t = await importTranscript(choice.path);
    else if (choice.kind === 'captions') t = await captionsTranscript(choice.path, choice.lang);
    else if (choice.kind === 'recogniser' && hasAudio) {
        log('[breakdown] running the local recogniser (TT_ASR_CMD)');
        t = await runRecogniser(choice.cmd, path.join(dir, 'source', 'audio.wav'), path.join(dir, 'asr_out'), null);
    }
    if (t) await writeJson(path.join(dir, 'transcript.json'), t);
    return t;
}

async function analyze(a: Args) {
    const dir = dirArg(a);
    await requireFf();
    const source = path.join(dir, 'source', 'video.mp4');
    const meta = await readJson<Meta>(path.join(dir, 'source', 'meta.json'));
    if (!meta) throw new UsageError(`No source/meta.json in ${dir}. Run fetch first.`);
    const threshold = num(a, 'scene') ?? 0.3;
    if (!(threshold > 0 && threshold < 1)) throw new UsageError('--scene must be between 0 and 1.');
    const addSec = list(str(a, 'add-cut'));
    const addFrames = list(str(a, 'add-cut-frame'));
    const removeSec = list(str(a, 'remove-cut'));
    if ([...addSec, ...removeSec].some((n) => !Number.isFinite(n) || n < 0)) throw new UsageError('--add-cut / --remove-cut take seconds, comma separated.');
    if (addFrames.some((n) => !Number.isInteger(n) || n <= 0)) throw new UsageError('--add-cut-frame takes whole frame numbers (the first frame of the new shot), comma separated.');

    log('[breakdown] probing');
    const tb = await workingTimebase(dir, source);
    const video = path.join(dir, tb.file);
    const facts = await probe(video);
    const maxDuration = num(a, 'max-duration') ?? 900;
    if (facts.duration > maxDuration) {
        // Frames and audio are decoded into memory; an unbounded input could exhaust it.
        throw new UsageError(`This video is ${Math.round(facts.duration)} s long; the limit is ${maxDuration} s (decoded frames and audio are held in memory). Trim it with ffmpeg, or raise --max-duration if the machine has the memory.`);
    }
    if (addFrames.some((n) => n >= tb.frames)) throw new UsageError(`--add-cut-frame takes frames between 1 and ${tb.frames - 1}.`);

    // Cut corrections are frames on this working file. Older ones in seconds are moved to frames; ones made on
    // another file (the source changed) no longer point at anything and are dropped.
    const overridesFile = path.join(dir, 'cuts_override.json');
    let remembered: FrameOverrides = { version: 2, sha256: tb.sha256, add: [], remove: [] };
    let rewrite = Boolean(a.flags['reset-cuts']);
    if (!a.flags['reset-cuts']) {
        const raw = await readJson<any>(overridesFile);
        if (raw && raw.version === 2) {
            if (raw.sha256 === tb.sha256) remembered = raw as FrameOverrides;
            else {
                log('[breakdown] The cut corrections were made on another video (the source changed): they are dropped.');
                rewrite = true;
            }
        } else if (raw) {
            remembered = migrateOverrides(raw, tb);
            rewrite = true;
        }
    }
    const snapped: Array<{ asked: number; frame: number; moved: number; mad: number | null }> = [];
    for (const t of addSec) {
        const center = Math.min(tb.frames - 1, Math.max(1, secToFrame(t, tb.rate)));
        const first = Math.max(0, center - 3);
        const diffs = await frameDiffsAround(video, tb, first, Math.min(7, tb.frames - first));
        const s = snapToChange(diffs, first, center);
        const frame = Math.min(tb.frames - 1, Math.max(1, s.frame));
        snapped.push({ asked: t, frame, moved: frame - center, mad: s.mad });
        if (s.mad === null) log(`[breakdown] --add-cut ${t}: no change within 2 frames, cut kept at frame ${frame}.`);
        else if (frame !== center) log(`[breakdown] --add-cut ${t}: moved ${frame - center > 0 ? '+' : ''}${frame - center} frame(s) to frame ${frame}, where the picture changes.`);
    }
    const overrides = recordFrameOverrides(remembered, [...snapped.map((s) => s.frame), ...addFrames], removeSec.map((t) => secToFrame(t, tb.rate)));
    if (addSec.length || addFrames.length || removeSec.length || rewrite) await writeJson(overridesFile, overrides);

    log('[breakdown] detecting cuts');
    // Both detectors report seconds from the first frame (ffmpeg's filters start the clock at 0).
    const sceneRel = await detectCuts(video, threshold);
    log('[breakdown] measuring motion');
    const frames = await grayFrames(video);
    const pairs = pairStats(frames);
    const fromDiff = a.flags['no-diff-cuts'] ? [] : diffCuts(pairs, sceneRel);
    const detectedFrames = [...new Set([...sceneRel.map((t) => secToFrame(t, tb.rate)), ...fromDiff.map((t) => secToFrame(t, tb.rate))])].sort((x, y) => x - y);
    const applied = applyFrameOverrides(detectedFrames, overrides);
    const cutFrames = mergeFrameCuts(applied.detected, applied.manual, tb.frames, minShotFrames(tb.rate));
    const toSec = (xs: number[]) => xs.map((f) => round3(frameToSec(f, tb.rate)));
    const cuts = toSec(cutFrames);
    const shotSpans = frameSpans(cutFrames, tb.frames, tb.rate);
    log(`[breakdown] ${shotSpans.length} shots`);
    const candidates = textCandidates(pairs, cuts);
    const shots: Shot[] = [];
    for (const s of shotSpans) {
        log(`[breakdown] frames for shot ${s.id}/${shotSpans.length}`);
        shots.push({
            ...s,
            motion: motionForShot(frames, pairs, s),
            text_change_candidates: candidates.filter((c) => c.t > s.start && c.t <= s.end),
            images: await exportShotImages(video, dir, s, facts.fps, stripFps(s, facts.duration, candidates)),
            review: null,
        });
    }
    const board = await storyboard(dir, shots.map((s) => s.images.mid));
    log('[breakdown] audio');
    const audio = await analyseAudio(video, dir, cuts, facts.hasAudio);
    const transcript = await resolveTranscript(dir, str(a, 'transcript'), audio.present);
    const { script, speech } = buildScript(shots, transcript);
    const b: Breakdown = {
        schema: 'tt.breakdown.v1',
        analysis_id: analysisId({ sha256: tb.sha256, rate: tb.rate, cuts: cutFrames, detector: DETECTOR_VERSION }),
        generated_at: new Date().toISOString(),
        source: meta,
        video: facts,
        timebase: tb,
        cuts: { threshold, detected: toSec(detectedFrames), from_frame_diff: fromDiff, added: toSec(overrides.add), removed: toSec(overrides.remove), final: cuts, frames: { detected: detectedFrames, added: overrides.add, removed: overrides.remove, final: cutFrames } },
        pacing: pacing(shots, facts.duration),
        shots,
        audio,
        storyboard: board,
        transcript: transcript ? { file: 'transcript.json', source: transcript.source, language: transcript.language, segments: transcript.segments.length } : null,
        review: null,
        script,
        speech,
    };
    await writeJson(path.join(dir, 'breakdown.json'), b);
    print({
        ok: true, dir, duration: facts.duration, rate: tb.rate, frames: tb.frames, ...(tb.cfr_copy ? { working_file: tb.file } : {}), ...(snapped.length ? { snapped } : {}), shots: shots.length, pacing: b.pacing,
        low_motion_shots: shots.filter((s) => s.motion.low_motion).map((s) => s.id),
        text_change_candidates: candidates.length,
        audio: { present: audio.present, bpm: audio.rhythm?.bpm ?? null, rhythm_reason: audio.rhythm_reason },
        speech: speech.status,
        transcript: b.transcript,
        next: transcript ? `review ${dir}` : `transcribe ${dir} (optional, needed for the script), then review ${dir}`,
    });
    return 0;
}

async function cmdFrames(a: Args) {
    const dir = dirArg(a);
    await requireFf();
    const b = await loadBreakdown(dir);
    const from = num(a, 'from');
    const to = num(a, 'to');
    if (from === undefined || to === undefined || !(to > from) || from < 0 || to > b.video.duration + 0.05) throw new UsageError(`frames needs --from and --to within 0-${b.video.duration}.`);
    const fps = num(a, 'fps') ?? 4;
    if (!(fps > 0 && fps <= 30)) throw new UsageError('--fps must be between 0 and 30.');
    await mkdir(path.join(dir, 'frames'), { recursive: true });
    const rel = `frames/frames_${from.toFixed(2)}_${to.toFixed(2)}.jpg`;
    const s = await sheet(path.join(dir, 'source', 'video.mp4'), from, to, fps, path.join(dir, rel), 300, 48);
    print({ ok: true, image: path.join(dir, rel), fps: s.fps, times: s.times, timestamps_burned: s.labelled });
    return 0;
}

async function transcribe(a: Args) {
    const dir = dirArg(a);
    const lang = str(a, 'lang') ?? null;
    const imp = str(a, 'import');
    const cmd = str(a, 'cmd') ?? (process.env.TT_ASR_CMD?.trim() || undefined);
    const caps = imp || cmd ? null : await chooseTranscript(dir, { captions: (await readJson<Meta>(path.join(dir, 'source', 'meta.json')))?.captions });
    let t: Transcript;
    if (imp) t = await importTranscript(path.resolve(imp), lang);
    else if (caps?.kind === 'captions') t = await captionsTranscript(caps.path, caps.lang);
    else if (cmd) {
        const audio = path.join(dir, 'source', 'audio.wav');
        const b = await readJson<Breakdown>(path.join(dir, 'breakdown.json'));
        if (b && !b.audio.present) throw new UsageError('This video has no audio stream; there is nothing to transcribe.');
        if (!(await readFile(audio).catch(() => null))) throw new UsageError(`No source/audio.wav in ${dir}. Run analyze first.`);
        log('[breakdown] running the recogniser');
        t = await runRecogniser(cmd, audio, path.join(dir, 'asr_out'), lang);
    } else {
        print({
            ok: false,
            error: 'No transcript source. This skill ships no speech model.',
            options: [
                'transcribe <dir> --import <file.srt|.vtt|.json>   (any transcript you already have)',
                'fetch --capture again: TikTok captions are saved when the post has them',
                'transcribe <dir> --cmd "<your local recogniser> {audio} {out}"   (or set TT_ASR_CMD)',
                'Recipes for Whisper and other local models: references/transcription.md',
                'Or skip it: the script stays "unconfirmed" and everything else still works.',
            ],
        });
        return 2;
    }
    await writeJson(path.join(dir, 'transcript.json'), t);
    let reviewCleared = false;
    let speechNote: string | undefined;
    const b = await readJson<Breakdown>(path.join(dir, 'breakdown.json'));
    if (b) {
        const { script, speech } = buildScript(b.shots, t);
        // Conclusions of an earlier review may rest on the old transcript: they are cleared, and
        // apply-review rebuilds them from the (kept) answers file against the new one.
        reviewCleared = Boolean(b.review);
        await writeJson(path.join(dir, 'breakdown.json'), { ...b, shots: b.shots.map((s) => ({ ...s, review: null })), review: null, transcript: { file: 'transcript.json', source: t.source, language: t.language, segments: t.segments.length }, script, speech });
        speechNote = speech.reason;
    }
    print({ ok: true, segments: t.segments.length, language: t.language, source: t.source, preview: t.segments.slice(0, 3), ...(speechNote ? { note: speechNote } : {}), next: reviewCleared ? `The earlier review was cleared because the transcript changed: apply-review ${dir}` : `review ${dir}` });
    return 0;
}

async function review(a: Args) {
    const dir = dirArg(a);
    const b = await loadBreakdown(dir);
    const tasks = buildTasks(b, await loadTranscript(dir));
    await writeJson(path.join(dir, 'review_tasks.json'), tasks);
    const answers = path.join(dir, 'review_answers.json');
    let existing = await readJson<{ analysis_id?: string }>(answers);
    let stale: string | null = null;
    if (existing && existing.analysis_id !== b.analysis_id) {
        // Written for other shots: keep it aside so it cannot be applied to this analysis.
        stale = path.join(dir, 'review_answers.stale.json');
        await rename(answers, stale);
        existing = null;
    }
    if (!existing) await writeJson(answers, answersTemplate(b));
    print({ ok: true, tasks: path.join(dir, 'review_tasks.json'), answers, answers_created: !existing, ...(stale ? { stale_answers_moved_to: stale } : {}), shots: b.shots.length, next: `Read the images in review_tasks.json, fill review_answers.json, then: apply-review ${dir}` });
    return 0;
}

async function apply(a: Args) {
    const dir = dirArg(a);
    const b = await loadBreakdown(dir);
    const file = path.resolve(str(a, 'answers') ?? path.join(dir, 'review_answers.json'));
    const answers = await readJson<unknown>(file);
    if (!answers) throw new UsageError(`No answers file at ${file}. Run review first.`);
    const res = applyReview(b, answers, await loadTranscript(dir));
    if (res.splits.length && !res.errors.length) {
        print({ ok: false, reason: 'missed_cuts', splits: res.splits, next: `analyze ${dir} --add-cut ${res.splits.join(',')}  then review again (shot numbers change)` });
        return 2;
    }
    if (!res.ok || !res.breakdown) {
        print({ ok: false, errors: res.errors, warnings: res.warnings, downgrades: res.downgrades });
        return 1;
    }
    await writeJson(path.join(dir, 'breakdown.json'), res.breakdown);
    print({ ok: true, warnings: res.warnings, downgrades: res.downgrades, next: `summary ${dir}` });
    return 0;
}

async function summary(a: Args) {
    const dir = dirArg(a);
    const b = await loadBreakdown(dir);
    let recreate: string | null = null;
    if (b.review) {
        const [ff, comfy] = await Promise.all([toolVersion('ffmpeg'), toolVersion('comfy', '--version')]);
        recreate = path.join(dir, 'recreate.md');
        await writeFile(recreate, recreateMarkdown(b, { ffmpeg: ff, comfy }));
    }
    print(summaryText(b) + (recreate ? `\n\nRecreate plan: ${recreate}` : ''));
    return 0;
}

async function main(): Promise<number> {
    const a = parseArgs(process.argv.slice(2));
    const cmd = a._[0];
    if (!cmd || a.flags.help || a.flags.h) {
        print(HELP);
        return cmd || a.flags.help || a.flags.h ? 0 : 1;
    }
    switch (cmd) {
        case 'doctor': return doctor();
        case 'fetch': return cmdFetch(a);
        case 'analyze': return analyze(a);
        case 'frames': return cmdFrames(a);
        case 'transcribe': return transcribe(a);
        case 'review': return review(a);
        case 'apply-review':
        case 'apply': return apply(a);
        case 'summary': return summary(a);
        default: throw new UsageError(`Unknown command "${cmd}". Run with --help.`);
    }
}

main().then(
    (code) => process.exit(code),
    (e) => {
        const err = e as Error & { hint?: string; kind?: string };
        print({ ok: false, error: scrubUrls(String(err.message)), ...(err.kind ? { kind: err.kind } : {}), ...(err.hint ? { hint: err.hint } : {}) });
        process.exit(e instanceof UsageError ? 2 : 1);
    },
);

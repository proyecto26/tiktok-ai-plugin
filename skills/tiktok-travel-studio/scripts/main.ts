#!/usr/bin/env -S npx -y bun
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { analyse, combine, resolveFaceCmd, termsOf } from './analyse.ts';
import { ToolError, installHint, toolVersion } from './ff.ts';
import { DEFAULT_GAP_HOURS, DEFAULT_MAX_KM, SCHEMA, groupTrips, loadLibrary, saveJson, type Library } from './library.ts';
import { buildDrafts, loadCaptionLinter, type PhotoSetsFile } from './drafts.ts';
import { probeMedia, scanFolders } from './media.ts';
import { addMusic } from './music.ts';
import { PHOTO_POST_MAX, buildPhotoSets, type Ratio } from './photos.ts';
import { DEFAULT_LENGTH, parseFocus, renderClip } from './render.ts';

const HELP = `TikTok travel studio: a travel backlog into vertical cuts, photo sets and local drafts (never publishes)

Usage: npx -y bun scripts/main.ts <command> [options]      Output is JSON on stdout; progress goes to stderr.

  doctor                                   Check ffmpeg, ffprobe (blurdetect), Bun and the optional face detector
  scan <folders...> -o library.json        Probe photos and videos: date, GPS, duration, size, orientation, rotation, frame rate
  group library.json [--gap-hours 36] [--max-km 150]   Trips by date gaps and GPS distance (written into library.json)
  score library.json [--length 15] [--force]           Sharpness, motion, exposure, duration fit, faces (TT_FACE_CMD only)
  shortlist library.json [--n 10] [--kind video|photo] [--trip trip-1] [-o shortlist.json]
  render <video...> | --shortlist shortlist.json  [--out-dir renders] [--length 15] [--start s] [--focus x,y] [--keep-audio]
                                           1080x1920 vertical cuts: focus = faces, else motion, else centre
  music --video <rendered.mp4> --file <audio> -o <out.mp4> [--start s] [--fade 1.5]   Loudness -14 LUFS, fades, never loops
  photos <images...> | --shortlist shortlist.json [--ratio 9:16|4:5|both] [--per-set 35] [--out-dir photos] [--focus x,y]
  drafts [--videos a.mp4,b.mp4] [--photosets photos/photosets.json] [--place "Lisbon"] [--hook "..."] [--caption "..."] [-o drafts.json]
`;

class UsageError extends Error {}
const log = (m: string) => process.stderr.write(`${m}\n`);
const print = (o: unknown) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

interface Args {
    _: string[];
    flags: Record<string, string | true>;
    /** Every value of a flag given more than once. */
    lists: Record<string, string[]>;
}
const VALUE_FLAGS = new Set(['o', 'out', 'out-dir', 'n', 'kind', 'trip', 'gap-hours', 'max-km', 'length', 'start', 'focus', 'shortlist', 'video', 'videos', 'file', 'fade', 'ratio', 'per-set', 'photosets', 'place', 'hook', 'caption', 'library', 'title', 'description']);

function parseArgs(argv: string[]): Args {
    const out: Args = { _: [], flags: {}, lists: {} };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--') || (a.startsWith('-') && a.length === 2 && !/\d/.test(a[1]))) {
            const name = a.replace(/^-+/, '');
            const eq = name.indexOf('=');
            const set = (k: string, v: string) => {
                out.flags[k] = v;
                (out.lists[k] ??= []).push(v);
            };
            if (eq > 0) set(name.slice(0, eq), name.slice(eq + 1));
            else if (VALUE_FLAGS.has(name)) {
                if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value.`);
                set(name, argv[++i]);
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
const libArg = (a: Args) => {
    const f = a._[1];
    if (!f) throw new UsageError('Pass the library.json written by scan.');
    return path.resolve(f);
};

async function requireFf(): Promise<void> {
    for (const t of ['ffmpeg', 'ffprobe']) if (!(await toolVersion(t))) throw new ToolError('tool_missing', `${t} was not found on PATH.`, installHint(t));
}

async function doctor() {
    const [ff, fp] = await Promise.all([toolVersion('ffmpeg'), toolVersion('ffprobe')]);
    const faceCmd = resolveFaceCmd();
    const problems: string[] = [];
    if (!ff) problems.push(`ffmpeg missing. ${installHint('ffmpeg')}`);
    if (!fp) problems.push(`ffprobe missing. ${installHint('ffprobe')}`);
    const { run } = await import('./ff.ts');
    const blur = ff ? (await run('ffmpeg', ['-hide_banner', '-filters'])).stdout.toString('utf8').includes('blurdetect') : false;
    print({
        ok: problems.length === 0,
        required: { ffmpeg: ff, ffprobe: fp, bun: typeof Bun !== 'undefined' ? Bun.version : null },
        optional: {
            blurdetect: blur ? 'available' : 'missing: sharpness will not be scored (needs ffmpeg 7 or newer)',
            face_detector: faceCmd ? `configured (TT_FACE_CMD): ${faceCmd}` : 'not configured: faces are not scored and crops use motion, else the centre. Set TT_FACE_CMD to a local command that prints face boxes as JSON (references/face-detector.md). Nothing is downloaded.',
        },
        problems,
    });
    return problems.length ? 1 : 0;
}

async function cmdScan(a: Args) {
    const folders = a._.slice(1);
    const out = str(a, 'o', 'out');
    if (!folders.length || !out) throw new UsageError('scan needs one or more folders and -o library.json.');
    await requireFf();
    const r = await scanFolders(folders);
    const lib: Library = { schema: SCHEMA, kind: 'library', created_at: new Date().toISOString(), roots: folders.map((f) => path.resolve(f)), items: r.items, trips: [], skipped: r.skipped, skipped_total: r.skipped_total };
    await mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await saveJson(path.resolve(out), lib);
    print({ ok: true, library: path.resolve(out), items: r.items.length, videos: r.items.filter((i) => i.kind === 'video').length, photos: r.items.filter((i) => i.kind === 'photo').length, skipped: r.skipped_total, undated_fallbacks: r.items.filter((i) => i.date_source === 'mtime').length, next: `group ${out}` });
    return 0;
}

async function cmdGroup(a: Args) {
    const file = libArg(a);
    const lib = await loadLibrary(file);
    lib.trips = groupTrips(lib.items, { gapHours: num(a, 'gap-hours') ?? DEFAULT_GAP_HOURS, maxKm: num(a, 'max-km') ?? DEFAULT_MAX_KM });
    await saveJson(file, lib);
    print({ ok: true, library: file, trips: lib.trips.length, summary: lib.trips.map((t) => ({ id: t.id, start: t.start, end: t.end, videos: t.videos, photos: t.photos, centre: t.centre, undated: t.undated })), next: `score ${file}` });
    return 0;
}

async function cmdScore(a: Args) {
    const file = libArg(a);
    await requireFf();
    const lib = await loadLibrary(file);
    const faceCmd = resolveFaceCmd();
    const length = num(a, 'length') ?? 15;
    const force = a.flags.force === true;
    let scored = 0;
    let kept = 0;
    let withFaces = 0;
    const failed: { path: string; error: string }[] = [];
    for (const it of lib.items) {
        if (it.score && !force) {
            kept++;
            continue;
        }
        try {
            log(`[score] ${it.path}`);
            const an = await analyse(it, { faceCmd, length });
            const terms = termsOf(an);
            const c = combine(terms);
            if (an.faces && an.faces.count > 0) withFaces++;
            it.score = { total: c.total, used: c.used, terms, blur: an.sharpness.blur, sharpness_method: an.sharpness.method, yavg: an.exposure.yavg, motion_mean: an.motion?.mean ?? null, motion_centroid: an.motion?.centroid ?? null, best_start: an.motion?.best_start ?? 0, faces: an.faces ? { count: an.faces.count, centre: an.faces.centre } : null, notes: [an.faces_note, an.sharpness.method === 'unavailable' ? 'sharpness not scored: this ffmpeg has no blurdetect filter' : null].filter(Boolean) };
            scored++;
        } catch (e) {
            failed.push({ path: it.path, error: (e as Error).message.split('\n')[0] });
        }
    }
    lib.scoring = { weights: 'sharpness .35, motion .25, exposure .25, duration_fit .15, faces .2 (only the terms that exist are averaged)', length, faces: faceCmd ? 'TT_FACE_CMD' : null };
    await saveJson(file, lib);
    print({ ok: true, library: file, scored, already_scored: kept, failed, faces: faceCmd ? `TT_FACE_CMD configured; ${withFaces} clip(s) with faces` : 'not configured: the faces term is null for every item (set TT_FACE_CMD to use a local detector; nothing is downloaded)', next: `shortlist ${file} --n 10` });
    return 0;
}

async function cmdShortlist(a: Args) {
    const file = libArg(a);
    const lib = await loadLibrary(file);
    const n = num(a, 'n') ?? 10;
    const kind = str(a, 'kind');
    if (kind && kind !== 'video' && kind !== 'photo') throw new UsageError('--kind is video or photo.');
    const trip = str(a, 'trip');
    const tripOf = new Map<string, string>();
    for (const t of lib.trips) for (const id of t.items) tripOf.set(id, t.id);
    if (trip && !lib.trips.some((t) => t.id === trip)) throw new ToolError('trip_not_found', `No trip "${trip}".`, `Run group, then pick one of: ${lib.trips.map((t) => t.id).join(', ') || '(none yet)'}`);
    const pool = lib.items.filter((i) => (!kind || i.kind === kind) && (!trip || tripOf.get(i.id) === trip));
    if (pool.some((i) => !i.score)) throw new ToolError('not_scored', `${pool.filter((i) => !i.score).length} item(s) have no score.`, `Run: score ${file}`);
    const top = [...pool].sort((x, y) => (y.score as any).total - (x.score as any).total).slice(0, n);
    const entries = top.map((i) => ({ id: i.id, path: i.path, kind: i.kind, trip: tripOf.get(i.id) ?? null, taken_at: i.taken_at, duration: i.duration, score: (i.score as any).total, start: (i.score as any).best_start ?? 0, focus: null as [number, number] | null }));
    const out = path.resolve(str(a, 'o', 'out') ?? path.join(path.dirname(file), 'shortlist.json'));
    await saveJson(out, { schema: SCHEMA, kind: 'shortlist', created_at: new Date().toISOString(), library: file, entries });
    print({ ok: true, shortlist: out, entries: entries.length, top: entries.slice(0, 5).map((e) => ({ path: e.path, score: e.score })), note: 'Edit `focus` ([x, y] as fractions of the displayed frame) or `start` in an entry to steer render.', next: `render --shortlist ${out}` });
    return 0;
}

interface ShortEntry {
    path: string;
    kind: 'video' | 'photo';
    start?: number;
    focus?: [number, number] | null;
    taken_at?: string | null;
}
async function loadShortlist(file: string): Promise<ShortEntry[]> {
    let j: any;
    try {
        j = JSON.parse(await readFile(path.resolve(file), 'utf8'));
    } catch {
        throw new ToolError('shortlist_not_found', `Cannot read ${file}.`, 'Run shortlist first.');
    }
    if (j.schema !== SCHEMA || j.kind !== 'shortlist' || !Array.isArray(j.entries)) throw new ToolError('bad_schema', `${file} is not a ${SCHEMA} shortlist.`);
    return j.entries;
}
const validFocus = (f: unknown): [number, number] | null => (Array.isArray(f) && f.length === 2 ? parseFocus(`${f[0]},${f[1]}`) : null);

async function cmdRender(a: Args) {
    await requireFf();
    const sl = str(a, 'shortlist');
    const entries: ShortEntry[] = sl ? (await loadShortlist(sl)).filter((e) => e.kind === 'video') : a._.slice(1).map((p) => ({ path: p, kind: 'video' as const }));
    if (!entries.length) throw new UsageError('render needs video files or --shortlist with video entries.');
    const focusFlag = str(a, 'focus');
    if (focusFlag && entries.length !== 1) throw new UsageError('--focus applies to one clip; for several, set `focus` per entry in the shortlist file.');
    const startFlag = num(a, 'start');
    if (startFlag !== undefined && entries.length !== 1) throw new UsageError('--start applies to one clip; for several, set `start` per entry in the shortlist file.');
    const outDir = path.resolve(str(a, 'out-dir', 'o', 'out') ?? 'renders');
    const length = num(a, 'length') ?? DEFAULT_LENGTH;
    const reports = [];
    const used = new Set<string>();
    for (const e of entries) {
        const item = await probeMedia(e.path);
        const base = path.basename(item.path, path.extname(item.path));
        let name = `${base}_9x16`;
        if (used.has(name)) name = `${base}_${item.id}_9x16`;
        used.add(name);
        log(`[render] ${item.path}`);
        reports.push(await renderClip(item, outDir, { length, start: startFlag ?? (typeof e.start === 'number' ? e.start : undefined), focus: focusFlag ? parseFocus(focusFlag) : validFocus(e.focus), keepAudio: a.flags['keep-audio'] === true, name }));
    }
    print({ ok: true, out_dir: outDir, rendered: reports.length, clips: reports, next: 'music --video <clip> --file <your audio> -o <out.mp4>, or drafts --videos <clips>' });
    return 0;
}

async function cmdMusic(a: Args) {
    await requireFf();
    const video = str(a, 'video');
    const file = str(a, 'file');
    const out = str(a, 'o', 'out');
    if (!video || !file || !out) throw new UsageError('music needs --video <rendered.mp4> --file <audio> -o <out.mp4>.');
    const r = await addMusic({ video: path.resolve(video), music: path.resolve(file), out: path.resolve(out), start: num(a, 'start'), fade: num(a, 'fade') });
    print({ ok: true, ...r });
    return 0;
}

async function cmdPhotos(a: Args) {
    await requireFf();
    const ratio = str(a, 'ratio') ?? '9:16';
    if (ratio !== '9:16' && ratio !== '4:5' && ratio !== 'both') throw new UsageError('--ratio is 9:16, 4:5 or both.');
    const sl = str(a, 'shortlist');
    let files = a._.slice(1);
    const focusByPath: Record<string, [number, number] | null> = {};
    if (sl) {
        const es = (await loadShortlist(sl)).filter((e) => e.kind === 'photo').sort((x, y) => String(x.taken_at ?? '').localeCompare(String(y.taken_at ?? '')));
        files = es.map((e) => e.path);
        for (const e of es) focusByPath[path.resolve(e.path)] = validFocus(e.focus);
    }
    const focus = str(a, 'focus');
    if (focus && files.length !== 1) throw new UsageError('--focus applies to one photo; for several, set `focus` per entry in the shortlist file.');
    const outDir = path.resolve(str(a, 'out-dir', 'o', 'out') ?? 'photos');
    const r = await buildPhotoSets(files, { outDir, ratio: ratio as Ratio | 'both', perSet: num(a, 'per-set'), focus: focus ? parseFocus(focus) : null, focusByPath });
    const file = path.join(outDir, 'photosets.json');
    await saveJson(file, { schema: SCHEMA, kind: 'photosets', created_at: new Date().toISOString(), limit: PHOTO_POST_MAX, limit_note: 'Working number from recon, to be confirmed in the live photo composer (PHOTO_POST_MAX in scripts/photos.ts).', sets: r.sets, warnings: r.warnings });
    print({ ok: true, photosets: file, sets: r.sets.map((s) => ({ id: s.id, ratio: s.ratio, count: s.count })), warnings: r.warnings, next: `drafts --photosets ${file}` });
    return 0;
}

async function cmdDrafts(a: Args) {
    const videos = (str(a, 'videos') ?? '').split(',').map((s) => s.trim()).filter(Boolean).concat(str(a, 'video') ? [str(a, 'video')!] : []);
    const ps = str(a, 'photosets');
    let photosets: PhotoSetsFile | null = null;
    if (ps) {
        try {
            photosets = JSON.parse(await readFile(path.resolve(ps), 'utf8'));
        } catch {
            throw new ToolError('photosets_not_found', `Cannot read ${ps}.`, 'Run photos first.');
        }
        if (photosets?.schema !== SCHEMA || photosets.kind !== 'photosets') throw new ToolError('bad_schema', `${ps} is not a ${SCHEMA} photosets file.`);
    }
    const linter = await loadCaptionLinter();
    const d = await buildDrafts({ videos, photosets, place: str(a, 'place'), hook: str(a, 'hook'), captions: a.lists.caption ?? [] }, linter);
    const out = path.resolve(str(a, 'o', 'out') ?? 'drafts.json');
    await saveJson(out, d);
    print({ ok: true, drafts_file: out, drafts: d.drafts.length, lint: d.lint, summary: d.drafts.map((x) => ({ id: x.id, kind: x.kind, status: x.status, command: x.prepare?.command ?? null })), warnings: d.warnings, note: d.publishing });
    return 0;
}

async function main(argv: string[]): Promise<number> {
    if (!argv.length || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
        process.stdout.write(HELP);
        return 0;
    }
    try {
        const a = parseArgs(argv);
        switch (a._[0]) {
            case 'doctor':
                return await doctor();
            case 'scan':
                return await cmdScan(a);
            case 'group':
                return await cmdGroup(a);
            case 'score':
                return await cmdScore(a);
            case 'shortlist':
                return await cmdShortlist(a);
            case 'render':
                return await cmdRender(a);
            case 'music':
                return await cmdMusic(a);
            case 'photos':
                return await cmdPhotos(a);
            case 'drafts':
                return await cmdDrafts(a);
            default:
                throw new UsageError(`Unknown command "${a._[0]}". Run with --help.`);
        }
    } catch (e) {
        const code = e instanceof UsageError ? 'usage' : e instanceof ToolError ? e.code : 'error';
        print({ ok: false, error: { code, message: (e as Error).message, hint: e instanceof ToolError ? e.hint : undefined } });
        return e instanceof UsageError ? 2 : 1;
    }
}

process.exitCode = await main(process.argv.slice(2));

#!/usr/bin/env -S npx -y bun
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { analyse, combine, resolveFaceCmd, termsOf } from './analyse.ts';
import { ToolError, installHint, toolVersion } from './ff.ts';
import { DEFAULT_GAP_HOURS, DEFAULT_MAX_KM, SCHEMA, groupTrips, loadLibrary, saveJson, type Library } from './library.ts';
import { scanFolders } from './media.ts';

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
}
const VALUE_FLAGS = new Set(['o', 'out', 'out-dir', 'n', 'kind', 'trip', 'gap-hours', 'max-km', 'length', 'start', 'focus', 'shortlist', 'video', 'videos', 'file', 'fade', 'ratio', 'per-set', 'photosets', 'place', 'hook', 'caption', 'library', 'title', 'description']);

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

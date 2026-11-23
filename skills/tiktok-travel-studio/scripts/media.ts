/** Probing and scanning: one library item per photo or video, with displayed size (rotation applied), date, GPS. */
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { readJpegExif } from './exif.ts';
import { ToolError, ffprobeJson, must } from './ff.ts';

export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi']);
export const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export interface Gps {
    lat: number;
    lon: number;
}

export interface Item {
    id: string;
    path: string;
    kind: 'video' | 'photo';
    bytes: number;
    /** Displayed size: rotation metadata already applied. */
    width: number;
    height: number;
    stored_width: number;
    stored_height: number;
    /** Clockwise degrees the player applies (0, 90, 180, 270), from the display matrix or the EXIF orientation. */
    rotation: number;
    orientation: 'portrait' | 'landscape' | 'square';
    duration: number | null;
    fps: number | null;
    variable_rate: boolean;
    has_audio: boolean;
    taken_at: string | null;
    date_source: 'exif' | 'container' | 'mtime';
    gps: Gps | null;
    score?: unknown;
}

const normRot = (r: number) => ((Math.round(r) % 360) + 360) % 360;
const EXIF_ROT: Record<number, number> = { 1: 0, 2: 0, 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 };

/** "+48.8584+002.2945/" (ISO 6709), as MP4/MOV `location` tags carry it. */
export function parseIso6709(s: string | undefined): Gps | null {
    const m = s?.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
    if (!m) return null;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

const idOf = (abs: string) => createHash('sha1').update(abs.replace(/\\/g, '/')).digest('hex').slice(0, 10);

function parseRate(r: string | undefined): number | null {
    const m = r?.match(/^(\d+)\/(\d+)$/);
    return m && Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
}

/** True when the packet timestamps are not evenly spaced (checked over the first 20 s). */
async function isVariableRate(file: string): Promise<boolean> {
    const r = await must('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+20', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file]);
    const pts = r.stdout
        .toString('utf8')
        .split(/\r?\n/)
        .map(Number)
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
    const deltas: number[] = [];
    for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] > 1e-6) deltas.push(pts[i] - pts[i - 1]);
    if (deltas.length < 3) return false;
    return Math.max(...deltas) > 1.5 * Math.min(...deltas);
}

export async function probeMedia(file: string): Promise<Item> {
    const abs = path.resolve(file);
    const ext = path.extname(abs).toLowerCase();
    const isPhoto = PHOTO_EXT.has(ext);
    const [st, probe] = await Promise.all([stat(abs), ffprobeJson(abs)]);
    const v = (probe.streams ?? []).find((s: any) => s.codec_type === 'video');
    if (!v) throw new ToolError('no_video_stream', `${abs} has no picture.`);
    const sw = Number(v.width);
    const sh = Number(v.height);

    let rotation = 0;
    let taken: string | null = null;
    let source: Item['date_source'] = 'mtime';
    let gps: Gps | null = null;

    if (isPhoto) {
        if (ext === '.jpg' || ext === '.jpeg') {
            const e = await readJpegExif(abs);
            if (e.orientation) rotation = EXIF_ROT[e.orientation] ?? 0;
            if (e.date) {
                taken = e.date;
                source = 'exif';
            }
            gps = e.gps;
        }
    } else {
        const side = (v.side_data_list ?? []).find((s: any) => s.rotation !== undefined);
        rotation = normRot(Number(side?.rotation ?? v.tags?.rotate ?? 0));
        const tags = { ...(probe.format?.tags ?? {}), ...Object.fromEntries(Object.entries(probe.format?.tags ?? {}).map(([k, x]) => [k.toLowerCase(), x])) } as Record<string, string>;
        const ct = tags.creation_time;
        if (ct && !/^0000|^1904|^1970-01-01T00:00:00/.test(ct)) {
            const d = new Date(ct);
            if (!Number.isNaN(d.getTime())) {
                taken = d.toISOString().replace(/\.\d+Z$/, 'Z');
                source = 'container';
            }
        }
        gps = parseIso6709(tags.location ?? tags['com.apple.quicktime.location.iso6709']);
    }
    if (!taken) taken = st.mtime.toISOString().replace(/\.\d+Z$/, 'Z');

    const swap = rotation === 90 || rotation === 270;
    // EXIF orientations 5-8 swap the axes; a plain 180 or 0 does not.
    const width = swap ? sh : sw;
    const height = swap ? sw : sh;
    const duration = isPhoto ? null : Number(probe.format?.duration ?? v.duration);
    return {
        id: idOf(abs),
        path: abs,
        kind: isPhoto ? 'photo' : 'video',
        bytes: st.size,
        width,
        height,
        stored_width: sw,
        stored_height: sh,
        rotation,
        orientation: width === height ? 'square' : width > height ? 'landscape' : 'portrait',
        duration: duration !== null && Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : null,
        fps: isPhoto ? null : parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate),
        variable_rate: isPhoto ? false : await isVariableRate(abs),
        has_audio: (probe.streams ?? []).some((s: any) => s.codec_type === 'audio'),
        taken_at: taken,
        date_source: source,
        gps,
    };
}

export interface Skipped {
    path: string;
    reason: string;
}

async function walk(dir: string, out: string[]): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p, out);
        else if (e.isFile()) out.push(p);
    }
}

export async function scanFolders(folders: string[]): Promise<{ items: Item[]; skipped: Skipped[]; skipped_total: number }> {
    const files: string[] = [];
    for (const f of folders) {
        const abs = path.resolve(f);
        const st = await stat(abs).catch(() => null);
        if (!st?.isDirectory()) throw new ToolError('folder_not_found', `Not a folder: ${abs}`, 'Pass one or more existing folders.');
        await walk(abs, files);
    }
    const items: Item[] = [];
    const skipped: Skipped[] = [];
    let skippedTotal = 0;
    const seen = new Set<string>();
    const skip = (p: string, reason: string) => {
        skippedTotal++;
        if (skipped.length < 200) skipped.push({ path: p, reason });
    };
    for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        if (!VIDEO_EXT.has(ext) && !PHOTO_EXT.has(ext)) {
            skip(f, ext === '.heic' || ext === '.heif' ? 'unsupported_format: convert HEIC to JPEG first' : 'not_media');
            continue;
        }
        if (seen.has(f)) continue;
        seen.add(f);
        try {
            items.push(await probeMedia(f));
        } catch (e) {
            if (e instanceof ToolError && e.code === 'tool_missing') throw e;
            skip(f, `unreadable: ${(e as Error).message.split('\n')[0]}`);
        }
    }
    return { items, skipped, skipped_total: skippedTotal };
}

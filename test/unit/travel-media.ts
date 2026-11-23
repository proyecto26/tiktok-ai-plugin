// Test helpers for the travel studio: tiny generated media and a minimal EXIF writer (no real photos).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export function ff(args: string[]): void {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-y', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr}`);
}
export function probeJson(file: string): any {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' });
    return JSON.parse(r.stdout);
}
/** One gray frame at time t, scaled to w x h, as bytes (row-major). */
export function grayFrame(file: string, t: number, w: number, h: number): Uint8Array {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
    return new Uint8Array(r.stdout);
}

// ---- minimal big-endian EXIF ------------------------------------------------------------------------------------
interface Ent {
    tag: number;
    type: 2 | 3 | 4 | 5; // ASCII, SHORT, LONG, RATIONAL
    vals: string | number[] | [number, number][];
}
const SIZE: Record<number, number> = { 2: 1, 3: 2, 4: 4, 5: 8 };
function count(e: Ent): number {
    return typeof e.vals === 'string' ? Buffer.byteLength(e.vals) + 1 : e.vals.length;
}
function payload(e: Ent): Buffer {
    if (typeof e.vals === 'string') return Buffer.concat([Buffer.from(e.vals, 'latin1'), Buffer.from([0])]);
    const out = Buffer.alloc(count(e) * SIZE[e.type]);
    (e.vals as any[]).forEach((v, i) => {
        if (e.type === 3) out.writeUInt16BE(v, i * 2);
        else if (e.type === 4) out.writeUInt32BE(v, i * 4);
        else {
            out.writeUInt32BE(v[0], i * 8);
            out.writeUInt32BE(v[1], i * 8 + 4);
        }
    });
    return out;
}
const even = (n: number) => n + (n % 2);
function ifdSize(es: Ent[]): number {
    return 2 + 12 * es.length + 4 + es.reduce((n, e) => n + (payload(e).length > 4 ? even(payload(e).length) : 0), 0);
}
function writeIfd(es: Ent[], at: number): Buffer {
    es = [...es].sort((a, b) => a.tag - b.tag);
    const table = Buffer.alloc(2 + 12 * es.length + 4);
    table.writeUInt16BE(es.length, 0);
    const extra: Buffer[] = [];
    let dataAt = at + table.length;
    es.forEach((e, i) => {
        const p = payload(e);
        const o = 2 + 12 * i;
        table.writeUInt16BE(e.tag, o);
        table.writeUInt16BE(e.type, o + 2);
        table.writeUInt32BE(count(e), o + 4);
        if (p.length <= 4) p.copy(table, o + 8);
        else {
            table.writeUInt32BE(dataAt, o + 8);
            const padded = p.length % 2 ? Buffer.concat([p, Buffer.from([0])]) : p;
            extra.push(padded);
            dataAt += padded.length;
        }
    });
    return Buffer.concat([table, ...extra]);
}
const dms = (deg: number): [number, number][] => {
    const d = Math.floor(deg);
    const m = Math.floor((deg - d) * 60);
    const s = Math.round(((deg - d) * 60 - m) * 60 * 100);
    return [[d, 1], [m, 1], [s, 100]];
};
export interface ExifSpec {
    orientation?: number;
    date?: string; // "YYYY:MM:DD HH:MM:SS"
    gps?: { lat: number; lon: number };
}
export function buildExif(spec: ExifSpec): Buffer {
    const gps: Ent[] = spec.gps
        ? [
              { tag: 1, type: 2, vals: spec.gps.lat >= 0 ? 'N' : 'S' },
              { tag: 2, type: 5, vals: dms(Math.abs(spec.gps.lat)) },
              { tag: 3, type: 2, vals: spec.gps.lon >= 0 ? 'E' : 'W' },
              { tag: 4, type: 5, vals: dms(Math.abs(spec.gps.lon)) },
          ]
        : [];
    const exif: Ent[] = spec.date ? [{ tag: 0x9003, type: 2, vals: spec.date }] : [];
    const ifd0: Ent[] = [];
    if (spec.orientation) ifd0.push({ tag: 0x0112, type: 3, vals: [spec.orientation] });
    if (exif.length) ifd0.push({ tag: 0x8769, type: 4, vals: [0] });
    if (gps.length) ifd0.push({ tag: 0x8825, type: 4, vals: [0] });
    const exifAt = 8 + ifdSize(ifd0);
    const gpsAt = exifAt + (exif.length ? ifdSize(exif) : 0);
    for (const e of ifd0) {
        if (e.tag === 0x8769) e.vals = [exifAt];
        if (e.tag === 0x8825) e.vals = [gpsAt];
    }
    const head = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8]);
    const tiff = Buffer.concat([head, writeIfd(ifd0, 8), exif.length ? writeIfd(exif, exifAt) : Buffer.alloc(0), gps.length ? writeIfd(gps, gpsAt) : Buffer.alloc(0)]);
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(body.length + 2);
    return Buffer.concat([Buffer.from([0xff, 0xe1]), len, body]);
}
/** Generate a JPEG with lavfi and insert an EXIF APP1 right after SOI. */
export function makeJpeg(file: string, opts: { size?: string; filter?: string; exif?: ExifSpec } = {}): void {
    ff(['-f', 'lavfi', '-i', `testsrc2=s=${opts.size ?? '320x180'}:d=1`, ...(opts.filter ? ['-vf', opts.filter] : []), '-frames:v', '1', '-update', '1', '-q:v', '3', file]);
    if (!opts.exif) return;
    const jpg = readFileSync(file);
    // drop an existing JFIF APP0 so the EXIF segment comes first
    let at = 2;
    if (jpg[2] === 0xff && jpg[3] === 0xe0) at = 4 + jpg.readUInt16BE(4);
    writeFileSync(file, Buffer.concat([jpg.subarray(0, 2), buildExif(opts.exif), jpg.subarray(at)]));
}

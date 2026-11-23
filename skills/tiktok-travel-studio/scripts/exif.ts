/** Minimal EXIF reader for JPEG files: orientation, capture date and GPS. Never throws; missing data is null. */
import { open } from 'node:fs/promises';

export interface Exif {
    orientation: number | null;
    /** Local capture time as `YYYY-MM-DDTHH:MM:SS` (EXIF has no time zone). */
    date: string | null;
    gps: { lat: number; lon: number } | null;
}

const EMPTY = (): Exif => ({ orientation: null, date: null, gps: null });

/** Parses one APP1 segment (with or without the leading FFE1 + length) or a bare "Exif\0\0" + TIFF block. */
export function parseExif(seg: Buffer): Exif {
    try {
        return parse(seg);
    } catch {
        return EMPTY();
    }
}

function parse(seg: Buffer): Exif {
    let at = 0;
    if (seg.length > 4 && seg[0] === 0xff && seg[1] === 0xe1) at = 4;
    if (seg.subarray(at, at + 6).toString('latin1') !== 'Exif\0\0') return EMPTY();
    const t = seg.subarray(at + 6);
    if (t.length < 8) return EMPTY();
    const le = t.toString('latin1', 0, 2) === 'II';
    if (!le && t.toString('latin1', 0, 2) !== 'MM') return EMPTY();
    const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
    const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    const sizeOf: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    interface Entry {
        type: number;
        count: number;
        valueAt: number;
    }
    const readIfd = (off: number): Map<number, Entry> => {
        const m = new Map<number, Entry>();
        if (off + 2 > t.length) return m;
        const n = Math.min(u16(off), 256);
        for (let i = 0; i < n; i++) {
            const o = off + 2 + i * 12;
            if (o + 12 > t.length) break;
            const type = u16(o + 2);
            const count = u32(o + 4);
            const bytes = (sizeOf[type] ?? 1) * count;
            m.set(u16(o), { type, count, valueAt: bytes <= 4 ? o + 8 : u32(o + 8) });
        }
        return m;
    };
    const ascii = (e: Entry | undefined) => (e ? t.toString('latin1', e.valueAt, e.valueAt + e.count).replace(/\0.*$/s, '') : null);
    const rationals = (e: Entry | undefined) => {
        if (!e || e.type !== 5) return null;
        const out: number[] = [];
        for (let i = 0; i < e.count; i++) {
            const den = u32(e.valueAt + i * 8 + 4);
            out.push(den ? u32(e.valueAt + i * 8) / den : NaN);
        }
        return out;
    };

    const ifd0 = readIfd(u32(4));
    const out = EMPTY();
    const o = ifd0.get(0x0112);
    if (o && o.type === 3) {
        const v = u16(o.valueAt);
        out.orientation = v >= 1 && v <= 8 ? v : null;
    }
    const exifPtr = ifd0.get(0x8769);
    const exifIfd = exifPtr ? readIfd(u32(exifPtr.valueAt)) : new Map<number, Entry>();
    const d = ascii(exifIfd.get(0x9003)) ?? ascii(exifIfd.get(0x9004)) ?? ascii(ifd0.get(0x0132));
    const m = d?.match(/^(\d{4}):(\d\d):(\d\d)[ T](\d\d):(\d\d):(\d\d)/);
    if (m && m[1] !== '0000') out.date = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    const gpsPtr = ifd0.get(0x8825);
    if (gpsPtr) {
        const g = readIfd(u32(gpsPtr.valueAt));
        const lat = rationals(g.get(2));
        const lon = rationals(g.get(4));
        const conv = (v: number[] | null) => (v && v.length === 3 && v.every(Number.isFinite) ? v[0] + v[1] / 60 + v[2] / 3600 : null);
        const la = conv(lat);
        const lo = conv(lon);
        if (la !== null && lo !== null) {
            out.gps = {
                lat: (ascii(g.get(1)) === 'S' ? -1 : 1) * la,
                lon: (ascii(g.get(3)) === 'W' ? -1 : 1) * lo,
            };
        }
    }
    return out;
}

/** Reads the first APP1 EXIF segment of a JPEG (only the first 256 KiB are looked at). */
export async function readJpegExif(file: string): Promise<Exif> {
    const fh = await open(file, 'r').catch(() => null);
    if (!fh) return EMPTY();
    try {
        const buf = Buffer.alloc(262144);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const b = buf.subarray(0, bytesRead);
        if (b[0] !== 0xff || b[1] !== 0xd8) return EMPTY();
        let i = 2;
        while (i + 4 < b.length && b[i] === 0xff) {
            const marker = b[i + 1];
            if (marker === 0xda || marker === 0xd9) break;
            const len = b.readUInt16BE(i + 2);
            if (marker === 0xe1) {
                const e = parseExif(b.subarray(i, i + 2 + len));
                if (e.orientation !== null || e.date || e.gps) return e;
            }
            i += 2 + len;
        }
        return EMPTY();
    } finally {
        await fh.close();
    }
}

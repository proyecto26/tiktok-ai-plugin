// tiktok-travel-studio: EXIF, probing (rotation, rate), scan -> library.json, trip grouping.
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseExif } from '../../skills/tiktok-travel-studio/scripts/exif.ts';
import { groupTrips } from '../../skills/tiktok-travel-studio/scripts/library.ts';
import { probeMedia, scanFolders } from '../../skills/tiktok-travel-studio/scripts/media.ts';
import { buildExif, ff, makeJpeg } from './travel-media.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'tt-travel-scan-'));
const p = (n: string) => path.join(dir, n);

beforeAll(() => {
    mkdirSync(p('paris'));
    mkdirSync(p('lisbon'));
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', 'creation_time=2026-05-01T10:00:00Z', '-metadata', 'location=+48.8584+002.2945/', p('paris/land.mp4')]);
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('raw.mp4')]);
    ff(['-display_rotation', '90', '-i', p('raw.mp4'), '-c', 'copy', '-metadata', 'creation_time=2026-05-02T09:00:00Z', p('paris/phone.mp4')]);
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-vf', "select='lt(n,20)+not(mod(n,4))'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('paris/vfr.mp4')]);
    makeJpeg(p('paris/a.jpg'), { exif: { date: '2026:05:01 12:30:00', gps: { lat: 48.8584, lon: 2.2945 } } });
    makeJpeg(p('paris/b.jpg'), { exif: { orientation: 6, date: '2026:05:02 08:00:00' } });
    makeJpeg(p('lisbon/c.jpg'), { exif: { date: '2026:08:10 15:00:00', gps: { lat: 38.7223, lon: -9.1393 } } });
    makeJpeg(p('lisbon/nodate.jpg'));
    writeFileSync(p('lisbon/notes.txt'), 'not media');
});

describe('exif', () => {
    test('reads orientation, date and GPS from a minimal segment', () => {
        const seg = buildExif({ orientation: 6, date: '2026:05:01 12:30:00', gps: { lat: 48.8584, lon: -2.2945 } });
        const e = parseExif(seg);
        expect(e.orientation).toBe(6);
        expect(e.date).toBe('2026-05-01T12:30:00');
        expect(e.gps!.lat).toBeCloseTo(48.8584, 3);
        expect(e.gps!.lon).toBeCloseTo(-2.2945, 3);
    });
    test('no EXIF -> nulls, never throws', () => {
        expect(parseExif(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toEqual({ orientation: null, date: null, gps: null });
        expect(parseExif(Buffer.alloc(0)).gps).toBeNull();
    });
});

describe('probeMedia', () => {
    test('landscape video: date and GPS from container tags', async () => {
        const m = await probeMedia(p('paris/land.mp4'));
        expect(m.kind).toBe('video');
        expect([m.width, m.height]).toEqual([320, 180]);
        expect(m.orientation).toBe('landscape');
        expect(m.rotation).toBe(0);
        expect(m.duration).toBeCloseTo(2, 0);
        expect(m.taken_at).toBe('2026-05-01T10:00:00Z');
        expect(m.date_source).toBe('container');
        expect(m.gps!.lat).toBeCloseTo(48.8584, 3);
        expect(m.variable_rate).toBe(false);
    });
    test('phone video stored landscape with rotation metadata is portrait in displayed size', async () => {
        const m = await probeMedia(p('paris/phone.mp4'));
        expect(m.rotation).toBe(90);
        expect([m.width, m.height]).toEqual([180, 320]);
        expect([m.stored_width, m.stored_height]).toEqual([320, 180]);
        expect(m.orientation).toBe('portrait');
    });
    test('variable frame rate is detected', async () => {
        expect((await probeMedia(p('paris/vfr.mp4'))).variable_rate).toBe(true);
    });
    test('photo: EXIF date, GPS; orientation 6 swaps the displayed size', async () => {
        const a = await probeMedia(p('paris/a.jpg'));
        expect(a.kind).toBe('photo');
        expect(a.taken_at).toBe('2026-05-01T12:30:00');
        expect(a.date_source).toBe('exif');
        expect(a.gps!.lon).toBeCloseTo(2.2945, 3);
        expect(a.duration).toBeNull();
        const b = await probeMedia(p('paris/b.jpg'));
        expect([b.width, b.height]).toEqual([180, 320]);
        expect(b.rotation).toBe(90);
        expect(b.orientation).toBe('portrait');
    });
    test('no EXIF: falls back to the file time and says so', async () => {
        const m = await probeMedia(p('lisbon/nodate.jpg'));
        expect(m.date_source).toBe('mtime');
        expect(m.taken_at).toMatch(/^\d{4}-\d\d-\d\dT/);
        expect(m.gps).toBeNull();
    });
});

describe('scan', () => {
    test('walks folders, skips non-media, records skipped files', async () => {
        const r = await scanFolders([dir]);
        const names = r.items.map((i) => path.basename(i.path)).sort();
        expect(names).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'land.mp4', 'nodate.jpg', 'phone.mp4', 'raw.mp4', 'vfr.mp4']);
        expect(r.skipped.some((s) => s.path.endsWith('notes.txt'))).toBe(true);
        expect(new Set(r.items.map((i) => i.id)).size).toBe(r.items.length);
    });
    test('a missing folder is an error with a code', async () => {
        await expect(scanFolders([p('nope')])).rejects.toMatchObject({ code: 'folder_not_found' });
    });
});

describe('groupTrips', () => {
    const it = (id: string, t: string | null, gps: [number, number] | null) => ({ id, taken_at: t, gps: gps ? { lat: gps[0], lon: gps[1] } : null, kind: 'photo' as const });
    test('splits on a date gap', () => {
        const trips = groupTrips([it('1', '2026-05-01T10:00:00', null), it('2', '2026-05-02T09:00:00', null), it('3', '2026-08-10T10:00:00', null)] as any);
        expect(trips.map((t) => t.items)).toEqual([['1', '2'], ['3']]);
        expect(trips[0].start).toBe('2026-05-01T10:00:00');
    });
    test('splits on GPS distance even with a small time gap', () => {
        const trips = groupTrips([it('1', '2026-05-01T10:00:00', [48.85, 2.29]), it('2', '2026-05-01T14:00:00', [38.72, -9.14])] as any);
        expect(trips).toHaveLength(2);
        expect(trips[1].centre!.lat).toBeCloseTo(38.72, 1);
    });
    test('undated items go to their own group, never into a trip', () => {
        const trips = groupTrips([it('1', '2026-05-01T10:00:00', null), it('2', null, null)] as any);
        expect(trips.find((t) => t.undated)!.items).toEqual(['2']);
        expect(trips.filter((t) => !t.undated)).toHaveLength(1);
    });
    test('input order does not matter', () => {
        const trips = groupTrips([it('2', '2026-05-02T09:00:00', null), it('1', '2026-05-01T10:00:00', null)] as any);
        expect(trips[0].items).toEqual(['1', '2']);
    });
});

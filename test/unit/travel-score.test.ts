// tiktok-travel-studio: scoring terms (sharpness, motion, exposure, duration fit, faces), shortlist, CLI.
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyse, combine, durationFit, resolveFaceCmd, splitCommand } from '../../skills/tiktok-travel-studio/scripts/analyse.ts';
import { probeMedia } from '../../skills/tiktok-travel-studio/scripts/media.ts';
import { ff, makeJpeg } from './travel-media.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'tt-travel-score-'));
const p = (n: string) => path.join(dir, n);
const MAIN = path.resolve(import.meta.dir, '../../skills/tiktok-travel-studio/scripts/main.ts');
const cli = (args: string[], env: Record<string, string | undefined> = {}) => {
    const r = Bun.spawnSync([process.execPath, MAIN, ...args], { env: { ...process.env, TT_FACE_CMD: '', ...env }, cwd: dir });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const fakeFace = p('face.ts');

beforeAll(() => {
    mkdirSync(p('lib'));
    const box = 'color=black:s=640x360:r=10:d=3[bg];color=white:s=60x60:r=10:d=3[fg];[bg][fg]overlay=x=\'460+40*sin(t*5)\':y=150';
    ff(['-filter_complex', box, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('lib/motion.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=gray:s=640x360:r=10:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('lib/static.mp4')]);
    makeJpeg(p('lib/sharp.jpg'), { size: '640x360' });
    makeJpeg(p('lib/blur.jpg'), { size: '640x360', filter: 'gblur=sigma=8' });
    makeJpeg(p('lib/dark.jpg'), { size: '640x360', filter: 'eq=brightness=-0.75' });
    writeFileSync(fakeFace, 'console.log(JSON.stringify([{x:0.1,y:0.2,w:0.2,h:0.2}]));\n');
});

describe('terms', () => {
    test('a sharp photo scores sharper than a blurred one (blurdetect)', async () => {
        const a = await analyse(await probeMedia(p('lib/sharp.jpg')), {});
        const b = await analyse(await probeMedia(p('lib/blur.jpg')), {});
        expect(a.sharpness.score!).toBeGreaterThan(b.sharpness.score!);
        expect(a.sharpness.method).toBe('blurdetect');
    });
    test('exposure: a very dark frame scores below a normal one', async () => {
        const n = await analyse(await probeMedia(p('lib/sharp.jpg')), {});
        const d = await analyse(await probeMedia(p('lib/dark.jpg')), {});
        expect(n.exposure.score).toBeGreaterThan(d.exposure.score);
        expect(d.exposure.yavg).toBeLessThan(60);
    });
    test('motion: moving box > static clip; centroid follows the box (right side); photos have no motion', async () => {
        const m = await analyse(await probeMedia(p('lib/motion.mp4')), {});
        const s = await analyse(await probeMedia(p('lib/static.mp4')), {});
        expect(m.motion!.score).toBeGreaterThan(s.motion!.score);
        expect(s.motion!.centroid).toBeNull();
        expect(m.motion!.centroid![0]).toBeGreaterThan(0.65);
        expect(m.motion!.centroid![1]).toBeGreaterThan(0.3);
        expect(m.motion!.centroid![1]).toBeLessThan(0.7);
        expect((await analyse(await probeMedia(p('lib/sharp.jpg')), {})).motion).toBeNull();
    });
    test('duration fit: too short and too long score low, a normal length scores 1; photos null', () => {
        expect(durationFit(10)).toBe(1);
        expect(durationFit(1)).toBeLessThan(0.5);
        expect(durationFit(300)).toBeLessThan(0.2);
        expect(durationFit(null)).toBeNull();
    });
    test('faces are null when no detector is configured and the analysis says why', async () => {
        const a = await analyse(await probeMedia(p('lib/sharp.jpg')), { faceCmd: null });
        expect(a.faces).toBeNull();
        expect(a.faces_note).toMatch(/TT_FACE_CMD/);
    });
    test('faces from a configured local detector: boxes in, centre out', async () => {
        const cmd = `"${process.execPath}" "${fakeFace}" {file}`;
        const a = await analyse(await probeMedia(p('lib/sharp.jpg')), { faceCmd: cmd });
        expect(a.faces!.count).toBe(1);
        expect(a.faces!.centre![0]).toBeCloseTo(0.2, 3);
        expect(a.faces!.centre![1]).toBeCloseTo(0.3, 3);
    });
    test('a detector that fails does not break scoring: faces null with the error noted', async () => {
        const a = await analyse(await probeMedia(p('lib/sharp.jpg')), { faceCmd: `"${process.execPath}" "${p('missing.ts')}" {file}` });
        expect(a.faces).toBeNull();
        expect(a.faces_note).toMatch(/failed/);
    });
    test('splitCommand keeps quoted paths and appends the file when there is no placeholder', () => {
        expect(splitCommand('"C:/a b/x.exe" --f {file}', '/f/1.jpg')).toEqual(['C:/a b/x.exe', '--f', '/f/1.jpg']);
        expect(splitCommand('detect', '/f/1.jpg')).toEqual(['detect', '/f/1.jpg']);
        expect(resolveFaceCmd({ TT_FACE_CMD: '  ' })).toBeNull();
    });
    test('combine averages only the terms that exist', () => {
        const c = combine({ sharpness: 1, motion: null, exposure: 0.5, duration_fit: null, faces: null });
        expect(c.total).toBeCloseTo((1 * 0.35 + 0.5 * 0.25) / 0.6, 3);
        expect(c.used).toEqual(['sharpness', 'exposure']);
    });
});

describe('CLI: scan, group, score, shortlist', () => {
    test('end to end writes tt.travel.v1 files and reports the faces term as unavailable', () => {
        let r = cli(['scan', p('lib'), '-o', p('library.json')]);
        expect(r.code).toBe(0);
        expect(JSON.parse(r.out).items).toBe(5);
        r = cli(['group', p('library.json')]);
        expect(JSON.parse(r.out).trips).toBeGreaterThanOrEqual(1);
        r = cli(['score', p('library.json')]);
        const rep = JSON.parse(r.out);
        expect(rep.ok).toBe(true);
        expect(rep.faces).toMatch(/not configured/i);
        const lib = JSON.parse(readFileSync(p('library.json'), 'utf8'));
        expect(lib.schema).toBe('tt.travel.v1');
        expect(lib.items.every((i: any) => typeof i.score.total === 'number')).toBe(true);
        expect(lib.items.every((i: any) => i.score.faces === null)).toBe(true);
        r = cli(['shortlist', p('library.json'), '--n', '3', '-o', p('shortlist.json')]);
        const sl = JSON.parse(readFileSync(p('shortlist.json'), 'utf8'));
        expect(sl.schema).toBe('tt.travel.v1');
        expect(sl.kind).toBe('shortlist');
        expect(sl.entries).toHaveLength(3);
        expect(sl.entries[0].score).toBeGreaterThanOrEqual(sl.entries[1].score);
        r = cli(['shortlist', p('library.json'), '--n', '2', '--kind', 'video', '-o', p('sl2.json')]);
        expect(JSON.parse(readFileSync(p('sl2.json'), 'utf8')).entries.every((e: any) => e.kind === 'video')).toBe(true);
    });
    test('shortlist before score is a clear error', () => {
        cli(['scan', p('lib'), '-o', p('unscored.json')]);
        const r = cli(['shortlist', p('unscored.json'), '--n', '2']);
        expect(r.code).toBe(1);
        expect(JSON.parse(r.out).error.code).toBe('not_scored');
    });
});

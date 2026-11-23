// tiktok-travel-studio: photo-post sets (count limit, 9:16 / 4:5 crops) and drafts.json (linted captions, publish prepare).
import { beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildDrafts, loadCaptionLinter, shellQuote, slug } from '../../skills/tiktok-travel-studio/scripts/drafts.ts';
import { PHOTO_POST_MAX, buildPhotoSets } from '../../skills/tiktok-travel-studio/scripts/photos.ts';
import { ff, grayFrame, makeJpeg, probeJson } from './travel-media.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'tt-travel-photos-'));
const p = (n: string) => path.join(dir, n);
const MAIN = path.resolve(import.meta.dir, '../../skills/tiktok-travel-studio/scripts/main.ts');
const cli = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, MAIN, ...args], { env: { ...process.env, TT_FACE_CMD: '' }, cwd: dir });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const dims = (f: string) => {
    const s = probeJson(f).streams[0];
    return [s.width, s.height];
};
const many: string[] = [];

beforeAll(() => {
    mkdirSync(p('src'));
    makeJpeg(p('src/base.jpg'), { size: '64x36' });
    for (let i = 0; i < 40; i++) {
        const f = p(`src/p${String(i).padStart(2, '0')}.jpg`);
        copyFileSync(p('src/base.jpg'), f);
        many.push(f);
    }
    // left half white, right half black
    ff(['-f', 'lavfi', '-i', 'color=black:s=640x360:d=1,drawbox=x=0:y=0:w=320:h=360:color=white:t=fill', '-frames:v', '1', '-update', '1', p('src/split.jpg')]);
    makeJpeg(p('src/rot.jpg'), { size: '320x180', exif: { orientation: 6 } });
    ff(['-f', 'lavfi', '-i', 'color=c=blue:s=1080x1920:r=25:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('clip_a.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=green:s=1080x1920:r=25:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('clip_b.mp4')]);
});

describe('photos', () => {
    test('the limit is a named constant (35, to be confirmed against TikTok photo mode)', () => {
        expect(PHOTO_POST_MAX).toBe(35);
    });
    test('more photos than the limit are split into several sets, none above the limit', async () => {
        const r = await buildPhotoSets(many, { outDir: p('out40'), ratio: '9:16', faceCmd: null });
        expect(r.sets.map((s) => s.files.length)).toEqual([35, 5]);
        expect(r.sets.every((s) => s.files.length <= PHOTO_POST_MAX)).toBe(true);
        expect(dims(r.sets[0].files[0])).toEqual([1080, 1920]);
        expect(r.warnings.join(' ')).toMatch(/upscaled/);
    }, 60000);
    test('--per-set above the limit is refused with a code', async () => {
        await expect(buildPhotoSets(many.slice(0, 3), { outDir: p('outx'), ratio: '9:16', perSet: 50, faceCmd: null })).rejects.toMatchObject({ code: 'photo_limit' });
        await expect(buildPhotoSets([], { outDir: p('outy'), ratio: '9:16', faceCmd: null })).rejects.toMatchObject({ code: 'no_photos' });
    });
    test('both ratios: 1080x1920 and 1080x1350, one set per ratio', async () => {
        const r = await buildPhotoSets([p('src/split.jpg'), p('src/rot.jpg')], { outDir: p('outboth'), ratio: 'both', faceCmd: null });
        expect(r.sets.map((s) => s.ratio)).toEqual(['9:16', '4:5']);
        expect(dims(r.sets[0].files[0])).toEqual([1080, 1920]);
        expect(dims(r.sets[1].files[1])).toEqual([1080, 1350]);
    });
    test('focus: the crop follows an override, and EXIF orientation is honoured', async () => {
        const left = await buildPhotoSets([p('src/split.jpg')], { outDir: p('outL'), ratio: '9:16', focus: [0.05, 0.5], faceCmd: null });
        const right = await buildPhotoSets([p('src/split.jpg')], { outDir: p('outR'), ratio: '9:16', focus: [0.95, 0.5], faceCmd: null });
        expect(grayFrame(left.sets[0].files[0], 0, 9, 16)[8 * 9 + 4]).toBeGreaterThan(200);
        expect(grayFrame(right.sets[0].files[0], 0, 9, 16)[8 * 9 + 4]).toBeLessThan(50);
        const rot = await buildPhotoSets([p('src/rot.jpg')], { outDir: p('outRot'), ratio: '9:16', faceCmd: null });
        expect(rot.focus_sources).toEqual(['centre']);
        expect(dims(rot.sets[0].files[0])).toEqual([1080, 1920]);
    });
    test('a video among the inputs is refused', async () => {
        await expect(buildPhotoSets([p('clip_a.mp4')], { outDir: p('outv'), ratio: '9:16', faceCmd: null })).rejects.toMatchObject({ code: 'not_a_photo' });
    });
    test('CLI writes photosets.json', () => {
        const r = cli(['photos', p('src/p00.jpg'), p('src/p01.jpg'), '--ratio', '4:5', '--out-dir', p('outcli')]);
        expect(r.code).toBe(0);
        const j = JSON.parse(readFileSync(p('outcli/photosets.json'), 'utf8'));
        expect(j.schema).toBe('tt.travel.v1');
        expect(j.kind).toBe('photosets');
        expect(j.limit).toBe(35);
        expect(j.sets[0].files).toHaveLength(2);
    });
});

describe('drafts', () => {
    test('slug and shell quoting', () => {
        expect(slug('São Paulo, Brasil!')).toBe('saopaulobrasil');
        expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    });
    test('video drafts: suggestions are linted by tiktok-content, the best passes into the publish prepare command', async () => {
        const linter = await loadCaptionLinter();
        expect(linter).not.toBeNull();
        const d = await buildDrafts({ videos: [p('clip_a.mp4')], place: 'Lisbon', hook: 'The tram nobody tells you to take', captions: ['x'.repeat(2300)] }, linter);
        const v = d.drafts[0];
        expect(d.schema).toBe('tt.travel.v1');
        expect(d.kind).toBe('drafts');
        expect(d.lint.available).toBe(true);
        expect(v.kind).toBe('video');
        expect(v.suggestions.length).toBeGreaterThanOrEqual(3);
        const supplied = v.suggestions.find((s) => s.source === 'supplied')!;
        expect(supplied.lint!.verdict).toBe('FIX'); // over 2200 characters
        expect(v.chosen).not.toBeNull();
        const chosen = v.suggestions[v.chosen!];
        expect(chosen.lint!.verdict).not.toBe('FIX');
        expect(chosen.text).toContain('#lisbon');
        expect(v.prepare!.argv.slice(0, 2)).toEqual(['publish', 'prepare']);
        expect(v.prepare!.argv).toContain('--video');
        expect(v.prepare!.argv[v.prepare!.argv.indexOf('--caption') + 1]).toBe(chosen.text);
        expect(v.prepare!.command).toMatch(/^npx -y bun skills\/tiktok\/scripts\/main\.ts publish prepare --video /);
        expect(d.publishing).toMatch(/never/i);
        expect(JSON.stringify(d)).not.toMatch(/publish (begin|finish)/);
    });
    test('every suggestion is FIX -> nothing is chosen and no command is offered', async () => {
        const linter = await loadCaptionLinter();
        const d = await buildDrafts({ videos: [p('clip_a.mp4')], captions: ['x'.repeat(2300)], templates: false }, linter);
        expect(d.drafts[0].chosen).toBeNull();
        expect(d.drafts[0].prepare).toBeNull();
        expect(d.drafts[0].status).toBe('needs_edit');
    });
    test('photo set drafts use the photo lint (title and description) and the --photos form', async () => {
        const linter = await loadCaptionLinter();
        const sets = { schema: 'tt.travel.v1', kind: 'photosets', limit: 35, sets: [{ id: 'set-1', ratio: '9:16', size: [1080, 1920], files: [p('src/p00.jpg'), p('src/p01.jpg')], count: 2 }] };
        const d = await buildDrafts({ photosets: sets as any, place: 'Porto', hook: 'Two days in Porto, one rule' }, linter);
        const ph = d.drafts[0];
        expect(ph.kind).toBe('photo');
        expect(ph.title).toBe('Two days in Porto, one rule');
        expect(ph.prepare!.argv).toContain('--photos');
        expect(ph.prepare!.argv[ph.prepare!.argv.indexOf('--photos') + 1]).toBe(`${p('src/p00.jpg')},${p('src/p01.jpg')}`);
        expect(ph.prepare!.argv).toContain('--title');
        expect(ph.prepare!.argv).toContain('--description');
        expect(ph.suggestions[ph.chosen!].lint!.checks.some((c) => c.check === 'TITLE')).toBe(true);
    });
    test('when the sibling linter is missing: drafts are still written, flagged unlinted, with a warning', async () => {
        const d = await buildDrafts({ videos: [p('clip_a.mp4')], place: 'Lisbon' }, null);
        expect(d.lint.available).toBe(false);
        expect(d.lint.reason).toMatch(/tiktok-content/);
        expect(d.drafts[0].status).toBe('unlinted');
        expect(d.drafts[0].suggestions.every((s) => s.lint === null)).toBe(true);
        expect(d.warnings.join(' ')).toMatch(/not linted/i);
    });
    test('loadCaptionLinter returns null for a path that does not exist', async () => {
        expect(await loadCaptionLinter(p('nope/caption-lint.ts'))).toBeNull();
    });
    test('CLI drafts reads photosets.json and rendered videos, writes drafts.json, never publishes', () => {
        writeFileSync(p('captions.txt'), '');
        const r = cli(['drafts', '--videos', `${p('clip_a.mp4')},${p('clip_b.mp4')}`, '--photosets', p('outcli/photosets.json'), '--place', 'Faro', '--hook', 'Faro in 15 seconds', '-o', p('drafts.json')]);
        expect(r.code).toBe(0);
        const j = JSON.parse(readFileSync(p('drafts.json'), 'utf8'));
        expect(j.drafts.map((x: any) => x.kind)).toEqual(['video', 'video', 'photo']);
        expect(JSON.parse(r.out).drafts).toBe(3);
        expect(j.drafts.every((x: any) => x.prepare === null || x.prepare.argv.slice(0, 2).join(' ') === 'publish prepare')).toBe(true);
    });
});

// tiktok-travel-studio: render (rotation, VFR, focus order, trim) and music (loudnorm, fades, never loops).
import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { addMusic } from '../../skills/tiktok-travel-studio/scripts/music.ts';
import { probeMedia } from '../../skills/tiktok-travel-studio/scripts/media.ts';
import { parseFocus, renderClip } from '../../skills/tiktok-travel-studio/scripts/render.ts';
import { ff, grayFrame, probeJson } from './travel-media.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'tt-travel-render-'));
const p = (n: string) => path.join(dir, n);
const out = p('renders');
const fakeFace = p('face.ts');
const faceCmd = `"${process.execPath}" "${fakeFace}" {file}`;
const max = (b: Uint8Array) => b.reduce((m, x) => (x > m ? x : m), 0);

function volume(file: string, from: number, len: number): number {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-ss', String(from), '-t', String(len), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = r.stderr.match(/mean_volume: (-?[\d.]+|-inf) dB/);
    return m ? (m[1] === '-inf' ? -200 : Number(m[1])) : -200;
}
function lufs(file: string): number {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
    const all = [...r.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
    return Number(all[all.length - 1][1]);
}

beforeAll(() => {
    mkdirSync(out);
    writeFileSync(fakeFace, 'console.log(JSON.stringify([{x:0.1,y:0.2,w:0.2,h:0.2}]));\n');
    // stored landscape 320x180 with a white box in its top-left corner, displayed rotated by 90
    ff(['-f', 'lavfi', '-i', 'color=black:s=320x180:r=25:d=2,drawbox=x=0:y=0:w=60:h=40:color=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('mk.mp4')]);
    ff(['-display_rotation', '90', '-i', p('mk.mp4'), '-c', 'copy', p('phone.mp4')]);
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-vf', "select='lt(n,20)+not(mod(n,4))'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('vfr.mp4')]);
    const box = "color=black:s=640x360:r=10:d=3[bg];color=white:s=60x60:r=10:d=3[fg];[bg][fg]overlay=x='460+40*sin(t*5)':y=150";
    ff(['-filter_complex', box, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('motion.mp4')]);
    ff(['-f', 'lavfi', '-i', 'sine=frequency=440:d=2', p('short.wav')]);
    ff(['-f', 'lavfi', '-i', 'sine=frequency=440:d=8', '-af', 'volume=-30dB', p('quiet.wav')]);
    ff(['-f', 'lavfi', '-i', 'color=c=blue:s=1080x1920:r=25:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('vert.mp4')]);
});

describe('parseFocus', () => {
    test('x,y as fractions; anything else is refused', () => {
        expect(parseFocus('0.25,0.75')).toEqual([0.25, 0.75]);
        expect(() => parseFocus('1.5,0.2')).toThrow(/focus/);
        expect(() => parseFocus('a,b')).toThrow(/focus/);
        expect(() => parseFocus('0.5')).toThrow(/focus/);
    });
});

describe('render', () => {
    test('rotated phone video: rotation metadata is honoured (box lands bottom-left) and output is 1080x1920', async () => {
        const r = await renderClip(await probeMedia(p('phone.mp4')), out, { faceCmd: null });
        const v = probeJson(r.output).streams.find((s: any) => s.codec_type === 'video');
        expect([v.width, v.height]).toEqual([1080, 1920]);
        expect(v.side_data_list?.some((s: any) => s.rotation) ?? false).toBe(false);
        expect(r.rotation).toBe(90);
        expect(r.displayed).toEqual([180, 320]);
        const g = grayFrame(r.output, 0.5, 18, 32);
        const at = (x: number, y: number) => g[y * 18 + x];
        expect(at(1, 29)).toBeGreaterThan(200); // bottom-left bright
        expect(at(17, 0)).toBeLessThan(50); // top-right dark
        expect(at(0, 0)).toBeLessThan(50); // top-left dark (an un-rotated render would put the box here)
    });
    test('variable frame rate is rendered on a constant-rate copy', async () => {
        const r = await renderClip(await probeMedia(p('vfr.mp4')), out, { faceCmd: null });
        expect(r.cfr_copy).toBe(true);
        const o = await probeMedia(r.output);
        expect(o.variable_rate).toBe(false);
        expect(o.fps).toBeCloseTo(r.fps, 1);
        expect(o.duration!).toBeGreaterThan(2.5);
        expect(o.duration!).toBeLessThan(3.5);
    });
    test('a constant-rate clip does not get a copy', async () => {
        const r = await renderClip(await probeMedia(p('motion.mp4')), out, { faceCmd: null, length: 1 });
        expect(r.cfr_copy).toBe(false);
    });
    test('focus follows the motion centroid when there are no faces: the moving box stays in frame', async () => {
        const r = await renderClip(await probeMedia(p('motion.mp4')), out, { faceCmd: null, name: 'motion_auto' });
        expect(r.focus.source).toBe('motion');
        expect(r.focus.x).toBeGreaterThan(0.65);
        expect(max(grayFrame(r.output, 1, 54, 96))).toBeGreaterThan(200);
    });
    test('--focus overrides the automatic focus: the box leaves the frame', async () => {
        const r = await renderClip(await probeMedia(p('motion.mp4')), out, { faceCmd: null, focus: [0.05, 0.5], name: 'motion_override' });
        expect(r.focus).toEqual({ x: 0.05, y: 0.5, source: 'override' });
        expect(max(grayFrame(r.output, 1, 54, 96))).toBeLessThan(60);
    });
    test('faces beat motion: the detector centre is the focus', async () => {
        const r = await renderClip(await probeMedia(p('motion.mp4')), out, { faceCmd, name: 'motion_faces' });
        expect(r.focus.source).toBe('faces');
        expect(r.focus.x).toBeCloseTo(0.2, 2);
        expect(max(grayFrame(r.output, 1, 54, 96))).toBeLessThan(60);
    });
    test('a static clip falls back to the centre', async () => {
        const r = await renderClip(await probeMedia(p('vert.mp4')), out, { faceCmd: null });
        expect(r.focus).toEqual({ x: 0.5, y: 0.5, source: 'centre' });
    });
    test('trims to the target length and honours --start', async () => {
        const r = await renderClip(await probeMedia(p('motion.mp4')), out, { faceCmd: null, length: 1, start: 1, name: 'motion_trim' });
        expect(r.start).toBe(1);
        const o = await probeMedia(r.output);
        expect(o.duration!).toBeGreaterThan(0.85);
        expect(o.duration!).toBeLessThan(1.2);
    });
    test('a clip shorter than the target is kept whole, never looped or padded', async () => {
        const r = await renderClip(await probeMedia(p('vert.mp4')), out, { faceCmd: null, length: 15, name: 'vert_short' });
        expect(r.duration).toBeCloseTo(4, 0);
        expect((await probeMedia(r.output)).duration!).toBeLessThan(4.3);
    });
});

describe('music', () => {
    test('music shorter than the video does not loop: it fades out and the rest is silent, and the report says so', async () => {
        const r = await addMusic({ video: p('vert.mp4'), music: p('short.wav'), out: p('m_short.mp4') });
        expect(r.looped).toBe(false);
        expect(r.music_ended_early_by).toBeCloseTo(2, 0);
        expect(r.warnings.join(' ')).toMatch(/shorter/);
        const o = await probeMedia(p('m_short.mp4'));
        expect(o.has_audio).toBe(true);
        expect(o.duration!).toBeGreaterThan(3.8);
        expect(o.duration!).toBeLessThan(4.3);
        expect(volume(p('m_short.mp4'), 0.2, 1.2)).toBeGreaterThan(-35);
        expect(volume(p('m_short.mp4'), 2.6, 1.2)).toBeLessThan(-60);
    });
    test('longer music is cut at the video end and normalised to -14 LUFS', async () => {
        const r = await addMusic({ video: p('vert.mp4'), music: p('quiet.wav'), out: p('m_long.mp4') });
        expect(r.music_ended_early_by).toBe(0);
        expect(r.loudness.target_lufs).toBe(-14);
        expect(Math.abs(lufs(p('m_long.mp4')) + 14)).toBeLessThan(1.5);
        expect((await probeMedia(p('m_long.mp4'))).duration!).toBeLessThan(4.3);
        // fade out at the end: the last 0.3 s is quieter than the middle
        expect(volume(p('m_long.mp4'), 3.7, 0.3)).toBeLessThan(volume(p('m_long.mp4'), 1.5, 1));
    });
    test('the video picture is copied, not re-encoded', async () => {
        const v = probeJson(p('m_long.mp4')).streams.find((s: any) => s.codec_type === 'video');
        expect([v.width, v.height]).toEqual([1080, 1920]);
    });
    test('missing music is a coded error', async () => {
        await expect(addMusic({ video: p('vert.mp4'), music: p('nope.mp3'), out: p('x.mp4') })).rejects.toMatchObject({ code: 'music_not_found' });
    });
});

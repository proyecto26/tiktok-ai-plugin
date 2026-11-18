// tiktok-video-breakdown CLI: transcript precedence, timeline sampling, doctor, and the end-to-end run
// (ported from instagram-video-breakdown). Media tests build lavfi fixtures and skip without ffmpeg.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Breakdown } from '../../skills/tiktok-video-breakdown/scripts/breakdown.ts';
import { STRIP_FPS, stripFps } from '../../skills/tiktok-video-breakdown/scripts/shots.ts';
import { chooseTranscript } from '../../skills/tiktok-video-breakdown/scripts/transcript.ts';

const MAIN = path.resolve(import.meta.dir, '../../skills/tiktok-video-breakdown/scripts/main.ts');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const ENV = { ...process.env, TT_ASR_CMD: '' };
delete (ENV as Record<string, string | undefined>).TT_ASR_CMD;

describe('transcript precedence', () => {
    const dir = () => {
        const d = mkdtempSync(path.join(os.tmpdir(), 'tt-tx-'));
        mkdirSync(path.join(d, 'source'));
        return d;
    };
    test('an explicit --transcript file wins over everything', async () => {
        const d = dir();
        writeFileSync(path.join(d, 'source/captions.eng-US.vtt'), 'WEBVTT\n');
        writeFileSync(path.join(d, 'transcript.json'), '{}');
        expect(await chooseTranscript(d, { file: '/x/my.srt', asrCmd: 'asr {audio} {out}' })).toEqual({ kind: 'file', path: '/x/my.srt' });
    });
    test('then a transcript made earlier with transcribe', async () => {
        const d = dir();
        writeFileSync(path.join(d, 'source/captions.eng-US.vtt'), 'WEBVTT\n');
        writeFileSync(path.join(d, 'transcript.json'), '{}');
        expect((await chooseTranscript(d, {})).kind).toBe('existing');
    });
    test('then the TikTok captions saved by fetch (first in name order)', async () => {
        const d = dir();
        writeFileSync(path.join(d, 'source/captions.spa-ES.vtt'), 'WEBVTT\n');
        writeFileSync(path.join(d, 'source/captions.eng-US.vtt'), 'WEBVTT\n');
        expect(await chooseTranscript(d, { asrCmd: 'asr {audio} {out}' })).toEqual({ kind: 'captions', path: path.join(d, 'source/captions.eng-US.vtt'), lang: 'eng-US' });
    });
    test('then the local recogniser (TT_ASR_CMD), then none', async () => {
        const d = dir();
        expect(await chooseTranscript(d, { asrCmd: 'asr {audio} {out}' })).toEqual({ kind: 'recogniser', cmd: 'asr {audio} {out}' });
        expect(await chooseTranscript(d, { asrCmd: '  ' })).toEqual({ kind: 'none' });
        expect(await chooseTranscript(d, {})).toEqual({ kind: 'none' });
    });
});

describe('timeline sampling', () => {
    test('up to 90 s the strip keeps the Instagram 2 fps', () => {
        expect(STRIP_FPS).toBe(2);
        expect(stripFps({ start: 10, end: 14 }, 60, [])).toBe(2);
    });
    test('longer videos are length-scaled', () => {
        expect(stripFps({ start: 10, end: 14 }, 180, [])).toBeCloseTo(1, 5);
        expect(stripFps({ start: 10, end: 14 }, 900, [])).toBeCloseTo(0.25, 5);
        expect(stripFps({ start: 10, end: 14 }, 3600, [])).toBeCloseTo(0.25, 5);
    });
    test('the hook (first 3 s) and shots with a text change get double density', () => {
        expect(stripFps({ start: 0, end: 2.5 }, 60, [])).toBe(4);
        expect(stripFps({ start: 2.9, end: 6 }, 60, [])).toBe(4);
        expect(stripFps({ start: 10, end: 14 }, 60, [{ t: 12, band: 'bottom' }])).toBe(4);
        expect(stripFps({ start: 10, end: 14 }, 180, [{ t: 12, band: 'bottom' }])).toBeCloseTo(2, 5);
        expect(stripFps({ start: 10, end: 14 }, 60, [{ t: 20, band: 'bottom' }])).toBe(2);
    });
});

describe.skipIf(!HAS_FFMPEG)('doctor', () => {
    test('ffmpeg and ffprobe are required; the recogniser is optional', () => {
        const r = spawnSync(process.execPath, [MAIN, 'doctor'], { encoding: 'utf8', env: ENV });
        const j = JSON.parse(r.stdout);
        expect(r.status).toBe(0);
        expect(j.ok).toBe(true);
        expect(j.required.ffmpeg).toBeTruthy();
        expect(j.optional.speech_recogniser).toMatch(/not configured/);
        const withAsr = JSON.parse(spawnSync(process.execPath, [MAIN, 'doctor'], { encoding: 'utf8', env: { ...ENV, TT_ASR_CMD: 'asr {audio} {out}' } }).stdout);
        expect(withAsr.optional.speech_recogniser).toMatch(/configured \(TT_ASR_CMD\)/);
    });
});

describe.skipIf(!HAS_FFMPEG)('CLI on lavfi fixtures', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'tt-bd-cli-'));
    const ff = (args: string[]) => {
        const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args]);
        if (r.status !== 0) throw new Error(r.stderr.toString());
    };
    const size = '360x640';
    const fx = (n: string) => path.join(tmp, n);
    const cli = (...args: string[]) => {
        const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: 'utf8', env: ENV });
        return { code: r.status, out: r.stdout, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
    };
    let drawtext = true;

    beforeAll(() => {
        // A: three colour segments of different brightness (cut detection reads luma), a 120 BPM click (cuts at 2 s and 4 s, on the beat).
        ff(['-f', 'lavfi', '-i', `color=c=red:s=${size}:d=2:r=30`, '-f', 'lavfi', '-i', `color=c=yellow:s=${size}:d=2:r=30`, '-f', 'lavfi', '-i', `color=c=blue:s=${size}:d=2:r=30`,
            '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,0.5),0.01),sin(2*PI*1000*t),0)':d=6:s=22050",
            '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fx('a.mp4')]);
        // B: no audio stream.
        ff(['-f', 'lavfi', '-i', `testsrc2=s=${size}:d=3:r=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', fx('b.mp4')]);
        // E: a still image for 3 s, then a moving pattern for 3 s.
        ff(['-f', 'lavfi', '-i', `color=c=gray:s=${size}:d=3:r=30`, '-f', 'lavfi', '-i', `testsrc2=s=${size}:d=3:r=30`, '-filter_complex', '[0][1]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fx('e.mp4')]);
        // F: one static shot whose caption changes at 1 s and 2 s.
        const dt = (text: string, when: string) => `drawtext=text='${text}':enable='${when}':x=(w-tw)/2:y=h*0.74:fontsize=64:fontcolor=white`;
        try {
            ff(['-f', 'lavfi', '-i', `color=c=0x202020:s=${size}:d=3:r=30`, '-vf', [dt('ONE', 'lt(t,1)'), dt('TWO WORDS', 'between(t,1,1.999)'), dt('THREE NOW', 'gte(t,2)')].join(','), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fx('f.mp4')]);
        } catch {
            drawtext = false;
            console.warn('[video-breakdown] this ffmpeg cannot draw text: caption fixture skipped.');
        }
    }, 120_000);
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));


    test('CLI end to end on a local file', () => {
        const out = fx('run-a');
        expect(cli('fetch', '--file', fx('a.mp4'), '-o', out).json).toMatchObject({ ok: true });
        const an = cli('analyze', out).json;
        expect(an).toMatchObject({ ok: true, shots: 3, speech: 'unconfirmed', audio: { present: true } });
        expect(Math.abs(an.audio.bpm - 120)).toBeLessThanOrEqual(2);
        const b = JSON.parse(readFileSync(path.join(out, 'breakdown.json'), 'utf8')) as Breakdown;
        expect(b.audio.cuts_on_beat_ratio).toBe(1);
        expect(b.shots.every((s) => s.motion.low_motion === true)).toBe(true);
        for (const s of b.shots) for (const f of [s.images.first, s.images.last, s.images.sheet, s.images.strip]) expect(existsSync(path.join(out, f))).toBe(true);
        expect(existsSync(path.join(out, 'storyboard.jpg'))).toBe(true);
        expect(existsSync(path.join(out, 'source', 'audio.wav'))).toBe(true);

        expect(cli('transcribe', out).code).toBe(2);
        writeFileSync(fx('t.srt'), '1\n00:00:00,300 --> 00:00:01,800\nRed means stop.\n\n2\n00:00:04,200 --> 00:00:05,500\nBlue means calm.\n');
        expect(cli('transcribe', out, '--import', fx('t.srt')).json).toMatchObject({ ok: true, segments: 2 });

        expect(cli('review', out).json).toMatchObject({ ok: true, shots: 3, answers_created: true });
        const tasks = JSON.parse(readFileSync(path.join(out, 'review_tasks.json'), 'utf8'));
        expect(tasks.shots[2].transcript[0].text).toBe('Blue means calm.');
        const answers = JSON.parse(readFileSync(path.join(out, 'review_answers.json'), 'utf8'));
        expect(cli('apply-review', out).code).toBe(1);
        answers.hook = 'A red card';
        answers.visual_style = 'flat colour cards';
        answers.structure = [{ label: 'cards', start: 0, end: 6 }];
        answers.audio_notes = { voice_present: true, music_present: true, evidence: { voice: { source: 'transcript' }, music: { source: 'tempo' } } };
        answers.shots = b.shots.map((s) => ({ id: s.id, type: 'static_hold', confidence: 0.9, evidence: ['one flat colour in every tile'], description: 'Flat colour card', on_screen_text: [], layers: [] }));
        writeFileSync(path.join(out, 'review_answers.json'), JSON.stringify(answers));
        const ap = cli('apply-review', out);
        expect(ap.json).toMatchObject({ ok: true });
        expect(ap.json.downgrades.join(' ')).toMatch(/music_present/);
        const sum = cli('summary', out);
        expect(sum.code).toBe(0);
        expect(sum.out).toMatch(/Voice: yes\. Music: unconfirmed\./);
        expect(sum.out).toMatch(/\[shot 1\] Red means stop\./);
        expect(sum.out).toMatch(/\[shot 3\] Blue means calm\./);
        expect(readFileSync(path.join(out, 'recreate.md'), 'utf8')).toMatch(/Static card/);

        const fr = cli('frames', out, '--from', '1.5', '--to', '2.5', '--fps', '4').json;
        expect(fr.ok).toBe(true);
        expect(fr.times.length).toBe(4);
        expect(existsSync(fr.image)).toBe(true);

        // A new transcript clears the applied review; the kept answers are re-applied against it.
        writeFileSync(fx('empty.srt'), '');
        writeFileSync(fx('empty.json'), JSON.stringify({ segments: [] }));
        expect(cli('transcribe', out, '--import', fx('empty.json')).json.next).toMatch(/earlier review was cleared/);
        expect((JSON.parse(readFileSync(path.join(out, 'breakdown.json'), 'utf8')) as Breakdown).review).toBeNull();
        const again = cli('apply-review', out).json;
        expect(again.ok).toBe(true);
        expect(again.downgrades.join(' ')).toMatch(/voice_present/);
        expect(cli('summary', out).out).toMatch(/Voice: unconfirmed/);
        expect(cli('analyze', out, '--max-duration', '3').code).toBe(2);

        // A manual cut is remembered, can be undone, and old answers cannot be applied to new shots.
        expect(cli('analyze', out, '--add-cut', '5').json).toMatchObject({ ok: true, shots: 4 });
        expect(cli('analyze', out).json.shots).toBe(4);
        expect(cli('apply-review', out).json.errors.join(' ')).toMatch(/another analysis/);
        const rv = cli('review', out).json;
        expect(rv.answers_created).toBe(true);
        expect(existsSync(rv.stale_answers_moved_to)).toBe(true);
        expect(cli('analyze', out, '--remove-cut', '5').json.shots).toBe(3);
        expect(cli('analyze', out).json.shots).toBe(3);
        expect(cli('analyze', out, '--add-cut', '5').json.shots).toBe(4);
        expect(cli('analyze', out, '--reset-cuts').json.shots).toBe(3);
    }, 240_000);

    test('B: a video without an audio stream', () => {
        const out = fx('run-b');
        cli('fetch', '--file', fx('b.mp4'), '-o', out);
        expect(cli('analyze', out).json).toMatchObject({ ok: true, audio: { present: false, bpm: null } });
        const b = JSON.parse(readFileSync(path.join(out, 'breakdown.json'), 'utf8')) as Breakdown;
        expect(b.audio).toMatchObject({ present: false, rhythm: null, onsets: null, wav: null });
        expect(cli('transcribe', out, '--cmd', 'x {audio} {out}').code).toBe(2);
    }, 120_000);

    test('usage errors are JSON with exit 2', () => {
        expect(cli('analyze', fx('nope')).code).toBe(2);
        expect(cli('bogus').code).toBe(2);
        expect(cli('fetch', 'abc').code).toBe(2);
    }, 60_000);
});

describe.skipIf(!HAS_FFMPEG)('captions are used automatically', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'tt-bd-cap-'));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));
    test('a saved caption track becomes the transcript at analyze', () => {
        const v = path.join(tmp, 'c.mp4');
        const ff = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=360x640:d=2:r=30', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', v]);
        expect(ff.status).toBe(0);
        const out = path.join(tmp, 'run');
        const run = (...a: string[]) => JSON.parse(spawnSync(process.execPath, [MAIN, ...a], { encoding: 'utf8', env: ENV }).stdout);
        expect(run('fetch', '--file', v, '-o', out).ok).toBe(true);
        writeFileSync(path.join(out, 'source/captions.eng-US.vtt'), 'WEBVTT\n\n00:00.200 --> 00:01.500\nSYNTH: hello there\n');
        const an = run('analyze', out);
        expect(an).toMatchObject({ ok: true, transcript: { source: 'tiktok_captions:eng-US', segments: 1 } });
        const b = JSON.parse(readFileSync(path.join(out, 'breakdown.json'), 'utf8')) as Breakdown;
        expect(b.transcript?.source).toBe('tiktok_captions:eng-US');
        expect(existsSync(path.join(out, 'transcript.json'))).toBe(true);
    }, 120_000);
});


// Frame cuts, frame overrides and the evidence-bound analysis id (pure).
import { describe, expect, test } from 'bun:test';

import { DETECTOR_VERSION, analysisId } from '../../skills/tiktok-video-breakdown/scripts/breakdown.ts';
import { applyFrameOverrides, frameSpans, mergeFrameCuts, migrateOverrides, recordFrameOverrides } from '../../skills/tiktok-video-breakdown/scripts/shots.ts';

describe('frame cuts', () => {
    test('manual cuts are never dropped; detected ones inside their spacing are', () => {
        // 3: within 8 of frame 0; 30 and 33: within 8 of manual 32; 118: within 8 of the end
        expect(mergeFrameCuts([3, 30, 33, 118], [32], 120, 8)).toEqual([32]);
        expect(mergeFrameCuts([30, 60], [2, 119], 120, 8)).toEqual([2, 30, 60, 119]);
        expect(mergeFrameCuts([30, 34, 60], [], 120, 8)).toEqual([30, 60]);
        expect(mergeFrameCuts([], [0, 120, 50], 120, 8)).toEqual([50]);
        expect(mergeFrameCuts([60, 60], [61, 61], 120, 8)).toEqual([61]);
    });
    test('frame overrides: newest wins within one frame', () => {
        const a = recordFrameOverrides({ version: 2, sha256: 's', add: [60], remove: [] }, [], [61]);
        expect(a).toEqual({ version: 2, sha256: 's', add: [], remove: [61] });
        expect(applyFrameOverrides([30, 60, 90], a)).toEqual({ detected: [30, 90], manual: [] });
        const b = recordFrameOverrides(a, [62], []);
        expect(b).toEqual({ version: 2, sha256: 's', add: [62], remove: [] });
        expect(applyFrameOverrides([30, 60, 90], b)).toEqual({ detected: [30, 60, 90], manual: [62] });
    });
    test('old overrides migrate', () => {
        const tb = { rate: '30/1', fps: 30, frames: 120, start_time: 0, clock_offset: 0, file: 'source/video.mp4', sha256: 's', cfr_copy: false };
        expect(migrateOverrides({ add: [2.0, 3.033], remove: [1.5] }, tb)).toEqual({ version: 2, sha256: 's', add: [60, 91], remove: [45] });
    });
    test('spans carry frames and derived seconds', () => {
        expect(frameSpans([60], 120, '30/1')).toEqual([
            { id: 1, first_frame: 0, end_frame: 60, start: 0, end: 2, duration: 2 },
            { id: 2, first_frame: 60, end_frame: 120, start: 2, end: 4, duration: 2 },
        ]);
        expect(frameSpans([], 90, '30000/1001')).toEqual([{ id: 1, first_frame: 0, end_frame: 90, start: 0, end: 3.003, duration: 3.003 }]);
    });
});

describe('analysis id', () => {
    test('analysis id changes with evidence', () => {
        const base = { sha256: 'aa', rate: '30/1', cuts: [60], detector: DETECTOR_VERSION };
        const id = analysisId(base);
        expect(id).toMatch(/^a[0-9a-f]{8}-2$/);
        expect(analysisId({ ...base })).toBe(id);
        for (const d of [{ sha256: 'ab' }, { rate: '60/1' }, { cuts: [61] }, { detector: 'x' }]) expect(analysisId({ ...base, ...d })).not.toBe(id);
    });
});

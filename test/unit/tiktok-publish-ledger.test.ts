import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolvePendingDir } from '../../skills/tiktok/scripts/paths.ts';
import { beginAttempt, markOutcome, openAttempts } from '../../skills/tiktok/scripts/publish/ledger.ts';

const CHILD = path.resolve(import.meta.dir, 'ledger-child.ts');
let before: string | undefined;
beforeEach(() => {
    before = process.env.TIKTOK_DATA_DIR;
    process.env.TIKTOK_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'ttledger-'));
});
afterEach(() => {
    process.env.TIKTOK_DATA_DIR = before;
});
const kind = (k: string) => expect.objectContaining({ kind: k });
const child = (args: string[]) => JSON.parse(spawnSync(process.execPath, [CHILD, ...args], { env: process.env, encoding: 'utf8' }).stdout || '{}');
const childAsync = (args: string[]) =>
    new Promise<Record<string, string>>((resolve) => {
        const p = spawn(process.execPath, [CHILD, ...args], { env: process.env });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.on('close', () => resolve(JSON.parse(out || '{}')));
    });

describe('publish attempt ledger', () => {
    test('an attempt left open by a crashed process blocks the next begin', async () => {
        const r = child(['begin', 'd1']);
        expect(r.id).toBeString();
        const open = await openAttempts();
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({ id: r.id, state: 'submitted', digest: 'd1', account: 'jdnichollsc' });
        await expect(beginAttempt({ account: 'jdnichollsc', digest: 'd2' })).rejects.toThrow(kind('publish_busy'));
    });
    test('published and rejected close an attempt; processing and unknown keep it open', async () => {
        const a = await beginAttempt({ account: 'jdnichollsc', digest: 'd' });
        await markOutcome(a.id, 'processing');
        await expect(beginAttempt({ account: 'jdnichollsc', digest: 'e' })).rejects.toThrow(kind('publish_busy'));
        await markOutcome(a.id, 'unknown', { detail: 'page timed out' });
        expect((await openAttempts())[0]).toMatchObject({ state: 'unknown', detail: 'page timed out' });
        await markOutcome(a.id, 'published', { postId: '123' });
        expect(await openAttempts()).toEqual([]);
        const b = await beginAttempt({ account: 'jdnichollsc', digest: 'e' });
        await markOutcome(b.id, 'rejected');
        expect(await openAttempts()).toEqual([]);
    });
    test('a corrupt attempt record is open, reported and blocks', async () => {
        const dir = path.join(resolvePendingDir(), 'attempts');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'broken.json'), '{not json');
        expect(await openAttempts()).toEqual([{ id: 'broken', unreadable: true }]);
        await expect(beginAttempt({ account: 'jdnichollsc', digest: 'd' })).rejects.toThrow(kind('publish_busy'));
    });
    test('two processes racing begin → exactly one attempt', async () => {
        const at = String(Date.now() + 700);
        const [x, y] = await Promise.all([childAsync(['begin', 'a', at]), childAsync(['begin', 'b', at])]);
        const ids = [x, y].filter((r) => r.id);
        expect(ids).toHaveLength(1);
        expect([x, y].find((r) => !r.id)).toEqual({ kind: 'publish_busy' });
        expect(await openAttempts()).toHaveLength(1);
    });
    test('markOutcome on an unknown id fails loudly', async () => {
        await expect(markOutcome('nope', 'published')).rejects.toThrow(/nope/);
    });
});

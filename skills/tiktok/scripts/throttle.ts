import { open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveThrottlePath } from './paths.ts';
import { ensurePrivateDir } from './secure.ts';

/** Default gap between TikTok requests across every process (a policy, not a verified safe rate). */
export const DEFAULT_MIN_GAP_MS = 1500;

export function minGapMs(): number {
    const v = Number(process.env.TIKTOK_MIN_GAP_MS);
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MIN_GAP_MS;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STALE_LOCK_MS = 10_000;

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const file = resolveThrottlePath();
    await ensurePrivateDir(path.dirname(file));
    const lock = `${file}.lock`;
    const start = Date.now();
    for (;;) {
        try {
            const h = await open(lock, 'wx');
            await h.close();
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            try {
                if (Date.now() - (await stat(lock)).mtimeMs > STALE_LOCK_MS) await rm(lock, { force: true });
            } catch {
                // lock vanished between calls
            }
            if (Date.now() - start > 30_000) throw new Error('Timed out waiting for the request pacing lock.');
            await sleep(15);
        }
    }
    try {
        return await fn();
    } finally {
        await rm(lock, { force: true });
    }
}

/**
 * Reserves the next request slot (shared across processes through throttle.json) and waits for it.
 * Two callers never get slots closer than minGapMs().
 */
export async function waitTurn(): Promise<void> {
    const gap = minGapMs();
    const file = resolveThrottlePath();
    const slot = await withLock(async () => {
        let last = 0;
        try {
            last = Number(JSON.parse(await readFile(file, 'utf8')).next) || 0;
        } catch {
            // first request or unreadable: start now
        }
        const now = Date.now();
        const mine = Math.max(now, last + gap);
        await writeFile(file, JSON.stringify({ next: mine }));
        return mine;
    });
    const wait = slot - Date.now();
    if (wait > 0) await sleep(wait);
}

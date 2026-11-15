import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveDataDir, resolveSignalPath, resolveThrottlePath, resolveCapturesDir } from '../../skills/tiktok/scripts/paths.ts';
import { ensurePrivateDir, InsecureStorageError, parseIcaclsPrincipals } from '../../skills/tiktok/scripts/secure.ts';
import { assertNoSignal, clearSignal, readSignal, writeSignal } from '../../skills/tiktok/scripts/signal.ts';

const SCRIPTS = path.resolve(import.meta.dir, '../../skills/tiktok/scripts');

describe('paths', () => {
    test('TIKTOK_DATA_DIR overrides the data dir and derived files live inside it', () => {
        const dir = resolveDataDir();
        expect(dir).toBe(path.resolve(process.env.TIKTOK_DATA_DIR!));
        expect(resolveSignalPath()).toBe(path.join(dir, 'signal.json'));
        expect(resolveThrottlePath()).toBe(path.join(dir, 'throttle.json'));
        expect(resolveCapturesDir().startsWith(dir)).toBe(true);
    });
});

describe('secure storage', () => {
    test('ensurePrivateDir locks a fresh temp dir', async () => {
        const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'tt-sec-')), 'data');
        await ensurePrivateDir(dir);
    });

    test('parseIcaclsPrincipals lists every principal (enforcement removes the others)', () => {
        const target = 'C:\\x\\data';
        const out = `${target} DESKTOP\\me:(OI)(CI)(F)\n         BUILTIN\\Administrators:(OI)(CI)(F)\n\nSuccessfully processed 1 files`;
        expect(parseIcaclsPrincipals(out, target)).toEqual(['DESKTOP\\me', 'BUILTIN\\Administrators']);
    });

    test('a failed lock throws and there is no insecure-storage escape hatch', async () => {
        const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'tt-sec-')), 'data');
        process.env.TIKTOK_ALLOW_INSECURE_STORAGE = '1';
        process.env.INSTAGRAM_ALLOW_INSECURE_STORAGE = '1';
        try {
            const restrict = async () => ({ ok: false, detail: 'stubbed failure' });
            await expect(ensurePrivateDir(dir, { restrict })).rejects.toBeInstanceOf(InsecureStorageError);
        } finally {
            delete process.env.TIKTOK_ALLOW_INSECURE_STORAGE;
            delete process.env.INSTAGRAM_ALLOW_INSECURE_STORAGE;
        }
    });
});

describe('account signal', () => {
    test('a written signal blocks, also in another process, and clearing unblocks', async () => {
        await writeSignal('challenge', 'captcha on /@x');
        await expect(assertNoSignal()).rejects.toMatchObject({ code: 'blocked_by_signal' });
        expect((await readSignal())?.kind).toBe('challenge');
        const child = spawnSync(process.execPath, ['-e', `import('${path.join(SCRIPTS, 'signal.ts').replace(/\\/g, '/')}').then(m => m.assertNoSignal()).then(() => process.exit(0), e => process.exit(e.code === 'blocked_by_signal' ? 3 : 1))`], { env: process.env });
        expect(child.status).toBe(3);
        await clearSignal();
        await assertNoSignal();
    });

    test('an unreadable signal file counts as a signal', async () => {
        writeFileSync(resolveSignalPath(), '{not json');
        await expect(assertNoSignal()).rejects.toMatchObject({ code: 'blocked_by_signal' });
        await clearSignal();
        await assertNoSignal();
    });
});

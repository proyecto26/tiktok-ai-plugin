import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    formatCookieHeader,
    missingCookies,
    parseCookieInput,
    redact,
    REQUIRED_COOKIES,
    writeCookieMapToDisk,
} from '../../skills/tiktok/scripts/cookie-store.ts';
import { cdpLaunchArgs, getTikTokCookiesViaChrome, isAllowedTarget, type CdpLike } from '../../skills/tiktok/scripts/auth.ts';
import { InsecureStorageError } from '../../skills/tiktok/scripts/secure.ts';

const MAIN = path.resolve(import.meta.dir, '../../skills/tiktok/scripts/main.ts');
const TRAP = path.join(import.meta.dir, 'fetch-trap.ts');

function cli(args: string[], env: Record<string, string>) {
    return spawnSync(process.execPath, ['--preload', TRAP, MAIN, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
}

describe('cookie parsing', () => {
    test('Cookie-Editor JSON keeps only tiktok.com cookies', () => {
        const json = JSON.stringify([
            { name: 'sessionid', value: 'abc', domain: '.tiktok.com' },
            { name: 'tt_csrf_token', value: 'csrf', domain: 'www.tiktok.com' },
            { name: 'sessionid', value: 'evil', domain: '.example.com' },
            { name: 'other', value: 'x', domain: '.tiktok.com.evil.com' },
        ]);
        expect(parseCookieInput(json)).toEqual({ sessionid: 'abc', tt_csrf_token: 'csrf' });
    });

    test('Netscape cookies.txt and a raw header both parse', () => {
        const txt = '# Netscape\n#HttpOnly_.tiktok.com\tTRUE\t/\tTRUE\t0\tsessionid\tabc\n.example.com\tTRUE\t/\tTRUE\t0\tx\ty\n';
        expect(parseCookieInput(txt)).toEqual({ sessionid: 'abc' });
        expect(parseCookieInput('Cookie: sessionid=abc; ttwid=1%7Cz')).toEqual({ sessionid: 'abc', ttwid: '1%7Cz' });
    });

    test('missingCookies follows REQUIRED_COOKIES', () => {
        expect(missingCookies({})).toEqual([...REQUIRED_COOKIES]);
        expect(missingCookies(Object.fromEntries(REQUIRED_COOKIES.map((n) => [n, 'v'])))).toEqual([]);
    });

    test('redact never returns a value; header joins pairs', () => {
        expect(JSON.stringify(redact({ sessionid: 'SECRET_SENTINEL_123' }))).not.toContain('SECRET_SENTINEL_123');
        expect(formatCookieHeader({ a: '1', b: '2' })).toBe('a=1; b=2');
    });

    test('writeCookieMapToDisk refuses when the private-dir lock fails', async () => {
        const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'tt-ck-')), 'x', 'cookies.json');
        const restrict = async () => ({ ok: false, detail: 'stub' });
        await expect(writeCookieMapToDisk({ sessionid: 'a' }, { cookiePath: file, restrict })).rejects.toBeInstanceOf(InsecureStorageError);
    });
});

describe('CDP login guards', () => {
    test('launch args bind DevTools to loopback with the dedicated profile', () => {
        const args = cdpLaunchArgs(9222, 'p');
        expect(args).toContain('--remote-debugging-address=127.0.0.1');
        expect(args).toContain('--remote-debugging-port=9222');
        expect(args).toContain('--user-data-dir=p');
    });

    test('only https://www.tiktok.com targets are allowed', () => {
        expect(isAllowedTarget('https://www.tiktok.com/login')).toBe(true);
        expect(isAllowedTarget('https://www.tiktok.com.evil.com/')).toBe(false);
        expect(isAllowedTarget('http://www.tiktok.com/')).toBe(false);
        expect(isAllowedTarget('https://evil.example/?u=https://www.tiktok.com/')).toBe(false);
    });

    function fakeCdp(targets: { targetId: string; type: string; url: string }[]) {
        const calls: { method: string; params?: Record<string, unknown> }[] = [];
        const cdp: CdpLike = {
            async send(method: string, params?: Record<string, unknown>) {
                calls.push({ method, params });
                if (method === 'Target.getTargets') return { targetInfos: targets } as never;
                if (method === 'Target.attachToTarget') return { sessionId: 's1' } as never;
                if (method === 'Network.getAllCookies') return { cookies: [{ name: 'sessionid', value: 'v', domain: '.tiktok.com', path: '/' }] } as never;
                if (method === 'Runtime.evaluate') return { result: { value: 'https://www.tiktok.com/foryou' } } as never;
                return {} as never;
            },
            close() {},
        };
        return { cdp, calls };
    }

    const baseDeps = (cdp: CdpLike, spawned: { n: number }) => ({
        findChrome: () => 'chrome',
        spawnChrome: () => {
            spawned.n += 1;
            return { kill() {} };
        },
        freePort: async () => 9333,
        waitForDebugger: async () => 'ws://127.0.0.1:9333/devtools/browser/x',
        connect: async () => cdp,
        restrict: async () => ({ ok: true, detail: 'stub' }),
        pollIntervalMs: 1,
        timeoutMs: 200,
    });

    test('attaches only to the TikTok target even when a foreign one comes first', async () => {
        const { cdp, calls } = fakeCdp([
            { targetId: 'evil', type: 'page', url: 'https://evil.example/' },
            { targetId: 'tt', type: 'page', url: 'https://www.tiktok.com/login' },
        ]);
        const map = await getTikTokCookiesViaChrome(baseDeps(cdp, { n: 0 }));
        expect(map.sessionid).toBe('v');
        const attach = calls.filter((c) => c.method === 'Target.attachToTarget');
        expect(attach.map((c) => c.params?.targetId)).toEqual(['tt']);
    });

    test('only foreign targets: no attach or evaluate, and an error', async () => {
        const { cdp, calls } = fakeCdp([{ targetId: 'evil', type: 'page', url: 'https://evil.example/' }]);
        await expect(getTikTokCookiesViaChrome(baseDeps(cdp, { n: 0 }))).rejects.toThrow(/tiktok/i);
        expect(calls.some((c) => c.method === 'Target.attachToTarget' || c.method === 'Runtime.evaluate')).toBe(false);
    });

    test('a failed private-dir lock means Chrome is never spawned', async () => {
        const { cdp } = fakeCdp([]);
        const spawned = { n: 0 };
        const deps = { ...baseDeps(cdp, spawned), restrict: async () => ({ ok: false, detail: 'stub' }) };
        await expect(getTikTokCookiesViaChrome(deps)).rejects.toBeInstanceOf(InsecureStorageError);
        expect(spawned.n).toBe(0);
    });
});

describe('status command', () => {
    test('prints cookie names and never a value', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'tt-st-'));
        await writeCookieMapToDisk({ sessionid: 'SECRET_SENTINEL_123', ttwid: 'SECRET_SENTINEL_123' }, { cookiePath: path.join(dir, 'cookies.json') });
        const r = cli(['status', '--json'], { TIKTOK_DATA_DIR: dir });
        expect(r.status).toBe(0);
        expect(r.stdout + r.stderr).not.toContain('SECRET_SENTINEL_123');
        const out = JSON.parse(r.stdout);
        expect(out.signedIn).toBe(true);
        expect(out.cookies).toContain('sessionid');
    });

    test('an empty store reports signedIn:false', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'tt-st-'));
        const r = cli(['status', '--json'], { TIKTOK_DATA_DIR: dir });
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout).signedIn).toBe(false);
    });
});

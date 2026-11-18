// Every fixture is synthetic or the owner's own: no secUid, no signed or query URLs, no token-like strings,
// no third-party handles, and third-party free text marked SYNTH:.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../fixtures');
const OWNER = 'jdnichollsc';
const TEXT_KEYS = new Set(['nickname', 'signature', 'desc', 'text']);
const HANDLE_KEYS = new Set(['uniqueId', 'unique_id']);

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
        const p = path.join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : /\.(json|html|vtt)$/i.test(n) ? [p] : [];
    });
}

/** Visit every value with its key and the nearest object that carries a handle (the item's author). */
function visit(v: unknown, owner: boolean, f: (key: string, value: unknown, owner: boolean) => void, key = ''): void {
    if (Array.isArray(v)) return v.forEach((x) => visit(x, owner, f, key));
    if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        const handle = [o.uniqueId, o.unique_id, (o.author as Record<string, unknown> | undefined)?.uniqueId, (o.user as Record<string, unknown> | undefined)?.unique_id, (o.user as Record<string, unknown> | undefined)?.uniqueId].find((x) => typeof x === 'string') as string | undefined;
        const own = handle === undefined ? owner : handle.toLowerCase() === OWNER;
        for (const [k, x] of Object.entries(o)) visit(x, own, f, k);
        return;
    }
    f(key, v, owner);
}

const files = walk(ROOT);

describe('fixtures privacy', () => {
    test('there are fixtures to check', () => {
        expect(files.length).toBeGreaterThan(0);
    });
    for (const file of files) {
        const rel = path.relative(ROOT, file);
        test(rel, () => {
            const raw = readFileSync(file, 'utf8');
            const problems: string[] = [];
            const strings: string[] = [];
            if (/\.json$/i.test(file)) {
                let data: unknown;
                try {
                    data = JSON.parse(raw);
                } catch {
                    data = undefined;
                }
                if (data !== undefined) {
                    visit(data, false, (k, v, own) => {
                        if (typeof v !== 'string') return;
                        strings.push(v);
                        if ((k === 'secUid' || k === 'sec_uid') && v) problems.push(`${k} has a value`);
                        if (HANDLE_KEYS.has(k) && v && v.toLowerCase() !== OWNER && !v.startsWith('synthetic_')) problems.push(`handle ${k}=${v}`);
                        if (TEXT_KEYS.has(k) && v && !own && !v.startsWith('SYNTH:')) problems.push(`${k} not SYNTH: ${v.slice(0, 30)}`);
                    });
                } else strings.push(raw);
            } else strings.push(raw);
            for (const s of strings) {
                for (const m of s.matchAll(/https?:\/\/[^\s"'<>]+/g)) if (m[0].includes('?')) problems.push(`query URL ${m[0].slice(0, 60)}`);
                for (const m of s.matchAll(/[A-Za-z0-9_-]{40,}/g)) problems.push(`token-like ${m[0].slice(0, 12)}…`);
                for (const m of s.matchAll(/"sec_?[uU]id"\s*:\s*"([^"]+)"/g)) problems.push(`secUid ${m[1].slice(0, 8)}…`);
            }
            expect(problems).toEqual([]);
        });
    }
});

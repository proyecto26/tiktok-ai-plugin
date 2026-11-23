// The breakdown modules shared with the sibling plugin are byte-identical (after CRLF→LF): each one matches the
// hash recorded in SHARED.sha256, and that list matches the sibling's when the sibling is checked out nearby.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SELF = 'tiktok';
const SIBLING = 'instagram';
const dirOf = (plugin: string, root: string) => path.join(root, 'skills', `${plugin}-video-breakdown`, 'scripts');
const ROOT = path.resolve(import.meta.dir, '../..');
const SCRIPTS = dirOf(SELF, ROOT);
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const sha = (s: string) => createHash('sha256').update(lf(s), 'utf8').digest('hex');
const entries = (file: string) =>
    lf(readFileSync(file, 'utf8'))
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
            const [hash, name] = l.trim().split(/\s+/);
            return { hash, name };
        });

describe('shared breakdown modules', () => {
    test('shared modules match their recorded hash', () => {
        const list = entries(path.join(SCRIPTS, 'SHARED.sha256'));
        expect(list.length).toBeGreaterThan(0);
        for (const { hash, name } of list) expect(`${name} ${sha(readFileSync(path.join(SCRIPTS, name), 'utf8'))}`).toBe(`${name} ${hash}`);
    });
    const siblingRoot = process.env.PLUGIN_SIBLING ?? path.resolve(ROOT, '..', '..', SIBLING, `${SIBLING}-ai-plugin`);
    const siblingList = path.join(dirOf(SIBLING, siblingRoot), 'SHARED.sha256');
    if (!existsSync(siblingList)) console.warn(`[shared-modules] ${SIBLING}-ai-plugin not found at ${siblingRoot}: cross-repo check skipped (set PLUGIN_SIBLING).`);
    test.skipIf(!existsSync(siblingList))('the sibling plugin has the same shared set', () => {
        expect(lf(readFileSync(siblingList, 'utf8'))).toBe(lf(readFileSync(path.join(SCRIPTS, 'SHARED.sha256'), 'utf8')));
    });
});

// The remake modules that are the same in both plugins (pure logic, ffmpeg steps, the ComfyUI client, the graphs):
// the platform-specific parts (schema name, canvas default, wording) live in main.ts and manifest.ts, which are not
// shared. The list is SHARED.sha256 in the remake skill's scripts folder; the sibling's list is compared with it once
// the sibling has one.
describe('shared remake modules', () => {
    const remakeDir = (plugin: string, root: string) => path.join(root, 'skills', `${plugin}-video-remake`, 'scripts');
    const MINE = remakeDir(SELF, ROOT);
    test('shared modules match their recorded hash', () => {
        const list = entries(path.join(MINE, 'SHARED.sha256'));
        expect(list.map((e) => e.name).sort()).toEqual(['audio.ts', 'cadence.ts', 'comfy.ts', 'ff.ts', 'graphs.ts', 'plan.ts', 'stretch.ts']);
        for (const { hash, name } of list) expect(`${name} ${sha(readFileSync(path.join(MINE, name), 'utf8'))}`).toBe(`${name} ${hash}`);
    });
    test('they name no platform, so one copy serves both', () => {
        for (const { name } of entries(path.join(MINE, 'SHARED.sha256'))) {
            const text = lf(readFileSync(path.join(MINE, name), 'utf8'));
            expect(`${name}: ${/tiktok|instagram|\big\.|\btt\./i.test(text)}`).toBe(`${name}: false`);
        }
    });
    const siblingRoot = process.env.PLUGIN_SIBLING ?? path.resolve(ROOT, '..', '..', SIBLING, `${SIBLING}-ai-plugin`);
    const siblingList = path.join(remakeDir(SIBLING, siblingRoot), 'SHARED.sha256');
    test.skipIf(!existsSync(siblingList))('the sibling plugin has the same shared set', () => {
        expect(lf(readFileSync(siblingList, 'utf8'))).toBe(lf(readFileSync(path.join(MINE, 'SHARED.sha256'), 'utf8')));
    });
});

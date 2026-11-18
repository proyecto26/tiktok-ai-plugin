// Local-only rule: no tiktok-* skill points at a paid or cloud route.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SKILLS = path.resolve(import.meta.dir, '../../skills');
const BANNED = [/comfy\s+cloud/i, /--allow-spend/i, /partner[- ]node/i, /\bgroq\b/i, /\bapify\b/i, /\bpublora\b/i, /api\.openai\.com/i, /assemblyai/i, /deepgram/i, /speech\.googleapis/i, /api\.elevenlabs/i];

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
        const p = path.join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
    });
}

describe('skills are local-only', () => {
    const files = readdirSync(SKILLS).filter((d) => d.startsWith('tiktok')).flatMap((d) => walk(path.join(SKILLS, d)));
    test('there are files to scan', () => expect(files.length).toBeGreaterThan(5));
    for (const f of files) {
        test(path.relative(SKILLS, f), () => {
            const text = readFileSync(f, 'utf8');
            const hits = BANNED.filter((re) => re.test(text)).map(String);
            expect(hits).toEqual([]);
        });
    }
});

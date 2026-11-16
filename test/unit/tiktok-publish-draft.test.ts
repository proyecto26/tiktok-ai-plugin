import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { approvalDigest, type PostSettings, prepareDraft, verifyDraft } from '../../skills/tiktok/scripts/publish/draft.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'ttdraft-'));
const file = (name: string, bytes: number | string) => {
    const p = path.join(dir, name);
    writeFileSync(p, typeof bytes === 'string' ? bytes : Buffer.alloc(bytes, 1));
    return p;
};
const video: PostSettings = { kind: 'video', caption: 'test, private', privacy: 'only_me', allowComments: true, allowReuse: true, aiGenerated: false, discloseContent: false };
const photo: PostSettings = { kind: 'photo', title: 't', description: 'd', privacy: 'only_me', allowComments: true, allowReuse: true, aiGenerated: false, discloseContent: false };
const kind = (k: string) => expect.objectContaining({ kind: k });

describe('prepareDraft', () => {
    test('a video draft hashes the file and binds the digest', async () => {
        const d = await prepareDraft({ files: [file('a.mp4', 'abc')], settings: video, account: '@JDNichollsc' });
        expect(d).toMatchObject({ schema: 'tt.draft.v1', account: 'jdnichollsc', media: [{ bytes: 3, manualFilePick: false }] });
        expect(d.media[0].sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(d.digest).toBe(approvalDigest(d));
    });
    test('the digest ignores key order and paths, and changes with any setting or byte', async () => {
        const a = await prepareDraft({ files: [file('b.mp4', 'abc')], settings: video, account: 'jdnichollsc' });
        const renamed = await prepareDraft({ files: [file('c.mp4', 'abc')], settings: { ...video }, account: 'jdnichollsc' });
        expect(renamed.digest).toBe(a.digest);
        const reordered = approvalDigest({ account: a.account, media: a.media, settings: Object.fromEntries(Object.entries(a.settings).reverse()) as unknown as PostSettings });
        expect(reordered).toBe(a.digest);
        for (const change of [{ caption: 'x' }, { privacy: 'friends' }, { allowComments: false }, { allowReuse: false }, { aiGenerated: true }, { discloseContent: true }]) {
            expect(approvalDigest({ ...a, settings: { ...a.settings, ...change } as PostSettings })).not.toBe(a.digest);
        }
        expect(approvalDigest({ ...a, account: 'other' })).not.toBe(a.digest);
        const p1 = file('p1.jpg', 'one');
        const p2 = file('p2.jpg', 'two');
        const ab = await prepareDraft({ files: [p1, p2], settings: photo, account: 'jdnichollsc' });
        const ba = await prepareDraft({ files: [p2, p1], settings: photo, account: 'jdnichollsc' });
        expect(ab.digest).not.toBe(ba.digest);
    });
    test('invalid drafts name the field', async () => {
        const mp4 = file('v.mp4', 'v');
        const jpg = file('i.jpg', 'i');
        const bad = (files: string[], settings: Partial<PostSettings>, re: RegExp) =>
            expect(prepareDraft({ files, settings: settings as PostSettings, account: 'jdnichollsc' })).rejects.toThrow(re);
        await bad([mp4], { ...video, caption: 'x'.repeat(2201) }, /caption/);
        await bad([jpg], { ...photo, title: 'x'.repeat(91) }, /title/);
        await bad([jpg], { ...photo, description: 'x'.repeat(4001) }, /description/);
        await bad([], photo, /photo/);
        await bad(Array.from({ length: 36 }, () => jpg), photo, /photo/);
        await bad([mp4, mp4], video, /one video/);
        await bad([jpg], video, /extension/);
        await bad([mp4], photo, /extension/);
        await bad([mp4], { ...video, privacy: 'everyone' }, /public/);
        await bad([mp4], { ...video, privacy: 'follow_back' }, /privacy/);
        await bad([path.join(dir, 'missing.mp4')], video, /not found/);
        await expect(prepareDraft({ files: [mp4], settings: { ...video, caption: 'x'.repeat(2201) }, account: 'jdnichollsc' })).rejects.toThrow(kind('invalid_draft'));
    });
    test('everyone is accepted only with public: true', async () => {
        const d = await prepareDraft({ files: [file('pub.mp4', 'p')], settings: { ...video, privacy: 'everyone' }, account: 'jdnichollsc', public: true });
        expect(d.settings.privacy).toBe('everyone');
    });
    test('a file over 10 MB needs a manual file pick', async () => {
        const d = await prepareDraft({ files: [file('big.mp4', 10 * 1024 * 1024 + 1)], settings: video, account: 'jdnichollsc' });
        expect(d.media[0].manualFilePick).toBe(true);
    });
});

describe('verifyDraft', () => {
    test('a file edited after prepare → approval_mismatch', async () => {
        const p = file('edit.mp4', 'before');
        const d = await prepareDraft({ files: [p], settings: video, account: 'jdnichollsc' });
        await verifyDraft(d);
        writeFileSync(p, 'after!');
        await expect(verifyDraft(d)).rejects.toThrow(kind('approval_mismatch'));
    });
    test('a draft whose settings were edited after the digest → approval_mismatch', async () => {
        const d = await prepareDraft({ files: [file('dig.mp4', 'x')], settings: video, account: 'jdnichollsc' });
        await expect(verifyDraft({ ...d, settings: { ...d.settings, privacy: 'everyone' } })).rejects.toThrow(kind('approval_mismatch'));
    });
});

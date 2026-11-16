import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { TtError } from '../client.ts';
import { resolvePendingDir } from '../paths.ts';
import { ensurePrivateDir } from '../secure.ts';
import { assertNoSignal, writeSignal } from '../signal.ts';
import { type Draft, normalizeAccount, type PostSettings, type Privacy, prepareDraft, verifyDraft } from './draft.ts';
import { allAttempts, beginAttempt, getAttempt, markOutcome, type Outcome, openAttempts } from './ledger.ts';
import { compareState, matchRow, type PageState, type Rows } from './reconcile.ts';

export const PUBLISH_BOOLEANS = ['public', 'no-comments', 'no-reuse', 'ai-generated', 'disclose', 'by-owner'] as const;

export const PUBLISH_HELP = `Publishing (TikTok Studio composer in your own Chrome; nothing is posted by the CLI itself):
  publish prepare (--video <f> | --photos <a,b,..>) [--caption s | --title s --description s]
                  [--privacy only_me|friends|everyone|follow_back] [--public]
                  [--no-comments] [--no-reuse] [--ai-generated] [--disclose]
                                         Dry run: hashes the media, prints the draft and its digest
  publish begin --draft <digest> --approve <digest> --page-state <file>
                                         After the owner's yes and compose.js state(): records the attempt
  publish finish --attempt <id> --outcome processing|unknown [--post-id id]
  publish finish --attempt <id> --outcome published|rejected --by-owner   Owner checked Studio by hand
  publish reconcile --attempt <id> --rows <file>   Settle an attempt from studio-rows.js output
  publish status                         Open attempts and the last closed ones`;

export const account = () => normalizeAccount(process.env.TIKTOK_ACCOUNT || 'jdnichollsc');
const draftsDir = () => path.join(resolvePendingDir(), 'drafts');
const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);

async function readJson<T>(file: string | undefined, what: string): Promise<T> {
    if (!file) throw new Error(`${what} needs a file path`);
    try {
        return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (error) {
        throw new Error(`${what}: cannot read ${file} (${(error as Error).message})`);
    }
}

async function saveDraft(d: Draft): Promise<string> {
    await ensurePrivateDir(resolvePendingDir());
    await ensurePrivateDir(draftsDir());
    const file = path.join(draftsDir(), `${d.digest}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(d, null, 2));
    await rename(`${file}.tmp`, file);
    return file;
}

async function loadDraft(digest: string | undefined): Promise<Draft> {
    if (!digest || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('--draft is the 64-hex digest printed by publish prepare');
    return readJson<Draft>(path.join(draftsDir(), `${digest}.json`), '--draft');
}

function settingsFrom(flags: Record<string, string | true>, kind: PostSettings['kind']): PostSettings {
    return {
        kind,
        caption: kind === 'video' ? (str(flags.caption) ?? '') : str(flags.caption),
        title: kind === 'photo' ? (str(flags.title) ?? '') : str(flags.title),
        description: kind === 'photo' ? (str(flags.description) ?? '') : str(flags.description),
        privacy: (str(flags.privacy) ?? 'only_me') as Privacy,
        allowComments: flags['no-comments'] !== true,
        allowReuse: flags['no-reuse'] !== true,
        aiGenerated: flags['ai-generated'] === true,
        discloseContent: flags.disclose === true,
    };
}

export async function publishCommand(sub: string | undefined, flags: Record<string, string | true>, out: (v: unknown) => void): Promise<number> {
    switch (sub) {
        case 'prepare': {
            const video = str(flags.video);
            const photos = str(flags.photos);
            if (!!video === !!photos) throw new TtError('invalid_draft', 'publish prepare takes --video <file> or --photos <a,b,...> (one of them)');
            const kind = video ? 'video' : 'photo';
            const files = video ? [video] : photos!.split(',').map((s) => s.trim()).filter(Boolean);
            const draft = await prepareDraft({ files, settings: settingsFrom(flags, kind), account: account(), public: flags.public === true });
            const file = await saveDraft(draft);
            out({
                dryRun: true,
                draft,
                savedTo: file,
                nextStep: 'Show this draft to the owner. Only after an explicit yes: open TikTok Studio upload, add the file(s), run compose.js fill + state, save the state, then publish begin --draft <digest> --approve <digest> --page-state <file>.',
                ...(draft.media.some((m) => m.manualFilePick) ? { manualFilePick: 'A file is over 10 MB: the owner selects it in the page; the rest stays automated.' } : {}),
            });
            return 0;
        }
        case 'begin': {
            await assertNoSignal();
            const draft = await loadDraft(str(flags.draft));
            if (str(flags.approve) !== draft.digest) throw new TtError('approval_mismatch', '--approve must be the exact digest the owner approved (from publish prepare).');
            await verifyDraft(draft);
            const state = await readJson<PageState>(str(flags['page-state']), '--page-state');
            if (state?.challenge === true) {
                await writeSignal('challenge', 'publish begin: verification on the upload page');
                throw new TtError('challenge', 'TikTok shows a verification on the upload page. Resolve it in the browser, then `resume`; do not click Post.');
            }
            const diff = compareState(draft, state);
            if (diff.length) throw new TtError('page_mismatch', `The page does not show the approved post: ${diff.join('; ')}. Fix the page (compose.js fill) and read the state again; do not click Post.`);
            const attempt = await beginAttempt({ account: draft.account, digest: draft.digest });
            out({ attempt, nextStep: `Click Post now (once). Then: publish finish --attempt ${attempt.id} --outcome ... or publish reconcile --attempt ${attempt.id} --rows <studio-rows.json>. If the page crashes or is unclear: --outcome unknown, never post again.` });
            return 0;
        }
        case 'finish': {
            const id = str(flags.attempt);
            const outcome = str(flags.outcome) as Outcome | undefined;
            if (!id || !outcome || !['published', 'processing', 'rejected', 'unknown'].includes(outcome)) throw new Error('publish finish --attempt <id> --outcome published|processing|rejected|unknown');
            // Closing an attempt normally needs the Studio readback (publish reconcile). A manual close is an owner override.
            const closing = outcome === 'published' || outcome === 'rejected';
            if (closing && flags['by-owner'] !== true) throw new Error('Closing an attempt by hand needs --by-owner (the owner checked Studio themselves). Otherwise use publish reconcile --rows.');
            const detail = closing ? `owner override${str(flags.detail) ? `: ${str(flags.detail)}` : ''}` : str(flags.detail);
            out({ attempt: await markOutcome(id, outcome, { postId: str(flags['post-id']), detail }) });
            return 0;
        }
        case 'reconcile': {
            const id = str(flags.attempt);
            if (!id) throw new Error('publish reconcile --attempt <id> --rows <file>');
            const attempt = await getAttempt(id);
            const draft = await loadDraft(attempt.digest);
            const rows = await readJson<Rows>(str(flags.rows), '--rows');
            if (rows?.schema !== 'tt-rows-v1' || !Array.isArray(rows.rows)) throw new Error('--rows is not a tt-rows-v1 file (run scripts/browser/studio-rows.js)');
            if (normalizeAccount(String(rows.account ?? '')) !== draft.account) throw new TtError('page_mismatch', `The Studio page is signed in as @${rows.account}, not @${draft.account}.`);
            const row = matchRow(draft, attempt.startedAt, rows.rows);
            if (!row) {
                out({ attempt, matched: null, note: 'No single Studio row matches this draft and its time (none yet, no readable time, or more than one). Reload Studio content later and reconcile again; do not post again.' });
                return 0;
            }
            const next =
                row.privacy !== draft.settings.privacy ? await markOutcome(id, 'unknown', { detail: `privacy_mismatch: Studio shows ${row.privacy}, approved ${draft.settings.privacy}. Fix it in Studio by hand; never re-post.` })
                : row.underReview ? await markOutcome(id, 'processing', { detail: 'Content under review' })
                : await markOutcome(id, 'published', { detail: 'readback: caption, privacy and review state from Studio content; disclosure toggles are not shown there' });
            out({ attempt: next, matched: row });
            return 0;
        }
        case 'status': {
            const all = await allAttempts();
            out({ open: await openAttempts(), recent: all.filter((a) => !('unreadable' in a) && (a.state === 'published' || a.state === 'rejected')).slice(0, 5) });
            return 0;
        }
        default:
            throw new Error(`Unknown publish step: ${sub ?? '(none)'}\n\n${PUBLISH_HELP}`);
    }
}

// Child process for the publish ledger tests: `begin <digest> [startAtMs]` prints {id} or {kind}.
import { beginAttempt } from '../../skills/tiktok/scripts/publish/ledger.ts';

const [, , action, digest, startAt] = process.argv;
if (action === 'begin') {
    const at = Number(startAt);
    if (at) while (Date.now() < at) await new Promise((r) => setTimeout(r, 1));
    try {
        const a = await beginAttempt({ account: 'jdnichollsc', digest: digest ?? 'd' });
        process.stdout.write(JSON.stringify({ id: a.id }));
    } catch (error) {
        process.stdout.write(JSON.stringify({ kind: (error as { kind?: string }).kind ?? String(error) }));
    }
    // exits without markOutcome: a crash mid-publish
}

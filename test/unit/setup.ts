// Preloaded before every unit test (see bunfig.toml): no pacing delays, and an
// isolated data dir so tests never touch the real session.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Live tests (TIKTOK_LIVE=1) need the real session and real pacing: leave them alone.
if (process.env.TIKTOK_LIVE !== '1') {
    process.env.TIKTOK_MIN_GAP_MS = '0';
    process.env.TIKTOK_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'tt-test-'));
    delete process.env.TIKTOK_COOKIES;
}

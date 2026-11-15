import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const APP_DATA_DIR = 'tiktok-ai-plugin';

export function resolveUserDataRoot(): string {
    if (process.platform === 'win32') {
        return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support');
    }
    return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
}

function override(name: string): string | undefined {
    const v = process.env[name]?.trim();
    return v ? path.resolve(v) : undefined;
}

export function resolveDataDir(): string {
    return override('TIKTOK_DATA_DIR') ?? path.join(resolveUserDataRoot(), APP_DATA_DIR);
}

export function resolveCookiePath(): string {
    return override('TIKTOK_COOKIE_PATH') ?? path.join(resolveDataDir(), 'cookies.json');
}

export function resolveChromeProfileDir(): string {
    return override('TIKTOK_CHROME_PROFILE_DIR') ?? path.join(resolveDataDir(), 'chrome-profile');
}

/** Account-wide stop signal (challenge, 429, login redirect). */
export function resolveSignalPath(): string {
    return path.join(resolveDataDir(), 'signal.json');
}

/** Shared request pacing state, honoured across processes. */
export function resolveThrottlePath(): string {
    return path.join(resolveDataDir(), 'throttle.json');
}

/** Redacted recon captures (never committed). */
export function resolveCapturesDir(): string {
    return path.join(resolveDataDir(), 'captures');
}

export function resolveOutputDir(): string {
    return override('TIKTOK_OUTPUT_DIR') ?? path.join(resolveDataDir(), 'outputs');
}

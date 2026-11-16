import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Runs scripts/browser/capture.js against a fake window: the hook must carry stop conditions out of the page.
const SRC = readFileSync(path.resolve(import.meta.dir, '../../skills/tiktok/scripts/browser/capture.js'), 'utf8');
const g = globalThis as Record<string, unknown>;
const saved = { location: g.location, window: g.window, fetch: g.fetch, XMLHttpRequest: g.XMLHttpRequest, document: g.document, scrollTo: g.scrollTo };
afterEach(() => Object.assign(g, saved));

function page(answers: Record<string, [number, string]>) {
    let scrolled = 0;
    g.location = { origin: 'https://www.tiktok.com', href: 'https://www.tiktok.com/@bob' };
    g.window = globalThis;
    delete g.__ttCapture;
    g.fetch = async (u: string) => new Response(answers[u][1], { status: answers[u][0] });
    g.XMLHttpRequest = function () {};
    (g.XMLHttpRequest as { prototype: Record<string, unknown> }).prototype.open = function () {};
    g.document = { getElementById: () => null, querySelector: () => null, body: { scrollHeight: 0 } };
    g.scrollTo = () => scrolled++;
    const run = () => (0, eval)(SRC);
    return { run, scrolled: () => scrolled };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('capture.js stop conditions', () => {
    test('an HTTP 429 on a kept API path marks rateLimited', async () => {
        const p = page({ '/api/post/item_list/?a=1': [429, '{"statusCode":0}'] });
        p.run();
        await (g.fetch as (u: string) => Promise<Response>)('/api/post/item_list/?a=1');
        await settle();
        expect(JSON.parse(p.run())).toMatchObject({ rateLimited: true });
    });
    test('more() refuses to scroll once a stop condition was seen', async () => {
        const p = page({ '/api/post/item_list/?a=1': [200, '<html>captcha</html>'] });
        p.run();
        await (g.fetch as (u: string) => Promise<Response>)('/api/post/item_list/?a=1');
        await settle();
        const r = (g.__ttCapture as { more(): Record<string, unknown> }).more();
        expect(r).toMatchObject({ stopped: true });
        expect(p.scrolled()).toBe(0);
    });
});

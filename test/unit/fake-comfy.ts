// A stand-in for a local ComfyUI server (its ordinary HTTP API) that "generates" by handing back the clip it was sent,
// so the remake's own steps (cut, upload, submit, wait, download, place, join, audio) run for real without a model.
// It listens on loopback only and records every submission.
import { MODELS, REQUIRED_NODES } from '../../skills/tiktok-video-remake/scripts/graphs.ts';

export interface Submission {
    id: string;
    /** The run (shot id) the job was submitted for, read from the graph's own file prefix. */
    unit: string;
    clientId: string;
    graph: Record<string, { class_type: string; inputs: Record<string, any> }>;
}

export function startFakeComfy() {
    const uploads = new Map<string, Uint8Array>();
    const outputs = new Map<string, Uint8Array>();
    const history = new Map<string, any>();
    const submissions: Submission[] = [];
    const state = { fail: new Set<string>(), seq: 0 };
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(req) {
            const u = new URL(req.url);
            const p = u.pathname;
            if (p === '/system_stats') return json({ system: { comfyui_version: 'fake' }, devices: [{ name: 'fake gpu', vram_total: 32 * 2 ** 30 }] });
            if (p === '/object_info') return json(Object.fromEntries(REQUIRED_NODES.map((c) => [c, {}])));
            if (p.startsWith('/object_info/')) {
                const cls = decodeURIComponent(p.slice('/object_info/'.length));
                const input = { UNETLoader: 'unet_name', CLIPLoader: 'clip_name', VAELoader: 'vae_name', LoraLoaderModelOnly: 'lora_name', CheckpointLoaderSimple: 'ckpt_name' }[cls];
                return json({ [cls]: { input: { required: input ? { [input]: [Object.values(MODELS)] } : {} } } });
            }
            if (p === '/upload/image' && req.method === 'POST') {
                const form = await req.formData();
                const f = form.get('image') as File;
                uploads.set(f.name, new Uint8Array(await f.arrayBuffer()));
                return json({ name: f.name, subfolder: '', type: 'input' });
            }
            if (p === '/prompt' && req.method === 'POST') {
                const body = (await req.json()) as { prompt: Submission['graph']; client_id: string };
                const prefix = String(body.prompt['803']?.inputs?.shot_id ?? '');
                const unit = /^remake_(.+)_\d+_[0-9a-f]{8}$/.exec(prefix)?.[1] ?? prefix;
                if (state.fail.has(unit)) return json({ error: { message: `refused ${unit}` }, node_errors: {} }, 400);
                const id = `p${++state.seq}`;
                const video = uploads.get(String(body.prompt['30'].inputs.file));
                if (!video) return json({ error: { message: 'the driving clip was never uploaded' }, node_errors: {} }, 400);
                const filename = `${prefix}_00001_.mp4`;
                outputs.set(filename, video);
                history.set(id, {
                    prompt: [state.seq, id, {}, { client_id: body.client_id }],
                    status: { status_str: 'success', completed: true },
                    outputs: { '809': { images: [{ filename, subfolder: 'video', type: 'output' }], animated: [true] } },
                });
                submissions.push({ id, unit, clientId: body.client_id, graph: body.prompt });
                return json({ prompt_id: id, number: state.seq, node_errors: {} });
            }
            if (p.startsWith('/history/')) {
                const id = decodeURIComponent(p.slice('/history/'.length));
                return json(history.has(id) ? { [id]: history.get(id) } : {});
            }
            if (p === '/history') return json(Object.fromEntries(history));
            if (p === '/queue') return json({ queue_running: [], queue_pending: [] });
            if (p === '/view') {
                const bytes = outputs.get(u.searchParams.get('filename') ?? '');
                return bytes ? new Response(bytes as unknown as BodyInit) : new Response('not found', { status: 404 });
            }
            return new Response('not found', { status: 404 });
        },
    });
    return {
        url: `http://127.0.0.1:${server.port}`,
        submissions,
        state,
        /** How many jobs were submitted for each run so far. */
        counts: () => submissions.reduce<Record<string, number>>((o, s) => ({ ...o, [s.unit]: (o[s.unit] ?? 0) + 1 }), {}),
        stop: () => server.stop(true),
    };
}

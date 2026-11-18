/** source/meta.json: where the analysed video came from. Written by fetch, read by every later step. */

/** Which sound TikTok credits. This is an attribution, not proof of what is audible. */
export interface Attribution {
    kind: 'licensed_music' | 'original_audio';
    title: string | null;
    artist: string | null;
    source: string;
}

export interface Meta {
    schema: 'tt.breakdown.source.v1';
    origin: 'tiktok' | 'local_file';
    fetched_at: string;
    /** The capture file or local file this came from. */
    ref: string | null;
    url: string | null;
    owner: string | null;
    post_id: string | null;
    caption: string;
    hashtags: string[];
    metrics: { likes: number | null; comments: number | null; plays: number | null; shares: number | null; saves: number | null };
    duration_sec: number | null;
    has_audio: boolean | null;
    taken_at: string | null;
    audio_attribution: Attribution | null;
    /** music id of the credited sound, when TikTok gave one. */
    music_id: string | null;
    /** Caption tracks saved next to the video (source/captions.<lang>.vtt). */
    captions: { lang: string; file: string; source: string }[];
    video: { file: string; bytes: number; width: number | null; height: number | null; cdn_host: string | null };
    cover: string | null;
}

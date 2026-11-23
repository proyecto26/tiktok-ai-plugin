# Changelog

## Unreleased

- tiktok-ads: new read-only skill. `eligibility` (Creator Rewards criteria: followers, 30-day views from
  Studio `vv_history`, age and region unknown unless stated; `unavailable: not offered to this account or region`
  when no program list names it), `analytics` (current vs previous period, traffic sources, search terms,
  rewards), `monetization` (programs active / eligible / ineligible), `decide` (kill / keep / scale / wait per ad
  from an Ads Manager CSV; tolerant of missing columns and `$1,234.50` / `1.234,50 EUR` strings), and `report`
  (FACTS / HYPOTHESES / MISSING / ACTIONS, JSON and markdown). References ported from instagram-ads and retargeted
  to Spark Ads, Promote, Ads Manager, Creator Rewards and TikTok Shop affiliates, dated and marked verify.
- tiktok: `scripts/browser/studio-capture.js`, a read-only hook for TikTok Studio analytics and monetization
  answers (own allowlist, sanitized projection that keeps metric and program fields and the `type_requests`
  query, strips URLs, log ids and signing tokens, schema `tt.studio-capture.v1`, same stop signals as
  `capture.js`). Endpoints seen live 2026-11-22; shapes in `skills/tiktok-ads/references/studio-capture.md`.
- tiktok-travel-studio (new): `scan`, `group`, `score`, `shortlist`, `render`, `music`, `photos`, `drafts` (schema
  `tt.travel.v1`). Rotation metadata and variable-rate clips are handled in `render` (constant-rate copy), focus is
  override, faces (only with a local `TT_FACE_CMD`), motion centroid, else centre; music is loudness-normalised to
  -14 LUFS and never loops; photo sets are capped at 35 images (constant to confirm against the live composer); drafts
  carry captions linted by `tiktok-content` and the `publish prepare` command, and nothing is published.
- tiktok: "too many attempts" is read from a JSON answer's own error message (non-zero status), no longer
  from post captions or comments, so a caption with those words no longer stops a read (capture.js and the
  terminal client). compose.js also records files dropped onto the page, so a dropped replacement video makes
  `publish begin` refuse instead of passing on the earlier file.
- breakdown: shot image times (`first_t`, `mid_t`, `last_t`, `strip_times`, burned labels) stay on the video
  clock when the video track starts late; only the seek uses the file's clock.
- test: live tag/music fixtures no longer carry real sound titles, artist names or sound ids; the fixture
  privacy test now checks sound authors and titles.
- tiktok: verified live on 2026-11-19: a private video published end to end with the new byte check
  (`publish begin` accepted the recorded bytes; reconcile settled `published` after review). Hashtag
  and sound reads ran on live `/tag/claude` and a `/music` page; their redacted shapes are now
  fixtures. SKILL.md notes the "Continue to post?" dialog and the browser tool's output limits.
- tiktok: browser reads stop on "too many attempts" answers (even with HTTP 200) and on a refused
  request (HTTP 401/403, empty body included); status 10222 reads as `private` on the capture path.
- tiktok: `publish begin` refuses a video page state with no record of the bytes handed to the page,
  as it already did for photos. `publish reconcile` lists an approved AI label or disclosure under
  `checkInApp` (Studio does not show them).
- tiktok-content: caption-lint honours `TIKTOK_CAPTION_MAX`, like `publish prepare`.
- tiktok-video-breakdown: `frames` reads the breakdown's working file (the constant-rate copy) and
  takes `--from`/`--to` on the video clock.
- README and manifests say which skills are built and which are planned; dropped the `test:live`
  script that pointed at a missing file.

- tiktok-video-breakdown: cuts are measured and stored as frames (`breakdown.json` `timebase` and
  `cuts.frames`; seconds are derived). A variable-rate source is analysed on a constant-rate copy
  (`source/work_cfr.mp4`). `--add-cut` moves to the strongest change within 2 frames and reports it
  (`snapped`); new `--add-cut-frame`; corrections are kept per working file and moved from seconds
  to frames on first use. `analysis_id` covers the file hash, the rate and the frame cuts.
- tiktok: media projection (play URLs, caption tracks, music), list coverage (`exhausted`), list identity checks
  (`mixed_lists`), and hashtag and sound reads from captures.
- tiktok-video-breakdown: guarded CDN downloader (no cookies to CDN hosts, signed URLs redacted), `fetch` from
  captures or `--file`, shots, audio, transcript and breakdown, local-only transcription.
- tiktok-content: hook triple scoring, caption linting with TikTok limits (video and photo posts), beats,
  AI-tell and slop checks.
- tiktok-audit: account audit from operator reads, with account vs sample coverage and a profile rubric.
- tiktok-research: per-creator outliers and recurring sounds and hashtags from hashtag, sound and profile reads.
- Fixtures: every third-party value synthetic (`synthetic_*` handles, `SYNTH:` text, no secUid), checked by a test.
- Scaffold: Agent Plugins, Claude Code and Codex manifests, README, test harness.

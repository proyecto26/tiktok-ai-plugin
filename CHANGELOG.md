# Changelog

## Unreleased

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

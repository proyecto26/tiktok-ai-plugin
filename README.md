# 🎵 TikTok AI Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Plugin-blueviolet)](https://code.claude.com/docs/en/plugins)
[![Agent Plugins](https://img.shields.io/badge/Agent_Plugins-1.0-orange)](https://agent-plugins.org/specification)
[![Skills](https://img.shields.io/badge/Skills-1_of_8-brightgreen)](#-the-essentials-kit-features)
[![TypeScript](https://img.shields.io/badge/TypeScript-Bun-blue)](https://bun.sh)

<img src="https://github.com/proyecto26/sherlock-ai-plugin/blob/main/images/claude-mascot-jumping-animated.svg" width="150">

> **Your TikTok, driven from the terminal by Claude Code, Codex, Cursor, Copilot CLI or any agent that runs shell commands.**

TikTok AI Plugin signs in with **your own browser session** and uses the same web flows tiktok.com
and TikTok Studio use. No TikTok API app, no Apify, no Groq, no cloud renderer: only npm, Python,
ComfyUI, Homebrew and open-source packages running on your machine.

Every write is a dry run until you approve the exact post. There are no like, follow or DM
commands, by design.

> **Status: phase 2.** The `tiktok` operator does login, reads and publishing. A private video and a
> private photo carousel have been published end to end on a real account; non-private posts, the AI
> label and the disclosure toggle still need `--experimental` until each has passed live. The other skills below are
> planned and marked so.

---

## 🧰 The Essentials Kit (Features)

### 📱 **1. TikTok (The Operator)**
*The client every other skill stands on.*
- **Cookie login**: Chrome opens with a dedicated profile, you sign in (2FA is fine), and the
  session cookies are captured through the local DevTools protocol. You can also import cookies
  from Cookie-Editor JSON, `cookies.txt` or a raw `Cookie:` header.
- **Reads**: profiles, videos, a single video and its comments, from the data the web pages embed
  first. Every result says which source answered and whether it is complete.
- **Publishing**: videos and photo posts through TikTok Studio's own web flow in your Chrome. Every
  post is a dry run first and needs your yes; the attempt is recorded before Post is clicked, and an
  unclear outcome stays open so nothing is posted twice. Private video and private photo posts are
  verified live; other variants are `--experimental`.

### ✍️ **2. TikTok Content (The Writer)** *(planned)*
*Hooks, scripts, captions and plans that sound like a person.* Hook scoring, caption linting,
repurposing and a content calendar.

### 🔎 **3. TikTok Audit (The Analyst)** *(planned)*
*Your account against its own median.* Formats, cadence, hooks and outliers from real posts.

### 🕵️ **4. TikTok Research (The Detective)** *(planned)*
*What works in your niche.* Competitors and outlier videos, read with your session.

### 💰 **5. TikTok Ads (The Strategist)** *(planned)*
*Monetization and Promote, read-only advice.* You create campaigns in the app or Ads Manager.

### 🎬 **6. TikTok Video Breakdown (The Editor)** *(planned)*
*Any TikTok into shots and script.* Download with your session (yt-dlp as fallback), cut-based
frames with ffmpeg, TikTok's own captions or local Whisper, and an `.srt`.

### 🎭 **7. TikTok Video Remake (The Director)** *(planned)*
*Replace one person in a video you may remake* with MiniMax H3 in a local ComfyUI, 1080x1920.

### 🧳 **8. TikTok Travel Studio (The Producer)** *(planned)*
*Your travel backlog into drafts.* Local `drafts.json` of clips and photo posts; it never
publishes on its own.

## ⚠️ Read this first: account risk

This plugin uses TikTok's web endpoints with your own session. That is how your browser talks to
TikTok, but it is **not an official API**, and automated use may break TikTok's Terms of Service.
TikTok can rate-limit, challenge or restrict accounts it believes are automated. The plugin is
built to stay conservative:

- Every write is a **dry run** until you approve the exact post.
- Requests are spaced at least 1.5 s apart. On HTTP 429, a captcha, a verification page or "too
  many attempts" the CLI **stops**, marks the account and never retries in a loop; `resume` clears
  it once you have dealt with it in the browser.
- There are **no** like, follow, unfollow, DM or delete commands.
- Cookies are stored only in a folder locked to your user (icacls on Windows, 0700/0600
  elsewhere). If that lock fails, nothing is saved. Cookie values are never printed.

Use a test account first. You are responsible for how you use your account.

---

## 🚀 Quick Start

### Requirements

- Node.js (for `npx`). Bun is fetched on demand by `npx -y bun`, with zero npm dependencies.
- Google Chrome, Chromium or Edge for `login`, or an exported cookie file.
- ffmpeg and ffprobe for the video skills (planned); a local ComfyUI with MiniMax H3 for the remake.

### Standards

This plugin follows the [Agent Plugins](https://agent-plugins.org/) v1.0.0 packaging standard
(root [`plugin.json`](./plugin.json)) and every skill follows the [Agent Skills](https://agentskills.io/)
spec (`skills/<name>/SKILL.md`). It also ships the Claude Code manifests
(`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) and the Codex manifests
(`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`). Run
`bash scripts/check-manifests.sh` to confirm they agree.

### Installation

#### Option 1: CLI Install (Recommended)

Use [npx skills](https://github.com/vercel-labs/skills) to install skills directly:

```bash
# Install all skills
npx skills add proyecto26/tiktok-ai-plugin

# Install specific skills
npx skills add proyecto26/tiktok-ai-plugin --skill tiktok

# List available skills
npx skills add proyecto26/tiktok-ai-plugin --list
```

#### Option 2: Claude Code Plugin

```bash
# Add the marketplace
/plugin marketplace add proyecto26/tiktok-ai-plugin

# Install the plugin
/plugin install tiktok-ai-plugin
```

#### Option 3: Codex / Cursor / Copilot CLI (Agent Plugins)

| Host | Install |
|------|---------|
| **OpenAI Codex** | `codex plugin marketplace add proyecto26/tiktok-ai-plugin` then `codex plugin add tiktok-ai-plugin@tiktok-ai-plugin-marketplace` (or pick it from `/plugins`) |
| **GitHub Copilot CLI** | `copilot plugin marketplace add proyecto26/tiktok-ai-plugin` then `copilot plugin install tiktok-ai-plugin@tiktok-ai-plugin-marketplace` |
| **Cursor** | Settings → Plugins → install from Git URL `https://github.com/proyecto26/tiktok-ai-plugin` |

Skills are discovered from `skills/`, so adding a skill is a one-directory change.

#### Option 4: Clone and Copy

```bash
git clone https://github.com/proyecto26/tiktok-ai-plugin.git
cp -r tiktok-ai-plugin/skills/* .claude/skills/
```

#### Option 5: Git Submodule

```bash
git submodule add https://github.com/proyecto26/tiktok-ai-plugin.git .claude/tiktok-ai-plugin
```

Then reference skills from `.claude/tiktok-ai-plugin/skills/`.

#### Option 6: Fork and Customize

1. Fork this repository
2. Customize the skills for your brand and niche
3. Clone your fork into your projects

### Authentication

Just tell your agent:

> *"Log me into TikTok"*

Chrome opens with a dedicated profile. Sign in and the CLI picks up the session cookies. Or run it
yourself:

```bash
npx -y bun skills/tiktok/scripts/main.ts login     # Chrome opens; sign in
npx -y bun skills/tiktok/scripts/main.ts status    # session state, cookie names only
```

Sessions expire. If a command answers `auth`, run `login` again.

## 🧪 Development

```bash
cd test
npm install                     # dev-only: typescript + types
npx tsc --noEmit
npx -y bun test unit            # offline; network is trapped in the CLI tests
bash ../scripts/check-manifests.sh
```

## 🚧 Known Limitations

- **Publishing is partly experimental.** Private video and private photo posts have passed live;
  non-private posts, the AI label and disclosure need `--experimental`. The page is checked against the
  approval by caption, privacy and toggles; a video by file name (a different file with the same name
  would pass), photos by the exact bytes given to the page's file input plus a visual fingerprint of each
  editor thumbnail (a close re-edit dropped into the editor could pass).
  The page must show no location. Studio rows carry no post id, only text and a minute, so another post with
  the same text in the same window could settle an attempt whose own Post failed: post nothing else with
  matching text until it is settled. The cover is left at TikTok's default: look at the preview before Post. Files over 10 MB are picked in the page by you.
- **No hashtag or search reads yet**, and no scheduling (Studio blocks scheduling for private posts).
- **Private endpoints change.** Field names and page data can move; every read reports its source.
- **No TikTok analytics API.** Watch time, traffic sources and follower growth live in TikTok
  Studio's analytics and are not estimated.

---

## 🌟 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=proyecto26/tiktok-ai-plugin&type=Date)](https://star-history.com/#proyecto26/tiktok-ai-plugin&Date)

## 💜 Sponsors

This project is free and open source. Sponsors help keep it maintained and growing.

[**Become a Sponsor**](https://github.com/sponsors/proyecto26) | [Sponsorship Program](https://proyecto26.com/sponsors/)

## 🤝 Contribution

When contributing to this repository, please first discuss the change you wish to make via issue,
email, or any other method with the owners of this repository before making a change.

Contributions are what make the open-source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated** ❤️.

You can learn more about how you can contribute to this project in the [contribution guide](https://github.com/proyecto26/.github/blob/master/CONTRIBUTING.md).

## ⚖️ License

This repository is available under the [MIT License](./LICENSE).

## 👍 Credits

- [instagram-ai-plugin](https://github.com/proyecto26/instagram-ai-plugin): the operator, cookie store and CDP login this plugin ports
- [marketingskills](https://github.com/coreyhaines31/marketingskills) (MIT, Corey Haines): the marketing skills the content and ads skills adapt
- [notebooklm-ai-plugin](https://github.com/proyecto26/notebooklm-ai-plugin): Chrome DevTools login helpers
- [sherlock-ai-plugin](https://github.com/proyecto26/sherlock-ai-plugin): plugin layout and CDP authentication patterns

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Not affiliated with, endorsed by, or sponsored by TikTok or ByteDance.

## Happy vibe posting 💯
Made with ❤️ by [Proyecto 26](https://proyecto26.com) - Changing the world with small contributions.

One hand can accomplish great things, but many can take you into space and beyond! 🌌

Together we do more, together we are more ❤️ <img width="150px" src="https://avatars0.githubusercontent.com/u/28855608?s=200&v=4" align="right">

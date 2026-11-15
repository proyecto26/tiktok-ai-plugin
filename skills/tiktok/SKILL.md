---
name: tiktok
description: This skill should be used when the user asks to "sign in to TikTok", "log in to TikTok with cookies", "read my TikTok profile", "list my TikTok videos", "get the comments of this TikTok", "check my TikTok session", or wants to drive their own TikTok account from the terminal with their browser session (no TikTok API app, no Apify). It is the operator every other tiktok-* skill stands on. Publishing videos and photo posts is being added after the upload flow is verified.
---

# TikTok (The Operator)

Drive your own TikTok account with your browser session. Every command runs with:

```bash
npx -y bun skills/tiktok/scripts/main.ts <command> [options]
```

## Commands (phase 1)

| Command | What it does |
|---|---|
| `login` | Opens Chrome with a dedicated profile; you sign in (2FA is fine); the session cookies are captured over the local DevTools protocol |
| `import-cookies --file <path>` | Imports Cookie-Editor JSON, `cookies.txt` or a raw `Cookie:` header (only `.tiktok.com` cookies are kept) |
| `logout` | Deletes the stored session |
| `status` | Signed in or not, cookie names (never values), and whether the account is stopped by a signal |
| `resume` | Clears the account signal after you resolved a captcha or verification in the browser |

## Rules

- Cookie values are never printed. The cookie store is locked to your user; if that lock fails nothing is saved.
- On HTTP 429, a captcha, a verification page or "too many attempts" every command stops and the account is
  marked with a signal; nothing runs again until you run `resume`. There are no retry loops.
- There are no like, follow, unfollow, DM or delete commands, by design.

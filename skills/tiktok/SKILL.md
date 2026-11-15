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
| `whoami` | The signed-in account (one paced request) |
| `profile --capture <file>` | Profile and stats from a browser capture |
| `videos --capture <file> [--limit N]` | Posts (default 20, max 200), videos and photo posts |
| `video --capture <file>` | One post |
| `comments --capture <file> [--limit N]` | Comments of a post |

## Reading through your own Chrome

TikTok answers plain HTTP page loads with a "Please wait" WAF page, and its list APIs need signatures that only
its own page code makes. So reads happen in **your normal Chrome** (claude-in-chrome), where you are already
signed in:

1. Open one tab on the profile or post. Wait for it to load.
2. Run the text of `scripts/browser/capture.js` in the tab (javascript_tool). It installs a read-only hook that
   copies the JSON answers the page fetches for itself, and returns a `tt.capture.v1` capture.
3. To load more posts or comments, run `window.__ttCapture.more()` (one scroll, at most 10 per page), wait
   several seconds, and run the script again to collect.
4. Save the returned JSON to a file and run the matching command above.

Every result is `{source, data, complete, reason?}`. `complete: false` says why: `signed_list_api` (no list
answer was captured, only what the page embedded), `not_scrolled_far_enough`, or `request_budget`.

Pace yourself: one tab, few page loads, long pauses. A 403 "Access denied" page, a captcha or a "Please wait"
page means stop: write nothing more, close the tab and tell the user.

## Rules

- Cookie values are never printed. The cookie store is locked to your user; if that lock fails nothing is saved.
- On HTTP 429, a captcha, a verification page or "too many attempts" every command stops and the account is
  marked with a signal; nothing runs again until you run `resume`. There are no retry loops.
- There are no like, follow, unfollow, DM or delete commands, by design.

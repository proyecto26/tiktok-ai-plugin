import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SKILLS = resolve(import.meta.dir, "../../skills");

function docs(): string[] {
  const out: string[] = [];
  for (const skill of readdirSync(SKILLS)) {
    const dir = join(SKILLS, skill);
    if (!statSync(dir).isDirectory()) continue;
    const skillMd = join(dir, "SKILL.md");
    try {
      statSync(skillMd);
      out.push(skillMd);
    } catch {}
    const refs = join(dir, "references");
    try {
      for (const f of readdirSync(refs)) if (f.endsWith(".md")) out.push(join(refs, f));
    } catch {}
  }
  return out;
}

const files = docs().filter((f) => !/(LICENSE|NOTICE)/i.test(f));
const text = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

const CLIENT_SPECIFIC: RegExp[] = [
  /javascript_tool/,
  /claude-in-chrome/,
  /AskUserQuestion/,
  /\bBash tool\b/,
  /\bRead tool\b/,
  /mcp__/,
  /\bTask tool\b/,
  /TodoWrite/,
  /Claude Code/,
];

const CONSENT_GATES: RegExp[] = [
  /do you have (the )?(consent|rights|permission)/i,
  /confirm (that )?you (own|have)/i,
  /--consent\b|--rights\b/,
  /ask (the user )?for (consent|permission|rights)/i,
  /(owner|user) (is|are) allowed to use/i,
  /allowed to use (it|the (material|video|footage|sound))/i,
  /\b(decline|refuse) (that part|to (fetch|download|break))/i,
];

const SKIP_SENSITIVE: RegExp[] = [
  /\b(skip|refuse|decline|avoid|do not (fetch|process|break down))\b[^.\n]{0,80}\b(age-restricted|sensitive)/i,
  /\b(age-restricted|sensitive)\b[^.\n]{0,60}\b(is|are) (skipped|refused|declined|not fetched)/i,
];

describe("skill text", () => {
  test("finds the skill documents", () => {
    expect(files.length).toBeGreaterThan(16);
  });
  for (const f of files) {
    const name = f.slice(SKILLS.length + 1);
    test(`${name}: no client-specific tool names`, () => {
      for (const re of CLIENT_SPECIFIC) expect(text(f)).not.toMatch(re);
    });
    test(`${name}: no consent or rights gates`, () => {
      for (const re of CONSENT_GATES) expect(text(f)).not.toMatch(re);
    });
    test(`${name}: does not skip sensitive or age-restricted posts`, () => {
      for (const re of SKIP_SENSITIVE) expect(text(f)).not.toMatch(re);
    });
  }
  test("breakdown keeps the source audio and does not forbid lifting it", () => {
    const t = text(join(SKILLS, "tiktok-video-breakdown/SKILL.md"));
    expect(t).not.toMatch(/do not lift the audio/i);
    expect(t).not.toMatch(/do not re-upload/i);
    expect(t).toMatch(/keeps? the source audio|source audio/i);
  });
  test("remake keeps its content limits and AI label line", () => {
    const t = text(join(SKILLS, "tiktok-video-remake/SKILL.md"));
    expect(t).toMatch(/Never depict a minor/);
    expect(t).toMatch(/AI-generated/);
  });
  test("every SKILL.md lists its commands", () => {
    for (const f of files.filter((x) => x.endsWith("SKILL.md"))) {
      expect(text(f)).toMatch(/\|\s*`[^`]+`\s*\||npx -y bun /);
    }
  });
});

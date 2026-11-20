import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RepoSnapshot } from "./protocol";

const MAX_FILES = 5000;
const MAX_LISTED = 50;
const SKIP = new Set([".git", "node_modules"]);

const hash = (s: string) => createHash("sha1").update(s).digest("hex");

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
}

function stamp(file: string): string {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "gone";
  }
}

function walk(root: string, rel: string, out: string[]): void {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (out.length >= MAX_FILES) return;
    if (SKIP.has(entry.name)) continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, r, out);
    else out.push(`${r}:${stamp(join(root, r))}`);
  }
}

export function snapshot(dir: string, isGit: boolean): RepoSnapshot {
  if (!isGit) {
    const entries: string[] = [];
    walk(dir, "", entries);
    return { dirty: false, changedFiles: [], fingerprint: hash(entries.sort().join("\n")) };
  }
  const status = git(dir, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const changedFiles = status.split("\n").filter(Boolean).map((l) => l.slice(3));
  let head = "";
  try {
    head = git(dir, ["rev-parse", "HEAD"]).trim();
  } catch {
    head = "no-commits";
  }
  const stamps = changedFiles.map((f) => `${f}:${stamp(join(dir, f))}`).join("\n");
  return {
    branch: git(dir, ["branch", "--show-current"]).trim() || undefined,
    dirty: changedFiles.length > 0,
    changedFiles: changedFiles.slice(0, MAX_LISTED),
    fingerprint: hash(`${head}\n${status}\n${stamps}`),
  };
}

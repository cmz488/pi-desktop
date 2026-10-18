import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
/* The header label is display-only; the Git pane owns authoritative reads. A
 * short reuse window keeps every /api/state from spawning git processes. */
const INFO_TTL_MS = 1500;
const cache = new Map();
export async function gitInfo(cwd) {
  const cached = cache.get(cwd);
  const now = Date.now();
  if (cached && now - cached.at < INFO_TTL_MS) return cached.value;
  const value = await readGitInfo(cwd);
  // Only repository answers are worth reusing: "not a repository" must stay
  // observable the moment a project is initialized.
  if (value) {
    if (cache.size > 64) cache.clear();
    cache.set(cwd, { at: now, value });
  } else cache.delete(cwd);
  return value;
}
/** A Git write can move the branch; the next read must not reuse the label. */
export function forgetGitInfo(cwd) {
  cache.delete(cwd);
}
async function readGitInfo(cwd) {
  const run = async (args) =>
    (
      await execute("git", args, {
        cwd,
        timeout: 1500,
        maxBuffer: 4096,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      })
    ).stdout.trim();
  try {
    return {
      branch: await run(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      detached: false,
    };
  } catch {
    try {
      return {
        branch: await run(["rev-parse", "--short", "HEAD"]),
        detached: true,
      };
    } catch {
      return null;
    }
  }
}

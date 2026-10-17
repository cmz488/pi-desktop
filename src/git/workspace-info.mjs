import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
export async function gitInfo(cwd) {
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

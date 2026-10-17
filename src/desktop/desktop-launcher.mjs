import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function desktopAddress(address) {
  const url = new URL(address);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("Desktop 只能连接不含凭据的本机 Pi-Agent 地址");
  return url.href;
}

async function electronBinary() {
  const explicit = process.env.PI_DESK_ELECTRON;
  if (explicit) {
    await access(explicit, constants.X_OK);
    return explicit;
  }
  const candidates = [];
  try {
    candidates.push(createRequire(import.meta.url)("electron"));
  } catch {
    /* Optional dependency may not have downloaded its executable. */
  }
  candidates.push("/usr/bin/electron43", "/usr/bin/electron");
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next known executable; report failure if none works. */
    }
  }
  throw new Error(
    "未找到 Electron；运行 npm rebuild electron，或用 PI_DESK_ELECTRON 指定可执行文件。Web 服务仍可使用。",
  );
}

// A detached frontend must not inherit the TUI's input or output streams.
// TUI passes its URL. Standalone Desktop receives options and owns its Harness.
export async function launchDesktop(
  address,
  { detached = true, options = {} } = {},
) {
  const child = spawn(
    await electronBinary(),
    [
      fileURLToPath(new URL("./desktop.mjs", import.meta.url)),
      ...(address
        ? [desktopAddress(address)]
        : ["--managed", JSON.stringify(options)]),
    ],
    { detached, stdio: detached ? "ignore" : "inherit" },
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  if (detached) child.unref();
  return child;
}

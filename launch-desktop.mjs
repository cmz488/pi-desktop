#!/usr/bin/env node
import { launchDesktop } from "./src/desktop/desktop-launcher.mjs";
import { deskOptions } from "./desk.mjs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const usage =
  "pi-desktop [--cwd PATH] [--agent-dir PATH] [--data-dir PATH] [--extension MODULE] [--port PORT] [--single-process]\n无需先启动 TUI；默认启动 Desktop 界面。指定 --port 可保留本机 Web 服务端口。传入本机 URL 可附加已有宿主。\n";

/** Launch Electron by default; an explicit loopback URL attaches an existing Pi host. */
export async function desktopMain(
  args = process.argv.slice(2),
  {
    launch = launchDesktop,
    output = process.stdout,
    processTarget = process,
  } = {},
) {
  const address = args.find((argument) => /^https?:\/\//.test(argument));
  const options = address ? {} : deskOptions(args);
  if (options.help) {
    output.write(usage);
    return undefined;
  }
  const child = await launch(address, { detached: false, options });
  const signals = new Map();
  const cleanup = () => {
    for (const [signal, listener] of signals)
      processTarget.removeListener(signal, listener);
  };
  child.once("exit", (code) => {
    cleanup();
    processTarget.exitCode = code ?? 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const listener = () => child.kill(signal);
    signals.set(signal, listener);
    processTarget.on(signal, listener);
  }
  return child;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  desktopMain().catch((error) => {
    process.stderr.write(`Pi Desktop 启动失败：${error.message}\n`);
    process.exitCode = 1;
  });
}

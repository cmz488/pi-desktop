import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startDurableDesk } from "./src/server/durable-server.mjs";
import { startDesktopHost } from "./src/control-plane/server.mjs";

export function deskOptions(args) {
  const options = { extensionPaths: [] };
  const keys = {
    "--cwd": "cwd",
    "--agent-dir": "agentDir",
    "--data-dir": "directory",
    "--host": "host",
    "--port": "port",
    "--tls-cert": "certPath",
    "--tls-key": "keyPath",
  };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (["--help", "-h"].includes(name)) return { help: true };
    if (name === "--single-process") {
      options.singleProcess = true;
      continue;
    }
    if (name === "--no-extensions") {
      options.noExtensions = true;
      continue;
    }
    if (name === "--extension" && args[index + 1]) {
      options.extensionPaths.push(args[++index]);
      continue;
    }
    if (!keys[name] || !args[index + 1])
      throw new Error(`未知或不完整参数：${name}`);
    options[keys[name]] = args[++index];
  }
  return options;
}
export async function deskMain(args = process.argv.slice(2)) {
  const options = deskOptions(args);
  if (options.help) {
    process.stdout.write(
      "pi web · 多项目 Desktop 工作空间\n[--cwd PATH] [--agent-dir PATH] [--data-dir PATH] [--port PORT] [--extension MODULE] [--no-extensions]\n每个 Agent 运行独立 Pi Durable 进程。--single-process 使用原单宿主入口，支持 --host、TLS 和远程连接。\n",
    );
    return;
  }
  const app = await (
    options.singleProcess ? startDurableDesk : startDesktopHost
  )(options);
  process.stdout.write(`Pi Desk · Pi Durable\n${app.url}\n`);
  const stop = async () => {
    await app.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  return app;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  deskMain().catch((error) => {
    process.stderr.write(`Pi Desk 启动失败：${error.message}\n`);
    process.exitCode = 1;
  });

import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  lstat,
  unlink,
  realpath,
} from "node:fs/promises";
import { join, resolve, delimiter } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const marker = "// pi-desktop-extension launcher v1";
const dir = resolve(
  process.env.PI_WEB_BIN_DIR ?? join(homedir(), ".local", "bin"),
);
const destination = join(dir, process.platform === "win32" ? "pi.cmd" : "pi");
if (process.platform === "win32")
  throw new Error(
    "Windows 请使用 pi-web；pi web 的 PATH 适配器目前支持 Linux/macOS。",
  );
let existing;
try {
  await lstat(destination);
  existing = await readFile(destination, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (process.argv.includes("--remove")) {
  if (!existing?.includes(marker))
    throw new Error("没有本包安装的启动适配器；保留现有命令。");
  await unlink(destination);
  process.stdout.write(`已移除 ${destination}；原版 pi 未改动。\n`);
} else {
  if (existing && !existing.includes(marker))
    throw new Error(
      "目标位置已有其他 pi 命令；不会覆盖。可通过 PI_WEB_BIN_DIR 指定独立目录。",
    );
  let original = process.env.PI_WEB_NATIVE_PI;
  if (!original && existing)
    original = JSON.parse(
      existing.match(/const nativePi=(.*);/)?.[1] ?? "null",
    );
  if (!original)
    for (const path of process.env.PATH.split(delimiter)) {
      // npm run injects the package's peer CLI before the user's real Pi command.
      if (
        process.env.npm_lifecycle_event &&
        /node_modules[\\/]\.bin$/.test(path)
      )
        continue;
      const candidate = join(path, "pi");
      if (resolve(candidate) === destination) continue;
      try {
        const target = await realpath(candidate);
        if (target !== destination) {
          original = resolve(candidate);
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  if (!original || resolve(original) === destination)
    throw new Error("没有找到原版 pi；请先安装 pi，或设置 PI_WEB_NATIVE_PI。");
  const entry = fileURLToPath(new URL("../../desk.mjs", import.meta.url));
  const content = `#!/usr/bin/env node\n${marker}\nimport { spawn } from 'node:child_process';\nconst nativePi=${JSON.stringify(resolve(original))};\nconst webEntry=${JSON.stringify(entry)};\nconst args=process.argv.slice(2);\nconst child=args[0]==='web'?spawn(process.execPath,[webEntry,...args.slice(1)],{stdio:'inherit',env:{...process.env,PI_WEB_NATIVE_PI:nativePi}}):spawn(nativePi,args,{stdio:'inherit'});\nfor(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));\nchild.on('error',()=>{process.stderr.write('无法启动 pi，请检查原版命令或重新安装启动适配器。\\n');process.exitCode=1;});\nchild.on('exit',(code,signal)=>{process.exitCode=code??(signal==='SIGINT'?130:143);});\n`;
  await mkdir(dir, { recursive: true });
  await writeFile(destination, content, { mode: 0o755 });
  await chmod(destination, 0o755);
  process.stdout.write(
    `已安装 ${destination}\n原版命令保留：${original}\n使用：pi web；卸载：npm run uninstall:launcher\n`,
  );
}

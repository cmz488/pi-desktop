import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * 构建 Percho 渲染层，并把产物登记成浏览器端可提供的白名单。
 *
 * 接口：`node src/ui-next/build.mjs`；产出 `build/ui-next/` 与 `src/ui-next/generated-assets.mjs`。
 * 不变量：白名单由真实产物生成，不手写。资产服务只认这张表（见 `web-assets.mjs`），
 *   手写名单一旦与产物不一致，页面就会 404 而测试看不出来。
 * 为什么生成：vite 会为 mermaid 等依赖产出带 hash 的分块名，无法预先枚举。
 * 错误：vite 构建失败时原样抛出并保留其输出；产物缺失时不覆盖旧白名单。
 */
const exec = promisify(execFile);
const packageRoot = new URL("../../", import.meta.url);
const outDir = new URL("build/ui-next/", packageRoot);
const generated = new URL("src/ui-next/generated-assets.mjs", packageRoot);

const CONTENT_TYPES = new Map([
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".css", "text/css"],
  [".html", "text/html"],
  [".json", "application/json"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".map", "application/json"],
  [".txt", "text/plain"],
]);

/** 递归列出产物文件，返回相对 `build/ui-next/` 的 posix 路径。 */
async function walk(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(new URL(`${entry.name}/`, directory), relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

export async function buildUi() {
  await exec(
    process.execPath,
    [
      fileURLToPath(new URL("../../node_modules/vite/bin/vite.js", import.meta.url)),
      "build",
      "--config",
      fileURLToPath(new URL("vite.config.mjs", import.meta.url)),
    ],
    { cwd: fileURLToPath(packageRoot), maxBuffer: 64 * 1024 * 1024 },
  );

  const files = (await walk(outDir)).sort();
  if (!files.includes("index.html"))
    throw new Error("构建产物缺少 index.html，拒绝登记白名单");
  if (!files.some((file) => file.startsWith("assets/") && file.endsWith(".js")))
    throw new Error("构建产物缺少脚本，拒绝登记白名单");

  const rows = [];
  for (const file of files) {
    const extension = file.slice(file.lastIndexOf("."));
    const type = CONTENT_TYPES.get(extension);
    // 未知扩展名直接失败：猜一个 MIME 会让浏览器拒绝加载而没人知道为什么。
    if (!type) throw new Error(`构建产物有未知扩展名：${file}`);
    rows.push({ url: `/ui-next/${file}`, file: `build/ui-next/${file}`, type });
  }

  const body = [
    "/**",
    " * 由 `src/ui-next/build.mjs` 生成，请勿手改。",
    " *",
    " * 内容：Percho 渲染层的构建产物清单（URL → 磁盘文件 + MIME）。",
    " * `asset-manifest.mjs` 把它并入公共资产白名单；资产服务只提供这里列出的文件。",
    " */",
    "export const UI_NEXT_ASSETS = Object.freeze([",
    ...rows.map(
      (row) =>
        `  Object.freeze({ url: ${JSON.stringify(row.url)}, file: ${JSON.stringify(row.file)}, type: ${JSON.stringify(row.type)} }),`,
    ),
    "]);",
    "",
  ].join("\n");

  await mkdir(new URL("src/ui-next/", packageRoot), { recursive: true });
  await writeFile(generated, body);
  return { files: rows.length, outDir: fileURLToPath(outDir) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await buildUi();
  console.log(`ui-next: ${result.files} 个产物 → ${result.outDir}`);
}

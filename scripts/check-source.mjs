import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const files = (await readdir(root)).filter((file) =>
  /\.(mjs|cjs|js)$/.test(file),
);
for (const directory of ["src", "scripts"]) {
  for (const file of await readdir(new URL(`${directory}/`, root), {
    recursive: true,
  }))
    if (/\.(mjs|cjs|js)$/.test(file)) files.push(`${directory}/${file}`);
}
for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ["--check", fileURLToPath(new URL(file, root))],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax checked ${files.length} source files.`);

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import ts from "typescript";
import manifest from "../package.json" with { type: "json" };

const repository = fileURLToPath(new URL("../", import.meta.url));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result.stdout;
};
const root = await mkdtemp(join(tmpdir(), "pi-desktop-package-"));
let server;
try {
  // A real tarball, extracted away from the repository, exposes missing files
  // that a source-tree check or dry-run-only assertion would silently mask.
  const data = JSON.parse(
    run(process.platform === "win32" ? "npm.cmd" : "npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      root,
    ]),
  );
  const pack = Array.isArray(data) ? data[0] : (data[manifest.name] ?? data);
  const files = new Set(pack.files.map((row) => row.path));
  const unpack = join(root, "unpacked");
  await mkdir(unpack);
  run("tar", ["-xzf", join(root, pack.filename), "-C", unpack]);
  const directory = join(unpack, "package");
  // Reuse installed dependencies only; never use source files as a fallback.
  await symlink(
    join(repository, "node_modules"),
    join(directory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const file of [
    "index.ts",
    "desk.mjs",
    "launch-desktop.mjs",
    "pi-command.mjs",
    "src/desktop/desktop.mjs",
    "src/control-plane/server.mjs",
    "src/server/asset-manifest.mjs",
    "docs/README.md",
    "examples/desk-extension.mjs",
    "README.md",
    "CONTEXT.md",
    "CONTRIBUTING.md",
    "DESIGN.md",
    "SOURCES.md",
    "LICENSE",
    "NOTICE",
  ])
    assert(files.has(file), `npm package is missing ${file}`);
  for (const file of files)
    assert(
      !/^(?:test|\.reference|\.desktop-data|coverage|screenshots|dist)\//.test(
        file,
      ),
      `development data leaked: ${file}`,
    );
  // Check Node/TypeScript references inside the tarball, where temporary
  // migration aliases cannot conceal an import of a removed source path.
  for (const file of files) {
    if (!/\.(?:mjs|cjs|ts)$/.test(file) || file.startsWith("src/ui/")) continue;
    const content = await readFile(join(directory, file), "utf8");
    const tree = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
    );
    const imports = [];
    function visit(node) {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;
      if (
        specifier &&
        ts.isStringLiteral(specifier) &&
        specifier.text.startsWith(".")
      )
        imports.push(specifier.text);
      ts.forEachChild(node, visit);
    }
    visit(tree);
    for (const specifier of imports) {
      const target = resolve(directory, dirname(file), specifier);
      const candidates = [target];
      // Pi's TypeScript loader resolves emitted .js specifiers to .ts sources.
      if (file.endsWith(".ts") && target.endsWith(".js"))
        candidates.push(target.slice(0, -3) + ".ts");
      assert(
        candidates.some((path) => files.has(relative(directory, path))),
        `broken packaged module import: ${file} -> ${specifier}`,
      );
    }
  }
  const { publicAssets, assetFile } = await import(
    pathToFileURL(join(directory, "src/server/asset-manifest.mjs"))
  );
  const { createStaticAssetHandler } = await import(
    pathToFileURL(join(directory, "src/server/web-assets.mjs"))
  );
  const handlers = new Map();
  for (const page of ["chat", "workspace", "preview"]) {
    const assets = publicAssets(page);
    for (const [file] of assets.values()) {
      await stat(assetFile(file));
      if (!file.startsWith("file:"))
        assert(files.has(file), `public asset omitted: ${file}`);
    }
    handlers.set(page, createStaticAssetHandler(assets));
  }
  let active;
  server = createServer((request, response) => {
    void active(
      request,
      response,
      new URL(request.url, "http://localhost").pathname,
    )
      .then((served) => {
        if (!served) {
          response.writeHead(404);
          response.end();
        }
      })
      .catch((error) => {
        response.writeHead(500);
        response.end(error.message);
      });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const page of handlers.keys()) {
    active = handlers.get(page);
    const pending = ["/"],
      visited = new Set();
    while (pending.length) {
      const path = pending.pop();
      if (visited.has(path)) continue;
      visited.add(path);
      const response = await fetch(origin + path);
      assert.equal(
        response.status,
        200,
        `${page} browser asset is missing: ${path}`,
      );
      const content = await response.text(),
        type = response.headers.get("content-type");
      const add = (specifier) => {
        if (!specifier || /^(?:[a-z]+:|#|\/\/)/i.test(specifier)) return;
        pending.push(new URL(specifier, origin + path).pathname);
      };
      if (type.includes("javascript")) {
        for (const [, specifier] of content.matchAll(
          /\b(?:from\s*|import\s*(?:\(\s*)?)["'](\.[^"']+)["']/g,
        ))
          add(specifier);
      } else if (type.includes("text/html")) {
        for (const [, specifier] of content.matchAll(
          /\b(?:src|href)=["']([^"'#]+)["']/g,
        ))
          add(specifier);
      } else if (type.includes("text/css")) {
        for (const [, specifier] of content.matchAll(
          /url\(["']?([^\s)"']+)["']?\)/g,
        ))
          add(specifier);
      }
    }
    assert.equal(
      (await fetch(origin + "/package.json")).status,
      404,
      "private package files must not be public assets",
    );
  }
  // All shipped documents must stand alone after npm installation.
  for (const file of files) {
    // Vendored legal notices retain upstream-relative references verbatim.
    if (!file.endsWith(".md") || file.startsWith("licenses/")) continue;
    const content = await readFile(join(directory, file), "utf8");
    for (const [, href] of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^(?:[a-z]+:|#|\/)/i.test(href)) continue;
      const path = decodeURIComponent(href.split(/[?#]/)[0]);
      if (!path) continue;
      const target = resolve(directory, dirname(file), path);
      assert(
        !relative(directory, target).startsWith(".."),
        `document escapes the package: ${file} -> ${href}`,
      );
      await stat(target).catch(() =>
        assert.fail(`broken packaged document link: ${file} -> ${href}`),
      );
    }
  }
  // Exercise the packaged Host with isolated storage and no Agent/model work.
  const { startDesktopHost } = await import(
    pathToFileURL(join(directory, "src/control-plane/server.mjs"))
  );
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const host = await startDesktopHost({
    agentDir,
    directory: join(root, "workspace"),
    defaultConversation: false,
  });
  try {
    assert.equal((await fetch(host.url)).status, 200);
    const response = await fetch(new URL("/api/workspace", host.url));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).agents, []);
  } finally {
    await host.stop();
  }
  assert.match(
    run(process.execPath, [join(directory, "launch-desktop.mjs"), "--help"]),
    /pi-desktop/,
  );
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.bin["pi-desktop"], "./launch-desktop.mjs");
  assert.equal(manifest.bin["pi-web"], "./pi-command.mjs");
  assert(manifest.dependencies.electron);
  console.log(
    `npm package verified from extracted tarball: ${pack.filename} · ${files.size} files · ${(pack.size / 1024).toFixed(0)} KiB · Host startup, modules, browser and document references complete`,
  );
} finally {
  if (server) await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
}

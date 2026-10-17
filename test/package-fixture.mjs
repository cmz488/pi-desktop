import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
export const packageFixtureName = "pi-desk-catalog-fixture";

export function catalogFixtureHtml(url) {
  const source = new URL(url);
  const name = packageFixtureName;
  if (source.pathname.startsWith("/packages/"))
    return `<!doctype html><main>
    <h1 class="content-title">${escape(source.pathname.slice("/packages/".length))}</h1>
    <p class="content-description">Official fixture summary</p>
    <dl class="definition-grid detail-grid"><dt>Package</dt><dd>${name}</dd><dt>Version</dt><dd>2.0.0</dd><dt>Published</dt><dd>Oct 2, 2026</dd><dt>Downloads</dt><dd>12.3K/mo · 4K/wk</dd><dt>Author</dt><dd>fixture-author</dd><dt>License</dt><dd>MIT</dd><dt>Types</dt><dd>extension, skill</dd><dt>Size</dt><dd>42 kB</dd><dt>Dependencies</dt><dd>0 dependencies</dd></dl>
    <pre class="raw-data-panel">{&quot;skills&quot;:[&quot;./skills&quot;]}</pre>
    <div class="packages-readme"><h1>Complete introduction</h1><p>${"Complete README content. ".repeat(4000)}FULL-README-END</p><a href="https://example.invalid/docs">Read documentation</a><a href="javascript:alert(1)">Unsafe link</a><a href="/packages/other" data-action="abort">Untrusted action attribute</a><img src="https://example.invalid/preview.png" onerror="window.catalogAttack=true"><iframe src="https://example.invalid/frame"></iframe><script>window.catalogAttack=true</script><button data-action="abort">Untrusted button</button></div></main>`;
  const page = Number(source.searchParams.get("page") ?? 1);
  const names = page === 1 ? [name, "@fixture/skills"] : ["pi-second-page"];
  const cards = names
    .map(
      (item, index) =>
        `<article data-package-card="true" data-package-name="${item}" data-package-types="${source.searchParams.get("type") || "extension skill"}" data-package-downloads="${12345 - index}" data-package-date="1790972865883"><h3 class="packages-name"><a href="/packages/${item}">${item}</a></h3><p class="packages-desc">${escape("Author summary <literal>")}</p><div class="packages-meta"><span>fixture-author</span><span>12.3K/mo</span><span>now</span></div><div class="packages-links"><a href="https://github.com/earendil-works/pi/issues/new?package-version=2.0.0">report</a></div><code>pi install npm:${item}</code></article>`,
    )
    .join("");
  return `<!doctype html><main><span class="packages-count">${page === 1 ? "1-2" : "3-3"} / 3${source.searchParams.has("name") || source.searchParams.has("type") ? " (of 42)" : ""}</span>${cards}<nav class="packages-pagination">${page === 1 ? '<a href="/packages?page=2">Next</a>' : '<a href="/packages?page=1">Previous</a>'}<span class="pagination-page is-active">${page}</span></nav></main>`;
}

// Implements only the local test npm protocol used by Pi's public npmCommand.
// It cannot contact a registry or install third-party code.
export async function createNativeNpmFixture(
  agentDir,
  { projectDir = agentDir } = {},
) {
  const root = join(agentDir, "npm", "node_modules", packageFixtureName);
  await mkdir(root, { recursive: true });
  const manifest = {
    name: packageFixtureName,
    version: "1.0.0",
    pi: { extensions: [], skills: [] },
  };
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  const command = join(agentDir, "fixture-npm.mjs"),
    log = join(agentDir, "fixture-npm.jsonl");
  await writeFile(
    command,
    `import {appendFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const args=process.argv.slice(2);
await appendFile(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='view'&&args[1].startsWith(${JSON.stringify(packageFixtureName)}))process.stdout.write(JSON.stringify('2.0.0'));
else if(args[0]==='root')process.stdout.write(${JSON.stringify(join(agentDir, "npm", "node_modules"))});
else if(args[0]==='install'&&args.some(value=>value===${JSON.stringify(packageFixtureName)}||value.startsWith(${JSON.stringify(packageFixtureName + "@")}))){const prefix=args[args.indexOf('--prefix')+1];if(!${JSON.stringify([join(agentDir, "npm"), join(projectDir, ".pi", "npm")])}.includes(prefix))throw new Error('Unexpected fixture install prefix');const installed=join(prefix,'node_modules',${JSON.stringify(packageFixtureName)});await mkdir(installed,{recursive:true});await writeFile(join(installed,'package.json'),JSON.stringify({...${JSON.stringify(manifest)},version:'2.0.0'}));}
else if(args[0]==='uninstall'&&args.includes(${JSON.stringify(packageFixtureName)})){}
else{process.stderr.write('Unexpected fixture npm command');process.exitCode=1;}
`,
  );
  return {
    root,
    log,
    source: "npm:" + packageFixtureName,
    settings: {
      packages: ["npm:" + packageFixtureName],
      enableInstallTelemetry: false,
      npmCommand: [process.execPath, command],
    },
  };
}

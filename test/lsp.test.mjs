import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createLspDiagnostics } from "../src/workspace/lsp-diagnostics.mjs";
import { createDeskBridge } from "../src/server/bridge.mjs";

const installed = (command) =>
  (process.env.PATH ?? "").split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fake(t, mode = "requests") {
  const root = await fixture(t),
    script = join(root, "server.mjs");
  await writeFile(
    script,
    `
let buffer=Buffer.alloc(0), target, replies={}, requestId;
const mode=${JSON.stringify(mode)};
const send=value=>{const data=Buffer.from(JSON.stringify({jsonrpc:'2.0',...value}));setImmediate(()=>{process.stdout.write('Content-Length: '+data.length+'\\r\\n\\r\\n');process.stdout.write(data);});};
process.stdin.on('data',data=>{buffer=Buffer.concat([buffer,data]);for(;;){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)break;const size=Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0,end).toString())[1]);if(buffer.length<end+4+size)break;const msg=JSON.parse(buffer.subarray(end+4,end+4+size));buffer=buffer.subarray(end+4+size);
if(mode==='hang')continue;
if(mode==='oversize'){process.stdout.write('Content-Length: 1048577\\r\\n\\r\\n');continue;}
if(msg.method==='initialize')send({id:msg.id,result:{capabilities:{diagnosticProvider:{}}}});
if(msg.method==='textDocument/didOpen')target=msg.params.textDocument.uri;
if(msg.method==='textDocument/diagnostic'){requestId=msg.id;if(mode==='incomplete')send({id:msg.id,result:{kind:'unchanged'}});else{send({id:901,method:'workspace/applyEdit',params:{edit:{changes:{[target]:[{newText:'MUTATED'}]}}}});send({id:902,method:'vscode/content',params:['https://example.invalid/schema']});send({id:903,method:'workspace/executeCommand',params:{command:'unsafe'}});}}
if([901,902,903].includes(msg.id)&&!msg.method){replies[msg.id]=msg.result??msg.error;if(Object.keys(replies).length===3)send({id:requestId,result:{kind:'full',items:Array.from({length:201},()=>({range:{start:{line:0,character:2},end:{line:0,character:3}},severity:1,code:42,message:JSON.stringify(replies)}))}});}
}});
`,
  );
  const lsp = createLspDiagnostics({
    spawnProcess: (_command, _args, options) =>
      spawn(process.execPath, [script], options),
  });
  t.after(() => lsp.stop());
  return { root, lsp };
}

test("LSP framing bounds diagnostics, refuses edits/schema IO/commands and rejects incomplete reports", async (t) => {
  const { root, lsp } = await fake(t);
  await writeFile(join(root, "error.json"), '{"value":}');
  const result = await lsp.analyze({
    root,
    path: "error.json",
    text: '{"value":}',
  });
  assert.equal(result.truncated, true);
  assert.equal(result.diagnostics.length, 200);
  assert.equal(result.diagnostics[0].column, 3);
  const responses = JSON.parse(result.diagnostics[0].message);
  assert.equal(responses[901].applied, false);
  assert.equal(responses[902].code, -32601);
  assert.equal(responses[903].code, -32601);
  assert.equal(await readFile(join(root, "error.json"), "utf8"), '{"value":}');
  const incomplete = await fake(t, "incomplete");
  await assert.rejects(
    incomplete.lsp.analyze({
      root: incomplete.root,
      path: "x.json",
      text: "{}",
    }),
    /完整诊断/,
  );
  const oversized = await fake(t, "oversize");
  await assert.rejects(
    oversized.lsp.analyze({ root: oversized.root, path: "x.json", text: "{}" }),
    /响应帧无效/,
  );
});

test("LSP admits at most two analyses and shutdown rejects pending work without spawning more", async (t) => {
  const { root, lsp } = await fake(t, "hang");
  const input = { root, path: "x.json", text: "{}" };
  const results = Promise.allSettled([lsp.analyze(input), lsp.analyze(input)]);
  await assert.rejects(lsp.analyze(input), (error) => error.status === 409);
  await lsp.stop();
  assert((await results).every((result) => result.status === "rejected"));
  await assert.rejects(lsp.analyze(input), /宿主已关闭/);
});

test(
  "installed TypeScript and JSON servers return real diagnostics without rewriting files or fetching schemas",
  {
    skip:
      !installed("typescript-language-server") ||
      !installed("vscode-json-language-server")
        ? "Requires existing local JS/TS and JSON language servers; never auto-installs"
        : false,
  },
  async (t) => {
    const root = await fixture(t),
      lsp = createLspDiagnostics();
    t.after(() => lsp.stop());
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    for (const [path, text, code] of [
      ["error.ts", 'const value: number = "wrong";\n', 2322],
      ["error.json", '{"value":}', 516],
    ]) {
      await writeFile(join(root, path), text);
      const result = await lsp.analyze({ root, path, text });
      assert(result.diagnostics.some((item) => item.code === code));
      assert.equal(await readFile(join(root, path), "utf8"), text);
    }
    const text = JSON.stringify({
      $schema: `http://127.0.0.1:${server.address().port}/schema`,
      value: 1,
    });
    await writeFile(join(root, "schema.json"), text);
    await lsp.analyze({ root, path: "schema.json", text });
    assert.equal(
      requests,
      0,
      "Explicit schema references must not cause HTTP downloads",
    );
  },
);

test("LSP HTTP validates target, trust, changed-file scope and native handoff before launching", async (t) => {
  const root = await fixture(t);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await writeFile(join(root, "x.ts"), "const value = 1;\n");
  let trusted = false,
    replacing = false;
  const bridge = createDeskBridge({
    agentDir: root,
    port: 0,
    host: "127.0.0.1",
    snapshot: () => ({ cwd: root, sessionId: "target", replacing }),
    capabilities: { projectTrusted: true },
    projectTrusted: () => {
      if (replacing) throw new Error("No native context");
      return trusted;
    },
  });
  t.after(() => bridge.stop());
  const url = new URL("/api/git-analysis", await bridge.start());
  const post = (body) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ sessionId: "other", path: "x.ts" })).status, 409);
  assert.equal((await post({ sessionId: "target", path: "x.ts" })).status, 403);
  trusted = true;
  assert.equal(
    (await post({ sessionId: "target", path: "../other.ts" })).status,
    422,
  );
  assert.equal((await post({ sessionId: "target", path: "x.rs" })).status, 422);
  replacing = true;
  assert.equal((await post({ sessionId: "target", path: "x.ts" })).status, 409);
});
test(
  "LSP HTTP discards diagnostics after focus or file changes, even while Agent writes are locked",
  { skip: !installed("typescript-language-server") },
  async (t) => {
    const root = await fixture(t);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    const path = join(root, "x.ts");
    await writeFile(path, 'const value: number = "wrong";\n');
    let sessionId = "target",
      calls = 0,
      announce;
    const bridge = createDeskBridge({
      agentDir: root,
      port: 0,
      host: "127.0.0.1",
      snapshot: () => ({ cwd: root, sessionId }),
      canWrite: () => false,
      capabilities: { projectTrusted: true },
      projectTrusted: () => {
        if (++calls === 2) announce();
        return true;
      },
    });
    t.after(() => bridge.stop());
    const url = new URL("/api/git-analysis", await bridge.start());
    const begin = () => {
      calls = 0;
      const started = new Promise((resolve) => {
        announce = resolve;
      });
      const response = fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "target", path: "x.ts" }),
      });
      return { started, response };
    };
    let operation = begin();
    await operation.started;
    sessionId = "other";
    assert.equal((await operation.response).status, 409);
    sessionId = "target";
    operation = begin();
    await operation.started;
    await writeFile(path, "const value: number = 1;\n");
    assert.equal((await operation.response).status, 409);
  },
);

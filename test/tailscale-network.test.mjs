import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpsServer } from "node:https";
import { createServer as httpServer } from "node:http";
import { connect } from "node:net";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exec = promisify(execFile);
test("public verification honors proxy rules, bypasses it for Funnel hosts, and rejects intercepted certificates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-tail-tls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function certificate(name) {
    const key = join(root, `${name}.key`),
      cert = join(root, `${name}.pem`);
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=pi-phone.test",
        "-addext",
        "subjectAltName=DNS:pi-phone.test,DNS:pi-phone.test.ts.net",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore" },
    );
    return { key: await readFile(key), cert: await readFile(cert), file: cert };
  }
  const trusted = await certificate("trusted"),
    intercepted = await certificate("intercepted");
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  let stall = false,
    endpoint,
    connections = 0;
  const good = httpsServer(trusted, (_req, res) =>
    res.end(JSON.stringify({ instance: "desktop" })),
  );
  const bad = httpsServer(intercepted, (_req, res) =>
    res.end(JSON.stringify({ instance: "desktop" })),
  );
  const proxy = httpServer();
  proxy.on("connect", (req, socket, head) => {
    assert.equal(req.url, "pi-phone.test:8443");
    connections++;
    if (stall) return;
    const upstream = connect(endpoint, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    track(upstream);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.once("close", () => upstream.destroy());
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [good, bad, proxy].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
  });
  for (const server of [good, bad, proxy]) {
    server.on("connection", track);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  }
  const env = {
    ...process.env,
    NODE_EXTRA_CA_CERTS: trusted.file,
    https_proxy: `http://127.0.0.1:${proxy.address().port}`,
    HTTPS_PROXY: "",
    NO_PROXY: "",
    no_proxy: "",
    ALL_PROXY: "",
    all_proxy: "",
    npm_config_proxy: "",
    npm_config_https_proxy: "",
    npm_config_no_proxy: "",
  };
  const funnelModule = JSON.stringify(
    new URL(`file://${resolve("src/remote/tailscale-funnel.mjs")}`).href,
  );
  const networkModule = JSON.stringify(
    new URL(`file://${resolve("src/remote/tailscale-network.mjs")}`).href,
  );
  const source = `import {createTailscaleFunnel} from ${funnelModule}; const f=createTailscaleFunnel();try{await f.verify('https://pi-phone.test:8443/',{expected:'desktop',signal:AbortSignal.timeout(10000)});console.log('verified');}catch(e){console.log(e.message);process.exitCode=1;}finally{await f.close();}`;
  endpoint = good.address().port;
  const success = await exec(
    process.execPath,
    ["--input-type=module", "-e", source],
    { env, timeout: 15000 },
  );
  assert.equal(success.stdout.trim(), "verified");
  assert.equal(connections, 1);
  const directSource = source
    .replace(
      "const f=createTailscaleFunnel();",
      `import {requestPublicHttps} from ${networkModule}; const lookup=(_host,options,callback)=>options?.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4); const f=createTailscaleFunnel({requestPublic:(url,options,callback)=>requestPublicHttps(url,{...options,lookup},callback)});`,
    )
    .replace(
      "https://pi-phone.test:8443/",
      `https://pi-phone.test.ts.net:${good.address().port}/`,
    );
  const beforeDirect = connections;
  const directSuccess = await exec(
    process.execPath,
    ["--input-type=module", "-e", directSource],
    { env, timeout: 15000 },
  );
  assert.equal(directSuccess.stdout.trim(), "verified");
  assert.equal(
    connections,
    beforeDirect,
    "ts.net Funnel checks bypass CONNECT",
  );
  endpoint = bad.address().port;
  await assert.rejects(
    exec(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      timeout: 15000,
    }),
    (error) => {
      assert.match(error.stdout, /公网扫码入口验证失败/);
      assert.doesNotMatch(error.stdout, /verified/);
      return error.code === 1;
    },
  );
  assert(connections > 1);
  const previous = connections;
  await assert.rejects(
    exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        source.replace(
          "createTailscaleFunnel()",
          "createTailscaleFunnel({verificationTimeout:300,verificationRetryDelay:5})",
        ),
      ],
      {
        env: { ...env, NO_PROXY: "pi-phone.test", no_proxy: "pi-phone.test" },
        timeout: 4000,
      },
    ),
    (error) => error.code === 1,
  );
  assert.equal(connections, previous, "NO_PROXY bypasses CONNECT");
  stall = true;
  await assert.rejects(
    exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        source.replace("timeout(10000)", "timeout(300)"),
      ],
      { env, timeout: 4000 },
    ),
    (error) => error.code === 1,
  );
});

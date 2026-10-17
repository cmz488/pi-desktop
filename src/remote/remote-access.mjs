import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { DeskError } from "../config/config-store.mjs";
import { createTailscaleFunnel } from "./tailscale-funnel.mjs";

const cookieLife = 12 * 60 * 60 * 1000;
const secret = () => randomBytes(32).toString("base64url");
const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};
const connectScript = `const key=new URLSearchParams(location.hash.slice(1)).get('connect');
// Keep the fragment until pairing succeeds: changing browser mode reloads this
// page and may cancel its first request. Fragments never go to the gateway.
if(key) fetch('/_pi/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})})
.then(async r=>{if(!r.ok)throw Error((await r.json()).error);location.replace('/'+location.search)})
.catch(e=>document.querySelector('#status').textContent=e.message);
else document.querySelector('#status').textContent='请扫描电脑上最新的二维码进入 Pi。';`;
const connectPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 Pi</title><style>body{color:#d5d8db;background:#161d27;font:16px system-ui;margin:0;min-height:100dvh;display:grid;place-items:center}main{padding:24px;max-width:32rem}h1{font-size:28px}p{line-height:1.7}</style><main><h1>连接 Pi</h1><p id="status" role="status">正在连接你的工作空间…</p></main><script src="/_pi/connect.js"></script></html>`;
const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
function cleanHeaders(input) {
  const denied = new Set([
    ...hopHeaders,
    ...(input.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((v) => v.trim()),
  ]);
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !denied.has(key.toLowerCase())),
  );
}

// A single Interface owns publication, scan authorization and revocation.
// The tunnel only forwards this guarded gateway, never the Desktop listener.
export function createRemoteAccess({
  targetUrl,
  onChange = () => {},
  directory,
  funnel = createTailscaleFunnel({ directory }),
}) {
  let phase = "off",
    error = "",
    approvalUrl = "",
    publicUrl,
    gateway,
    tunnel,
    controller,
    pending,
    closed = false,
    key = secret(),
    probe = secret();
  const cookieName = `__Host-pi-desk-${randomBytes(6).toString("hex")}`;
  const sessions = new Map(),
    proxies = new Set();
  const changed = () => onChange();
  let runtimeRecovering = false;
  const unsubscribe = funnel.onRuntimeChange?.(() => {
    const runtime = funnel.runtimeState?.();
    if (phase === "ready" && runtime?.phase !== "running") {
      runtimeRecovering = true;
      controller?.abort();
      phase = "error";
      error = "Tailscale 连接中断，正在恢复进程。恢复后请重新开启扫码连接。";
      revoke();
      stopping = dispose().finally(() => {
        stopping = undefined;
      });
    } else if (runtimeRecovering && runtime?.phase === "running") {
      runtimeRecovering = false;
      phase = "off";
      error = "";
    }
    changed();
  });
  function revoke() {
    key = secret();
    sessions.clear();
    for (const item of proxies) {
      item.upstream.destroy();
      item.response.destroy();
    }
    proxies.clear();
  }
  function read() {
    return {
      phase,
      runtime: funnel.runtimeState?.(),
      prepareSupported: !!funnel.prepare,
      error,
      approvalUrl,
      setupUrl:
        funnel.setupUrl ??
        "https://tailscale.com/docs/features/tailscale-funnel",
      url: phase === "ready" ? publicUrl : undefined,
      scanUrl:
        phase === "ready" ? `${publicUrl}_pi/scan#connect=${key}` : undefined,
      devices: [...sessions.values()].filter((value) => value > Date.now())
        .length,
    };
  }
  function authorizedToken(req) {
    const token = (req.headers.cookie ?? "")
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    const expires = sessions.get(token);
    if (expires && expires > Date.now()) return token;
    sessions.delete(token);
  }
  async function handle(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (!["checking", "ready"].includes(phase) || !publicUrl)
      return json(res, 503, { error: "远程共享已关闭，请在电脑重新开启。" });
    const authority = new URL(publicUrl);
    if (req.headers.host !== authority.host)
      return json(res, 403, { error: "远程地址无效" });
    const url = new URL(req.url, authority);
    if (
      url.origin !== authority.origin ||
      (req.headers.origin && req.headers.origin !== authority.origin)
    )
      return json(res, 403, { error: "跨站请求被拒绝" });
    if (!["GET", "HEAD", "POST"].includes(req.method))
      return json(res, 405, { error: "请求方式不支持" });
    if (
      req.method === "POST" &&
      (req.headers.origin !== authority.origin ||
        !/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? ""))
    )
      return json(res, 403, { error: "写入需要同源 JSON 请求" });
    if (url.pathname === "/_pi/health" && req.method === "GET")
      return json(res, 200, { instance: probe });
    if (phase !== "ready")
      return json(res, 503, { error: "正在验证公网连接，请稍后重新扫描。" });
    if (url.pathname === "/api/workspace/directory")
      return json(res, 403, { error: "请在电脑上选择项目文件夹。" });
    if (url.pathname === "/_pi/connect.js" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(connectScript);
    }
    if (url.pathname === "/_pi/scan" && req.method === "GET") {
      if (authorizedToken(req)) {
        res.writeHead(303, { Location: "/" + url.search });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(connectPage);
    }
    if (url.pathname === "/_pi/connect" && req.method === "POST") {
      const expected = key;
      let size = 0,
        chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2048) return json(res, 413, { error: "连接请求过大" });
        chunks.push(chunk);
      }
      let supplied;
      try {
        supplied = JSON.parse(Buffer.concat(chunks).toString()).key;
      } catch {
        /* invalid key */
      }
      if (
        typeof supplied !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) ||
        key !== expected ||
        phase !== "ready"
      )
        return json(res, 401, {
          error: "二维码已失效，请重新扫描电脑上的二维码。",
        });
      for (const [id, expires] of sessions)
        if (expires <= Date.now()) sessions.delete(id);
      // Rescanning in the same browser should not consume another device slot.
      if (authorizedToken(req)) return json(res, 200, { ok: true });
      if (sessions.size >= 64)
        return json(res, 429, {
          error: "连接设备过多，请在电脑撤销连接后重试。",
        });
      const token = secret();
      sessions.set(token, Date.now() + cookieLife);
      res.setHeader(
        "Set-Cookie",
        `${cookieName}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${cookieLife / 1000}`,
      );
      changed();
      return json(res, 200, { ok: true });
    }
    const token = authorizedToken(req);
    if (!token) {
      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(connectPage);
      }
      return json(res, 401, {
        error: "连接已失效，请重新扫描电脑上的二维码。",
      });
    }
    const expires = sessions.get(token);
    // A phone can operate Pi, but cannot publish or mint another remote credential.
    if (/^(?:\/agents\/[a-f0-9-]{36})?\/api\/remote$/.test(url.pathname)) {
      if (req.method !== "GET")
        return json(res, 403, { error: "请在电脑管理远程连接" });
      return json(res, 200, {
        remoteClient: true,
        url: publicUrl,
        urls: [],
        lan: false,
        tunnel: { phase: "ready" },
      });
    }
    if (
      /^\/(?:agents\/[a-f0-9-]{36}\/)?(?:_browser\/frame|api\/browser)$/.test(
        url.pathname,
      )
    )
      return json(res, 403, {
        error: "Chromium 浏览器仅在电脑本地运行，远程设备不传输浏览器画面。",
      });
    const backend = new URL(targetUrl());
    const headers = cleanHeaders(req.headers);
    for (const name of Object.keys(headers))
      if (/^(forwarded|x-forwarded-|tailscale-|cookie$)/i.test(name))
        delete headers[name];
    headers["x-pi-remote-client"] = "1";
    headers.host = backend.host;
    if (req.headers.origin) headers.origin = `http://${backend.host}`;
    // Auth is checked before forwarding; Host/Origin are translated only here.
    const upstream = (
      backend.protocol === "https:" ? httpsRequest : httpRequest
    )(
      new URL(url.pathname + url.search, backend),
      {
        method: req.method,
        headers,
      },
      (reply) => {
        const responseHeaders = cleanHeaders(reply.headers);
        delete responseHeaders["set-cookie"];
        res.writeHead(reply.statusCode, responseHeaders);
        reply.pipe(res);
      },
    );
    const entry = { upstream, response: res };
    proxies.add(entry);
    const expiration = setTimeout(() => {
      upstream.destroy();
      res.destroy();
    }, expires - Date.now());
    expiration.unref();
    res.once("close", () => {
      clearTimeout(expiration);
      proxies.delete(entry);
      upstream.destroy();
    });
    upstream.on("error", () => {
      if (!res.headersSent)
        json(res, 502, { error: "Pi 暂时无法连接，请稍后重试。" });
      else res.end();
    });
    req.pipe(upstream);
  }
  async function dispose() {
    revoke();
    const owned = tunnel,
      current = gateway;
    tunnel = undefined;
    gateway = undefined;
    await owned?.close();
    if (current) {
      await new Promise((resolve) => {
        current.close(resolve);
        current.closeAllConnections();
      });
    }
    publicUrl = undefined;
  }
  async function start(signal) {
    try {
      probe = secret();
      gateway = createServer((req, res) => {
        handle(req, res).catch(() => {
          if (!res.headersSent) json(res, 500, { error: "远程请求失败" });
          else res.end();
        });
      });
      gateway.requestTimeout = 30000;
      await new Promise((resolve, reject) => {
        gateway.once("error", reject);
        gateway.listen(0, "127.0.0.1", resolve);
      });
      signal.throwIfAborted();
      tunnel = await funnel.start({
        target: `http://127.0.0.1:${gateway.address().port}/`,
        signal,
        onApproval(url) {
          if (signal.aborted || approvalUrl === url) return;
          approvalUrl = url;
          changed();
        },
        onExit(cause) {
          if (signal.aborted) return;
          controller.abort();
          phase = "error";
          error =
            cause instanceof DeskError
              ? cause.message
              : "Tailscale 连接已结束，请重新开启远程连接。";
          revoke();
          changed();
          stopping = dispose().finally(() => {
            stopping = undefined;
          });
        },
      });
      signal.throwIfAborted();
      const url = new URL(tunnel.url);
      if (
        url.protocol !== "https:" ||
        !/^[a-z0-9.-]+\.ts\.net$/i.test(url.hostname) ||
        !["", "443", "8443", "10000"].includes(url.port) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new DeskError(503, "Tailscale 返回了无效的远程地址");
      publicUrl = url.href;
      if (funnel.verify) {
        phase = "checking";
        changed();
        try {
          await funnel.verify(publicUrl, { signal, expected: probe });
        } catch (cause) {
          if (signal.aborted) throw signal.reason;
          throw cause instanceof DeskError
            ? cause
            : new DeskError(
                503,
                "公网扫码入口无法连接，请检查电脑网络和 Tailscale 中继后重试。",
              );
        }
      }
      signal.throwIfAborted();
      approvalUrl = "";
      phase = "ready";
      changed();
    } catch (cause) {
      await dispose();
      if (!signal.aborted) {
        phase = "error";
        error =
          cause instanceof DeskError
            ? cause.message
            : "无法开启远程连接，请检查 Tailscale 配置。";
        changed();
      }
    }
  }
  let stopping;
  async function stop() {
    controller?.abort();
    phase = "off";
    approvalUrl = error = "";
    revoke();
    changed();
    await pending;
    await dispose();
  }
  return {
    read,
    async execute(action) {
      if (closed) throw new DeskError(409, "远程宿主已关闭");
      if (action === "prepare") {
        if (stopping) await stopping;
        if (closed) throw new DeskError(409, "远程宿主已关闭");
        if (
          !funnel.prepare ||
          ["preparing", "starting", "checking", "ready"].includes(phase)
        )
          return read();
        const prepareController = new AbortController();
        controller = prepareController;
        phase = "preparing";
        error = "";
        changed();
        pending = funnel
          .prepare(prepareController.signal)
          .then(() => {
            if (!prepareController.signal.aborted) {
              phase = "off";
              changed();
            }
          })
          .catch((cause) => {
            if (!prepareController.signal.aborted) {
              phase = "error";
              error = cause.message;
              changed();
            }
          });
      } else if (action === "start") {
        if (stopping) await stopping;
        if (closed) throw new DeskError(409, "远程宿主已关闭");
        if (["preparing", "starting", "checking", "ready"].includes(phase))
          return read();
        controller = new AbortController();
        phase = "starting";
        error = approvalUrl = "";
        changed();
        pending = start(controller.signal);
      } else if (action === "stop") {
        stopping ??= stop().finally(() => {
          stopping = undefined;
        });
        await stopping;
        if (phase !== "off") await stop();
      } else if (action === "rotate") {
        if (phase !== "ready") throw new DeskError(409, "请先开启远程连接");
        revoke();
        changed();
      } else throw new DeskError(422, "远程操作无效");
      return read();
    },
    async close() {
      closed = true;
      stopping ??= stop().finally(() => {
        stopping = undefined;
      });
      await stopping;
      unsubscribe?.();
      await funnel.close?.();
    },
  };
}

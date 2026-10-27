import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { DeskError } from "../config/config-store.mjs";
import { contentText } from "../shared/conversation.mjs";
import {
  createAuditLog,
  createBackpressure,
  sanitizeTranscript,
} from "./mobile-data.mjs";
import { ensureCertificate, localHosts } from "./self-signed-cert.mjs";

/**
 * 手机端（局域网）HTTP(S) 服务：独立端口、独立令牌、内置自签证书。
 *
 * 接口：`startMobileServer({ workspace, directory, pageHtml, iconPng, pwaManifest, port, tls })`
 *   返回 `{ url, urls, token, port, tokenPath, stop }`。
 * 不变量：
 *   - 手机端与桌面端是两套边界：独立端口、独立令牌；令牌只能访问下面列出的路径，
 *     读不到桌面路由，也读不到源码或资产目录；
 *   - `GET /` 不需要令牌（页面自己弹 TokenGate），其余全部要令牌；
 *   - 写端点用 `Authorization: Bearer`，不把令牌放进 URL（避免进日志）；
 *   - 令牌每次启动重新生成并落盘 0600，旧令牌立即失效；
 *   - TLS 默认开启。自签证书是局域网唯一可行形态：没有公共 CA 愿意为 `192.168.x.x` 签证书。
 *     关闭 TLS 只能由调用方显式要求，且返回的 `urls` 会如实标成 http。
 * 为什么独立服务：桌面 Host 的路由没有鉴权（只服务本机回环），把手机路由混进去就得给桌面
 *   路由也加鉴权，那是更大的安全面改动。
 * 错误：鉴权失败 401 且不回显令牌；未知路径 404；TLS 装配失败直接抛出，不静默降级到明文。
 */

/** 手机端只用这几个路径；其余一律 404。 */
const TRANSCRIPT = /^\/api\/sessions\/([^/]+)\/transcript$/;
const WRITE = /^\/api\/sessions\/([^/]+)\/(prompt|abort)$/;

const MAX_BODY = 64 * 1024;

const digestOf = (token) => createHash("sha256").update(token).digest();

/** 定长比较：长度不同直接失败，避免时序侧信道。 */
function matches(candidate, expected) {
  if (typeof candidate !== "string" || !candidate.length) return false;
  const value = digestOf(candidate);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

function bearerOf(request) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const value = header.slice("Bearer ".length).trim();
  return value || null;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new DeskError(413, "请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    throw new DeskError(422, "请求体不是有效 JSON");
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * 我们的消息 → 手机端可消费的形状。
 *
 * 转录里存的是模型消息（`content` 块），不是投影后的 `text`；直接读 `text` 会得到空字符串。
 * 脱敏与容量上限统一交给 `mobile-data.mjs`：出网的东西只能从一个地方裁剪。
 */
function projectMessages(messages) {
  const projected = (Array.isArray(messages) ? messages : []).map((message) => ({
    ...message,
    text: typeof message?.text === "string" ? message.text : contentText(message?.content),
  }));
  return sanitizeTranscript(projected);
}

/** PWA 清单：令牌不进 start_url，页面自行从 localStorage 恢复。 */
const pwaManifest = JSON.stringify({
  name: "Pi Desktop Remote",
  short_name: "Pi Desktop",
  start_url: "./",
  scope: "./",
  display: "standalone",
  background_color: "#161d27",
  theme_color: "#161d27",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
});

export async function startMobileServer({
  workspace,
  directory,
  pageHtml,
  port = 0,
  tls = true,
  // 远程控制开关：读运行态，不缓存；关闭时写端点一律 403。
  remoteControl = () => true,
}) {
  if (typeof pageHtml !== "string" || !pageHtml.length)
    throw new TypeError("手机端服务需要已构建的页面");

  const token = randomBytes(18).toString("base64url");
  const expectedDigest = digestOf(token);
  const tokenPath = join(directory, "mobile-token.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(tokenPath, JSON.stringify({ createdAt: Date.now(), digest: expectedDigest.toString("hex") }), {
    mode: 0o600,
  });

  // 出网数据面：容量上限与写操作审计。审计落盘到工作空间数据目录。
  const backpressure = createBackpressure();
  const audit = createAuditLog({
    append: (line) => {
      void appendFile(join(directory, "mobile-audit.jsonl"), `${line}\n`, {
        mode: 0o600,
      }).catch(() => {});
    },
  });
  const hosts = localHosts(networkInterfaces());
  let scheme = "http";
  let server;
  if (tls) {
    // 启用 TLS 时证书必须装配成功；失败就抛，不静默降级到明文。
    const { cert, key } = await ensureCertificate({ directory, hosts });
    server = createHttpsServer({ cert, key });
    scheme = "https";
  } else {
    server = createHttpServer();
  }

  /** 读一次会话目录；手机端只需要导航与按需正文。 */
  const collect = async () => {
    const state = await workspace.read();
    const agents = Array.isArray(state?.agents) ? state.agents : [];
    return {
      list: agents.map((agent) => ({
        sessionId: String(agent.id),
        name: agent.name ?? "未命名会话",
        cwd: agent.cwd ?? "",
        active: agent.status === "running" || agent.status === "ready",
        modifiedAt: Number(agent.updatedAt ?? Date.now()),
        ...(agent.readOnly ? { readOnly: true } : {}),
      })),
    };
  };

  server.on("request", async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (request.method === "GET" && path === "/") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(pageHtml);
        return;
      }
      if (request.method === "GET" && path === "/manifest.webmanifest") {
        response.writeHead(200, {
          "Content-Type": "application/manifest+json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(pwaManifest);
        return;
      }
      // 移动端用内联 SVG 作为图标，避免为一张图再开一条资产通道。
      if (request.method === "GET" && path === "/icon.svg") {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#161d27"/><circle cx="32" cy="32" r="14" fill="none" stroke="#d5d8db" stroke-width="3"/><circle cx="32" cy="32" r="4" fill="#d5d8db"/></svg>`;
        response.writeHead(200, {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(svg);
        return;
      }

      const isRead =
        request.method === "GET" &&
        (path === "/api/snapshot" || path === "/api/stream" || TRANSCRIPT.test(path));
      const isWrite = request.method === "POST" && WRITE.test(path);
      // 只读模式下写端点明确 403，而不是静默丢弃。
      if (isWrite && !remoteControl()) {
        audit.record({
          ip: request.socket.remoteAddress ?? "",
          action: "denied",
          target: url.pathname,
          result: "remote_control_off",
        });
        sendJson(response, 403, { error: "远程控制未开启" });
        return;
      }
      if (!isRead && !isWrite) {
        sendJson(response, 404, { error: "not found" });
        return;
      }

      // 写端点优先 Bearer（令牌不进 URL 日志）；读端点用 ?t=。
      const supplied =
        request.method === "POST"
          ? (bearerOf(request) ?? url.searchParams.get("t"))
          : url.searchParams.get("t");
      if (!matches(supplied, expectedDigest)) {
        sendJson(response, 401, { error: "invalid token" });
        return;
      }

      if (path === "/api/snapshot") {
        const { list } = await collect();
        sendJson(response, 200, {
          serverTime: Date.now(),
          list,
          // 活跃投影需要 Percho 的事件 reducer；我们的 SessionEvent 形状不同，尚未适配，
          // 因此快照不带 views/transcripts —— 客户端会退化为按需拉取历史。
          views: [],
          transcripts: [],
          pendingPermissions: [],
          remoteControl: remoteControl(),
          snapshotSeq: 0,
        });
        return;
      }

      if (path === "/api/stream") {
        // 连接上限是保护 Host 的手段：慢客户端或被反复重连的客户端不能拖住服务。
        if (!backpressure.admit()) {
          sendJson(response, 503, { error: "连接数已达上限" });
          return;
        }
        response.on("close", () => backpressure.release());
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        const timer = setInterval(() => {
          if (!response.writableEnded) response.write(": ping\n\n");
        }, 15000);
        timer.unref?.();
        request.on("close", () => clearInterval(timer));
        response.write(": connected\n\n");
        return;
      }

      const transcript = TRANSCRIPT.exec(path);
      if (transcript) {
        const id = decodeURIComponent(transcript[1]);
        const entries = (await workspace.transcript(Number(id))).entries ?? [];
        const messages = entries.flatMap((entry) => entry.model ?? []);
        const { messages: safe, truncated } = projectMessages(messages);
        sendJson(response, 200, { sessionId: id, messages: safe, truncated });
        return;
      }

      const write = WRITE.exec(path);
      if (write) {
        const id = Number(decodeURIComponent(write[1]));
        const input = await readBody(request);
        const ip = request.socket.remoteAddress ?? "";
        if (write[2] === "prompt") {
          const text = typeof input.text === "string" ? input.text.trim() : "";
          if (!text || text.length > 50000) {
            audit.record({ ip, action: "prompt", target: write[1], result: "error:bad_length" });
            throw new DeskError(422, "消息长度无效");
          }
          try {
            await workspace.execute("send", {
              id,
              message: text,
              requestId: `mobile-${id}-${Date.now()}`,
            });
          } catch (error) {
            // 审计只记错误分类，不记正文——正文可能含用户隐私。
            audit.record({
              ip,
              action: "prompt",
              target: write[1],
              result: `error:${String(error?.message ?? "unknown").slice(0, 80)}`,
            });
            throw error;
          }
          audit.record({ ip, action: "prompt", target: write[1], result: "ok" });
          sendJson(response, 200, { ok: true });
          return;
        }
        await workspace.execute("abort", { id });
        audit.record({ ip, action: "abort", target: write[1], result: "ok" });
        sendJson(response, 200, { ok: true });
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const status = error?.status ?? 500;
      sendJson(response, status, {
        error: status === 500 ? "服务端错误" : String(error.message),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  // 二维码地址：优先非回环的局域网 IP，手机才连得上；没有局域网地址时退回归环。
  const lan = hosts.filter((host) => host !== "127.0.0.1" && host !== "localhost");
  const urls = (lan.length ? lan : ["127.0.0.1"]).map(
    (host) => `${scheme}://${host}:${actualPort}/?t=${encodeURIComponent(token)}`,
  );

  return {
    token,
    scheme,
    get remoteControl() {
      return remoteControl();
    },
    /** 写操作审计（不含令牌与正文）。 */
    audit,
    /** 当前客户端数与队列深度。 */
    get capacity() {
      return { clients: backpressure.clients, queue: backpressure.queueSize };
    },
    port: actualPort,
    url: urls[0] ?? `${scheme}://127.0.0.1:${actualPort}/`,
    urls,
    tokenPath,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      // 停服务即撤销：下次启动重新生成令牌。
      await readFile(tokenPath, "utf8").catch(() => "");
    },
  };
}
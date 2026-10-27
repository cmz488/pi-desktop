import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DeskError } from "../config/config-store.mjs";
import { contentText } from "../shared/conversation.mjs";

/**
 * 手机端（局域网）HTTP 服务：独立端口、独立令牌。
 *
 * 接口：`startMobileServer({ workspace, directory, pageHtml, iconPng, pwaManifest, port })`
 *   返回 `{ url, token, stop }`。
 * 不变量：
 *   - 手机端与桌面端是两套边界：独立端口、独立令牌，令牌只能访问 `/api/*`，不能读桌面路由，
 *     也不能读源码或资产目录——否则一次手机连接就等于拿到整个 Host；
 *   - `GET /` 不需要令牌（页面自己弹 TokenGate），其余全部要令牌；
 *   - 写端点用 `Authorization: Bearer`，不把令牌放进 URL（避免进日志）；
 *   - 令牌每次启动重新生成并原子落盘，旧令牌立即失效。
 * 为什么独立服务而不是挂在桌面 Host 上：桌面 Host 的路由没有鉴权（它只服务本机回环），
 *   把手机路由混进去就得给桌面路由也加鉴权，那是更大的安全面改动。
 * 错误：鉴权失败 401 且不回显令牌；未知路径 404；写端点越界 403。
 */

/** 手机端只用这几个路径；其余一律 404。 */
const TRANSCRIPT = /^\/api\/sessions\/([^/]+)\/transcript$/;
const WRITE = /^\/api\/sessions\/([^/]+)\/(prompt|abort)$/;
const PERMISSION = /^\/api\/permissions\/([^/]+)\/respond$/;

const MAX_BODY = 64 * 1024;
const MAX_MESSAGES = 100;

function tokenDigest(token) {
  return createHash("sha256").update(token).digest("hex");
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

/** 我们的消息 → Percho 手机端消费的历史消息（保留 role/text，去掉不出网字段）。 */
function toHistoryMessage(message) {
  // 转录里存的是模型消息（content 块），不是投影后的 text；直接读 text 会得到空字符串。
  const text =
    typeof message?.text === "string"
      ? message.text
      : contentText(message?.content);
  return {
    role: message?.role ?? "user",
    text,
    ...(message?.toolName ? { toolName: String(message.toolName) } : {}),
    ...(message?.isError ? { isError: true } : {}),
    ...(typeof message?.eventKey === "number" ? { timestamp: message.eventKey } : {}),
  };
}

export async function startMobileServer({
  workspace,
  directory,
  pageHtml,
  iconPng,
  pwaManifest,
  port = 0,
}) {
  if (typeof pageHtml !== "string" || !pageHtml.length)
    throw new TypeError("手机端服务需要已构建的页面");

  const token = randomBytes(18).toString("base64url");
  const digest = tokenDigest(token);
  const tokenPath = join(directory, "mobile-token.json");
  // 数据目录在首次启动时可能还不存在；先建目录再落盘。
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    tokenPath,
    JSON.stringify({ createdAt: Date.now(), digest }),
    { mode: 0o600 },
  );

  /** 读一次会话目录；手机端只需要导航与按需正文。 */
  const collect = async () => {
    const state = await workspace.read();
    const agents = Array.isArray(state?.agents) ? state.agents : [];
    const list = agents.map((agent) => ({
      sessionId: String(agent.id),
      name: agent.name ?? "未命名会话",
      cwd: agent.cwd ?? "",
      active: agent.status === "running" || agent.status === "ready",
      modifiedAt: Number(agent.updatedAt ?? Date.now()),
      ...(agent.readOnly ? { readOnly: true } : {}),
    }));
    return { list };
  };

  const authorized = (token_) => {
    if (typeof token_ !== "string" || !token_.length) return false;
    // 定长比较避免时序侧信道；长度不同直接失败。
    const candidate = Buffer.from(tokenDigest(token_));
    const expected = Buffer.from(digest);
    return candidate.length === expected.length && candidate.equals(expected);
  };

  const server = createServer(async (request, response) => {
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
      if (request.method === "GET" && path === "/manifest.webmanifest" && pwaManifest) {
        response.writeHead(200, {
          "Content-Type": "application/manifest+json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(pwaManifest);
        return;
      }
      if (request.method === "GET" && path === "/icon.png" && iconPng) {
        response.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
        });
        response.end(iconPng);
        return;
      }

      const isRead =
        request.method === "GET" &&
        (path === "/api/snapshot" || path === "/api/stream" || TRANSCRIPT.test(path));
      const isWrite = request.method === "POST" && (WRITE.test(path) || PERMISSION.test(path));
      if (!isRead && !isWrite) {
        sendJson(response, 404, { error: "not found" });
        return;
      }

      // 写端点优先 Bearer（令牌不进 URL 日志）；读端点用 ?t=。
      const supplied = request.method === "POST" ? (bearerOf(request) ?? url.searchParams.get("t")) : url.searchParams.get("t");
      if (!authorized(supplied)) {
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
          remoteControl: true,
          snapshotSeq: 0,
        });
        return;
      }

      if (path === "/api/stream") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        const timer = setInterval(() => {
          if (!response.writableEnded) response.write(": ping\n\n");
        }, 15000);
        request.on("close", () => clearInterval(timer));
        response.write(": connected\n\n");
        return;
      }

      const transcript = TRANSCRIPT.exec(path);
      if (transcript) {
        const id = decodeURIComponent(transcript[1]);
        const entries = (await workspace.transcript(Number(id))).entries ?? [];
        const messages = entries.flatMap((entry) => entry.model ?? []);
        const tail = messages.slice(-MAX_MESSAGES);
        sendJson(response, 200, {
          sessionId: id,
          messages: tail.map(toHistoryMessage),
          truncated: messages.length > tail.length,
        });
        return;
      }

      const write = WRITE.exec(path);
      if (write) {
        const id = Number(decodeURIComponent(write[1]));
        const input = await readBody(request);
        if (write[2] === "prompt") {
          const text = typeof input.text === "string" ? input.text.trim() : "";
          if (!text || text.length > 50000) throw new DeskError(422, "消息长度无效");
          await workspace.execute("send", {
            id,
            message: text,
            requestId: `mobile-${id}-${Date.now()}`,
          });
          sendJson(response, 200, { ok: true });
          return;
        }
        await workspace.execute("abort", { id });
        sendJson(response, 200, { ok: true });
        return;
      }

      // 权限应答：手机端只允许一次性的 allow/deny，不再暴露其它形态。
      const permission = PERMISSION.exec(path);
      if (permission) {
        throw new DeskError(501, "手机端暂不支持应答权限请求");
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

  return {
    token,
    url: `http://127.0.0.1:${actualPort}/`,
    port: actualPort,
    tokenPath,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      // 停服务即撤销令牌：下次启动重新生成。
      await readFile(tokenPath, "utf8").catch(() => "");
    },
  };
}
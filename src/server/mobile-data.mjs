/**
 * 手机端出网数据面的唯一裁剪点：脱敏 + 容量上限 + 背压。
 *
 * 接口：`sanitizeMessage`（单条历史消息）、`createBackpressure`（每客户端与全局容量）、
 *   `createAuditLog`（写操作审计）。
 * 不变量：
 *   - 手机端**不得**看到 base64 图片、本地绝对路径、会话文件名、工具 `details` 里的路径；
 *     图片只保留数量占位，路径一律清空（保留字段形状，客户端不必改渲染）；
 *   - 任何上限都**明确可观测**：超出时返回 truncated 标记或拒绝，而不是静默截断；
 *   - 审计日志**绝不记录令牌**；
 *   - 裁剪是纯函数，不依赖会话状态，可在任何装配顺序下调用。
 * 为什么单独成文件：桌面端没有这些约束——它只服务本机回环。把裁剪放在手机端唯一入口，
 *   才能保证"出网的东西都过了一遍"，而不是散落在各个 handler 里靠自觉。
 */

/** 图片占位：保留数量，去掉内容。 */
export const IMAGE_PLACEHOLDER = Object.freeze({
  data: "",
  mimeType: "image/x-stripped",
});

/** 历史消息尾部上限。 */
export const TRANSCRIPT_TAIL_LIMIT = 100;

const PLACEHOLDER_KEYS = new Set([
  "sessionFile",
  "sessionPath",
  "artifactPaths",
  "artifactsDir",
  "artifacts",
  "nativeSessionPath",
  "cwd",
  "path",
  "paths",
  "filePath",
  "sourcePath",
  "outputPath",
  "jsonlPath",
  "dir",
  "directory",
  "root",
  "workspace",
  "extensionPath",
]);

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 内容块：image 换成占位，其余原样。 */
function sanitizeContent(content) {
  if (!Array.isArray(content)) return content;
  return content.map((block) =>
    isRecord(block) && block.type === "image"
      ? { ...block, ...IMAGE_PLACEHOLDER }
      : block,
  );
}

/**
 * details 递归清洗。
 *
 * 工具 details 是最容易夹带本机信息的地方（截图路径、子代理产物目录、mutex 的扩展路径），
 * 而它又会被手机端当作可渲染数据消费，所以必须逐层处理，不能只看顶层。
 */
function sanitizeDetails(value, depth = 0) {
  if (depth > 6) return undefined;
  if (Array.isArray(value))
    return value.map((item) => sanitizeDetails(item, depth + 1));
  if (!isRecord(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (PLACEHOLDER_KEYS.has(key)) {
      // 路径清空但保留键：客户端按字段存在与否分支，删键会改变渲染路径。
      out[key] = Array.isArray(item) ? [] : "";
      continue;
    }
    if (key === "images" && Array.isArray(item)) {
      out.images = item.map(() => ({ ...IMAGE_PLACEHOLDER }));
      continue;
    }
    if (key === "image") {
      out.image = isRecord(item) ? { ...IMAGE_PLACEHOLDER } : "";
      continue;
    }
    out[key] = sanitizeDetails(item, depth + 1);
  }
  return out;
}

/**
 * 单条消息脱敏。
 *
 * 保留 `role` 与 `text`（手机端就是靠这两项渲染），其余分支按上面规则处理。
 */
export function sanitizeMessage(message) {
  if (!isRecord(message)) return message;
  const out = {
    role: message.role ?? "user",
    text: typeof message.text === "string" ? message.text : "",
  };
  if (message.content !== undefined)
    out.content = sanitizeContent(message.content);
  if (message.toolName) out.toolName = String(message.toolName);
  if (message.toolCallId) out.toolCallId = String(message.toolCallId);
  if (message.isError) out.isError = true;
  if (message.stopReason) out.stopReason = String(message.stopReason);
  if (message.customType) out.customType = String(message.customType);
  if (typeof (message.eventKey ?? message.timestamp) === "number")
    out.timestamp = message.eventKey ?? message.timestamp;
  if (message.details !== undefined)
    out.details = sanitizeDetails(message.details);
  return out;
}

/**
 * 历史消息数组：先脱敏，再取尾部上限。
 *
 * `truncated` 必须如实反映"还有更早的消息"，否则手机会以为看到的就是全部。
 */
export function sanitizeTranscript(messages, limit = TRANSCRIPT_TAIL_LIMIT) {
  const list = Array.isArray(messages) ? messages : [];
  const tail = list.slice(-limit);
  return {
    messages: tail.map(sanitizeMessage),
    truncated: list.length > tail.length,
  };
}

/**
 * 每客户端与全局的容量与背压。
 *
 * 上限不是为了省内存（实际很小），是为了让弱网或被反复重连的客户端**无法拖住 Host**：
 * 达到连接上限时明确拒绝新连接，队列满时断开慢客户端，而不是无限累积。
 */
export function createBackpressure({
  maxClients = 5,
  maxQueue = 256,
  maxPendingSessions = 32,
  maxPendingEventsPerSession = 64,
} = {}) {
  let clients = 0;
  const queues = new Map();

  return {
    /** 尝试占用一个客户端名额；满则返回 false（调用方据此断连）。 */
    admit() {
      if (clients >= maxClients) return false;
      clients += 1;
      return true;
    },
    release() {
      clients = Math.max(0, clients - 1);
    },
    get clients() {
      return clients;
    },
    /**
     * 入队一帧；返回 false 表示超过背压上限，调用方应断开该客户端。
     * 按会话分别计数，避免一个高频会话挤掉其它会话的帧。
     */
    enqueue(sessionId, frame) {
      const key = String(sessionId);
      const queue = queues.get(key) ?? [];
      if (queues.size >= maxPendingSessions && !queues.has(key)) return false;
      if (queue.length >= maxPendingEventsPerSession) return false;
      queue.push(frame);
      queues.set(key, queue);
      if (queues.size > maxPendingSessions) return false;
      return true;
    },
    /** 取走某会话的待发帧。 */
    drain(sessionId) {
      const key = String(sessionId);
      const queue = queues.get(key) ?? [];
      queues.delete(key);
      return queue;
    },
    get queueSize() {
      let total = 0;
      for (const queue of queues.values()) total += queue.length;
      return total;
    },
    /** 全局队列上限；超过即整体过载。 */
    get overloaded() {
      let total = 0;
      for (const queue of queues.values()) total += queue.length;
      return total > maxQueue;
    },
  };
}

/**
 * 写操作审计（JSONL）。
 *
 * 记录时间/来源 IP/动作/目标/结果，**绝不记录令牌**与正文。
 * 为什么同步追加：写操作是人工点击速率，同步 IO 的代价远低于丢审计的风险。
 */
export function createAuditLog({ append, maxBytes = 1024 * 1024 } = {}) {
  const entries = [];
  let bytes = 0;

  return {
    record({ ip, action, target, result }) {
      const entry = {
        t: new Date().toISOString(),
        ip: String(ip ?? ""),
        action: String(action ?? ""),
        target: String(target ?? ""),
        result: String(result ?? ""),
      };
      const line = JSON.stringify(entry);
      entries.push(entry);
      bytes += Buffer.byteLength(line, "utf8") + 1;
      // 超过上限只保留尾部，保证内存有界；落盘由 append 负责（测试可注入）。
      if (bytes > maxBytes) {
        while (bytes > maxBytes && entries.length > 1) {
          const removed = entries.shift();
          bytes -= Buffer.byteLength(JSON.stringify(removed), "utf8") + 1;
        }
      }
      append?.(line);
      return entry;
    },
    get entries() {
      return [...entries];
    },
    get size() {
      return entries.length;
    },
  };
}

import { DeskError } from "../config/config-store.mjs";

// Keys and defaults follow Pi 0.99.2 docs/settings.md and SettingsManager.
const field = (key, label, type, defaultValue, extra = {}) => ({
  key,
  label,
  type,
  default: defaultValue,
  ...extra,
});
export const settingsGroups = [
  {
    id: "agent",
    title: "模型与思考",
    fields: [
      field("defaultProvider", "默认提供商", "string", ""),
      field("defaultModel", "默认模型 ID", "string", ""),
      field("defaultThinkingLevel", "思考强度", "enum", "medium", {
        options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      }),
      field("enabledModels", "模型选择范围", "array", [], {
        help: "每行一个 provider/model 模式；留空使用全部可用模型。",
      }),
      field("modelThinkingLevels", "各模型思考强度", "object", {}),
      field("thinkingBudgets", "思考 Token 预算", "object", {}),
      field("hideThinkingBlock", "隐藏思考内容", "boolean", false),
      field("showCacheMissNotices", "显示缓存通知", "boolean", false),
      field("cacheWarming", "缓存预热", "enum", "streaming", {
        options: ["off", "streaming", "idle"],
        globalOnly: true,
      }),
    ],
  },
  {
    id: "interaction",
    title: "会话与工具",
    fields: [
      field("steeringMode", "引导消息处理", "enum", "one-at-a-time", {
        options: ["one-at-a-time", "all"],
      }),
      field("followUpMode", "后续消息处理", "enum", "one-at-a-time", {
        options: ["one-at-a-time", "all"],
      }),
      field(
        "defaultTools",
        "默认工具",
        "array",
        ["read", "bash", "edit", "write"],
        { help: "每行一个名称；支持 +工具、-工具。" },
      ),
      field("codemode.mode", "Codemode 工具模式", "enum", "on", {
        options: ["on", "only"],
      }),
      field("codemode.inlineBudget", "Codemode 声明预算", "number", 3000),
      field("sessionDir", "会话存储目录", "string", ""),
      field("defaultProjectTrust", "项目默认信任", "enum", "ask", {
        options: ["ask", "always", "never"],
        globalOnly: true,
      }),
      field("doubleEscapeAction", "双击 Esc 动作", "enum", "tree", {
        options: ["tree", "fork", "none"],
      }),
      field("treeFilterMode", "会话树过滤", "enum", "default", {
        options: ["default", "no-tools", "user-only", "labeled-only", "all"],
      }),
    ],
  },
  {
    id: "context",
    title: "上下文与压缩",
    fields: [
      field("compaction.enabled", "自动压缩上下文", "boolean", true, {
        help: "上下文接近模型上限时，由 pi 自动总结较早的消息。也可在对话输入 /compact 手动压缩。",
      }),
      field("compaction.reserveTokens", "压缩触发预留 Token", "number", 16384, {
        help: "当模型上下文剩余空间低于此值时触发自动压缩。",
      }),
      field("compaction.keepRecentTokens", "保留近期 Token", "number", 20000, {
        help: "压缩时保留近期消息，其余历史由摘要替代。",
      }),
      field(
        "compaction.modelOverrides",
        "各模型压缩设置",
        "object",
        {},
        { help: "按 provider/model 设置不同压缩阈值。使用原生 pi JSON 格式。" },
      ),
      field(
        "branchSummary.reserveTokens",
        "分支摘要预留 Token",
        "number",
        16384,
      ),
      field("branchSummary.skipPrompt", "跳过分支摘要询问", "boolean", false),
    ],
  },
  {
    id: "network",
    title: "网络与重试",
    fields: [
      field("transport", "模型传输方式", "enum", "auto", {
        options: ["auto", "sse", "websocket", "websocket-cached"],
      }),
      field("httpProxy", "HTTP 代理", "string", "", {
        globalOnly: true,
        secret: true,
        help: "Pi 原生全局 httpProxy；填写完整地址，如 http://127.0.0.1:7897。已设置的 HTTP_PROXY／HTTPS_PROXY 优先。重启各 Agent 进程后应用。",
      }),
      field("httpIdleTimeoutMs", "HTTP 空闲超时（毫秒）", "number", 300000),
      field(
        "websocketConnectTimeoutMs",
        "WebSocket 连接超时（毫秒）",
        "number",
        15000,
      ),
      field("retry.enabled", "自动重试", "boolean", true),
      field("retry.maxRetries", "最大重试次数", "number", 3),
      field("retry.baseDelayMs", "重试初始间隔（毫秒）", "number", 2000),
      field("retry.maxAgentDelayMs", "重试最长等待（毫秒）", "number", 60000),
      field(
        "retry.provider.timeoutMs",
        "提供商请求超时（毫秒）",
        "number",
        300000,
      ),
      field("retry.provider.maxRetries", "提供商重试次数", "number", 0),
      field(
        "retry.provider.maxRetryDelayMs",
        "提供商最长重试等待（毫秒）",
        "number",
        60000,
      ),
    ],
  },
  {
    id: "resources",
    title: "资源与 Shell",
    fields: [
      ...["extensions", "skills", "prompts", "themes"].map((key) =>
        field(
          key,
          {
            extensions: "扩展路径 / 过滤",
            skills: "技能路径 / 过滤",
            prompts: "提示模板路径 / 过滤",
            themes: "主题路径 / 过滤",
          }[key],
          "array",
          [],
          { help: "每行一个路径或过滤规则；支持 +path、-path、!pattern。" },
        ),
      ),
      field("enableSkillCommands", "注册 /skill 命令", "boolean", true),
      field("shellPath", "Shell 可执行路径", "string", ""),
      field("shellCommandPrefix", "Shell 命令前缀", "string", ""),
      field("externalEditor", "外部编辑器命令", "string", ""),
      field("npmCommand", "npm 命令与参数", "array", ["npm"]),
    ],
  },
  {
    id: "display",
    title: "终端与显示",
    fields: [
      field("theme", "Pi 终端主题", "string", "system"),
      field("quietStartup", "隐藏启动标题", "boolean", false),
      field("tuiMode", "终端显示模式", "enum", "regular", {
        options: ["regular", "fullscreen"],
      }),
      field("fullscreenExitOutput", "退出全屏输出", "enum", "transcript", {
        options: ["transcript", "resume-hint"],
      }),
      field("fullscreenScrollbar", "全屏滚动条", "enum", "auto", {
        options: ["auto", "always", "hidden"],
      }),
      field("fullscreenCopyOnSelect", "选中自动复制", "boolean", true),
      field("fullscreenWheelScrollLines", "滚轮行数", "auto-number", "auto", {
        min: 1,
        max: 100,
      }),
      field("editorPaddingX", "编辑区横向留白", "number", 0, { max: 3 }),
      field("outputPad", "输出横向留白", "number", 1, { max: 1 }),
      field("autocompleteMaxVisible", "补全可见条目", "number", 5, {
        min: 3,
        max: 20,
      }),
      field("showHardwareCursor", "显示硬件光标", "boolean", false),
      field("terminal.showImages", "终端显示图片", "boolean", true),
      field("terminal.imageWidthCells", "终端图片宽度", "number", 60),
      field("terminal.clearOnShrink", "内容收缩时清空行", "boolean", false),
      field("terminal.showTerminalProgress", "终端标签进度", "boolean", false),
      field("terminal.hyperlinks", "终端超链接", "enum", "auto", {
        options: ["auto", true, false],
      }),
      field("terminal.trueColor", "终端真彩色", "enum", "auto", {
        options: ["auto", true, false],
      }),
      field("terminal.images", "终端图片协议", "enum", "auto", {
        options: ["auto", "kitty", "iterm2", false],
      }),
      field("images.autoResize", "自动缩放发送图片", "boolean", true),
      field("images.blockImages", "禁止发送图片", "boolean", false),
      field("markdown.codeBlockIndent", "代码块缩进", "string", "  "),
      field("markdown.mermaid", "Mermaid 显示", "enum", "streaming", {
        options: ["off", "final", "streaming"],
      }),
      field("collapseChangelog", "折叠更新日志", "boolean", false),
      field("enableInstallTelemetry", "安装匿名统计", "boolean", true),
      field("enableAnalytics", "分析数据共享", "boolean", false),
      field(
        "warnings.anthropicExtraUsage",
        "Anthropic 额外计费提醒",
        "boolean",
        true,
      ),
    ],
  },
];
const fields = new Map(
  settingsGroups.flatMap((group) =>
    group.fields.map((item) => [item.key, item]),
  ),
);
export const getSetting = (data, key) =>
  key.split(".").reduce((value, part) => value?.[part], data);
export function settingsProjection(data) {
  return Object.fromEntries(
    [...fields].map(([key, spec]) => [
      key,
      spec.secret
        ? { configured: Boolean(getSetting(data, key)) }
        : (getSetting(data, key) ?? null),
    ]),
  );
}
function validObject(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  return Object.entries(value).every(
    ([key, child]) =>
      !["__proto__", "constructor", "prototype"].includes(key) &&
      (child === null ||
        typeof child !== "object" ||
        (Array.isArray(child)
          ? child.every((item) => typeof item !== "object" || validObject(item))
          : validObject(child))),
  );
}
export function patchSettings(data, input) {
  const { patch, scope } = input;
  if (!patch || Array.isArray(patch) || typeof patch !== "object")
    throw new DeskError(422, "设置修改必须为对象");
  for (const [key, value] of Object.entries(patch)) {
    const spec = fields.get(key);
    if (!spec || (scope === "project" && spec.globalOnly))
      throw new DeskError(422, `此范围不能修改 ${key}`);
    const unset = value === null;
    const valid =
      unset ||
      (spec.type === "boolean"
        ? typeof value === "boolean"
        : spec.type === "enum"
          ? spec.options.includes(value)
          : spec.type === "number" || spec.type === "auto-number"
            ? (spec.type === "auto-number" && value === "auto") ||
              (Number.isSafeInteger(value) &&
                value >= (spec.min ?? 0) &&
                value <= (spec.max ?? Number.MAX_SAFE_INTEGER))
            : spec.type === "array"
              ? Array.isArray(value) &&
                value.every(
                  (item) => typeof item === "string" && item.length <= 4096,
                )
              : spec.type === "object"
                ? validObject(value)
                : typeof value === "string" && value.length <= 8192);
    if (!valid) throw new DeskError(422, `${spec.label} 的值无效`);
    if (key === "httpProxy" && !unset && value !== "") {
      let proxyUrl;
      try {
        proxyUrl = new URL(value);
      } catch {}
      if (
        !proxyUrl ||
        !["http:", "https:"].includes(proxyUrl.protocol) ||
        !proxyUrl.hostname
      )
        throw new DeskError(
          422,
          "HTTP 代理必须是完整的 http:// 或 https:// 地址，例如 http://127.0.0.1:7897",
        );
    }
    if (spec.secret && value === "") continue;
    if (spec.type === "object" && !unset) {
      if (
        key === "thinkingBudgets" &&
        Object.entries(value).some(
          ([k, v]) =>
            !["minimal", "low", "medium", "high"].includes(k) ||
            !Number.isSafeInteger(v) ||
            v < 0,
        )
      )
        throw new DeskError(422, "思考预算必须为非负整数");
      if (
        key === "modelThinkingLevels" &&
        Object.values(value).some(
          (v) => !fields.get("defaultThinkingLevel").options.includes(v),
        )
      )
        throw new DeskError(422, "模型思考强度无效");
      if (
        key === "compaction.modelOverrides" &&
        Object.values(value).some(
          (v) =>
            !validObject(v) ||
            Object.entries(v).some(
              ([k, n]) =>
                !["reserveTokens", "keepRecentTokens"].includes(k) ||
                !Number.isSafeInteger(n) ||
                n < 0,
            ),
        )
      )
        throw new DeskError(422, "模型压缩预算无效");
    }
    const parts = key.split(".");
    let target = data;
    for (const part of parts.slice(0, -1)) {
      if (unset && !target[part]) {
        target = null;
        break;
      }
      target[part] ??= {};
      target = target[part];
    }
    if (target) {
      if (unset) delete target[parts.at(-1)];
      else target[parts.at(-1)] = value;
    }
  }
  return data;
}

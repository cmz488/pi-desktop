// Pi's interactive commands need a Web action; extension, prompt and skill
// commands are loaded from the native session and still executed by Pi.
export const webCommands = [
  ["git", "Git 管理", "变更、暂存、提交、分支与远端同步", "git"],
  ["settings", "Pi 设置", "配置模型行为、上下文压缩、工具和资源", "general"],
  ["model", "选择模型", "切换当前 pi 会话使用的模型", "model"],
  ["models", "模型提供商", "管理端点、认证和默认模型", "providers"],
  ["login", "登录提供商", "使用原生 API Key 或 OAuth 认证", "providers"],
  ["logout", "退出认证", "在提供商设置中管理已保存的认证", "providers"],
  ["new", "新建会话", "开始新的 pi 会话", "new-session"],
  ["resume", "恢复会话", "选择当前工作空间中的历史会话", "sessions"],
  [
    "sessions",
    "并行会话管理",
    "列出、切换或恢复会话；运行中的任务继续执行",
    "sessions",
  ],
  ["compact", "压缩上下文", "调用 pi 原生压缩，可附加压缩要求", "native"],
  ["reload", "重载资源", "应用扩展、技能、提示模板与配置", "native"],
  ["name", "命名会话", "用 /name 名称设置当前会话标题", "native"],
  [
    "session",
    "会话信息",
    "查看模型、Token、费用和会话存储位置",
    "session-info",
  ],
  ["copy", "复制回复", "复制 pi 的最后一条助手回复", "copy"],
  ["mcp", "MCP 服务", "管理 Pi 原生 MCP 连接、认证和工具暴露", "mcp"],
  ["skills", "技能与模板", "查看 pi 实际加载的技能和提示模板", "skills"],
  ["help", "命令帮助", "查看命令、快捷键及 Web 操作", "help"],
].map(([name, label, description, action]) => ({
  name,
  label,
  description,
  action,
  source: "builtin",
}));

export function commandCatalog(session) {
  const extensions = session.extensionRunner
    .getRegisteredCommands()
    .filter((command) => command.invocationName !== "desk")
    .map((command) => ({
      name: command.invocationName,
      label: command.invocationName,
      description: command.description ?? "Pi 扩展命令",
      source: "extension",
      action: "prompt",
    }));
  const prompts = session.promptTemplates.map((prompt) => ({
    name: prompt.name,
    label: prompt.name,
    description: prompt.description,
    source: "prompt",
    action: "prompt",
  }));
  const skills = session.settingsManager.getEnableSkillCommands()
    ? session.resourceLoader.getSkills().skills.map((skill) => ({
        name: `skill:${skill.name}`,
        label: skill.name,
        description: skill.description,
        source: "skill",
        action: "prompt",
      }))
    : [];
  const rows = [...webCommands, ...extensions, ...prompts, ...skills];
  return rows.filter(
    (row, index) => rows.findIndex((item) => item.name === row.name) === index,
  );
}

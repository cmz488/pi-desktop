export const gitActions = [
  "stage",
  "unstage",
  "commit",
  "switch",
  "fetch",
  "pull",
  "push",
  "merge",
  "checkout",
  "reset",
  "tag",
];
export const gitExtendedActions = ["merge", "checkout", "reset", "tag"];
export const gitHelp = `/git status | diff [文件] | log [页码] | show 提交 | branches | tags
/git stage 文件 | unstage 文件 | commit 说明 | switch 分支
/git merge 分支或提交
/git checkout 分支或提交 | checkout -b 新分支 [起点] | checkout --detach 提交
/git reset soft|mixed 目标
/git tag [create] 名称 [目标] | tag annotate 名称 目标 注释 | tag -d 名称
/git fetch [远端] | pull [远端] | push [远端] | help
写操作需要确认；先预览再执行；不支持 hard、文件恢复、强推或自动 stash。引用限 HEAD、已有本地分支/tag 或唯一提交 SHA。`;
export class GitCommandError extends Error {
  status = 422;
}
/** File paths and commit prose retain the full remaining text; never shell parsing. */
export function parseGitCommand(text = "") {
  const match = text.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const action = match?.[1] ?? "status",
    value = match?.[2] ?? "";
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  const invalid = () => {
    throw new GitCommandError(gitHelp);
  };
  if (action === "log") {
    if (tokens.length > 1 || (value && !/^[1-9]\d{0,3}$/.test(value)))
      invalid();
    return { action, page: value ? Number(value) : 1 };
  }
  if (action === "show" || action === "merge") {
    if (tokens.length !== 1 || value.startsWith("-")) invalid();
    return { action, ref: value };
  }
  if (action === "reset") {
    if (
      tokens.length !== 2 ||
      !["soft", "mixed", "--soft", "--mixed"].includes(tokens[0])
    )
      invalid();
    return { action, mode: tokens[0].replace(/^--/, ""), ref: tokens[1] };
  }
  if (action === "checkout") {
    if (tokens[0] === "-b" && [2, 3].includes(tokens.length))
      return {
        action,
        mode: "create",
        branch: tokens[1],
        ref: tokens[2] ?? "HEAD",
      };
    if (tokens[0] === "--detach" && tokens.length === 2)
      return { action, mode: "detach", ref: tokens[1] };
    if (tokens.length !== 1 || value.startsWith("-")) invalid();
    return { action, mode: "auto", ref: value };
  }
  if (action === "tag") {
    if (tokens[0] === "annotate") {
      const annotation = value.match(/^annotate\s+(\S+)\s+(\S+)\s+([\s\S]+)$/);
      if (!annotation) invalid();
      return {
        action,
        operation: "create",
        name: annotation[1],
        ref: annotation[2],
        message: annotation[3],
      };
    }
    if (!tokens.length) return { action: "tags" };
    if (["-d", "delete"].includes(tokens[0]) && tokens.length === 2)
      return { action, operation: "delete", name: tokens[1] };
    const parts = tokens[0] === "create" ? tokens.slice(1) : tokens;
    if (![1, 2].includes(parts.length) || parts[0].startsWith("-")) invalid();
    return {
      action,
      operation: "create",
      name: parts[0],
      ref: parts[1] ?? "HEAD",
    };
  }
  if (
    !["status", "diff", "branches", "tags", "help", ...gitActions].includes(
      action,
    ) ||
    (["status", "branches", "tags", "help"].includes(action) && value)
  )
    invalid();
  return {
    action,
    ...(action === "stage" || action === "unstage"
      ? { paths: [value] }
      : action === "commit"
        ? { message: value }
        : action === "switch"
          ? { branch: value }
          : ["fetch", "pull", "push"].includes(action)
            ? { remote: value || undefined }
            : { path: value || undefined }),
  };
}

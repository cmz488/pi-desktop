import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { realpath, readlink, lstat, access, open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { DeskError } from "../config/config-store.mjs";
import { layoutGitGraph } from "../shared/git-graph.mjs";

const execute = promisify(execFile);
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 512 * 1024;
const FILE_READ_CHUNK_BYTES = 64 * 1024;
const CONFIRM_TTL_MS = 60_000;
const MAX_CONFIRMATIONS = 64;
const MAX_REPOSITORIES = 64;
const HISTORY_PAGE_SIZE = 30;
const MAX_HISTORY_PAGE = 9999;
const MAX_REF_LENGTH = 1024;
const canOperate = (state, action) =>
  !state.operations.length ||
  (state.mergeHead &&
    state.operations.every((name) => name === "MERGE_HEAD") &&
    (["stage", "unstage"].includes(action) ||
      (action === "commit" && !state.unmerged.length)));
const GIT_OPERATION_FILES = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
  "BISECT_LOG",
];
/** Only validated, stored plans reach these fixed argv; never accept client argv. */
function mutationArgs(r, state) {
  switch (r.action) {
    case "stage":
      return ["add", "--", ...r.paths];
    case "unstage":
      return state.head
        ? ["reset", "-q", "HEAD", "--", ...r.paths]
        : ["rm", "--cached", "-f", "--ignore-unmatch", "--", ...r.paths];
    case "commit":
      return ["commit", "-m", r.message];
    case "switch":
      return ["switch", "--", r.branch];
    case "fetch":
      return ["fetch", "--", r.remote];
    case "pull":
      return ["pull", "--ff-only", "--no-rebase", "--", r.remote, r.targetRef];
    case "push":
      return ["push", "--", r.remote, `HEAD:${r.targetRef}`];
    case "merge":
      return ["merge", "--no-edit", "--no-autostash", "--", r.commit];
    case "reset":
      return ["reset", "--" + r.mode, r.commit, "--"];
    case "checkout":
      if (r.mode === "branch")
        return ["checkout", "--no-guess", r.branch, "--"];
      if (r.mode === "create")
        return ["checkout", "--no-guess", "-b", r.branch, r.commit, "--"];
      return ["checkout", "--detach", r.commit, "--"];
    case "tag":
      if (r.operation === "delete") return ["tag", "--delete", "--", r.name];
      return r.message
        ? ["tag", "-a", "-m", r.message, "--", r.name, r.commit]
        : ["tag", "--", r.name, r.commit];
    default:
      throw new DeskError(422, "不支持此 Git 操作");
  }
}
const gitEnvironment = () => {
  const env = { ...process.env };
  // Do not inherit another repository/index or write token-bearing trace logs.
  for (const key of Object.keys(env))
    if (
      key.startsWith("GIT_TRACE") ||
      [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      ].includes(key)
    )
      delete env[key];
  return env;
};
const repositories = new Map();
const workspaces = new Map();
export const isGitBusy = (cwd) =>
  typeof cwd === "string" && !!workspaces.get(resolve(cwd))?.busy;
import { gitActions } from "../shared/git-command.mjs";
export {
  gitActions,
  gitHelp,
  parseGitCommand,
  GitCommandError,
} from "../shared/git-command.mjs";
const redacted = (value) =>
  String(value)
    .replace(/(?:https?|ssh|git|file):\/\/[^\s]+/gi, "<remote>")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** Resolve from server-owned session cwd, never a client-supplied repository. */
export async function getGitRepository(cwd) {
  const directory = await realpath(cwd);
  const probe = new GitRepository(directory);
  const root = await probe.run(["rev-parse", "--show-toplevel"]);
  const key = await realpath(root.replace(/\r?\n$/, ""));
  if (!repositories.has(key)) {
    if (repositories.size >= MAX_REPOSITORIES)
      throw new DeskError(429, "当前进程打开了过多 Git 仓库，请完成任务后重启");
    repositories.set(key, new GitRepository(key));
  }
  const repo = repositories.get(key);
  workspaces.set(resolve(cwd), repo);
  workspaces.set(directory, repo);
  workspaces.set(key, repo);
  return repo;
}
class GitRepository {
  constructor(root) {
    this.root = root;
    this.pending = new Map();
    this.busy = false;
  }
  async run(args, missing = false, network = false) {
    try {
      return (
        await execute(
          "git",
          ["--literal-pathspecs", "-c", "core.fsmonitor=false", ...args],
          {
            cwd: this.root,
            timeout: network ? 90_000 : 15_000,
            maxBuffer: MAX_OUTPUT_BYTES,
            env: {
              ...gitEnvironment(),
              LC_ALL: "C",
              GIT_OPTIONAL_LOCKS: "0",
              GIT_TERMINAL_PROMPT: "0",
              GCM_INTERACTIVE: "Never",
              GIT_EDITOR: "true",
              GIT_SEQUENCE_EDITOR: "true",
              GIT_PAGER: "cat",
              GIT_SSH_COMMAND:
                "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes",
              GIT_TRACE: "0",
              GIT_TRACE_CURL: "0",
              GIT_CURL_VERBOSE: "0",
            },
          },
        )
      ).stdout;
    } catch (error) {
      if (missing && error.code === 1) return "";
      throw new DeskError(
        422,
        `Git 操作未完成：${redacted(error.stderr || error.stdout || error.message).slice(0, 3000)}`,
      );
    }
  }
  async fileBytes(path, limit) {
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await handle.stat(),
        current = await lstat(path);
      const name = relative(this.root, await realpath(path));
      // Read a verified descriptor so replacing a path with a link cannot redirect IO.
      if (
        !info.isFile() ||
        current.isSymbolicLink() ||
        info.ino !== current.ino ||
        info.dev !== current.dev ||
        name.split(/[\\/]/).includes("..") ||
        isAbsolute(name)
      )
        throw new DeskError(409, "文件位置已变化，请刷新 Git");
      if (info.size > limit) throw new DeskError(422, "文件超过 Git 读取额度");
      const chunks = [],
        buffer = Buffer.alloc(Math.min(FILE_READ_CHUNK_BYTES, limit + 1));
      let size = 0;
      for (;;) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, limit - size + 1),
          null,
        );
        if (!bytesRead) break;
        size += bytesRead;
        if (size > limit) throw new DeskError(422, "文件在读取中超过 Git 额度");
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      return Buffer.concat(chunks, size);
    } finally {
      await handle.close();
    }
  }
  /** One diff run supplies both raw blob ids (a content-sensitive revision
   * stamp) and per-file numstat totals, without rendering any patch text.
   * Raw records start with ":" and are followed by their path record(s);
   * numstat records are "added<TAB>removed<TAB>path". */
  async diffFacts(args) {
    const records = (
      await this.run([
        "diff",
        "--raw",
        "--numstat",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        ...args,
      ])
    ).split("\0");
    const raw = [],
      totals = new Map();
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      if (record.startsWith(":")) {
        raw.push(record);
        const status = record.slice(record.lastIndexOf(" ") + 1);
        const paths = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
        for (let index = 0; index < paths; index++) raw.push(records[++i]);
        continue;
      }
      const first = record.indexOf("\t"),
        second = record.indexOf("\t", first + 1);
      const added = record.slice(0, first),
        removed = record.slice(first + 1, second);
      let path = record.slice(second + 1);
      if (!path) {
        i++;
        path = records[++i];
      }
      totals.set(path, {
        added: added === "-" ? null : Number(added),
        removed: removed === "-" ? null : Number(removed),
      });
    }
    return { raw: raw.join("\0"), totals };
  }
  async state({ readOnly = false, fingerprintPaths } = {}) {
    const status = await this.run([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const records = status.split("\0"),
      files = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      const index = record[0],
        worktree = record[1],
        path = record.slice(3);
      const originalPath =
        index === "R" || index === "C" || worktree === "R" || worktree === "C"
          ? records[++i]
          : undefined;
      files.push({
        path,
        originalPath,
        index,
        worktree,
        staged: index !== " " && index !== "?",
        unstaged: worktree !== " " || index === "?",
      });
    }
    const head = (
      await this.run(["rev-parse", "--verify", "--quiet", "HEAD"], true)
    ).trim();
    const branch = (
      await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"], true)
    ).trim();
    const upstreamFields = branch
      ? (
          await this.run([
            "for-each-ref",
            "--format=%(upstream:remotename)%00%(upstream:remoteref)",
            `refs/heads/${branch}`,
          ])
        )
          .trim()
          .split("\0")
      : [];
    const upstream =
      upstreamFields[0] && upstreamFields[1]?.startsWith("refs/heads/")
        ? { remote: upstreamFields[0], ref: upstreamFields[1] }
        : null;
    const refs = await this.historyRefsRaw();
    const tags = refs
      .split("\n")
      .filter((line) => line.startsWith("refs/tags/"))
      .map((line) => line.split("\0")[0].slice("refs/tags/".length));
    const historyRefs = refs
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, object, peeled] = line.split("\0");
        const type = id.startsWith("refs/heads/")
          ? "branch"
          : id.startsWith("refs/tags/")
            ? "tag"
            : "remote";
        const name = id.replace(/^refs\/(heads|tags|remotes)\//, "");
        return {
          id,
          name,
          type,
          commit: peeled || object,
          current: type === "branch" && name === branch,
        };
      });
    const historyRevision = createHash("sha256")
      .update(head)
      .update(refs)
      .digest("hex");
    const hash = createHash("sha256")
      .update(refs)
      .update(head)
      .update(branch)
      .update(await this.run(["config", "--null", "--list"]))
      .update(status);
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    // One diff run per side supplies raw blob ids for the revision hash and the
    // review totals. Whole patches are never generated, so large binaries stay
    // cheap and cannot overflow the output buffer.
    for (const [key, args] of [
      ["unstaged", []],
      ["staged", ["--cached"]],
    ]) {
      const facts = await this.diffFacts(args);
      hash.update(facts.raw);
      for (const [path, stats] of facts.totals) {
        const file = filesByPath.get(path);
        if (file) (file.stats ??= {})[key] = stats;
      }
    }
    let bytes = 0,
      previewBytes = 0;
    // Read-only cache stamps are metadata, not security fingerprints. Only
    // selected untracked stage inputs need byte hashes for write confirmation.
    for (const file of files) {
      const path = resolve(this.root, file.path);
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        hash.update(file.path + ":missing");
        continue;
      }
      hash.update(
        JSON.stringify([
          file.path,
          info.size,
          info.mtimeMs,
          info.ctimeMs,
          info.ino,
        ]),
      );
      if (file.index !== "?") continue;
      // Untracked sizes let the client keep a bulk stage inside the byte budget
      // below instead of failing the whole selection.
      file.size = info.size;
      if (info.isSymbolicLink()) {
        hash.update(await readlink(path));
        continue;
      }
      const selected =
        !readOnly &&
        (fingerprintPaths === undefined || fingerprintPaths.has(file.path));
      if (!info.isFile()) {
        if (selected) throw new DeskError(422, "无法确认特殊文件的内容");
        continue;
      }
      if (
        readOnly &&
        info.size <= MAX_PREVIEW_BYTES &&
        previewBytes + info.size <= MAX_UNTRACKED_BYTES
      ) {
        const content = await this.fileBytes(path, MAX_PREVIEW_BYTES);
        previewBytes += content.length;
        hash.update(content);
        if (!content.includes(0)) {
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(
              content,
            );
            file.stats = {
              unstaged: {
                added: text
                  ? text.split("\n").length - Number(text.endsWith("\n"))
                  : 0,
                removed: 0,
              },
            };
          } catch {
            /* Binary/non-UTF-8 files have unknown line counts. */
          }
        }
      }
      if (!selected) continue;
      if (bytes + info.size > MAX_UNTRACKED_BYTES)
        throw new DeskError(
          422,
          "本次选择的未跟踪文件超过 16 MiB 写确认额度；请减少选择或在终端处理",
        );
      const content = await this.fileBytes(path, MAX_UNTRACKED_BYTES - bytes);
      bytes += content.length;
      hash.update(content);
    }
    const operations = [];
    // One spawn for all markers; --git-path keeps linked worktrees correct.
    const operationPaths = (
      await this.run([
        "rev-parse",
        ...GIT_OPERATION_FILES.flatMap((name) => ["--git-path", name]),
      ])
    )
      .split("\n")
      .map((line) => line.replace(/\r$/, ""));
    while (operationPaths.at(-1) === "") operationPaths.pop();
    for (const [index, name] of GIT_OPERATION_FILES.entries()) {
      const path = operationPaths[index];
      if (!path) {
        hash.update(name + ":unknown");
        continue;
      }
      try {
        await access(resolve(this.root, path));
        operations.push(name);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    hash.update(operations.join("\0"));
    const mergeHead = operations.includes("MERGE_HEAD")
      ? (
          await this.run(
            ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
            true,
          )
        ).trim()
      : "";
    hash.update(mergeHead);
    hash.update(mergeHead ? "valid-merge" : "no-valid-merge");
    return {
      root: this.root,
      tags,
      historyRefs,
      historyRevision,
      mergeHead: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(mergeHead)
        ? mergeHead
        : "",
      unmerged: files
        .filter(
          (file) =>
            file.index === "U" ||
            file.worktree === "U" ||
            ["AA", "DD"].includes(file.index + file.worktree),
        )
        .map((file) => file.path),
      operations,
      upstream,
      head,
      branch: branch || `detached ${head.slice(0, 8)}`,
      files,
      revision: hash.digest("hex"),
      busy: this.busy,
      remotes: (await this.run(["remote"])).trim().split("\n").filter(Boolean),
      // Reuse the ref listing instead of asking for heads a second time.
      branches: historyRefs
        .filter((ref) => ref.type === "branch")
        .map((ref) => ref.name),
    };
  }
  async historyRefsRaw() {
    return this.run([
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(*objectname)",
      "refs/heads/",
      "refs/tags/",
      "refs/remotes/",
    ]);
  }
  async commitRef(value, state) {
    if (
      typeof value !== "string" ||
      !value ||
      value.length > MAX_REF_LENGTH ||
      value.startsWith("-") ||
      value.includes("\0")
    )
      throw new DeskError(422, "请选择 HEAD、已有分支/tag 或唯一提交 SHA");
    let ref = value;
    if (value === "HEAD" || /^[a-fA-F0-9]{7,64}$/.test(value)) {
    } else if (state.branches.includes(value) && state.tags.includes(value))
      throw new DeskError(
        422,
        "分支和 tag 同名，请使用完整 refs/heads/ 或 refs/tags/ 引用",
      );
    else if (state.branches.includes(value)) ref = "refs/heads/" + value;
    else if (state.tags.includes(value)) ref = "refs/tags/" + value;
    else if (
      !state.branches.some((name) => value === "refs/heads/" + name) &&
      !state.tags.some((name) => value === "refs/tags/" + name)
    )
      throw new DeskError(422, "引用不在已有分支/tag 中；不支持任意修订表达式");
    const commit = (
      await this.run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        ref + "^{commit}",
      ])
    ).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
      throw new DeskError(422, "目标不是唯一提交");
    return commit;
  }
  async read(input = {}) {
    const state = await this.state({ readOnly: true });
    if (input.action === "tags")
      return { ...state, output: state.tags.join("\n") || "没有本地 tag" };
    if (input.action === "show") {
      const commit = await this.commitRef(input.ref, state);
      return {
        ...state,
        commit,
        output: redacted(
          await this.run([
            "show",
            "--format=fuller",
            "--stat",
            "--patch",
            "--no-ext-diff",
            "--no-textconv",
            commit,
            "--",
          ]),
        ),
      };
    }
    if (input.action === "log") {
      const page = input.page ?? 1;
      if (!Number.isInteger(page) || page < 1 || page > MAX_HISTORY_PAGE)
        throw new DeskError(422, "历史页码无效");
      const scope = input.scope ?? "current";
      if (!["current", "all"].includes(scope))
        throw new DeskError(422, "图表范围无效");
      if (!state.head && (scope === "current" || !state.historyRefs.length))
        return {
          ...state,
          page,
          nextPage: null,
          commits: [],
          output: "尚无提交",
          graph: layoutGitGraph([], state.head),
        };
      const rows = (
        await this.run([
          "log",
          "--topo-order",
          "-" + (page * HISTORY_PAGE_SIZE + 1),
          "--format=%H%x00%h%x00%cs%x00%s%x00%an%x00%P",
          ...(scope === "all"
            ? [
                "--branches",
                "--tags",
                "--remotes",
                ...(state.head ? ["HEAD"] : []),
              ]
            : [state.head]),
          "--",
        ])
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      const referencesByCommit = new Map();
      for (const ref of state.historyRefs) {
        if (!referencesByCommit.has(ref.commit))
          referencesByCommit.set(ref.commit, []);
        referencesByCommit.get(ref.commit).push(ref);
      }
      const history = rows.map((row) => {
        const fields = row.split("\0");
        const [id, shortId, date, subject, author, parents] = fields;
        if (
          fields.length !== 6 ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id) ||
          (parents &&
            parents
              .split(" ")
              .some(
                (parent) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(parent),
              ))
        )
          throw new DeskError(422, "Git 历史元数据无效，不能生成图表");
        const references = (referencesByCommit.get(id) ?? [])
          .slice()
          .sort((a, b) => Number(b.current) - Number(a.current));
        if (id === state.head && !references.some((ref) => ref.current))
          references.unshift({
            id: "HEAD",
            name: "HEAD",
            type: "head",
            commit: id,
            current: true,
          });
        return {
          id,
          shortId,
          date,
          subject: redacted(subject),
          author: redacted(author),
          parentIds: parents ? parents.split(" ") : [],
          references,
          refs: references.map((ref) => ref.name).join(", "),
        };
      });
      const offset = (page - 1) * HISTORY_PAGE_SIZE;
      const commits = history.slice(offset, offset + HISTORY_PAGE_SIZE);
      let graph;
      try {
        graph = layoutGitGraph(history, state.head);
      } catch (error) {
        throw new DeskError(422, error.message);
      }
      graph.rows = graph.rows.slice(offset, offset + HISTORY_PAGE_SIZE);
      const latestHead = (
        await this.run(["rev-parse", "--verify", "--quiet", "HEAD"], true)
      ).trim();
      const latestRevision = createHash("sha256")
        .update(latestHead)
        .update(await this.historyRefsRaw())
        .digest("hex");
      if (latestRevision !== state.historyRevision)
        throw new DeskError(409, "Git 引用在读取中已变化，请刷新图表");
      return {
        ...state,
        page,
        scope,
        commits,
        graph,
        nextPage:
          rows.length > page * HISTORY_PAGE_SIZE && page < MAX_HISTORY_PAGE
            ? page + 1
            : null,
        output:
          commits
            .map(
              (commit) =>
                commit.shortId +
                " " +
                commit.date +
                " " +
                commit.subject +
                " · " +
                commit.author,
            )
            .join("\n") || "此页没有提交",
      };
    }
    if (input.action === "diff") {
      const file = state.files.find((file) => file.path === input.path);
      if (input.path && !file) throw new DeskError(404, "文件不在当前变更列表");
      const args = [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        ...(input.staged ? ["--cached"] : []),
        "--",
        ...(input.path ? [input.path] : []),
      ];
      let output = await this.run(args);
      if (file?.index === "?") {
        const info = await lstat(resolve(this.root, file.path));
        if (info.isSymbolicLink()) output = "未跟踪的符号链接（不读取目标）";
        else if (info.size > MAX_PREVIEW_BYTES)
          output = "文件大于 512 KiB；不显示预览";
        else {
          const data = await this.fileBytes(
            resolve(this.root, file.path),
            MAX_PREVIEW_BYTES,
          );
          if (data.includes(0)) output = "二进制文件（不显示内容）";
          else {
            try {
              output = new TextDecoder("utf-8", { fatal: true }).decode(data);
            } catch {
              output = "非 UTF-8 文件（不显示文本内容）";
            }
          }
        }
      }
      return { ...state, output: output || "没有可显示的文本差异" };
    }
    return state;
  }
  async prepare(input, binding) {
    if (this.busy) throw new DeskError(409, "Git 操作正在运行，请稍后重试");
    const state = await this.state({
      fingerprintPaths: new Set(
        input.action === "stage" && Array.isArray(input.paths)
          ? input.paths
          : [],
      ),
    });
    if (this.busy) throw new DeskError(409, "Git 操作正在运行，请稍后重试");
    if (!canOperate(state, input.action))
      throw new DeskError(
        409,
        "Git 合并/变基/拣选/二分操作尚未结束，请先在终端处理",
      );
    if (!gitActions.includes(input.action))
      throw new DeskError(422, "不支持的 Git 操作");
    const request = { action: input.action };
    if (["stage", "unstage"].includes(input.action)) {
      if (
        !Array.isArray(input.paths) ||
        !input.paths.length ||
        input.paths.length > 100
      )
        throw new DeskError(422, "请选择要操作的文件");
      request.paths = [
        ...new Set(
          input.paths.flatMap((path) => {
            if (
              typeof path !== "string" ||
              isAbsolute(path) ||
              /^[A-Za-z]:/.test(path) ||
              path.split(/[\\/]/).includes("..") ||
              path.includes("\0")
            )
              throw new DeskError(422, "文件路径无效");
            const file = state.files.find((file) => file.path === path);
            if (
              !file ||
              (input.action === "stage" ? !file.unstaged : !file.staged)
            )
              throw new DeskError(409, "文件状态已变化，请刷新");
            return [path, ...(file.originalPath ? [file.originalPath] : [])];
          }),
        ),
      ];
    }
    if (input.action === "commit") {
      if (
        typeof input.message !== "string" ||
        !input.message.trim() ||
        input.message.length > 8192 ||
        input.message.includes("\0")
      )
        throw new DeskError(422, "请输入有效提交说明（最多 8192 字符）");
      if (!state.files.some((file) => file.staged))
        throw new DeskError(409, "没有已暂存的变更；不会自动 git add");
      request.message = input.message;
    }
    if (input.action === "switch") {
      if (!state.branches.includes(input.branch))
        throw new DeskError(422, "请选择已有本地分支");
      if (state.files.length)
        throw new DeskError(
          409,
          "工作区有变更；请先提交或自行处理，不自动 stash",
        );
      request.branch = input.branch;
    }
    if (["merge", "checkout", "reset"].includes(input.action)) {
      if (input.action === "reset" && !["soft", "mixed"].includes(input.mode))
        throw new DeskError(422, "只支持 soft/mixed；不提供 hard 或文件恢复");
      if (input.action !== "reset" && state.files.length)
        throw new DeskError(409, "工作区有变更；不丢弃文件或自动 stash");
      if (!state.head) throw new DeskError(409, "此操作需要已有提交");
      if (input.action === "reset") {
        if (!state.branches.includes(state.branch))
          throw new DeskError(409, "请在本地分支上 reset");
        request.mode = input.mode;
      }
      if (input.action === "checkout") {
        if (
          !["auto", "branch", "create", "detach"].includes(input.mode ?? "auto")
        )
          throw new DeskError(422, "不支持文件恢复或强制 checkout");
        request.mode = input.mode ?? "auto";
        const branch = input.branch ?? input.ref;
        if (request.mode === "create") {
          if (
            typeof branch !== "string" ||
            branch.startsWith("-") ||
            branch.length > MAX_REF_LENGTH ||
            branch.includes("\0") ||
            branch === "HEAD" ||
            state.branches.includes(branch)
          )
            throw new DeskError(422, "请输入未存在的有效分支名");
          await this.run(["check-ref-format", "--branch", branch]);
          request.branch = branch;
        } else if (
          request.mode === "branch" ||
          (request.mode === "auto" && state.branches.includes(branch))
        ) {
          if (!state.branches.includes(branch))
            throw new DeskError(422, "请选择已有本地分支");
          request.mode = "branch";
          request.branch = branch;
        } else request.mode = "detach";
      }
      request.ref = input.ref ?? "HEAD";
      request.commit = await this.commitRef(
        request.mode === "branch"
          ? "refs/heads/" + request.branch
          : request.ref,
        state,
      );
    }
    if (input.action === "tag") {
      if (!["create", "delete"].includes(input.operation))
        throw new DeskError(422, "请选择创建或删除 tag");
      if (
        typeof input.name !== "string" ||
        !input.name ||
        input.name.length > MAX_REF_LENGTH ||
        input.name.startsWith("-") ||
        input.name.includes("\0")
      )
        throw new DeskError(422, "tag 名称无效");
      await this.run(["check-ref-format", "refs/tags/" + input.name]);
      request.operation = input.operation;
      request.name = input.name;
      if (input.operation === "delete") {
        if (!state.tags.includes(input.name))
          throw new DeskError(409, "tag 已不存在");
      } else {
        if (state.tags.includes(input.name))
          throw new DeskError(409, "tag 已存在；不覆盖");
        request.ref = input.ref ?? "HEAD";
        request.commit = await this.commitRef(request.ref, state);
        if (input.message !== undefined && input.message !== "") {
          if (
            typeof input.message !== "string" ||
            input.message.length > 8192 ||
            input.message.includes("\0") ||
            !input.message.trim()
          )
            throw new DeskError(422, "tag 注释无效");
          request.message = input.message;
        }
      }
    }
    if (["fetch", "pull", "push"].includes(input.action)) {
      const remote =
        input.remote ??
        state.upstream?.remote ??
        (state.remotes.includes("origin") ? "origin" : state.remotes[0]);
      if (
        !state.remotes.includes(remote) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)
      )
        throw new DeskError(422, "请选择已配置的远端；不接受 URL");
      if (
        input.action !== "fetch" &&
        (!state.head || !state.branches.includes(state.branch))
      )
        throw new DeskError(409, "请在已有提交的本地分支上操作");
      if (input.action === "pull" && state.files.length)
        throw new DeskError(409, "工作区有变更，不自动 stash 或合并");
      request.remote = remote;
      request.branch = state.branch;
      if (input.action !== "fetch")
        request.targetRef =
          remote === state.upstream?.remote
            ? state.upstream.ref
            : `refs/heads/${state.branch}`;
    }
    for (const [id, item] of this.pending)
      if (item.expires < Date.now()) this.pending.delete(id);
    if (this.pending.size >= MAX_CONFIRMATIONS)
      throw new DeskError(429, "待确认请求过多，请稍后重试");
    const token = randomUUID();
    this.pending.set(token, {
      request,
      binding,
      revision: state.revision,
      expires: Date.now() + CONFIRM_TTL_MS,
    });
    return {
      token,
      revision: state.revision,
      request,
      branch: state.branch,
      staged: state.files
        .filter((file) => file.staged)
        .map((file) => file.path),
      affected: state.files.map((file) => file.path),
      warning:
        (input.action === "reset"
          ? "将移动当前分支 HEAD；soft 保留索引和工作树，mixed 取消暂存但保留工作树。未跟踪文件不删除。不提供 hard。 "
          : input.action === "merge"
            ? "正常合并；可能产生合并提交或冲突。不自动解决或中止冲突。 "
            : input.action === "checkout"
              ? "只切换分支/提交，不恢复文件或丢弃改动；detach 不指向本地分支。 "
              : input.action === "tag"
                ? "仅修改本地 tag；不覆盖或自动推送。 "
                : "") +
        "只执行上述操作。提交包含全部已暂存文件；仓库配置的 hooks、filters、签名程序和凭据助手可能执行或有自己的交互。本包不提供密码输入，需登录时先在终端完成。确认 60 秒内有效。",
    };
  }
  async confirm(token, binding, guard = () => {}) {
    const item = this.pending.get(token);
    this.pending.delete(token);
    if (!item || item.binding !== binding || item.expires < Date.now())
      throw new DeskError(409, "确认已失效，请重新预览");
    if (this.busy) throw new DeskError(409, "Git 操作正在运行");
    this.busy = true;
    try {
      await guard();
      const state = await this.state({
        fingerprintPaths: new Set(
          item.request.action === "stage" ? item.request.paths : [],
        ),
      });
      if (!canOperate(state, item.request.action))
        throw new DeskError(409, "Git 操作状态已变化，请先解决冲突");
      if (state.revision !== item.revision)
        throw new DeskError(409, "仓库内容已变化，请重新预览并确认");
      await guard();
      const r = item.request;
      const args = mutationArgs(r, state);
      try {
        const output = redacted(
          await this.run(
            args,
            false,
            ["fetch", "pull", "push"].includes(r.action),
          ),
        );
        return { ok: true, output: output.slice(0, 20000) };
      } catch (error) {
        if (
          r.action === "merge" &&
          (await this.state({ readOnly: true })).operations.includes(
            "MERGE_HEAD",
          )
        )
          return {
            ok: false,
            conflict: true,
            output:
              "合并存在冲突；先在终端或编辑器解决文件，再明确暂存并提交。不会自动解决、中止或 reset。\n" +
              error.message,
          };
        throw error;
      }
    } finally {
      this.busy = false;
    }
  }
}

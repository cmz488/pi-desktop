import { useEffect, useState } from "react";
import { nativeRequest } from "../../pi-http-bridge";
import { useNativeSession } from "../../stores/desktop-workspace";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { PatchView } from "../diff/DiffFileCard";
import { Feedback, Field, inputClass } from "./NativeControls";

type GitFile = {
	path: string;
	staged: boolean;
	unstaged: boolean;
	index: string;
	size?: number;
	added?: number;
	removed?: number;
};
type GitCommit = {
	id: string;
	shortId: string;
	subject: string;
	author: string;
	date: string;
	references?: { id: string; name: string; type: string }[];
};
type GitState = {
	branch: string;
	head?: string;
	root: string;
	files: GitFile[];
	branches: string[];
	remotes: string[];
	tags: string[];
	busy?: boolean;
	permittedActions: string[];
	operations?: string[];
	limits: { stagePaths: number; stageBytes: number };
	commits?: GitCommit[];
	page?: number;
	nextPage?: number | null;
	output?: string;
	graph?: any;
};
const commitDrafts = new Map<string, string>();
export function GitPanel({ sessionId }: { sessionId: string }) {
	const { snapshot, error: snapshotError } = useNativeSession(sessionId);
	const [data, setData] = useState<GitState | null>(null);
	const [tab, setTab] = useState("review");
	const [staged, setStaged] = useState(false);
	const [error, setError] = useState("");
	const [output, setOutput] = useState("");
	const [busy, setBusy] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [patch, setPatch] = useState("");
	const [analysis, setAnalysis] = useState<any>(null);
	const [message, setMessage] = useState(commitDrafts.get(sessionId) ?? "");
	const [plan, setPlan] = useState<any>(null);
	const [history, setHistory] = useState<GitState | null>(null);
	const [historyScope, setHistoryScope] = useState("current");
	const [branch, setBranch] = useState("");
	const [remote, setRemote] = useState("");
	const [action, setAction] = useState("checkout");
	const [ref, setRef] = useState("HEAD");
	const [mode, setMode] = useState("auto");
	const [name, setName] = useState("");
	const [tagOperation, setTagOperation] = useState("create");
	const [tagMessage, setTagMessage] = useState("");
	const [trust, setTrust] = useState(false);
	const supported = Boolean(snapshot?.gitManagement);
	const trusted = snapshot?.projectTrusted === true;
	const writable =
		trusted &&
		!busy &&
		!data?.busy &&
		(snapshot?.gitWritable ?? snapshot?.idle) &&
		!data?.operations?.length;
	const allowed = (kind: string) => writable && data?.permittedActions.includes(kind);
	const read = (kind = "status", extra: Record<string, string> = {}) =>
		nativeRequest(
			`/api/git?${new URLSearchParams({ action: kind, ...extra })}`,
			undefined,
			sessionId,
		);
	const refresh = async () => {
		const value = await read();
		setData(value);
		setBranch((previous) => previous || value.branch);
		setRemote((previous) => previous || value.remotes[0] || "");
	};
	useEffect(() => {
		if (!supported || !trusted) return;
		let live = true;
		void read()
			.then((value) => {
				if (live) {
					setData(value);
					setBranch(value.branch);
					setRemote(value.remotes[0] ?? "");
				}
			})
			.catch((reason: Error) => {
				if (live) setError(reason.message);
			});
		return () => {
			live = false;
		};
	}, [sessionId, supported, trusted]);
	const run = async (operation: () => Promise<void>) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await operation();
		} catch (reason) {
			setError((reason as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const prepare = (input: Record<string, unknown>, note = "") =>
		run(async () => {
			const value = await nativeRequest("/api/git", input, sessionId);
			setPlan({ ...value, note });
		});
	const execute = () => {
		const token = plan.token;
		setPlan(null);
		void run(async () => {
			const result = await nativeRequest("/api/git", { token }, sessionId);
			setOutput(result.output || "Git 操作已完成");
			setSelected(null);
			setPatch("");
			await refresh();
			if (result.conflict) setError(result.output);
		});
	};
	const showPatch = (path: string) =>
		void run(async () => {
			const value = await read("diff", { path, staged: String(staged) });
			setSelected(path);
			setPatch(value.output);
			setAnalysis(null);
		});
	const bulk = () => {
		if (!data) return;
		const paths: string[] = [];
		let budget = data.limits.stageBytes;
		let skipped = 0;
		for (const file of data.files)
			if (staged ? file.staged : file.unstaged) {
				if (
					paths.length >= data.limits.stagePaths ||
					(!staged && file.index === "?" && (file.size ?? 0) > budget)
				) {
					skipped++;
					continue;
				}
				if (!staged && file.index === "?") budget -= file.size ?? 0;
				paths.push(file.path);
			}
		if (paths.length)
			void prepare(
				{ action: staged ? "unstage" : "stage", paths },
				skipped ? `${skipped} 个文件超出本次额度，保留原状。` : "",
			);
	};
	const loadHistory = (page = 1, scope = historyScope) =>
		void run(async () => {
			const value = await read("log", { page: String(page), scope });
			setHistory(value);
			setTab("history");
			setPatch("");
			setSelected(null);
		});
	const rows = data?.files.filter((row) => (staged ? row.staged : row.unstaged)) ?? [];
	const labels: Record<string, string> = {
		stage: "暂存",
		unstage: "取消暂存",
		commit: "提交",
		switch: "切换分支",
		fetch: "Fetch",
		pull: "Pull（仅快进）",
		push: "Push",
		checkout: "检出",
		merge: "合并",
		reset: "回退",
		tag: "标签",
	};
	return (
		<section className="space-y-3 p-3" aria-label="Git 仓库管理">
			<Feedback error={error || snapshotError} message={output} />
			{!snapshot && !snapshotError && (
				<p role="status" className="text-ui-12 text-ink-faint">
					读取仓库能力…
				</p>
			)}
			{snapshot && !supported && (
				<p className="text-ui-12 text-ink-faint">当前宿主不提供 Git 管理。</p>
			)}
			{supported && !trusted && (
				<div className="space-y-2">
					<p className="text-ui-12 leading-relaxed text-ink-dim">
						读取 Git 前需要信任当前项目；仓库过滤器可能执行本机程序。
					</p>
					<Button onClick={() => setTrust(true)}>信任当前项目</Button>
				</div>
			)}
			{supported && trusted && (
				<>
					<header className="flex items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-ui-12 text-ink" title={data?.root}>
							⎇ {data?.branch || "未创建分支"}
						</span>
						<Button size="sm" disabled={busy} onClick={() => void run(refresh)}>
							刷新
						</Button>
					</header>
					<div className="flex flex-wrap gap-1" role="tablist" aria-label="Git 分类">
						{[
							["review", "工作区"],
							["commit", "提交"],
							["history", "历史"],
							["manage", "分支与标签"],
						].map(([key, label]) => (
							<Button
								key={key}
								size="sm"
								role="tab"
								disabled={busy}
								aria-selected={tab === key}
								className={tab === key ? "bg-hover text-ink" : ""}
								onClick={() => (key === "history" ? loadHistory() : setTab(key))}
							>
								{label}
							</Button>
						))}
					</div>
					{data && !writable && (
						<p role="status" className="text-ui-11 text-ink-faint">
							会话任务、配置操作或合并结束后可写入；仍可审查差异。
						</p>
					)}
					{tab === "review" && (
						<>
							<div className="flex items-center justify-between gap-2">
								<select
									aria-label="变更来源"
									className={`${inputClass} !w-auto`}
									value={String(staged)}
									onChange={(event) => {
										setStaged(event.target.value === "true");
										setSelected(null);
										setPatch("");
									}}
								>
									<option value="false">未暂存</option>
									<option value="true">已暂存</option>
								</select>
								<Button
									size="sm"
									disabled={!allowed(staged ? "unstage" : "stage") || !rows.length}
									onClick={bulk}
								>
									{staged ? "全部取消暂存" : "全部暂存"}
								</Button>
							</div>
							{rows.length === 0 ? (
								<p className="py-6 text-center text-ui-12 text-ink-faint">
									没有{staged ? "已暂存" : "未暂存"}的变更。
								</p>
							) : (
								rows.map((file) => (
									<div key={file.path} className="border-b border-border py-1">
										<div className="flex items-center gap-1">
											<button
												type="button"
												className="min-w-0 flex-1 truncate py-2 text-left text-ui-12 text-ink-dim hover:text-ink"
												onClick={() => showPatch(file.path)}
											>
												{file.path}
											</button>
											<Button
												size="sm"
												disabled={!allowed(staged ? "unstage" : "stage")}
												onClick={() =>
													void prepare({ action: staged ? "unstage" : "stage", paths: [file.path] })
												}
											>
												{staged ? "取消暂存" : "暂存"}
											</Button>
										</div>
										{selected === file.path && (
											<>
												<PatchView patch={patch} />
												{snapshot?.gitAnalysis && /\.(?:[cm]?[jt]sx?|jsonc?)$/i.test(file.path) && (
													<Button
														size="sm"
														disabled={busy}
														onClick={() =>
															void run(async () =>
																setAnalysis(
																	await nativeRequest(
																		"/api/git-analysis",
																		{ path: file.path },
																		sessionId,
																	),
																),
															)
														}
													>
														分析当前文件
													</Button>
												)}
												{analysis && (
													<pre className="whitespace-pre-wrap text-ui-11 text-ink-dim">
														{JSON.stringify(analysis, null, 2)}
													</pre>
												)}
											</>
										)}
									</div>
								))
							)}
						</>
					)}
					{tab === "commit" && (
						<form
							className="space-y-3"
							onSubmit={(event) => {
								event.preventDefault();
								void prepare({ action: "commit", message });
							}}
						>
							<p className="text-ui-11 text-ink-faint">仅提交已暂存变更，不自动添加文件。</p>
							<Field label="提交说明">
								<textarea
									aria-label="提交说明"
									required
									rows={5}
									className={inputClass}
									value={message}
									onChange={(event) => {
										setMessage(event.target.value);
										commitDrafts.set(sessionId, event.target.value);
									}}
								/>
							</Field>
							<Button
								type="submit"
								variant="primary"
								disabled={
									!allowed("commit") || !message.trim() || !data?.files.some((row) => row.staged)
								}
							>
								预览提交
							</Button>
						</form>
					)}
					{tab === "history" && (
						<>
							<div className="flex items-center gap-2">
								<select
									aria-label="Git 图表范围"
									disabled={busy}
									className={inputClass}
									value={historyScope}
									onChange={(event) => {
										setHistoryScope(event.target.value);
										loadHistory(1, event.target.value);
									}}
								>
									<option value="current">当前 HEAD</option>
									<option value="all">全部分支与标签</option>
								</select>
								<Button
									size="sm"
									className="shrink-0 whitespace-nowrap"
									disabled={busy}
									onClick={() => loadHistory()}
								>
									刷新历史
								</Button>
							</div>
							{history?.commits?.map((commit, index) => (
								<button
									key={commit.id}
									type="button"
									className="flex w-full items-center gap-2 border-b border-border py-2 text-left hover:bg-hover"
									onClick={() =>
										void run(async () => {
											const value = await read("show", { ref: commit.id });
											setPatch(value.output);
											setSelected(commit.id);
										})
									}
								>
									{history.graph?.rows[index] && (
										<svg
											aria-hidden
											width={history.graph.width}
											height={history.graph.height}
											className="shrink-0"
										>
											<g fill="none" stroke="currentColor" className="text-ink-faint">
												{history.graph.rows[index].edges.map((edge: any, i: number) => (
													<path key={i} d={edge.path} />
												))}
											</g>
											<circle
												cx={history.graph.rows[index].node.x}
												cy={history.graph.rows[index].node.y}
												r={3}
												fill="currentColor"
												className="text-ink-dim"
											/>
										</svg>
									)}
									<span className="min-w-0 flex-1">
										<span className="block truncate text-ui-12 text-ink">{commit.subject}</span>
										<span className="text-ui-10 text-ink-faint">
											{commit.shortId} · {commit.author} · {commit.date}
										</span>
										<span className="flex flex-wrap gap-1">
											{commit.references?.map((item) => (
												<span
													key={item.id}
													className="rounded bg-hover px-1 text-ui-10 text-ink-dim"
												>
													{item.name}
												</span>
											))}
										</span>
									</span>
								</button>
							))}
							<div className="flex items-center justify-between">
								<Button
									size="sm"
									disabled={busy || (history?.page ?? 1) <= 1}
									onClick={() => loadHistory((history?.page ?? 1) - 1)}
								>
									上一页
								</Button>
								<span className="text-ui-11 text-ink-faint">第 {history?.page ?? 1} 页</span>
								<Button
									size="sm"
									disabled={busy || !history?.nextPage}
									onClick={() => loadHistory(history!.nextPage!)}
								>
									下一页
								</Button>
							</div>
							{selected && <PatchView patch={patch} />}
						</>
					)}
					{tab === "manage" && (
						<form
							className="space-y-3"
							onSubmit={(event) => {
								event.preventDefault();
								void prepare({
									action,
									ref,
									...(action === "checkout"
										? { mode, ...(mode === "create" ? { branch: name } : {}) }
										: action === "reset"
											? { mode: ["soft", "mixed"].includes(mode) ? mode : "soft" }
											: action === "tag"
												? { operation: tagOperation, name, message: tagMessage }
												: {}),
								});
							}}
						>
							<Field label="操作">
								<select
									className={inputClass}
									value={action}
									onChange={(event) => {
										setAction(event.target.value);
										setMode(event.target.value === "reset" ? "soft" : "auto");
									}}
								>
									{[
										["checkout", "分支或提交"],
										["merge", "合并"],
										["reset", "回退（保留工作树）"],
										["tag", "本地标签"],
									].map(([value, label]) => (
										<option key={value} value={value}>
											{label}
										</option>
									))}
								</select>
							</Field>
							<Field label="目标分支、标签或提交 SHA">
								<input
									aria-label="目标引用"
									className={inputClass}
									value={ref}
									onChange={(event) => setRef(event.target.value)}
								/>
							</Field>
							{["checkout", "reset"].includes(action) && (
								<Field label="模式">
									<select
										aria-label="Git 操作模式"
										className={inputClass}
										value={mode}
										onChange={(event) => setMode(event.target.value)}
									>
										{(action === "reset"
											? [
													["soft", "soft · 保留索引和工作树"],
													["mixed", "mixed · 取消暂存并保留工作树"],
												]
											: [
													["auto", "已有分支或提交"],
													["create", "创建分支"],
													["detach", "Detached HEAD"],
												]
										).map(([value, label]) => (
											<option key={value} value={value}>
												{label}
											</option>
										))}
									</select>
								</Field>
							)}
							{action === "tag" && (
								<Field label="标签操作">
									<select
										className={inputClass}
										value={tagOperation}
										onChange={(event) => setTagOperation(event.target.value)}
									>
										<option value="create">创建</option>
										<option value="delete">删除本地标签</option>
									</select>
								</Field>
							)}
							{(action === "tag" || (action === "checkout" && mode === "create")) && (
								<Field label="名称">
									<input
										aria-label="分支或标签名称"
										className={inputClass}
										required
										value={name}
										onChange={(event) => setName(event.target.value)}
									/>
								</Field>
							)}
							{action === "tag" && (
								<>
									<Field label="标签注释">
										<textarea
											className={inputClass}
											value={tagMessage}
											onChange={(event) => setTagMessage(event.target.value)}
										/>
									</Field>
									<div className="flex flex-wrap gap-1">
										{data?.tags.map((tag) => (
											<Button
												size="sm"
												key={tag}
												onClick={() => {
													setName(tag);
													setRef(tag);
												}}
											>
												{tag}
											</Button>
										))}
									</div>
								</>
							)}
							<Button type="submit" variant="primary" disabled={!allowed(action)}>
								预览操作
							</Button>
						</form>
					)}
					<details className="border-t border-border pt-3">
						<summary className="cursor-pointer text-ui-12 text-ink-dim">切换分支与远端同步</summary>
						<div className="mt-3 space-y-3">
							<Field label="本地分支">
								<select
									aria-label="本地分支"
									className={inputClass}
									value={branch}
									onChange={(event) => setBranch(event.target.value)}
								>
									{data?.branches.map((row) => (
										<option key={row}>{row}</option>
									))}
								</select>
							</Field>
							<Button
								disabled={!allowed("switch") || !!data?.files.length}
								onClick={() => void prepare({ action: "switch", branch })}
							>
								预览切换
							</Button>
							<Field label="远端">
								<select
									aria-label="已配置远端"
									className={inputClass}
									value={remote}
									onChange={(event) => setRemote(event.target.value)}
								>
									{data?.remotes.map((row) => (
										<option key={row}>{row}</option>
									))}
								</select>
							</Field>
							<div className="flex gap-1">
								{["fetch", "pull", "push"].map((kind) => (
									<Button
										key={kind}
										disabled={!allowed(kind) || !remote}
										onClick={() => void prepare({ action: kind, remote })}
									>
										{labels[kind]}
									</Button>
								))}
							</div>
						</div>
					</details>
				</>
			)}
			{plan && (
				<ConfirmDialog
					title={`确认 Git ${labels[plan.request.action] ?? plan.request.action}`}
					description={
						[
							plan.request.message,
							plan.request.paths?.join("、"),
							plan.request.branch,
							plan.request.name,
							plan.request.commit,
							plan.warning,
							plan.note,
						]
							.filter(Boolean)
							.join("\n") || "执行已预览的 Git 操作？"
					}
					confirmLabel="确认执行"
					cancelLabel="取消"
					onConfirm={execute}
					onCancel={() => setPlan(null)}
				/>
			)}
			{trust && (
				<ConfirmDialog
					title="信任当前项目"
					description={`信任 ${snapshot?.cwd}？项目扩展和仓库过滤器可能执行本机程序。`}
					confirmLabel="信任项目"
					cancelLabel="取消"
					onCancel={() => setTrust(false)}
					onConfirm={() => {
						setTrust(false);
						void run(async () => {
							await nativeRequest("/api/project-trust", { trusted: true }, sessionId);
						});
					}}
				/>
			)}
		</section>
	);
}

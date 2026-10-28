import type { SessionMeta } from "@percho/shared";
import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { desktopRequest, desktopSessions, nativeRequest } from "../../pi-http-bridge";
import { useNativeSession } from "../../stores/desktop-workspace";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { COMPOSER_FOCUS_EVENT, useDraftStore, withDraftText } from "../../stores/drafts";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Feedback, Field, inputClass } from "./NativeControls";
import { readClientPolicy } from "../../../../../../ui/shared/client-policy.js";
import {
	projectRoundTree,
	DEFAULT_ROUND_LIMIT,
	MAX_ROUND_LIMIT,
} from "../../../../../../ui/shared/round-tree-view.js";
import {
	taskKindLabel,
	taskStatusLabel,
	taskDeliveryLabel,
	taskReceiptLabel,
} from "../../../../../../ui/shared/task-vocabulary.js";
import { createExtensionAdapterRegistry } from "../../../../../../shared/extension-adapters.mjs";
import {
	projectExtensionPages,
	projectExtensionPanels,
} from "../../../../../../ui/shared/extension-workbench.js";

type TaskDraft = {
	values: Record<string, string>;
	attempt?: { signature: string; requestId: string };
};
const drafts = new Map<string, TaskDraft>();
const EMPTY_TASK: Record<string, string> = {
	name: "",
	prompt: "",
	model: "",
	thinkingLevel: "",
	instructions: "",
	tools: "",
	maxTurns: "",
};
const WAIT_TOTAL_MS = 5 * 60 * 1000;
async function openSession(id: string) {
	const meta = (await desktopSessions.list()).find((row: SessionMeta) => row.sessionId === id);
	if (!meta) throw new Error("会话不存在");
	await useProjectsStore.getState().openSession(meta);
	await useProjectsStore.getState().load();
}
function prefill(id: string, text: string) {
	useDraftStore.getState().updateDraft(id, (draft) => withDraftText(draft, text));
	window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT, { detail: { moveToEnd: true } }));
}
export function TasksPanel({ sessionId }: { sessionId: string }) {
	const { snapshot, error: stateError } = useNativeSession(sessionId);
	const [tab, setTab] = useState("tasks");
	const [roundLimit, setRoundLimit] = useState(DEFAULT_ROUND_LIMIT);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [data, setData] = useState<any>(null);
	const [tree, setTree] = useState<any>(null);
	const [history, setHistory] = useState<any>(null);
	const [detail, setDetail] = useState<any>(null);
	const [selected, setSelected] = useState<number | null>(null);
	const [compose, setCompose] = useState(false);
	const [draft, setDraft] = useState(drafts.get(sessionId)?.values ?? EMPTY_TASK);
	const [busy, setBusy] = useState(false);
	const [waiting, setWaiting] = useState<number | null>(null);
	const [query, setQuery] = useState("");
	const [confirm, setConfirm] = useState<{
		title: string;
		description: string;
		execute: () => Promise<void>;
	} | null>(null);
	const waitRequest = useRef<AbortController | null>(null);
	const live = useRef(true);
	const detailSequence = useRef(0);
	const policy = readClientPolicy({
		sessionId: snapshot?.sessionId,
		ready: snapshot && !snapshot.initializing,
		capabilities: snapshot?.capabilities,
		sessionCommands: snapshot?.sessionCommands,
		taskCommands: snapshot?.sessionCommands && !snapshot?.capabilities?.remote,
	});
	const body = (command: string, extra: object = {}) => ({
		command,
		id: Number(snapshot.sessionId),
		sessionId: String(snapshot.sessionId),
		...extra,
	});
	const refresh = async () => {
		const value = await nativeRequest("/api/tasks", undefined, sessionId);
		if (live.current) setData(value);
	};
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
			waitRequest.current?.abort();
		};
	}, [sessionId]);
	useEffect(() => {
		if (!snapshot || !policy.canReadTasks) return;
		let active = true;
		const update = () =>
			void nativeRequest("/api/tasks", undefined, sessionId)
				.then((value) => {
					if (active) setData(value);
				})
				.catch((reason: Error) => {
					if (active) setError(reason.message);
				});
		update();
		const timer = setInterval(update, 1500);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [sessionId, Boolean(snapshot), policy.canReadTasks]);
	useEffect(() => {
		if (selected === null || !policy.canReadTaskDetails) return;
		const sequence = ++detailSequence.current;
		const controller = new AbortController();
		const update = () =>
			void desktopSessions
				.path(`/api/task-detail?taskId=${selected}`, sessionId)
				.then((path) => desktopRequest(path, undefined, { signal: controller.signal }))
				.then((value) => {
					if (!controller.signal.aborted && sequence === detailSequence.current) setDetail(value);
				})
				.catch((reason: Error) => {
					if (!controller.signal.aborted) setError(reason.message);
				});
		update();
		const timer = setInterval(update, 1500);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, [sessionId, selected, policy.canReadTaskDetails]);
	const run = async (action: () => Promise<void>) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (reason) {
			if (live.current) setError((reason as Error).message);
		} finally {
			if (live.current) setBusy(false);
		}
	};
	const change = (key: string, value: string) =>
		setDraft((previous) => {
			const values = { ...previous, [key]: value };
			drafts.set(sessionId, { ...drafts.get(sessionId), values });
			return values;
		});
	const spawn = async () => {
		const config: Record<string, unknown> = {};
		if (draft.model) config.model = JSON.parse(draft.model);
		if (draft.maxTurns) config.maxTurns = Number(draft.maxTurns);
		for (const key of ["thinkingLevel", "instructions"]) if (draft[key]) config[key] = draft[key];
		if (draft.tools.trim())
			config.tools = draft.tools
				.split(/[,\n]/)
				.map((value) => value.trim())
				.filter(Boolean);
		const input = body("subagent.spawn", {
			name: draft.name,
			prompt: draft.prompt,
			...(Object.keys(config).length ? { config } : {}),
		});
		const signature = JSON.stringify(input);
		const previous = drafts.get(sessionId)?.attempt;
		const attempt =
			previous?.signature === signature ? previous : { signature, requestId: crypto.randomUUID() };
		drafts.set(sessionId, { values: draft, attempt });
		const result = await nativeRequest(
			"/api/command",
			{ ...input, requestId: attempt.requestId },
			sessionId,
		);
		if (!live.current) return;
		drafts.delete(sessionId);
		setDraft(EMPTY_TASK);
		setCompose(false);
		setSelected(result.taskId);
		setMessage("子代理任务已创建。");
		await refresh();
	};
	const wait = async (taskId: number) => {
		waitRequest.current?.abort();
		const controller = new AbortController();
		waitRequest.current = controller;
		setWaiting(taskId);
		setError("");
		const timer = setTimeout(() => controller.abort(), WAIT_TOTAL_MS);
		try {
			const path = await desktopSessions.path("/api/command", sessionId);
			while (!controller.signal.aborted) {
				try {
					const result = await desktopRequest(path, body("wait", { taskId }), {
						signal: controller.signal,
					});
					if (!controller.signal.aborted && live.current) {
						setMessage(result.outcome?.status ? `任务：${result.outcome.status}` : "任务已结束。");
						await refresh();
					}
					break;
				} catch (reason) {
					if ((reason as any).status !== 408 || controller.signal.aborted) throw reason;
				}
			}
		} catch (reason) {
			if (live.current && !controller.signal.aborted) setError((reason as Error).message);
		} finally {
			clearTimeout(timer);
			if (waitRequest.current === controller) {
				waitRequest.current = null;
				if (live.current) {
					setWaiting(null);
					if (controller.signal.aborted) setMessage("观察等待已取消，任务继续运行。");
				}
			}
		}
	};
	const loadTree = () =>
		void run(async () => {
			const result = await nativeRequest("/api/tree", undefined, sessionId);
			if (live.current) {
				setTree(result);
				setTab("tree");
			}
		});
	const loadHistory = (before?: number) =>
		void run(async () => {
			const result = await nativeRequest(
				`/api/subagent-history${before === undefined ? "" : `?before=${before}`}`,
				undefined,
				sessionId,
			);
			if (live.current)
				setHistory((previous: any) =>
					before === undefined
						? result
						: { ...result, records: [...previous.records, ...result.records] },
				);
		});
	const branchAction = async (kind: string, entryId: number) => {
		const result = await nativeRequest(
			"/api/command",
			body(kind, {
				entryId,
				...(kind === "fork" ? { mode: "tail", expectedEntryId: entryId } : {}),
			}),
			sessionId,
		);
		if (!live.current) return;
		if (kind === "fork") {
			const selected = await desktopSessions.target(sessionId);
			const next =
				result.agentId ??
				(selected.owner ? `${selected.owner}/${result.sessionId}` : String(result.sessionId));
			await openSession(next);
		} else {
			setTree(await nativeRequest("/api/tree", undefined, sessionId));
			setMessage("已退回到所选轮次。");
		}
	};
	const tasks = data?.tasks ?? [];
	const rounds = projectRoundTree(tree, roundLimit).rounds;
	return (
		<section className="space-y-3 p-3" aria-label="任务与分支">
			<div className="flex flex-wrap gap-1" role="tablist" aria-label="任务分类">
				{[
					["tasks", "任务与子代理"],
					["tree", "对话分支"],
					["extensions", "扩展面板"],
				].map(([key, label]) => (
					<Button
						key={key}
						size="sm"
						role="tab"
						aria-selected={tab === key}
						className={tab === key ? "bg-hover text-ink" : ""}
						onClick={() => (key === "tree" ? loadTree() : setTab(key))}
					>
						{label}
					</Button>
				))}
			</div>
			<Feedback error={error || stateError} message={message} />
			{tab === "tasks" && (
				<>
					<div className="flex items-center justify-between">
						<h3 className="text-ui-13 font-medium text-ink">任务与子代理</h3>
						<Button disabled={!policy.canManageTasks} onClick={() => setCompose((value) => !value)}>
							新建子代理
						</Button>
					</div>
					<input
						aria-label="搜索任务"
						className={inputClass}
						placeholder="搜索任务"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					{compose && (
						<form
							data-task-compose
							className="space-y-3 rounded-lg border border-border p-3"
							onSubmit={(event) => {
								event.preventDefault();
								void run(spawn);
							}}
						>
							<fieldset disabled={busy} className="space-y-3">
								<Field label="名称（可选）">
									<input
										name="name"
										aria-label="子代理名称"
										className={inputClass}
										maxLength={120}
										value={draft.name}
										onChange={(event) => change("name", event.target.value)}
									/>
								</Field>
								<Field label="委托任务">
									<textarea
										name="prompt"
										aria-label="委托任务"
										className={inputClass}
										required
										rows={4}
										maxLength={512000}
										value={draft.prompt}
										onChange={(event) => change("prompt", event.target.value)}
									/>
								</Field>
								<details>
									<summary className="cursor-pointer text-ui-12 text-ink-dim">
										模型、工具与回合预算
									</summary>
									<div className="mt-3 space-y-3">
										<Field label="模型">
											<select
												name="model"
												className={inputClass}
												value={draft.model}
												onChange={(event) => change("model", event.target.value)}
											>
												<option value="">继承当前模型</option>
												{data?.models?.map((row: any) => (
													<option
														key={`${row.provider}/${row.modelId}`}
														value={JSON.stringify({ provider: row.provider, modelId: row.modelId })}
													>
														{row.provider} / {row.name ?? row.modelId}
													</option>
												))}
											</select>
										</Field>
										<Field label="思考等级">
											<select
												name="thinkingLevel"
												className={inputClass}
												value={draft.thinkingLevel}
												onChange={(event) => change("thinkingLevel", event.target.value)}
											>
												<option value="">继承当前设置</option>
												{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
													(level) => (
														<option key={level}>{level}</option>
													),
												)}
											</select>
										</Field>
										<Field label="额外指令">
											<textarea
												name="instructions"
												className={inputClass}
												value={draft.instructions}
												onChange={(event) => change("instructions", event.target.value)}
											/>
										</Field>
										<Field label="工具（逗号分隔，留空继承）">
											<input
												name="tools"
												className={inputClass}
												value={draft.tools}
												onChange={(event) => change("tools", event.target.value)}
											/>
										</Field>
										<Field label="最大模型回合">
											<input
												name="maxTurns"
												type="number"
												min={1}
												max={256}
												step={1}
												className={inputClass}
												value={draft.maxTurns}
												onChange={(event) => change("maxTurns", event.target.value)}
											/>
										</Field>
									</div>
								</details>
								<Button type="submit" variant="primary" disabled={busy || !policy.canManageTasks}>
									创建子代理
								</Button>
								<Button onClick={() => setCompose(false)}>收起</Button>
							</fieldset>
						</form>
					)}
					{!policy.canReadTasks && snapshot && (
						<p className="py-4 text-ui-12 text-ink-faint">当前宿主不提供原生任务管理。</p>
					)}
					{tasks
						.filter((task: any) =>
							`${task.name} ${task.id} ${task.kind}`.toLowerCase().includes(query.toLowerCase()),
						)
						.map((task: any) => (
							<article
								key={task.id}
								className="space-y-2 border-b border-border py-3"
								data-task-id={task.id}
							>
								<button
									type="button"
									className="w-full text-left"
									onClick={() => setSelected(Number(task.id))}
								>
									<strong className="text-ui-12 text-ink">
										{task.name ?? taskKindLabel(task.kind)}
									</strong>
									<p className="text-ui-11 text-ink-faint">
										#{task.id} · {taskStatusLabel(task.status)}
										{task.owner ? ` · 父任务 #${task.owner}` : ""}
										{task.waitingOn?.length ? ` · 等待 ${task.waitingOn.join("、")}` : ""}
									</p>
									{task.blockedReason && (
										<p className="text-ui-11 text-err">{task.blockedReason}</p>
									)}
								</button>
								<div className="flex gap-1">
									<Button
										size="sm"
										disabled={!policy.canManageTasks}
										onClick={() =>
											waiting === task.id
												? waitRequest.current?.abort()
												: void wait(Number(task.id))
										}
									>
										{waiting === task.id ? "取消等待" : "等待"}
									</Button>
									<Button
										size="sm"
										tone="danger"
										disabled={busy || !policy.canManageTasks}
										onClick={() =>
											setConfirm({
												title: "中止任务",
												description: `中止任务 #${task.id} 及其拥有的工作？`,
												execute: async () => {
													await nativeRequest(
														"/api/command",
														body("cancel", { taskId: Number(task.id) }),
														sessionId,
													);
													await refresh();
												},
											})
										}
									>
										中止
									</Button>
								</div>
							</article>
						))}
					{policy.canReadTasks && !tasks.length && (
						<p className="py-4 text-ui-12 text-ink-faint">当前没有进行中的任务。</p>
					)}
					{data?.tools?.map((tool: any, index: number) => (
						<details key={tool.id ?? index}>
							<summary className="text-ui-12 text-ink-dim">
								{tool.name ?? tool.toolName} · 执行中
							</summary>
							<pre className="whitespace-pre-wrap text-ui-11 text-ink-dim">
								{typeof tool.output === "string"
									? tool.output
									: JSON.stringify(tool.args ?? tool.input, null, 2)}
							</pre>
						</details>
					))}
					{tasks.some((task: any) => task.background) && (
						<Button
							size="sm"
							tone="danger"
							disabled={busy || !policy.canManageTasks}
							onClick={() =>
								setConfirm({
									title: "中止后台任务",
									description: "只中止带后台标记的任务，前台工作保持运行。",
									execute: async () => {
										await nativeRequest(
											"/api/command",
											body("cancel", { background: true }),
											sessionId,
										);
										await refresh();
									},
								})
							}
						>
							中止后台
						</Button>
					)}
					{policy.canReadSubagentHistory && (
						<details
							onToggle={(event) => {
								if (event.currentTarget.open && !history) loadHistory();
							}}
						>
							<summary className="cursor-pointer text-ui-12 text-ink-dim">已结束的子代理</summary>
							<div className="space-y-1 pt-2">
								{history?.records?.map((record: any) => (
									<Button
										key={record.id}
										size="sm"
										className="block w-full text-left"
										onClick={() => setSelected(Number(record.id))}
									>
										{record.name} · {taskReceiptLabel(record)}
									</Button>
								))}
								{history?.nextBefore != null && (
									<Button disabled={busy} onClick={() => loadHistory(history.nextBefore)}>
										更早记录
									</Button>
								)}
								{history?.records?.length === 0 && (
									<p className="text-ui-11 text-ink-faint">暂无已结束的委托。</p>
								)}
							</div>
						</details>
					)}
					{detail && selected !== null && <TaskDetail data={detail} />}
				</>
			)}
			{tab === "tree" && (
				<div role="tree" aria-label="对话轮次与分支路径">
					<label className="mb-3 flex items-center gap-2 text-ui-11 text-ink-faint">
						最近
						<input
							className={`${inputClass} !w-20`}
							aria-label="分支树显示的最近对话轮数"
							type="number"
							min={1}
							max={MAX_ROUND_LIMIT}
							value={roundLimit}
							onChange={(event) => {
								const value = Number(event.target.value);
								if (Number.isSafeInteger(value) && value >= 1 && value <= MAX_ROUND_LIMIT)
									setRoundLimit(value);
							}}
						/>
						轮
					</label>
					{rounds.map((round: any) => (
						<article
							key={round.id}
							role="treeitem"
							aria-current={round.current ? "true" : undefined}
							className="mb-3 space-y-2 border-l-2 border-border pl-3"
						>
							<p className="text-ui-11 text-ink-faint">
								第 {round.number} 轮 ·{" "}
								{round.current ? "当前位置" : round.active ? "当前路径" : "历史路径"}
							</p>
							<p className="text-ui-12 text-ink">{round.prompt}</p>
							<p className="line-clamp-3 text-ui-11 text-ink-dim">{round.answer}</p>
							<Button
								size="sm"
								disabled={
									!policy.canManageBranches ||
									!Number.isSafeInteger(round.entryId) ||
									(!round.current && tree?.idle === false)
								}
								onClick={() =>
									round.current
										? void run(() => branchAction("fork", round.entryId))
										: setConfirm({
												title: "退回对话轮次",
												description: `退回到第 ${round.number} 轮？原始树保留。`,
												execute: async () => branchAction("rewind", round.entryId),
											})
								}
							>
								{round.current ? "创建分支" : "退回"}
							</Button>
						</article>
					))}
					{tree?.branches?.length > 0 && (
						<section className="space-y-1 border-t border-border pt-3">
							<h4 className="text-ui-12 text-ink-dim">原有分支</h4>
							{tree.branches.map((branch: any) => (
								<Button
									size="sm"
									key={branch.id}
									onClick={() =>
										void run(async () => {
											const target = await desktopSessions.target(sessionId);
											if (live.current)
												await openSession(
													target.owner ? `${target.owner}/${branch.id}` : String(branch.id),
												);
										})
									}
								>
									{branch.name}
								</Button>
							))}
						</section>
					)}
					{!rounds.length && (
						<p className="py-4 text-ui-12 text-ink-faint">此会话还没有已提交的对话轮次。</p>
					)}
				</div>
			)}
			{tab === "extensions" && snapshot && (
				<ExtensionPages sessionId={sessionId} snapshot={snapshot} onError={setError} />
			)}
			{confirm && (
				<ConfirmDialog
					title={confirm.title}
					description={confirm.description}
					confirmLabel="确认"
					cancelLabel="取消"
					onCancel={() => setConfirm(null)}
					onConfirm={() => {
						const action = confirm.execute;
						setConfirm(null);
						void run(action);
					}}
				/>
			)}
		</section>
	);
}
function TaskDetail({ data }: { data: any }) {
	const task = data.task;
	return (
		<section aria-label="原生任务详情" className="space-y-3 rounded-lg border border-border p-3">
			<h4 className="text-ui-12 font-medium text-ink">
				{taskReceiptLabel(task)} · #{task.id}
			</h4>
			{task.outcome?.error && <p className="text-ui-12 text-err">{task.outcome.error.message}</p>}
			{task.budgetError && <p className="text-ui-12 text-err">{task.budgetError.message}</p>}
			{task.outcome?.result?.answer && (
				<pre className="whitespace-pre-wrap text-ui-12 text-ink-dim">
					{task.outcome.result.answer}
				</pre>
			)}
			{task.outcome?.result?.answerEntryId !== undefined && (
				<p className="text-ui-10 text-ink-faint">原生回答 #{task.outcome.result.answerEntryId}</p>
			)}
			{data.children?.map((child: any) => (
				<div key={child.id}>
					<h5 className="text-ui-12 text-ink">{child.name ?? `子会话 ${child.id}`}</h5>
					{child.partial?.text && (
						<section>
							<p className="text-ui-11 text-ink-faint">正在输出</p>
							<pre className="whitespace-pre-wrap text-ui-12 text-ink-dim">
								{child.partial.text}
							</pre>
						</section>
					)}
					{child.messages?.map((entry: any, index: number) => (
						<details key={entry.id ?? index} open={entry.role === "assistant"}>
							<summary className="text-ui-11 text-ink-faint">{entry.role}</summary>
							<pre className="whitespace-pre-wrap text-ui-12 text-ink-dim">
								{entry.text ??
									(typeof entry.content === "string"
										? entry.content
										: JSON.stringify(entry.content, null, 2))}
							</pre>
						</details>
					))}
					{child.tools?.map((tool: any, index: number) => (
						<details key={index}>
							<summary className="text-ui-11 text-ink-faint">工具 · {tool.name}</summary>
							<pre className="whitespace-pre-wrap text-ui-11 text-ink-dim">
								{typeof tool.output === "string"
									? tool.output
									: JSON.stringify(tool.output, null, 2)}
							</pre>
						</details>
					))}
					{(child.messagesTruncated || child.toolsTruncated) && (
						<p className="text-ui-10 text-ink-faint">较早内容已裁剪。</p>
					)}
				</div>
			))}
			{task.messageResults?.length > 0 && (
				<details>
					<summary className="text-ui-12 text-ink-dim">
						消息处理（{task.messageResults.length} 条）
					</summary>
					{task.messageResults.map((row: any) => (
						<div key={row.submissionId ?? row.deliveryTaskId} className="space-y-1 py-2">
							<p className="text-ui-11 text-ink-dim">
								{row.mode === "followUp" ? "后续消息" : "引导消息"} · #
								{row.submissionId ?? row.deliveryTaskId} · {taskDeliveryLabel(row.status)}
							</p>
							{row.error && <p className="text-ui-11 text-err">{row.error.message}</p>}
						</div>
					))}
				</details>
			)}
			{task.messageResultsTruncated && (
				<p className="text-ui-10 text-ink-faint">仅显示最近的消息处理状态。</p>
			)}
		</section>
	);
}
function ExtensionPages({
	sessionId,
	snapshot,
	onError,
}: {
	sessionId: string;
	snapshot: any;
	onError: (message: string) => void;
}) {
	const registry = useMemo(() => createExtensionAdapterRegistry(), [sessionId]);
	const pages = useMemo(
		() => [
			...projectExtensionPanels(registry, snapshot.messages ?? [], {
				sessionId: String(snapshot.sessionId),
			}),
			...projectExtensionPages(registry, snapshot.messages ?? [], {
				sessionId: String(snapshot.sessionId),
			}),
		],
		[registry, snapshot],
	);
	const [selected, setSelected] = useState("");
	const page = pages.find((row) => row.key === selected) ?? pages[0];
	const disclosures = useRef(new Map<string, boolean>());
	const content = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const root = content.current;
		if (!root) return;
		const toggle = (event: Event) => {
			const node = event.target;
			if (node instanceof HTMLDetailsElement && node.dataset.disclosure)
				disclosures.current.set(node.dataset.disclosure, node.open);
		};
		root.addEventListener("toggle", toggle, true);
		return () => root.removeEventListener("toggle", toggle, true);
	}, [page?.key]);
	const html = page
		? DOMPurify.sanitize(
				page.panel
					? registry.renderPanel(page.panel, { disclosures: disclosures.current })
					: registry.render(page.view, { placement: "page", disclosures: disclosures.current }),
			)
		: "";
	useEffect(() => () => registry.dispose?.(), [registry]);
	const act = async (kind: string, value: string) => {
		try {
			if (!page?.panel?.panel.acceptsAction?.(kind, value)) return;
			if (kind === "command") await nativeRequest("/api/prompt", { message: value }, sessionId);
			else if (kind === "refresh") return;
			else {
				await openSession(sessionId);
				if (kind === "prefill") prefill(sessionId, value);
				else window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT));
			}
		} catch (reason) {
			onError((reason as Error).message);
		}
	};
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap gap-1">
				{pages.map((row) => (
					<Button key={row.key} size="sm" onClick={() => setSelected(row.key)}>
						{row.view.title || row.view.label}
					</Button>
				))}
			</div>
			{page ? (
				<div
					className="desktop-card"
					ref={content}
					onClick={(event) => {
						const target = (event.target as Element).closest<HTMLElement>("[data-panel-action]");
						if (target) void act(target.dataset.panelAction ?? "", target.dataset.panelValue ?? "");
					}}
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			) : (
				<p className="py-4 text-ui-12 text-ink-faint">此会话还没有扩展页面。</p>
			)}
		</div>
	);
}

export function BtwPanel({
	sessionId,
	initialQuestion = "",
}: {
	sessionId: string;
	initialQuestion?: string;
}) {
	const { snapshot, error: stateError } = useNativeSession(sessionId);
	const [threads, setThreads] = useState<any[]>([]);
	const [selected, setSelected] = useState<any>(null);
	const [text, setText] = useState(initialQuestion);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [cancelling, setCancelling] = useState(false);
	const available =
		snapshot &&
		Boolean(
			snapshot.capabilities?.btw ||
				snapshot.commands?.some((row: any) => row.name === "btw" && row.source === "extension"),
		);
	useEffect(() => {
		if (!available) return;
		let live = true;
		const update = () =>
			void nativeRequest("/api/btw", { action: "list" }, sessionId)
				.then((value) => {
					if (live) setThreads(value.rows);
				})
				.catch((reason: Error) => {
					if (live) setError(reason.message);
				});
		update();
		const timer = setInterval(update, 1500);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [sessionId, available]);
	const run = async (input: Record<string, unknown>) => {
		const result = await nativeRequest("/api/btw", input, sessionId);
		if (result.error) throw new Error(result.error);
		setSelected(result.thread);
		return result.thread;
	};
	const act = async (operation: () => Promise<void>) => {
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
	return (
		<section className="space-y-3 p-3" aria-label="独立侧聊">
			<Feedback error={error || stateError} />
			{snapshot && !available ? (
				<p className="text-ui-12 leading-relaxed text-ink-faint">
					当前会话未加载 pi-btw 扩展，可在设置的扩展分类中管理资源。
				</p>
			) : (
				<>
					<p className="text-ui-11 text-ink-faint">独立讨论，不写入主对话。</p>
					<div className="flex flex-wrap gap-1">
						<Button
							size="sm"
							disabled={busy || cancelling}
							onClick={() => {
								setSelected(null);
								setText("");
							}}
						>
							新侧聊
						</Button>
						{threads.map((row) => (
							<Button
								size="sm"
								key={row.id}
								disabled={busy || cancelling}
								onClick={() =>
									void act(async () => {
										await run({ action: "open", threadId: row.id });
									})
								}
							>
								{row.title}
							</Button>
						))}
					</div>
					<form
						className="space-y-2"
						onSubmit={(event) => {
							event.preventDefault();
							void act(async () => {
								const thread = selected ?? (await run({ action: "open" }));
								await run({ action: "ask", question: text, threadId: thread.id });
							});
						}}
					>
						<Field label="侧聊问题">
							<textarea
								aria-label="侧聊问题"
								required
								className={inputClass}
								rows={3}
								value={text}
								onChange={(event) => setText(event.target.value)}
							/>
						</Field>
						<Button type="submit" variant="primary" disabled={busy || cancelling || !available}>
							提问
						</Button>
					</form>
					{selected?.turns.map((turn: any, index: number) => (
						<article key={index} className="space-y-2 border-t border-border pt-3">
							<p className="text-ui-12 font-medium text-ink">{turn.question}</p>
							<pre className="whitespace-pre-wrap text-ui-12 text-ink-dim">{turn.answer}</pre>
						</article>
					))}
					{selected && (
						<div className="flex flex-wrap gap-1">
							<Button
								disabled={cancelling}
								onClick={() => {
									const threadId = selected.id;
									setCancelling(true);
									setError("");
									void run({ action: "cancel", threadId })
										.catch((reason: Error) => setError(reason.message))
										.finally(() => setCancelling(false));
								}}
							>
								取消侧聊
							</Button>
							<Button
								disabled={busy || cancelling || !selected.turns.length}
								onClick={() =>
									void act(async () => {
										await openSession(sessionId);
										prefill(sessionId, selected.turns.at(-1).answer);
									})
								}
							>
								带回主对话输入框
							</Button>
						</div>
					)}
				</>
			)}
		</section>
	);
}

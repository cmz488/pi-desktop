import { memo, useCallback, useEffect, useRef, useState } from "react";
import { updateNativeUi } from "./native-ui";
import DOMPurify from "dompurify";
import { nativeMarkup } from "../../../../../native-markup.mjs";
import {
	desktopRequest,
	desktopSessions,
	nativeRequest,
} from "../../pi-http-bridge";
import { getPi } from "../../api";
import { useSessionsStore } from "../../stores/sessions";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { useProjectsStore } from "../../stores/projects";
import {
	COMPOSER_FOCUS_EVENT,
	useDraftStore,
	withDraftText,
} from "../../stores/drafts";
import "../../../../../native-workbench.css";
import {
	DESKTOP_WORKBENCH_EVENT,
	type DesktopWorkbenchTab,
} from "./desktop-navigation";
import "./native-workbench.css";

const load = (path: string) => import(/* @vite-ignore */ path);
export const escape = (value: unknown) =>
	String(value ?? "").replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			]!,
	);
const field = (
	label: string,
	name: string,
	value = "",
	type = "text",
	extra = "",
) =>
	`<label class="field-label">${escape(label)}<input name="${escape(name)}" type="${type}" value="${escape(value)}" ${extra}></label>`;
const prefill = (id: string, text: string) => {
	useDraftStore
		.getState()
		.updateDraft(id, (draft) => withDraftText(draft, text));
	window.dispatchEvent(
		new CustomEvent(COMPOSER_FOCUS_EVENT, { detail: { moveToEnd: true } }),
	);
};

async function openSession(id: string) {
	const meta = (await desktopSessions.list()).find(
		(row) => row.sessionId === id,
	);
	if (!meta) throw new Error("会话不存在");
	await useProjectsStore.getState().openSession(meta);
	await useProjectsStore.getState().load();
}

type Tab = DesktopWorkbenchTab;
const tabs: [Tab, string][] = [
	["agents", "会话与进程"],
	["extensions", "扩展与任务"],
	["files", "文件与浏览器"],
	["git", "Git"],
	["settings", "Pi 设置与资源"],
	["btw", "侧聊"],
];

export function NativeDesktopBar() {
	const id = useSessionsStore((s) => s.activeSessionId);
	const [open, setOpen] = useState(false);
	const [ui, setUi] = useState<any>(null);
	const close = useCallback(() => setOpen(false), []);
	const [navigation, setNavigation] = useState<{
		tab: Tab;
		view?: string;
		question?: string;
		sessionId?: string;
	}>({ tab: "agents" });
	useEffect(() => {
		const navigate = (event: Event) => {
			setNavigation((event as CustomEvent).detail);
			setOpen(true);
		};
		window.addEventListener(DESKTOP_WORKBENCH_EVENT, navigate);
		return () => window.removeEventListener(DESKTOP_WORKBENCH_EVENT, navigate);
	}, []);
	useEffect(() => {
		setUi(null);
		desktopSessions.select(id);
		updateNativeUi(id);
		if (!id) {
			document.title = "Pi Desktop";
			return;
		}
		let current = true;
		void desktopSessions
			.state(id)
			.then((value) => {
				if (current) {
					setUi({ ...value.ui, statuses: value.statuses });
					updateNativeUi(id, value.ui);
				}
			})
			.catch(console.error);
		const off = getPi().onEvent(({ sessionId, event }) => {
			if (sessionId === id && event.type === "desktop_snapshot") {
				setUi(event.desktopUi);
				updateNativeUi(id, event.desktopUi);
			}
		});
		const offDialog = getPi().onExtensionDialogRequest((request) => {
			if (request.sessionId === id) close();
		});
		return () => {
			current = false;
			off();
			offDialog();
		};
	}, [id, close]);
	useEffect(() => {
		document.title = ui?.title || "Pi Desktop";
	}, [ui?.title]);
	return (
		<>
			<div className="desktop-toolbar">
				<button
					type="button"
					aria-haspopup="dialog"
					onClick={() => {
						setNavigation({ tab: "agents" });
						setOpen(true);
					}}
				>
					Pi 工作台
				</button>
				<span role="status">
					{(ui?.statuses ?? []).join(" · ")}
					{ui?.workingVisible !== false && ui?.workingMessage
						? ` · ${ui.workingMessage}`
						: ""}
					{ui?.recovery?.outstanding
						? ` · 已从检查点恢复 ${ui.recovery.outstanding} 项`
						: ""}
				</span>
				{ui?.capabilities?.usedMembers?.length > 0 && (
					<span title={ui.capabilities.usedMembers.join(", ")}>
						扩展使用了降级界面能力
					</span>
				)}
			</div>
			{open && (
				<NativeWorkbench
					sessionId={id}
					onClose={close}
					navigation={navigation}
				/>
			)}
		</>
	);
}

const NativeWorkbench = memo(function NativeWorkbench({
	sessionId,
	onClose,
	navigation,
}: {
	sessionId: string | null;
	onClose: () => void;
	navigation: {
		tab: Tab;
		view?: string;
		question?: string;
		sessionId?: string;
	};
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [tab, setTab] = useState<Tab>(navigation.tab);
	useEffect(() => {
		setTab(navigation.tab);
	}, [navigation]);
	const [error, setError] = useState("");
	const [scopeId, setScopeId] = useState(navigation.sessionId ?? sessionId);
	useEffect(() => {
		if (navigation.sessionId) setScopeId(navigation.sessionId);
	}, [navigation.sessionId]);
	const [scopes, setScopes] = useState<any[]>([]);
	useEffect(() => {
		let current = true;
		void desktopSessions
			.list()
			.then((rows) => {
				if (!current) return;
				setScopes(rows);
				setScopeId((id) =>
					rows.some((row) => row.sessionId === id)
						? id
						: (rows.find((row) => row.sessionId === sessionId)?.sessionId ??
							rows.find((row) => row.active)?.sessionId ??
							rows[0]?.sessionId ??
							null),
				);
			})
			.catch((error: Error) => {
				if (current) setError(error.message);
			});
		return () => {
			current = false;
		};
	}, [tab, sessionId]);
	useEffect(() => {
		const root = dialog.current!;
		root.showModal();
		const cancel = (e: Event) => {
			e.preventDefault();
			onClose();
		};
		root.addEventListener("cancel", cancel);
		return () => {
			root.removeEventListener("cancel", cancel);
			root.close();
		};
	}, [onClose]);
	return (
		<dialog
			ref={dialog}
			className="desktop-workbench native-dialog"
			aria-label="Pi 工作台"
		>
			<header className="native-header">
				<h2>Pi 工作台</h2>
				<label>
					工作台会话
					<select
						aria-label="工作台会话"
						value={scopeId ?? ""}
						onChange={(event) => setScopeId(event.target.value)}
					>
						<option value="">未选择</option>
						{scopes.map((row) => (
							<option key={row.sessionId} value={row.sessionId}>
								{row.name ?? row.sessionId}
								{row.readOnly ? "（只读）" : ""}
							</option>
						))}
					</select>
				</label>
				<button type="button" onClick={onClose} aria-label="关闭 Pi 工作台">
					关闭
				</button>
			</header>
			<nav className="native-tabs" aria-label="工作台功能">
				{tabs.map(([key, label]) => (
					<button
						type="button"
						key={key}
						aria-current={tab === key ? "page" : undefined}
						onClick={() => {
							setError("");
							setTab(key);
						}}
					>
						{label}
					</button>
				))}
			</nav>
			{error && (
				<p className="native-error" role="alert">
					{error}
				</p>
			)}
			<section
				className="native-body"
				key={`${tab}:${tab === "agents" ? "" : scopeId}:${navigation.view ?? ""}:${navigation.question ?? ""}`}
			>
				{tab === "agents" ? (
					<AgentsPanel
						onOpen={() => {
							onClose();
						}}
						onError={setError}
					/>
				) : !scopeId ? (
					<p>请先从会话与进程页创建或打开会话。</p>
				) : tab === "extensions" ? (
					<ExtensionPanel
						sessionId={scopeId}
						onError={setError}
						onClose={onClose}
						onSettings={() => setTab("settings")}
					/>
				) : tab === "files" ? (
					<FilesPanel sessionId={scopeId} onError={setError} />
				) : tab === "git" ? (
					<GitPanel sessionId={scopeId} onError={setError} />
				) : tab === "settings" ? (
					<SettingsPanel
						sessionId={scopeId}
						onError={setError}
						onClose={onClose}
						initialView={navigation.view}
					/>
				) : (
					<BtwPanel
						sessionId={scopeId}
						onError={setError}
						onClose={onClose}
						initialQuestion={navigation.question}
					/>
				)}
			</section>
		</dialog>
	);
});

function AgentsPanel({
	onOpen,
	onError,
}: {
	onOpen: () => void;
	onError: (value: string) => void;
}) {
	const [workspace, setWorkspace] = useState<any>(null);
	const [archived, setArchived] = useState(false);
	const [busy, setBusy] = useState(false);
	const [cwd, setCwd] = useState("");
	const [editor, setEditor] = useState<any>(null);
	const pinned = useUiPreferencesStore((state) => state.pinnedSessions);
	const edit = async (row: any) => {
		const revision = workspace.revision;
		try {
			const detail =
				row.id && ["prompt", "project"].includes(row.kind)
					? await desktopRequest(
							`/api/workspace/detail?kind=${row.kind}&id=${encodeURIComponent(row.id)}`,
						)
					: row;
			setEditor({ ...detail, kind: row.kind, baseRevision: revision });
		} catch (error) {
			onError((error as Error).message);
		}
	};
	const refresh = useCallback(async () => {
		if (await desktopSessions.detect())
			setWorkspace(await desktopRequest("/api/workspace"));
		else
			setWorkspace({ compatible: true, agents: await desktopSessions.list() });
	}, []);
	useEffect(() => {
		let alive = true;
		const update = () => {
			if (alive) void refresh().catch((e) => onError(e.message));
		};
		update();
		const timer = setInterval(update, 2000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [refresh, onError]);
	const run = async (
		command: string,
		row: any,
		extra: object = {},
		revision = workspace.revision,
	) => {
		if (
			[
				"agent.stop",
				"agent.restart",
				"agent.archive",
				"agent.resume",
				"project.remove",
			].includes(command) &&
			!window.confirm(
				`确认${({ "agent.stop": "停止进程", "agent.restart": "重启进程", "agent.archive": "归档会话", "agent.resume": "接管 Pi 历史", "project.remove": "移除项目（停止所属进程，保留历史，可重新添加目录恢复）" } as any)[command]}「${row.name ?? row.id}」？`,
			)
		)
			return;
		setBusy(true);
		onError("");
		try {
			await desktopRequest("/api/workspace/command", {
				command,
				id: row.id,
				...extra,
				revision,
			});
			await refresh();
			await useProjectsStore.getState().load();
			return true;
		} catch (e) {
			onError((e as Error).message);
			return false;
		} finally {
			setBusy(false);
		}
	};
	if (!workspace) return <p role="status">读取会话与进程…</p>;
	if (workspace.compatible)
		return (
			<>
				<p>当前为兼容宿主，进程生命周期由所属 Pi TUI／SDK 拥有。</p>
				{workspace.agents.map((row: any) => (
					<article className="native-row" key={row.sessionId}>
						<strong>{row.name}</strong>
						<button
							type="button"
							onClick={() => {
								void openSession(row.sessionId)
									.then(onOpen)
									.catch((e) => onError(e.message));
							}}
						>
							打开会话
						</button>
					</article>
				))}
			</>
		);
	return (
		<>
			<div className="native-actions">
				<label>
					<input
						type="checkbox"
						checked={archived}
						onChange={(e) => setArchived(e.target.checked)}
					/>{" "}
					显示归档记录
				</label>
				<button
					type="button"
					onClick={() => void refresh().catch((e) => onError(e.message))}
				>
					刷新
				</button>
			</div>
			<form
				className="native-actions"
				onSubmit={(e) => {
					e.preventDefault();
					void run("project.save", {}, { cwd });
				}}
			>
				<label>
					项目目录
					<input
						aria-label="项目目录"
						value={cwd}
						onChange={(e) => setCwd(e.target.value)}
						required
					/>
				</label>
				<button
					type="button"
					onClick={() =>
						void getPi()
							.pickDirectory()
							.then((path) => {
								if (path) setCwd(path);
							})
							.catch((e) => onError(e.message))
					}
				>
					选择目录
				</button>
				<button disabled={busy} type="submit">
					添加项目
				</button>
			</form>
			<div className="native-actions">
				<button
					type="button"
					onClick={() =>
						void edit({ kind: "prompt", name: "", instructions: "" })
					}
				>
					新建人格与系统提示词
				</button>
			</div>
			{(workspace.promptProfiles ?? []).map((row: any) => (
				<button
					type="button"
					key={row.id}
					onClick={() => void edit({ ...row, kind: "prompt" })}
				>
					编辑人格：{row.name}
				</button>
			))}
			{(workspace.projects ?? []).map((row: any) => (
				<article key={row.id} className="native-row">
					<div>
						<strong>{row.name}</strong>
						<p>{row.cwd}</p>
					</div>
					<button
						disabled={busy}
						type="button"
						onClick={() =>
							void run("conversation.create", {}, { projectId: row.id })
						}
					>
						新建会话
					</button>
					<button
						disabled={busy}
						type="button"
						onClick={() => edit({ ...row, kind: "project" })}
					>
						项目配置
					</button>
					<button
						disabled={busy}
						type="button"
						onClick={() => void run("project.remove", row)}
					>
						移除项目
					</button>
				</article>
			))}
			{(workspace.agents ?? [])
				.filter((row: any) => archived === Boolean(row.archived))
				.map((row: any) => (
					<article key={row.id} className="native-agent">
						<div>
							<strong>{row.name}</strong>
							<p>
								{row.source === "pi" ? "Pi TUI 历史" : row.status} ·{" "}
								{row.cwd ??
									workspace.projects.find((p: any) => p.id === row.projectId)
										?.cwd ??
									"日常空间"}
							</p>
							{row.error && <p role="alert">{row.error}</p>}
						</div>
						<div className="native-actions">
							<button
								disabled={busy}
								type="button"
								onClick={() => void edit({ ...row, kind: "rename" })}
							>
								重命名
							</button>
							<button
								type="button"
								onClick={() =>
									useUiPreferencesStore.getState().togglePin(row.id)
								}
							>
								{pinned.includes(row.id) ? "取消置顶" : "置顶"}
							</button>
							{row.source !== "pi" &&
								row.projectId &&
								row.status === "running" && (
									<button
										disabled={busy}
										type="button"
										onClick={() => {
											void (async () => {
												setBusy(true);
												try {
													const current = await desktopSessions.state(row.id);
													const trusted = !current.projectTrusted;
													if (
														window.confirm(
															trusted
																? `信任项目 ${current.cwd}？项目扩展和工具可能执行本机程序。`
																: `撤销对项目 ${current.cwd} 的信任？`,
														)
													)
														await nativeRequest(
															"/api/project-trust",
															{ trusted },
															row.id,
														);
												} catch (error) {
													onError((error as Error).message);
												} finally {
													setBusy(false);
												}
											})();
										}}
									>
										项目信任
									</button>
								)}
							{row.archived ? (
								<button
									disabled={busy}
									type="button"
									onClick={() => void run("agent.restore", row)}
								>
									恢复归档
								</button>
							) : (
								<>
									<button
										disabled={busy}
										type="button"
										onClick={() => {
											setBusy(true);
											void openSession(row.id)
												.then(onOpen)
												.catch((e) => onError(e.message))
												.finally(() => setBusy(false));
										}}
									>
										打开
									</button>
									{row.source === "pi" ? (
										<button
											disabled={busy}
											type="button"
											onClick={() => void run("agent.resume", row)}
										>
											在 Desktop 中继续
										</button>
									) : (
										<>
											{row.status === "running" ? (
												<>
													<button
														disabled={busy}
														type="button"
														onClick={() => void run("agent.stop", row)}
													>
														停止进程
													</button>
													<button
														disabled={busy}
														type="button"
														onClick={() => void run("agent.restart", row)}
													>
														重启进程
													</button>
												</>
											) : (
												<>
													<button
														disabled={busy}
														type="button"
														onClick={() => void run("agent.start", row)}
													>
														启动进程
													</button>
												</>
											)}
											<label>
												系统提示词
												<select
													aria-label={`系统提示词 ${row.name}`}
													value={row.promptProfileId ?? "standard"}
													disabled={busy}
													onChange={(e) =>
														void run("agent.prompt", row, {
															promptProfileId: e.target.value,
														})
													}
												>
													<option value="standard">Pi 默认</option>
													{(workspace.promptProfiles ?? []).map((p: any) => (
														<option key={p.id} value={p.id}>
															{p.name}
														</option>
													))}
												</select>
											</label>
											<label>
												审批
												<select
													aria-label={`审批 ${row.name}`}
													value={row.approvalMode ?? "ask-risky"}
													disabled={busy}
													onChange={(e) =>
														void run("agent.policy", row, {
															mode: e.target.value,
														})
													}
												>
													<option value="ask-risky">风险操作确认</option>
													<option value="ask-all">全部确认</option>
													<option value="yolo">完全访问</option>
												</select>
											</label>
										</>
									)}
									{row.status !== "running" && (
										<button
											disabled={busy}
											type="button"
											onClick={() => void run("agent.archive", row)}
										>
											归档
										</button>
									)}
								</>
							)}
						</div>
					</article>
				))}
			{editor && (
				<form
					className="native-editor"
					onSubmit={(event) => {
						event.preventDefault();
						const command =
							editor.kind === "rename" ? "agent.rename" : `${editor.kind}.save`;
						const { kind, baseRevision, ...data } = editor;
						void run(command, editor, data, baseRevision).then((saved) => {
							if (saved) setEditor(null);
						});
					}}
				>
					<h3>
						编辑
						{editor.kind === "prompt"
							? "人格"
							: editor.kind === "project"
								? "项目"
								: "Agent"}
					</h3>
					<label>
						名称
						<input
							value={editor.name ?? ""}
							onChange={(e) => setEditor({ ...editor, name: e.target.value })}
							required
						/>
					</label>
					{editor.kind === "prompt" ? (
						<label>
							系统提示词
							<textarea
								rows={10}
								value={editor.instructions ?? ""}
								onChange={(e) =>
									setEditor({ ...editor, instructions: e.target.value })
								}
							/>
						</label>
					) : (
						editor.kind === "project" && (
							<label>
								项目目录
								<input value={editor.cwd ?? ""} readOnly />
							</label>
						)
					)}
					<div className="native-actions">
						<button disabled={busy} type="submit">
							保存
						</button>
						<button type="button" onClick={() => setEditor(null)}>
							取消
						</button>
					</div>
				</form>
			)}
		</>
	);
}

// Form drafts and idempotency receipts are client state, isolated by the full Host identity.
type TaskDraft = {
	values: Record<string, string>;
	attempt?: { signature: string; requestId: string };
};
const taskDrafts = new Map<string, Map<string, TaskDraft>>();

function ExtensionPanel({
	sessionId,
	onError,
	onClose,
	onSettings,
}: {
	sessionId: string;
	onError: (text: string) => void;
	onClose: () => void;
	onSettings: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let disposed = false;
		let cleanup: (() => void) | undefined;
		void (async () => {
			const [
				{ createExtensionWorkbench },
				{ createBranchTreePanel },
				{ createTaskPanel },
				{ createExtensionAdapterRegistry },
			] = await Promise.all([
				load("/extension-workbench.js"),
				load("/branch-tree-panel.js"),
				load("/task-panel.js"),
				load("/extension-adapters.mjs"),
			]);
			if (disposed) return;
			const registry = createExtensionAdapterRegistry();
			registry.setSession?.(sessionId);
			const selected = await desktopSessions.target(sessionId);
			const local = (id: string | number) =>
				selected.owner && /^\d+$/.test(String(id))
					? `${selected.owner}/${id}`
					: String(id);
			const api = async (
				path: string,
				input?: any,
				options?: { signal?: AbortSignal; selectSession?: boolean },
			) => {
				const url = new URL(path, location.origin);
				const id =
					input?.id ??
					url.searchParams.get("sessionId") ??
					url.searchParams.get("id");
				url.searchParams.delete("sessionId");
				url.searchParams.delete("id");
				const target = id == null ? sessionId : local(id);
				return desktopRequest(
					await desktopSessions.path(url.pathname + url.search, target),
					input,
					options,
				);
			};
			const common = {
				toast: onError,
				fetchDetail: (id: string, taskId: number, options: object) =>
					api(
						`/api/task-detail?sessionId=${id}&taskId=${taskId}`,
						undefined,
						options,
					),
				fetchHistory: (
					id: string,
					before: number | undefined,
					options: object,
				) =>
					api(
						`/api/subagent-history?sessionId=${id}${before === undefined ? "" : `&before=${before}`}`,
						undefined,
						options,
					),
			};
			const branches = createBranchTreePanel({
				...common,
				fetchTree: (id: string, options: object) =>
					api(`/api/tree?id=${id}`, undefined, options),
				command: (command: string, input: object) =>
					api("/api/command", { command, ...input }),
				openCreatedSession: async (id: string) => {
					await openSession(local(id));
					onClose();
				},
				switchSession: async (id: string) => {
					await openSession(local(id));
					onClose();
				},
			});
			let nativeId = "";
			const drafts = taskDrafts.get(sessionId) ?? new Map();
			taskDrafts.set(sessionId, drafts);
			const tasks = createTaskPanel({
				drafts,
				...common,
				fetchDetail: common.fetchDetail,
				fetchTasks: (id: string, options: object) =>
					api(`/api/tasks?id=${id}`, undefined, options),
				command: apiCommand,
				currentSession: () => nativeId,
			});
			function apiCommand(input: object, options: object) {
				return api("/api/command", input, options);
			}
			const controller = createExtensionWorkbench({
				root: ref.current,
				registry,
				builtinPages: [branches, tasks],
				sanitize: (html: string) => DOMPurify.sanitize(html),
				loadDetails: async () => refresh(),
				onError,
				onCount: () => {},
				onPanelAction: async ({ kind, value }: any) => {
					if (kind === "refresh") await refresh();
					else if (kind === "command") {
						await nativeRequest("/api/prompt", { message: value }, sessionId);
						await refresh();
					} else {
						await openSession(sessionId);
						if (kind === "prefill") prefill(sessionId, value);
						onClose();
					}
				},
			});
			controller.setActive(true);
			const refresh = async () => {
				const state = await desktopSessions.state(sessionId);
				if (disposed) return;
				nativeId = String(state.sessionId);
				controller.update(state.messages, {
					sessionId: nativeId,
					ready: !state.initializing,
					capabilities: state.capabilities,
					sessionCommands: state.sessionCommands,
					taskCommands: state.sessionCommands && !state.capabilities?.remote,
				});
			};
			cleanup = () => {
				controller.setActive(false);
				branches.dispose();
				tasks.dispose();
				registry.dispose?.();
			};
			await refresh();
			const timer = setInterval(() => {
				void refresh().catch((e) => onError(e.message));
			}, 1500);
			const stop = cleanup;
			cleanup = () => {
				clearInterval(timer);
				stop();
			};
		})().catch((e) => {
			cleanup?.();
			onError(e.message);
		});
		return () => {
			disposed = true;
			cleanup?.();
		};
	}, [sessionId, onError, onClose]);
	return (
		<div
			ref={ref}
			className="native-extensions"
			onClick={(event) => {
				const target = (event.target as Element).closest<HTMLElement>(
					"[data-view]",
				);
				if (target?.dataset.view === "workspace") onClose();
				else if (target?.dataset.view === "plugins") onSettings();
			}}
			dangerouslySetInnerHTML={{
				__html: nativeMarkup["view-extensions"].replace(/ hidden(?=[\s>])/, ""),
			}}
		/>
	);
}

function FilesPanel({
	sessionId,
	onError,
}: {
	sessionId: string;
	onError: (text: string) => void;
}) {
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let disposed = false;
		let controller: any;
		void (async () => {
			const { createWorkspacePanels } = await load("/workspace-panels.js");
			let state = await desktopSessions.state(sessionId);
			if (disposed) return;
			controller = createWorkspacePanels({
				pane: root.current,
				request: (path: string, input: unknown) =>
					nativeRequest(path, input, sessionId),
				snapshot: () => state,
				reveal: () => {},
				show: () => {},
				storageKey: `pi-native-panels:${sessionId}`,
			});
			controller.update();
			controller.configure({
				nativeBrowser: Boolean((window as any).piDesk?.browserCommand),
			});
			await controller.openDirectory("");
		})().catch((e) => onError(e.message));
		return () => {
			disposed = true;
			controller?.dispose();
		};
	}, [sessionId, onError]);
	return <div ref={root} className="native-files" />;
}

function GitPanel({
	sessionId,
	onError,
}: {
	sessionId: string;
	onError: (text: string) => void;
}) {
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let disposed = false;
		let timer: ReturnType<typeof setInterval>;
		void (async () => {
			const { createGitPane } = await load("/git-pane.js");
			let state = await desktopSessions.state(sessionId);
			if (disposed) return;
			const reveal = (mode = "review") => {
				root
					.current!.querySelectorAll<HTMLButtonElement>("[data-right-view]")
					.forEach((button) =>
						button.setAttribute(
							"aria-selected",
							String(button.dataset.rightView === mode),
						),
					);
				for (const key of ["review", "history", "manage", "commit"]) {
					const node = root.current!.querySelector<HTMLElement>(
						`#git-${key}-pane`,
					)!;
					node.hidden = key !== mode;
				}
			};
			const pane = createGitPane({
				root: root.current,
				request: (path: string, input: unknown) =>
					nativeRequest(path, input, sessionId),
				snapshot: () => ({ ...state, live: true, connected: true }),
				esc: escape,
				reveal,
				confirm: (plan: any, execute: () => Promise<void>, note = "") => {
					if (
						window.confirm(
							`确认 Git 操作？\n${JSON.stringify(plan.request, null, 2)}\n${plan.warning ?? ""}\n${note}`,
						)
					)
						void execute().catch((e) => onError(e.message));
				},
			});
			pane.update();
			await pane.open();
			root
				.current!.querySelectorAll<HTMLButtonElement>("[data-right-view]")
				.forEach((button) => {
					button.onclick = () => {
						if (button.dataset.rightView === "history") void pane.history();
						else void pane.open("", button.dataset.rightView);
					};
				});
			timer = setInterval(() => {
				void desktopSessions
					.state(sessionId)
					.then((next) => {
						if (!disposed) {
							state = next;
							pane.update();
						}
					})
					.catch((e) => onError(e.message));
			}, 1500);
		})().catch((e) => onError(e.message));
		return () => {
			disposed = true;
			clearInterval(timer);
		};
	}, [sessionId, onError]);
	return (
		<div
			ref={root}
			className="native-git"
			dangerouslySetInnerHTML={{ __html: nativeMarkup["workspace-right"] }}
		/>
	);
}

function SettingsPanel({
	sessionId,
	onError,
	onClose,
	initialView = "general",
}: {
	sessionId: string;
	onError: (text: string) => void;
	onClose: () => void;
	initialView?: string;
}) {
	const root = useRef<HTMLDivElement>(null);
	const [view, setView] = useState(initialView);
	const currentView = useRef(view);
	currentView.current = view;
	const controllers = useRef<any>(null);
	const pages = [
		"general",
		"personality",
		"providers",
		"skills",
		"mcp",
		"plugins",
		"marketplace",
		"appearance",
	];
	const show = useCallback((page: string) => {
		currentView.current = page;
		setView(page);
		for (const name of pages) {
			const node = root.current?.querySelector<HTMLElement>(`#view-${name}`);
			if (node) node.hidden = page !== name;
		}
		controllers.current?.update();
	}, []);
	useEffect(() => {
		let disposed = false;
		let cleanup: (() => void) | undefined;
		void (async () => {
			const [
				{ createChatDialog },
				{ createPreferencesSettings },
				{ createProviderSettings },
				{ createResourceSettings },
				{ createPackageSettings },
				{ dshIcon },
				{ openAgentConfiguration },
			] = await Promise.all([
				load("/chat-dialog.js"),
				load("/preferences-settings.js"),
				load("/provider-settings.js"),
				load("/resource-settings.js"),
				load("/package-settings.js"),
				load("/dsh-icons.mjs"),
				load("/agent-config.js"),
			]);
			let state = await desktopSessions.state(sessionId);
			if (disposed) return;
			const global = await desktopSessions.detect();
			let configuration = global
				? await desktopRequest("/api/workspace")
				: null;
			const scope = root.current!;
			const api = async (path: string, input?: any, options?: any) => {
				if (
					global &&
					["/api/personality", "/api/packages/update-all"].some((route) =>
						path.startsWith(route),
					)
				)
					return desktopRequest(path, input, options);
				return desktopRequest(
					await desktopSessions.path(path, sessionId),
					input,
					options,
				);
			};
			const identity = `${sessionId}:${state.cwd}`;
			const dialog = createChatDialog({
				scope,
				getIdentity: () => (disposed ? "" : identity),
				onError: (e: Error) => onError(e.message),
			});
			scope
				.querySelectorAll(
					"#dialog [data-close-dialog], #dialog [data-action='close-dialog']",
				)
				.forEach((button) =>
					button.addEventListener("click", () => dialog.close()),
				);
			const refresh = async () => {
				const next = await desktopSessions.state(sessionId);
				if (disposed) return;
				state = next;
				update();
				const [providers, plugins] = await Promise.all([
					api("/api/providers"),
					api("/api/plugins"),
				]);
				if (disposed) return;
				provider.applyInventory("providers", providers);
				provider.applyInventory("modelChoices", providers);
				packages.applyInventory(plugins);
				update();
			};
			const common = {
				root: scope,
				live: true,
				api,
				esc: escape,
				field,
				icon: dshIcon,
				openDialog: (...args: any[]) => dialog.open(...args),
				toast: onError,
				getState: () => state,
				refresh,
			};
			const provider = createProviderSettings({
				...common,
				pollInteractions: async () => {
					await openSession(sessionId);
					onClose();
				},
				selectModel: (provider: string, id: string) =>
					getPi().setModel({ sessionId, provider, modelId: id }),
				setDefaults: (defaults: any) => {
					state.defaults = defaults;
				},
				openModels: (providerId: string) => {
					const row = provider.pickerModels.find(
						(row: any) => row.id === providerId,
					);
					dialog.open(
						"选择当前会话模型",
						`<label class="field-label">模型<select name="model">${(
							row?.models ?? []
						)
							.filter((model: any) => model.available)
							.map(
								(model: any) =>
									`<option value="${escape(model.id)}">${escape(model.name ?? model.id)}</option>`,
							)
							.join("")}</select></label>`,
						async (data: FormData) => {
							await getPi().setModel({
								sessionId,
								provider: providerId,
								modelId: String(data.get("model")),
							});
							await refresh();
						},
					);
				},
				onModelsChanged: () => {},
			});
			const packages = createPackageSettings({
				...common,
				isDialogCurrent: (token: any) => dialog.isCurrent(token),
				getConnected: () => true,
				refreshInventories: refresh,
			});
			const resource = createResourceSettings({
				...common,
				getCommands: () => state.commands ?? [],
				loadCommands: async () => {},
				useCommand: async (name: string) => {
					await openSession(sessionId);
					prefill(sessionId, `/${name} `);
					onClose();
				},
				beginInteraction: async () => {
					await openSession(sessionId);
					onClose();
				},
			});
			const preferences = createPreferencesSettings({
				...common,
				embedded: global,
				manageAppearance: false,
				getDesktopConfiguration: () => configuration,
				showView: show,
				desktopMessage: (type: string, input: any) => {
					if (type !== "configure-prompt") return;
					const revision = configuration.revision;
					void (async () => {
						const row = input?.id
							? await desktopRequest(
									`/api/workspace/detail?kind=prompt&id=${encodeURIComponent(input.id)}`,
								)
							: undefined;
						if (disposed) return;
						dialog.open(
							row ? "编辑人格" : "新建人格",
							`${field("名称", "name", row?.name ?? "", "text", "required")}<label class="field-label">系统提示词<textarea name="instructions" rows="10">${escape(row?.instructions ?? "")}</textarea></label>`,
							async (data: FormData) => {
								await desktopRequest("/api/workspace/command", {
									command: "prompt.save",
									id: row?.id,
									name: data.get("name"),
									instructions: data.get("instructions"),
									revision,
								});
								configuration = await desktopRequest("/api/workspace");
								update();
							},
						);
					})().catch((error: Error) => onError(error.message));
				},
			});
			const update = () => {
				const context = {
					identity,
					view: currentView.current,
					active: !disposed,
				};
				for (const controller of [preferences, provider, resource, packages])
					controller.setContext(context);
				preferences.update();
				provider.update();
			};
			scope.querySelector("#dialog")!.addEventListener("click", (event) => {
				const button = (event.target as Element).closest("button");
				if (
					button &&
					[provider, resource, packages, preferences].some((controller) =>
						controller.handleClick(button),
					)
				)
					event.stopPropagation();
			});
			controllers.current = { update };
			const agentButton = scope.querySelector<HTMLButtonElement>(
				"[data-native-agent]",
			)!;
			agentButton.hidden =
				!state.capabilities?.durable || state.capabilities?.readOnly;
			agentButton.onclick = () => {
				void openAgentConfiguration({
					api,
					snapshot: () => state,
					dialog,
					escape,
					refresh,
				}).catch((error: Error) => onError(error.message));
			};
			cleanup = () => {
				dialog.dispose();
				preferences.dispose();
				provider.dispose();
				resource.dispose();
				packages.dispose();
				controllers.current = null;
			};
			scope
				.querySelector("[data-native-reload]")!
				.addEventListener("click", () => {
					void api("/api/reload", {})
						.then(refresh)
						.then(() => {
							preferences.reloaded();
							packages.reloaded();
						})
						.catch((e) => onError(e.message));
				});
			await refresh();
			show(currentView.current);
		})().catch((e) => {
			cleanup?.();
			onError(e.message);
		});
		return () => {
			disposed = true;
			cleanup?.();
		};
	}, [sessionId, onError, onClose, show]);
	return (
		<div className="native-settings" ref={root}>
			<nav className="native-tabs" aria-label="Pi 设置分类">
				{[
					["general", "Pi 配置"],
					["personality", "人格与提示词"],
					["providers", "提供商"],
					["skills", "技能与命令"],
					["mcp", "MCP"],
					["plugins", "已安装包"],
					["marketplace", "包目录"],
				].map(([key, label]) => (
					<button
						type="button"
						key={key}
						aria-current={view === key ? "page" : undefined}
						onClick={() => show(key)}
					>
						{label}
					</button>
				))}
				<button type="button" data-native-agent hidden>
					配置当前 Agent
				</button>
				<button type="button" data-native-reload>
					重载资源
				</button>
			</nav>
			<button className="desktop-personality" type="button" hidden>
				人格
			</button>
			<div
				dangerouslySetInnerHTML={{
					__html:
						pages.map((name) => nativeMarkup[`view-${name}`]).join("") +
						nativeMarkup.dialog,
				}}
			/>
		</div>
	);
}

function BtwPanel({
	sessionId,
	onError,
	onClose,
	initialQuestion = "",
}: {
	sessionId: string;
	onError: (text: string) => void;
	onClose: () => void;
	initialQuestion?: string;
}) {
	const [threads, setThreads] = useState<any[]>([]);
	const [selected, setSelected] = useState<any>(null);
	const [text, setText] = useState(initialQuestion);
	const [busy, setBusy] = useState(false);
	const [available, setAvailable] = useState<boolean | null>(null);
	const refresh = useCallback(async () => {
		const result = await nativeRequest(
			"/api/btw",
			{ action: "list" },
			sessionId,
		);
		setThreads(result.rows);
	}, [sessionId]);
	useEffect(() => {
		let alive = true;
		let timer: ReturnType<typeof setInterval>;
		const update = () => {
			if (alive) void refresh().catch((e) => onError(e.message));
		};
		void desktopSessions
			.state(sessionId)
			.then((state) => {
				if (!alive) return;
				const supported = Boolean(
					state.capabilities?.btw ||
						state.commands?.some(
							(row: any) => row.name === "btw" && row.source === "extension",
						),
				);
				setAvailable(supported);
				if (supported) {
					update();
					timer = setInterval(update, 1500);
				}
			})
			.catch((e) => {
				if (alive) onError(e.message);
			});
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [sessionId, refresh, onError]);
	const run = async (input: any) => {
		setBusy(true);
		try {
			const result = await nativeRequest("/api/btw", input, sessionId);
			if (result.error) throw new Error(result.error);
			setSelected(result.thread);
			await refresh();
			return result.thread;
		} catch (e) {
			onError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const current = selected;
	if (available !== true)
		return (
			<p>
				{available === null
					? "读取侧聊能力…"
					: "当前会话未加载 pi-btw 扩展，请先从技能与资源管理启用。"}
			</p>
		);
	return (
		<>
			<p>使用当前会话的 pi-btw 扩展，独立讨论不会写入主对话。</p>
			<nav className="native-actions">
				<button
					type="button"
					onClick={() => {
						setSelected(null);
						setText("");
					}}
				>
					新侧聊
				</button>
				{threads.map((row) => (
					<button
						type="button"
						key={row.id}
						onClick={() => void run({ action: "open", threadId: row.id })}
					>
						{row.title}
					</button>
				))}
			</nav>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void (async () => {
						const thread = current ?? (await run({ action: "open" }));
						if (thread)
							await run({ action: "ask", question: text, threadId: thread.id });
					})();
				}}
			>
				<label>
					侧聊问题
					<textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						required
					/>
				</label>
				<button disabled={busy} type="submit">
					提问
				</button>
			</form>
			{current && (
				<>
					{current.turns.map((turn: any, index: number) => (
						<article key={index}>
							<strong>{turn.question}</strong>
							<pre className="native-answer">{turn.answer}</pre>
						</article>
					))}
					<div className="native-actions">
						<button
							type="button"
							onClick={() =>
								void run({ action: "cancel", threadId: current.id })
							}
						>
							取消侧聊
						</button>
						<button
							type="button"
							disabled={!current.turns.length}
							onClick={() => {
								void openSession(sessionId)
									.then(() => {
										prefill(sessionId, current.turns.at(-1).answer);
										onClose();
									})
									.catch((e) => onError(e.message));
							}}
						>
							带回主对话输入框
						</button>
					</div>
				</>
			)}
		</>
	);
}

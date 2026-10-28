import { useEffect } from "react";
import { useSessionsStore } from "../../stores/sessions";
import { useDesktopWorkspace } from "../../stores/desktop-workspace";
import { useUiStore, type RightPanelView } from "../../stores/ui";
import { useSettingsStore } from "../../stores/settings";
import { SessionChanges } from "../diff/DiffSidebar";
import { FilesPanel, BrowserPanel } from "./WorkspaceFiles";
import { GitPanel } from "./WorkspaceGit";
import { BtwPanel, TasksPanel } from "./WorkspaceTasks";
import { CloseIcon } from "../icons";
import { Button } from "../ui/Button";
import { inputClass } from "./NativeControls";
import "./desktop-panels.css";

const TABS: [RightPanelView, string][] = [
	["files", "文件"],
	["web", "网页"],
	["changes", "会话改动"],
	["git", "Git"],
	["tasks", "任务"],
	["btw", "侧聊"],
];
export function WorkspaceSidebar() {
	const open = useUiStore((s) => s.diffSidebarOpen);
	const setOpen = useUiStore((s) => s.setDiffSidebarOpen);
	const view = useUiStore((s) => s.rightPanelView);
	const requested = useUiStore((s) => s.rightSessionId);
	const question = useUiStore((s) => s.rightQuestion);
	const active = useSessionsStore((s) => s.activeSessionId);
	const sessions = useSessionsStore((s) => s.sessions);
	const workspace = useDesktopWorkspace((s) => s.workspace);
	const settingsOpen = useSettingsStore((s) => s.open);
	const id = requested ?? active;
	const scopes = new Map(sessions.map((row) => [row.sessionId, row.name ?? row.sessionId]));
	for (const row of workspace?.agents ?? [])
		if (!row.archived && row.source !== "pi") scopes.set(row.id, row.name);
	useEffect(() => {
		if (!open) return;
		const close = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !document.querySelector('[role="dialog"][aria-modal]'))
				setOpen(false);
		};
		window.addEventListener("keydown", close);
		return () => window.removeEventListener("keydown", close);
	}, [open, setOpen]);
	return (
		<aside
			className={`diff-sidebar workspace-dock${open ? " open" : ""}`}
			aria-label="工作区侧栏"
			aria-hidden={!open}
			inert={!open}
		>
			<div className="flex h-full min-h-0 flex-col">
				<header className="flex shrink-0 items-center border-b border-border px-2 py-1.5">
					<div
						className="flex min-w-0 flex-1 flex-wrap gap-0.5"
						role="tablist"
						aria-label="工作区面板"
					>
						{TABS.map(([key, label]) => (
							<Button
								key={key}
								size="sm"
								role="tab"
								id={`workspace-tab-${key}`}
								aria-controls="workspace-panel"
								aria-selected={view === key}
								tabIndex={view === key ? 0 : -1}
								className={view === key ? "bg-hover text-ink" : ""}
								onKeyDown={(event) => {
									if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
										event.preventDefault();
										const index = TABS.findIndex((row) => row[0] === key);
										const next =
											event.key === "Home"
												? 0
												: event.key === "End"
													? TABS.length - 1
													: (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) %
														TABS.length;
										useUiStore
											.getState()
											.openRightPanel(TABS[next][0], requested ?? undefined, question);
										document.getElementById(`workspace-tab-${TABS[next][0]}`)?.focus();
									}
								}}
								onClick={() =>
									useUiStore.getState().openRightPanel(key, requested ?? undefined, question)
								}
							>
								{label}
							</Button>
						))}
					</div>
					<Button size="sm" aria-label="关闭工作区侧栏" onClick={() => setOpen(false)}>
						<CloseIcon size={14} />
					</Button>
				</header>
				{view !== "changes" && (
					<div className="flex shrink-0 items-center gap-2 px-3 py-2">
						<span className="shrink-0 text-ui-11 text-ink-faint">查看会话</span>
						<select
							aria-label="侧栏会话"
							className={inputClass}
							value={requested ?? ""}
							onChange={(event) =>
								useUiStore
									.getState()
									.openRightPanel(view, event.target.value || undefined, question)
							}
						>
							<option value="">
								跟随当前会话{active && scopes.get(active) ? ` · ${scopes.get(active)}` : ""}
							</option>
							{[...scopes].map(([key, label]) => (
								<option key={key} value={key}>
									{label}
								</option>
							))}
						</select>
					</div>
				)}
				<div
					id="workspace-panel"
					role="tabpanel"
					aria-labelledby={`workspace-tab-${view}`}
					className="min-h-0 flex-1 overflow-auto"
				>
					{open &&
						!settingsOpen &&
						(view === "changes" ? (
							<SessionChanges />
						) : !id ? (
							<p className="p-4 text-ui-12 leading-relaxed text-ink-faint">
								从左侧打开会话，或在上方选择要查看的会话。
							</p>
						) : view === "files" ? (
							<FilesPanel key={`${id}:files`} sessionId={id} />
						) : view === "web" ? (
							<BrowserPanel key={`${id}:web`} sessionId={id} />
						) : view === "git" ? (
							<GitPanel key={`${id}:git`} sessionId={id} />
						) : view === "tasks" ? (
							<TasksPanel key={`${id}:tasks`} sessionId={id} />
						) : (
							<BtwPanel key={`${id}:btw`} sessionId={id} initialQuestion={question} />
						))}
				</div>
			</div>
		</aside>
	);
}

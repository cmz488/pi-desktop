import type { SessionMeta } from "@percho/shared";
import { useState } from "react";
import { useDesktopWorkspace, type DesktopAgent } from "../../stores/desktop-workspace";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useUiStore } from "../../stores/ui";
import { desktopSessions, nativeRequest } from "../../pi-http-bridge";
import { pushExtensionToast } from "../../stores/toasts";
import type { ContextMenuItem } from "../ui/ContextMenu";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Button } from "../ui/Button";
import { openDesktopPanel } from "./desktop-navigation";
import { Feedback } from "./NativeControls";

export function useNativeSessionActions(session?: SessionMeta | null) {
	const workspace = useDesktopWorkspace((s) => s.workspace);
	const [confirmation, setConfirmation] = useState<{
		title: string;
		description: string;
		execute: () => Promise<void>;
	} | null>(null);
	const row = workspace?.agents.find((agent) => agent.id === session?.sessionId);
	const report = (action: () => Promise<void>) =>
		void action().catch((reason: Error) => pushExtensionToast("error", reason.message));
	const command = (kind: string, label: string, danger = false): ContextMenuItem => ({
		key: `native:${kind}`,
		label,
		danger,
		onSelect: () => {
			if (!row || !workspace) return;
			const id = row.id;
			const revision = workspace.revision;
			const execute = () => useDesktopWorkspace.getState().command(kind, id, {}, revision);
			if (["agent.stop", "agent.restart", "agent.resume", "agent.archive"].includes(kind))
				setConfirmation({
					title: label,
					description: `${label}「${row.name}」？${kind === "agent.resume" ? "所属 Pi TUI 退出后才能接管，保留原生会话记录。" : kind === "agent.stop" ? "会话历史保留，运行中的任务将停止。" : ""}`,
					execute,
				});
			else report(execute);
		},
	});
	const items: ContextMenuItem[] = [];
	if (row) {
		if (row.archived) items.push(command("agent.restore", "恢复归档"));
		else if (row.source === "pi") items.push(command("agent.resume", "在 Desktop 中继续"));
		else {
			items.push({
				key: "native:settings",
				label: "会话设置",
				separatorBefore: true,
				onSelect: () => openDesktopPanel("settings", "agent", undefined, row.id),
			});
			if (row.status === "running") {
				items.push(command("agent.stop", "停止进程", true), command("agent.restart", "重启进程"));
				if (row.projectId)
					items.push({
						key: "native:trust",
						label: "项目信任",
						onSelect: () =>
							report(async () => {
								const state = await desktopSessions.state(row.id);
								const trusted = !state.projectTrusted;
								setConfirmation({
									title: trusted ? "信任项目" : "撤销项目信任",
									description: `${state.cwd}。受信任的项目扩展与工具可能执行本机程序。`,
									execute: async () => {
										await nativeRequest("/api/project-trust", { trusted }, row.id);
									},
								});
							}),
					});
			} else items.push(command("agent.start", "启动进程"));
		}
	}
	return {
		items,
		element: confirmation && (
			<ConfirmDialog
				title={confirmation.title}
				description={confirmation.description}
				confirmLabel="确认"
				cancelLabel="取消"
				danger={confirmation.title === "停止进程"}
				onCancel={() => setConfirmation(null)}
				onConfirm={() => {
					const execute = confirmation.execute;
					setConfirmation(null);
					report(execute);
				}}
			/>
		),
	};
}
export function NativeSidebarList({ archived }: { archived: boolean }) {
	const workspace = useDesktopWorkspace((s) => s.workspace);
	const error = useDesktopWorkspace((s) => s.error);
	const search = useProjectsStore((s) => s.search);
	const active = useSessionsStore((s) => s.activeSessionId);
	const view = useUiStore((s) => s.sidebarView);
	const [failure, setFailure] = useState("");
	const run = async (action: () => Promise<void>) => {
		setFailure("");
		try {
			await action();
		} catch (reason) {
			setFailure((reason as Error).message);
		}
	};
	const rows =
		workspace?.agents.filter(
			(row) =>
				Boolean(row.archived) === archived &&
				`${row.name} ${row.cwd ?? ""}`.toLowerCase().includes(search.toLowerCase()),
		) ?? [];
	return (
		<section aria-label={archived ? "归档会话" : "会话进程"} className="space-y-1">
			<header className="flex items-center justify-between px-1 py-2">
				<h3 className="text-ui-12 font-medium text-ink">{archived ? "归档会话" : "会话进程"}</h3>
				<Button size="sm" onClick={() => useUiStore.getState().setSidebarView("sessions")}>
					返回会话
				</Button>
			</header>
			<Feedback error={failure || error} />
			{rows.map((row) => (
				<NativeAgentRow key={row.id} row={row} active={active === row.id} onRun={run} />
			))}
			{!rows.length && (
				<p className="px-2 py-6 text-ui-12 text-ink-faint">
					{view === "archive" ? "没有归档会话。" : "没有匹配的会话进程。"}
				</p>
			)}
		</section>
	);
}
function NativeAgentRow({
	row,
	active,
	onRun,
}: {
	row: DesktopAgent;
	active: boolean;
	onRun: (action: () => Promise<void>) => Promise<void>;
}) {
	const metadata: SessionMeta = {
		sessionId: row.id,
		name: row.name,
		cwd: row.cwd ?? "",
		active: row.status === "running",
		createdAt: 0,
		messageCount: 0,
		archivable: true,
	};
	const actions = useNativeSessionActions(metadata);
	const [expanded, setExpanded] = useState(false);
	const [archiving, setArchiving] = useState(false);
	const open = async () => {
		const meta = (await desktopSessions.list()).find(
			(value: SessionMeta) => value.sessionId === row.id,
		);
		if (!meta) throw new Error("会话已不可用");
		await useProjectsStore.getState().openSession(meta);
		useUiStore.getState().setSidebarView("sessions");
	};
	return (
		<article
			className={`rounded-lg p-2 ${active ? "bg-hover" : "hover:bg-hover/50"}`}
			data-native-agent={row.id}
		>
			<div className="flex items-center gap-1">
				<button
					type="button"
					className="min-w-0 flex-1 text-left"
					onClick={() => (row.archived ? setExpanded((value) => !value) : void onRun(open))}
				>
					<span className="block truncate text-ui-12 text-ink">{row.name}</span>
					<span className="block truncate text-ui-10 text-ink-faint">
						{row.source === "pi" ? "Pi TUI 历史" : row.archived ? "已归档" : row.status}
					</span>
				</button>
				<Button
					size="sm"
					aria-label={`管理会话 ${row.name}`}
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
				>
					···
				</Button>
			</div>
			{row.error && <p className="text-ui-11 text-err">{row.error}</p>}
			{expanded && (
				<div className="mt-1 flex flex-wrap gap-0.5">
					{actions.items.map((item) => (
						<Button
							key={item.key}
							size="sm"
							tone={item.danger ? "danger" : "default"}
							onClick={item.onSelect}
						>
							{item.label}
						</Button>
					))}
					{!row.archived && row.status !== "running" && (
						<Button size="sm" tone="danger" onClick={() => setArchiving(true)}>
							归档
						</Button>
					)}
				</div>
			)}
			{actions.element}
			{archiving && (
				<ConfirmDialog
					title="归档会话"
					description={`归档「${row.name}」并保留完整原生历史？`}
					confirmLabel="归档"
					cancelLabel="取消"
					onCancel={() => setArchiving(false)}
					onConfirm={() => {
						setArchiving(false);
						void onRun(() => useDesktopWorkspace.getState().command("agent.archive", row.id));
					}}
				/>
			)}
		</article>
	);
}

import type { SessionMeta } from "@percho/shared";
import { useState } from "react";
import { useDesktopWorkspace } from "../../stores/desktop-workspace";
import { desktopSessions, nativeRequest } from "../../pi-http-bridge";
import { pushExtensionToast } from "../../stores/toasts";
import type { ContextMenuItem } from "../ui/ContextMenu";
import { ConfirmDialog } from "../ui/ConfirmDialog";

/**
 * 会话右键菜单里的原生进程操作（启停 / 重启 / 归档 / 恢复 / 项目信任）。
 * 「会话进程」不再是独立页面：这里就是进程管理的唯一入口，观察左栏会话行即可操作。
 */
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
					description: `${label}「${row.name}」？${
						kind === "agent.resume"
							? "所属 Pi TUI 退出后才能接管，保留原生会话记录。"
							: kind === "agent.stop"
								? "会话历史保留，运行中的任务将停止。"
								: kind === "agent.archive"
									? "归档后历史保留在归档库，可从「视图选项 → 仅显示已归档」找回。"
									: ""
					}`,
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

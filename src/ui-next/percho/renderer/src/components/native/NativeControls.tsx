import type { ReactNode } from "react";
import { useSessionsStore } from "../../stores/sessions";
import { useDesktopWorkspace } from "../../stores/desktop-workspace";

export const inputClass =
	"w-full min-w-0 rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-ui-12 text-ink outline-none focus-visible:border-ink-faint disabled:opacity-50";
export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: ReactNode;
}) {
	return (
		<label className="flex min-w-0 flex-col gap-1.5 text-ui-12 text-ink-2">
			<span>{label}</span>
			{children}
			{hint && <span className="text-ui-11 leading-relaxed text-ink-faint">{hint}</span>}
		</label>
	);
}
export function Feedback({ error, message }: { error?: string | null; message?: string }) {
	return error ? (
		<p role="alert" className="my-2 break-words text-ui-12 text-err">
			{error}
		</p>
	) : message ? (
		<p role="status" className="my-2 text-ui-12 text-ink-dim">
			{message}
		</p>
	) : null;
}
export function useSettingsSessionId() {
	const active = useSessionsStore((s) => s.activeSessionId);
	const workspace = useDesktopWorkspace((s) => s.workspace);
	return (
		active ?? workspace?.agents.find((row) => row.status === "running" && !row.archived)?.id ?? null
	);
}
export function EmptySession() {
	return (
		<p className="py-6 text-ui-12 leading-relaxed text-ink-faint">
			在左侧打开会话后，可以管理所属项目的原生配置和资源。
		</p>
	);
}

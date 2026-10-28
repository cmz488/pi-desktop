import { useUiStore } from "../../stores/ui";
import { useDesktopWorkspace } from "../../stores/desktop-workspace";
import { useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";
import { GearIcon } from "../icons";

/**
 * 左栏底部：设置入口——左栏收起时整栏藏起，所以设置入口就只在侧栏，不另设临时图标。
 * v9：顶栏常驻，「本轮改动」开关永远在顶栏右侧，左栏不再补这个入口。
 */
export function SidebarFooter() {
	const t = useT();
	const native = useDesktopWorkspace((s) => s.supported);
	const view = useUiStore((s) => s.sidebarView);
	const setSettingsOpen = useSettingsStore((s) => s.setOpen);
	return (
		<div className="flex shrink-0 flex-col gap-px p-2">
			{native && (
				<div className="flex gap-1">
					<button
						type="button"
						aria-pressed={view === "processes"}
						className="flex-1 rounded-lg px-2 py-1.5 text-left text-ui-12 text-ink-dim hover:bg-hover hover:text-ink"
						onClick={() =>
							useUiStore.getState().setSidebarView(view === "processes" ? "sessions" : "processes")
						}
					>
						会话进程
					</button>
					<button
						type="button"
						aria-pressed={view === "archive"}
						className="flex-1 rounded-lg px-2 py-1.5 text-left text-ui-12 text-ink-dim hover:bg-hover hover:text-ink"
						onClick={() =>
							useUiStore.getState().setSidebarView(view === "archive" ? "sessions" : "archive")
						}
					>
						归档会话
					</button>
				</div>
			)}
			<button
				type="button"
				className="flex h-8 w-full items-center gap-[9px] rounded-[7px] px-2 text-ui-135 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
				onClick={() => {
					useUiStore.getState().setSettingsAgentId(null);
					setSettingsOpen(true);
				}}
			>
				<GearIcon size={14} />
				<span>{t("sidebar.settings")}</span>
			</button>
		</div>
	);
}

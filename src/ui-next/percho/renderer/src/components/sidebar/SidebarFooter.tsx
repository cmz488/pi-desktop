import { useUiStore } from "../../stores/ui";
import { useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";
import { GearIcon } from "../icons";

/**
 * 左栏底部：只留设置入口。
 * 会话进程与归档不再是一等页面——进程操作在会话右键菜单里，归档是「视图选项」的筛选状态。
 */
export function SidebarFooter() {
	const t = useT();
	const setSettingsOpen = useSettingsStore((s) => s.setOpen);
	return (
		<div className="flex shrink-0 flex-col gap-px p-2">
			<button
				type="button"
				className="flex h-8 w-full items-center gap-[9px] rounded-[7px] px-2 text-ui-135 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
				onClick={() => {
					useUiStore.getState().setSidebarViewOptionsOpen(false);
					setSettingsOpen(true);
				}}
			>
				<GearIcon size={14} />
				<span>{t("sidebar.settings")}</span>
			</button>
		</div>
	);
}

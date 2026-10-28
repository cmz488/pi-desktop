import { useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { COMPOSER_FOCUS_EVENT } from "../../stores/drafts";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useUiStore } from "../../stores/ui";
import { EditIcon, SearchIcon } from "../icons";
import type { MenuAnchor } from "../ui/place-menu";
import { SidebarViewMenu } from "./SidebarViewMenu";

/**
 * 左栏固定头区：新会话入口 + 搜索框 + 视图选项。
 * 「视图选项」承接原「会话进程 / 归档会话」两个页面：分组、排序与归档筛选都在一个弹层里，
 * 进程操作留在会话右键菜单。slash `/sessions` 也打开同一个弹层（`sidebarViewOptionsOpen`）。
 */
export function SidebarHeader() {
	const t = useT();
	const search = useProjectsStore((s) => s.search);
	const setSearch = useProjectsStore((s) => s.setSearch);
	const activateNewSessionDraft = useSessionsStore((s) => s.activateNewSessionDraft);
	const open = useUiStore((s) => s.sidebarViewOptionsOpen);
	const trigger = useRef<HTMLButtonElement>(null);
	const [anchor, setAnchor] = useState<MenuAnchor | null>(null);

	useLayoutEffect(() => {
		if (!open) {
			setAnchor(null);
			return;
		}
		const measure = () => {
			const rect = trigger.current?.getBoundingClientRect();
			if (rect) setAnchor({ left: rect.left, top: rect.bottom + 4, width: rect.width, height: rect.height });
		};
		measure();
		// 斜杠命令可能刚把收起的左栏展开：等一帧再量，避免锚在宽度过渡的 0 点。
		const frame = requestAnimationFrame(measure);
		return () => cancelAnimationFrame(frame);
	}, [open]);

	const openNewSession = () => {
		activateNewSessionDraft();
		// 等新会话页 Composer 挂载后再聚焦；同步派发会被刚卸载的真实会话 Composer 接走。
		requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT)));
	};

	return (
		<div className="flex shrink-0 flex-col gap-1 px-2.5 pt-2.5 pb-2">
			<button
				type="button"
				className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-ui-14 font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
				onClick={openNewSession}
			>
				<EditIcon size={17} className="shrink-0" />
				<span>{t("sidebar.newSession")}</span>
			</button>
			<div className="flex items-center gap-1.5">
				<div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-hover px-2">
					<SearchIcon size={13} className="shrink-0 text-ink-faint" />
					<input
						type="search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder={t("sidebar.search")}
						className="min-w-0 flex-1 bg-transparent text-ui-13 text-ink-2 outline-none placeholder:text-ink-faint [&::-webkit-search-cancel-button]:hidden"
					/>
				</div>
				<button
					ref={trigger}
					type="button"
					aria-label="视图选项"
					aria-haspopup="dialog"
					aria-expanded={open}
					className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
						open ? "bg-hover text-ink" : "text-ink-dim hover:bg-hover hover:text-ink"
					}`}
					onClick={() => useUiStore.getState().setSidebarViewOptionsOpen(!open)}
				>
					<ViewOptionsGlyph />
				</button>
			</div>
			{open && anchor && (
				<SidebarViewMenu
					anchor={anchor}
					onClose={() => useUiStore.getState().setSidebarViewOptionsOpen(false)}
				/>
			)}
		</div>
	);
}

function ViewOptionsGlyph() {
	return (
		<svg
			width="15"
			height="15"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.3"
			aria-hidden="true"
		>
			<path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" />
		</svg>
	);
}

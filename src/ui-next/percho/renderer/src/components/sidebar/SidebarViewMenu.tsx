import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { type MenuAnchor, placeMenu } from "../ui/place-menu";
import { CheckIcon } from "../icons";

/** 视图选项弹层：分组 / 排序 / 归档筛选。关闭方式与右键菜单一致（外点、Esc、滚动、缩放）。 */
export function SidebarViewMenu({ anchor, onClose }: { anchor: MenuAnchor; onClose: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	const grouping = useUiPreferencesStore((s) => s.sidebarGrouping);
	const sort = useUiPreferencesStore((s) => s.sidebarSort);
	const archived = useUiPreferencesStore((s) => s.sidebarArchived);
	const setGrouping = useUiPreferencesStore((s) => s.setSidebarGrouping);
	const setSort = useUiPreferencesStore((s) => s.setSidebarSort);
	const setArchived = useUiPreferencesStore((s) => s.setSidebarArchived);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const { width, height } = el.getBoundingClientRect();
		setPos(
			placeMenu(
				anchor,
				{ width, height },
				{ width: window.innerWidth, height: window.innerHeight },
			),
		);
	}, [anchor]);

	useLayoutEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (ref.current?.contains(event.target as Node)) return;
			onClose();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("resize", onClose);
		window.addEventListener("scroll", onClose, true);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("resize", onClose);
			window.removeEventListener("scroll", onClose, true);
		};
	}, [onClose]);

	return createPortal(
		<div
			ref={ref}
			role="dialog"
			aria-label="视图选项"
			className="no-drag fixed z-50 w-[236px] rounded-xl border border-border bg-surface p-1.5 shadow-pop"
			style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? "visible" : "hidden" }}
		>
			<Section label="分组方式">
				<Option
					checked={grouping === "workspace"}
					label="按工作区"
					icon={<FolderGlyph />}
					onSelect={() => setGrouping("workspace")}
				/>
				<Option
					checked={grouping === "list"}
					label="单列表"
					icon={<ListGlyph />}
					onSelect={() => setGrouping("list")}
				/>
			</Section>
			<Divider />
			<Section label="排序方式">
				<Option
					checked={sort === "recent"}
					label="最近更新"
					icon={<ClockGlyph />}
					onSelect={() => setSort("recent")}
				/>
				<Option
					checked={sort === "name"}
					label="按名称"
					icon={<SortGlyph />}
					onSelect={() => setSort("name")}
				/>
			</Section>
			<Divider />
			<Section label="筛选会话">
				<Option
					checked={archived === "active"}
					label="隐藏已归档"
					icon={<ArchiveGlyph />}
					onSelect={() => setArchived("active")}
				/>
				<Option
					checked={archived === "all"}
					label="全部对话"
					icon={<ChatGlyph />}
					onSelect={() => setArchived("all")}
				/>
				<Option
					checked={archived === "archived"}
					label="仅显示已归档"
					icon={<ArchiveGlyph checked />}
					onSelect={() => setArchived("archived")}
				/>
			</Section>
		</div>,
		document.body,
	);
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div role="radiogroup" aria-label={label} className="py-0.5">
			<p className="px-2 pb-1 pt-1.5 text-ui-11 text-ink-faint">{label}</p>
			{children}
		</div>
	);
}

function Option({
	checked,
	label,
	icon,
	onSelect,
}: {
	checked: boolean;
	label: string;
	icon: React.ReactNode;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={checked}
			className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui-13 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
			onClick={onSelect}
		>
			<span
				className="flex w-4 shrink-0 items-center justify-center text-ink-dim"
				aria-hidden="true"
			>
				{icon}
			</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{checked && <CheckIcon size={12} className="shrink-0 text-ink" />}
		</button>
	);
}

function Divider() {
	return <div className="mx-1.5 my-1 h-px bg-border" />;
}

const glyph = "fill-none stroke-current";
function FolderGlyph() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 16 16"
			className={glyph}
			strokeWidth="1.3"
			aria-hidden="true"
		>
			<path d="M1.8 4.6h4.3l1.3 1.5h6.8v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V4.6Z" />
		</svg>
	);
}
function ListGlyph() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 16 16"
			className={glyph}
			strokeWidth="1.3"
			aria-hidden="true"
		>
			<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
		</svg>
	);
}
function ClockGlyph() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 16 16"
			className={glyph}
			strokeWidth="1.3"
			aria-hidden="true"
		>
			<circle cx="8" cy="8" r="6" />
			<path d="M8 4.6V8l2.4 1.6" />
		</svg>
	);
}
function SortGlyph() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 16 16"
			className={glyph}
			strokeWidth="1.3"
			aria-hidden="true"
		>
			<path d="M4.5 3.5v9M2.5 10.5l2 2 2-2M9 4h5M9 8h3.5M9 12h2" />
		</svg>
	);
}
function ArchiveGlyph({ checked = false }: { checked?: boolean }) {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 16 16"
			className={glyph}
			strokeWidth="1.3"
			aria-hidden="true"
		>
			<path d="M2 4.2h12v2.2H2zM3.2 6.4v6.2h9.6V6.4M6.4 9h3.2" />
			{checked && <path d="m5.6 7.8 1.8 1.8 3.2-3.2" />}
		</svg>
	);
}
function ChatGlyph() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 16 16"
			className={glyph}
			strokeWidth="1.3"
			aria-hidden="true"
		>
			<path d="M2.2 3.8h11.6v7.4H7l-3.6 2.4v-2.4H2.2z" />
		</svg>
	);
}

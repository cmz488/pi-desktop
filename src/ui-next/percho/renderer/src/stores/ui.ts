import { create } from "zustand";

/** chip → 侧栏跳转目标（nonce 保证重复跳同文件也重触发） */
export interface DiffFocus {
	/** 目标文件卡的首个 section key（TurnFileChange.sections[0].toolCallKey） */
	sectionKey: string;
	nonce: number;
}

export type RightPanelView = "changes" | "git" | "files" | "web" | "tasks" | "btw";

interface UiStore {
	rightPanelView: RightPanelView;
	rightSessionId: string | null;
	rightQuestion: string;
	openRightPanel: (view: RightPanelView, sessionId?: string, question?: string) => void;
	/** 左侧栏「视图选项」弹层（瞬时；slash 命令与会话菜单可以打开它） */
	sidebarViewOptionsOpen: boolean;
	setSidebarViewOptionsOpen: (open: boolean) => void;
	/** todo 面板展开态（按会话，切换会话互不影响；不含持久化） */
	todoExpanded: Record<string, boolean>;
	toggleTodoExpanded: (sessionId: string) => void;
	/** diff 侧栏开关（内存态，不持久化——重启统一关闭，用户已定） */
	diffSidebarOpen: boolean;
	setDiffSidebarOpen: (open: boolean) => void;
	toggleDiffSidebar: () => void;
	/** chip 跳转侧栏的聚焦目标（侧栏消费后清除） */
	diffFocus: DiffFocus | null;
	setDiffFocus: (sectionKey: string) => void;
	clearDiffFocus: () => void;
}

/** 界面态里只放「不跨会话、不落盘」的瞬时开关；持久化偏好一律走 ui-preferences */
export const useUiStore = create<UiStore>((set) => ({
	rightPanelView: "changes",
	rightSessionId: null,
	rightQuestion: "",
	openRightPanel: (view, sessionId, question = "") =>
		set({
			rightPanelView: view,
			rightSessionId: sessionId ?? null,
			rightQuestion: question,
			diffSidebarOpen: true,
		}),
	sidebarViewOptionsOpen: false,
	setSidebarViewOptionsOpen: (open) => set({ sidebarViewOptionsOpen: open }),
	todoExpanded: {},
	toggleTodoExpanded: (sessionId) =>
		set((state) => ({
			todoExpanded: { ...state.todoExpanded, [sessionId]: !state.todoExpanded[sessionId] },
		})),
	diffSidebarOpen: false,
	setDiffSidebarOpen: (open) => set({ diffSidebarOpen: open }),
	toggleDiffSidebar: () => set((state) => ({ diffSidebarOpen: !state.diffSidebarOpen })),
	diffFocus: null,
	setDiffFocus: (sectionKey) =>
		set((state) => ({
			rightPanelView: "changes",
			rightSessionId: null,
			diffFocus: { sectionKey, nonce: (state.diffFocus?.nonce ?? 0) + 1 },
		})),
	clearDiffFocus: () => set({ diffFocus: null }),
}));

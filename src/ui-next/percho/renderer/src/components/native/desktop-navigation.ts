export const DESKTOP_WORKBENCH_EVENT = "pi-desktop:workbench";
export type DesktopWorkbenchTab =
	| "agents"
	| "extensions"
	| "files"
	| "git"
	| "settings"
	| "btw";

/** User navigation only; never starts a model request or changes session ownership. */
export function openDesktopWorkbench(
	tab: DesktopWorkbenchTab,
	view?: string,
	question?: string,
	sessionId?: string,
) {
	window.dispatchEvent(
		new CustomEvent(DESKTOP_WORKBENCH_EVENT, {
			detail: { tab, view, question, sessionId },
		}),
	);
}

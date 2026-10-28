import { useSettingsStore, type SettingsCategory } from "../../stores/settings";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { useUiStore } from "../../stores/ui";

export type DesktopDestination = "agents" | "extensions" | "files" | "git" | "settings" | "btw";
/** Navigation never changes the active conversation or starts execution. */
export function openDesktopPanel(
	destination: DesktopDestination,
	view?: string,
	question?: string,
	sessionId?: string,
) {
	if (destination === "settings") {
		const category =
			(
				{ providers: "models", plugins: "extensions", marketplace: "extensions" } as Record<
					string,
					SettingsCategory
				>
			)[view ?? ""] ??
			view ??
			"general";
		if (category === "agent") useUiStore.getState().setSettingsAgentId(sessionId ?? null);
		useSettingsStore.getState().openWith(category as SettingsCategory);
	} else if (destination === "agents") {
		if (useUiPreferencesStore.getState().sidebarCollapsed)
			useUiPreferencesStore.getState().toggleSidebarCollapsed();
		useUiStore.getState().setSidebarView("processes");
	} else {
		useUiStore
			.getState()
			.openRightPanel(
				destination === "extensions"
					? "tasks"
					: destination === "files"
						? "files"
						: destination === "git"
							? "git"
							: "btw",
				sessionId,
				question,
			);
	}
}

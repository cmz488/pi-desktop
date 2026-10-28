import { useEffect, useState } from "react";
import { LOCAL_ENVIRONMENT } from "@percho/shared";
import { getExecutionApi } from "../../environment-api";
import { desktopSessions } from "../../pi-http-bridge";
import { useWorkspaceObservation } from "../../stores/desktop-workspace";
import { useSessionsStore } from "../../stores/sessions";
import { updateNativeUi } from "./native-ui";

/** Native title/status projection shares Percho's chrome; it is not another navigation shell. */
export function NativeSessionStatus() {
	const id = useSessionsStore((s) => s.activeSessionId);
	const [ui, setUi] = useState<any>(null);
	useWorkspaceObservation();
	useEffect(() => {
		let live = true;
		desktopSessions.select(id);
		setUi(null);
		updateNativeUi(id);
		if (!id) {
			document.title = "Pi Desktop";
			return;
		}
		void desktopSessions
			.state(id)
			.then((state) => {
				if (live) {
					setUi({ ...state.ui, statuses: state.statuses });
					updateNativeUi(id, state.ui);
				}
			})
			.catch(console.error);
		const off = getExecutionApi(LOCAL_ENVIRONMENT).onEvent(({ sessionId, event }) => {
			if (live && sessionId === id && event.type === "desktop_snapshot") {
				setUi(event.desktopUi);
				updateNativeUi(id, event.desktopUi);
			}
		});
		return () => {
			live = false;
			off();
		};
	}, [id]);
	useEffect(() => {
		document.title = ui?.title || "Pi Desktop";
	}, [ui?.title]);
	const text = [
		...(ui?.statuses ?? []),
		...(ui?.workingVisible !== false && ui?.workingMessage ? [ui.workingMessage] : []),
		...(ui?.recovery?.outstanding ? [`已从检查点恢复 ${ui.recovery.outstanding} 项`] : []),
	].join(" · ");
	return text ? (
		<div role="status" className="px-4 py-1 text-ui-11 text-ink-faint" aria-label="Pi 扩展状态">
			{text}
		</div>
	) : null;
}

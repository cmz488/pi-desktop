import { useSettingsStore } from "../../stores/settings";
import { openDesktopWorkbench } from "./desktop-navigation";

export function NativeSettingsButton({
	view,
	children,
}: {
	view: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className="rounded-lg border border-border px-3 py-2 text-ui-13 text-ink-2 hover:bg-hover"
			onClick={() => {
				useSettingsStore.getState().setOpen(false);
				openDesktopWorkbench("settings", view);
			}}
		>
			{children}
		</button>
	);
}

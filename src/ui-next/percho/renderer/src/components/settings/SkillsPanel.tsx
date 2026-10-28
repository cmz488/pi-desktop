import { NativeSkills } from "../native/NativeResources";
import { useSettingsStore } from "../../stores/settings";

export function SkillsPanel() {
	const diagnostics = useSettingsStore((s) => s.skillDiagnostics);
	return (
		<div>
			<NativeSkills />
			{diagnostics.length > 0 && (
				<ul className="mt-4 space-y-1">
					{diagnostics.map((row) => (
						<li key={row.path ?? row.message} className="text-ui-11 text-ink-dim">
							<span className={row.type === "error" ? "text-err" : "text-ink-faint"}>
								{row.type}
							</span>{" "}
							· {row.message}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

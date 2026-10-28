import { useState } from "react";
import { createPortal } from "react-dom";
import { getPi, supportsHostChannel } from "../../api";
import { getExecutionApi } from "../../environment-api";
import { LOCAL_ENVIRONMENT } from "@percho/shared";
import { useT } from "../../i18n";
import { useProjectsStore } from "../../stores/projects";
import { useDesktopWorkspace } from "../../stores/desktop-workspace";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { Button } from "../ui/Button";
import { Feedback, Field, inputClass } from "../native/NativeControls";

export function AddProjectDialog({
	onClose,
	onLocalProject,
}: {
	onClose: () => void;
	onLocalProject?: () => Promise<void>;
}) {
	const t = useT();
	const [path, setPath] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const add = async () => {
		setBusy(true);
		setError("");
		try {
			const cwd = await getExecutionApi(LOCAL_ENVIRONMENT).validateDirectory({ path });
			if (useDesktopWorkspace.getState().supported)
				await useDesktopWorkspace.getState().command("project.save", undefined, { cwd });
			useProjectsStore.getState().addKnownProject(cwd);
			useProjectsStore.getState().select(cwd);
			onClose();
		} catch (reason) {
			setError((reason as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return createPortal(
		<div
			role="dialog"
			aria-modal
			aria-label={t("sidebar.addProject")}
			className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20"
		>
			<form
				className="w-[400px] max-w-[calc(100vw-32px)] space-y-4 rounded-xl bg-surface p-5 shadow-dialog"
				onSubmit={(event) => {
					event.preventDefault();
					void add();
				}}
			>
				<h2 className="text-ui-14 font-semibold text-ink">{t("sidebar.addProject")}</h2>
				<Field label="项目目录">
					<input
						aria-label="项目目录"
						required
						className={inputClass}
						value={path}
						onChange={(event) => setPath(event.target.value)}
						placeholder="项目的本地目录"
					/>
				</Field>
				<Feedback error={error} />
				<div className="flex flex-wrap justify-end gap-1">
					<Button onClick={onClose} disabled={busy}>
						{t("common.cancel")}
					</Button>
					<Button
						disabled={busy}
						onClick={() => {
							void (async () => {
								try {
									if (onLocalProject) {
										await onLocalProject();
										onClose();
									} else {
										const cwd = await getPi().pickDirectory();
										if (cwd) setPath(cwd);
									}
								} catch (reason) {
									setError((reason as Error).message);
								}
							})();
						}}
					>
						选择目录
					</Button>
					{supportsHostChannel("remote:getStatus") && (
						<Button
							onClick={() => {
								onClose();
								useRemoteConnectionStore.getState().setOpen(true);
							}}
						>
							{t("remote.remoteProject")}
						</Button>
					)}
					<Button type="submit" variant="primary" disabled={busy || !path.trim()}>
						添加项目
					</Button>
				</div>
			</form>
		</div>,
		document.body,
	);
}

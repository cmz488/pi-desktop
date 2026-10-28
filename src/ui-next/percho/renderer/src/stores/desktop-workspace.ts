import { useEffect, useState } from "react";
import { create } from "zustand";
import { desktopRequest, desktopSessions } from "../pi-http-bridge";
import { useProjectsStore } from "./projects";

export interface DesktopAgent {
	id: string;
	name: string;
	projectId?: string;
	cwd?: string;
	status: string;
	desired?: boolean;
	source?: string;
	archived?: boolean;
	promptProfileId?: string;
	approvalMode?: string;
	error?: string;
}
export interface DesktopProject {
	id: string;
	name: string;
	cwd: string;
}
export interface PromptProfile {
	id: string;
	name: string;
	instructions?: string;
}
export interface DesktopWorkspace {
	revision: string;
	agents: DesktopAgent[];
	projects: DesktopProject[];
	promptProfiles: PromptProfile[];
}
interface WorkspaceStore {
	workspace: DesktopWorkspace | null;
	supported: boolean | null;
	error: string | null;
	refresh: () => Promise<void>;
	command: (
		command: string,
		id?: string,
		extra?: Record<string, unknown>,
		revision?: string,
	) => Promise<void>;
}
export const useDesktopWorkspace = create<WorkspaceStore>((set, get) => ({
	workspace: null,
	supported: null,
	error: null,
	refresh: async () => {
		const supported = await desktopSessions.detect();
		if (!supported) {
			set({ supported: false });
			return;
		}
		const workspace = await desktopRequest("/api/workspace");
		set({ workspace, supported: true, error: null });
	},
	command: async (command, id, extra = {}, revision) => {
		await desktopRequest("/api/workspace/command", {
			command,
			id,
			...extra,
			revision: revision ?? get().workspace?.revision,
		});
		await get().refresh();
		await useProjectsStore.getState().load();
	},
}));

/** Observation has no process ownership; unmount only removes this polling observer. */
export function useWorkspaceObservation() {
	useEffect(() => {
		let live = true;
		const update = () =>
			void useDesktopWorkspace
				.getState()
				.refresh()
				.catch((error: Error) => {
					if (live) useDesktopWorkspace.setState({ error: error.message });
				});
		update();
		const timer = setInterval(update, 3000);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, []);
}

export function useNativeSession(requestedId?: string | null) {
	const [snapshot, setSnapshot] = useState<any>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		let live = true;
		setSnapshot(null);
		setError("");
		if (!requestedId) return;
		const refresh = () =>
			void desktopSessions
				.state(requestedId)
				.then((value) => {
					if (live) setSnapshot(value);
				})
				.catch((reason: Error) => {
					if (live) setError(reason.message);
				});
		refresh();
		const timer = setInterval(refresh, 2000);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [requestedId]);
	return { snapshot, error };
}

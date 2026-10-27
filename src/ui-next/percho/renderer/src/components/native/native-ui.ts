import { type RefObject, useEffect } from "react";
import { create } from "zustand";
import { useSessionsStore } from "../../stores/sessions";

type NativeUi = {
	workingVisible?: boolean;
	hiddenThinkingLabel?: string;
	toolsExpanded?: boolean;
	toolsExpansionVersion?: number;
};
const EMPTY: NativeUi = {};
const useNativeUiState = create<{ sessionId: string | null; ui: NativeUi }>(
	() => ({
		sessionId: null,
		ui: EMPTY,
	}),
);

export function updateNativeUi(
	sessionId: string | null,
	input: NativeUi = EMPTY,
) {
	const ui = {
		workingVisible: input.workingVisible,
		hiddenThinkingLabel: input.hiddenThinkingLabel,
		toolsExpanded: input.toolsExpanded,
		toolsExpansionVersion: input.toolsExpansionVersion,
	};
	const current = useNativeUiState.getState();
	if (
		current.sessionId === sessionId &&
		(Object.keys(ui) as (keyof NativeUi)[]).every(
			(key) => current.ui[key] === ui[key],
		)
	)
		return;
	useNativeUiState.setState({ sessionId, ui });
}
export function useNativeUi() {
	const id = useSessionsStore((s) => s.activeSessionId);
	return useNativeUiState((s) => (s.sessionId === id ? s.ui : EMPTY));
}
export function useNativeToolDisclosure(
	ref: RefObject<HTMLDetailsElement | null>,
) {
	const ui = useNativeUi();
	useEffect(() => {
		if (ref.current && ui.toolsExpansionVersion !== undefined)
			ref.current.open = ui.toolsExpanded === true;
	}, [ref, ui.toolsExpansionVersion, ui.toolsExpanded]);
}

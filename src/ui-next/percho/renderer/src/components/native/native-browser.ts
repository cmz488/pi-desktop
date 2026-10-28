export interface BrowserTab {
	id: string;
	url: string;
	title: string;
	active?: boolean;
}
export interface BrowserState {
	tabs: BrowserTab[];
	connected?: boolean;
}
interface NativeTab extends BrowserTab {
	owner: string;
}
interface NativeBrowserHost {
	browserCommand: (input: Record<string, unknown>) => Promise<NativeTab | undefined>;
}

/** Electron sends one owned tab per event; the Agent browser sends a complete tab list. */
export class NativeBrowserSession {
	private readonly owner = crypto.randomUUID();
	private readonly tabs = new Map<string, BrowserTab>();
	private activeId: string | undefined;
	constructor(private readonly host: NativeBrowserHost) {}

	state(): BrowserState {
		return {
			tabs: [...this.tabs.values()].map((tab) => ({ ...tab, active: tab.id === this.activeId })),
		};
	}
	accept(tab: NativeTab): BrowserState | undefined {
		if (tab.owner !== this.owner) return;
		this.tabs.set(tab.id, tab);
		return this.state();
	}
	async execute(action: string, extra: Record<string, unknown> = {}): Promise<BrowserState> {
		if (action === "hide") {
			await this.host.browserCommand({ action });
			return this.state();
		}
		const id = action === "new" ? crypto.randomUUID() : String(extra.id ?? this.activeId ?? "");
		// A newly mounted viewport has no tab to lay out yet.
		if (!id && action === "layout") return this.state();
		const previous = this.activeId;
		// Navigation events can arrive before invoke() resolves; layout already needs this identity.
		if (action === "new" || action === "select") this.activeId = id;
		let tab: NativeTab | undefined;
		try {
			tab = await this.host.browserCommand({
				...extra,
				owner: this.owner,
				id,
				action: action === "new" ? "navigate" : action === "select" ? "state" : action,
			});
		} catch (error) {
			if ((action === "new" || action === "select") && this.activeId === id)
				this.activeId = previous;
			throw error;
		}
		if (action === "close") {
			this.tabs.delete(id);
			if (this.activeId === id) this.activeId = [...this.tabs.keys()].at(-1);
		} else {
			if (tab) this.accept(tab);
		}
		return this.state();
	}
}

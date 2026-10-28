import { useEffect, useRef, useState } from "react";
import { desktopSessions, nativeRequest } from "../../pi-http-bridge";
import { useNativeSession } from "../../stores/desktop-workspace";
import { getPi } from "../../api";
import { Button } from "../ui/Button";
import { Feedback, inputClass } from "./NativeControls";
import { CloseIcon, ChevronRightIcon, FileTextIcon, FolderOpenIcon } from "../icons";

const loadShared = (path: string) => import(/* @vite-ignore */ path);
type FileResult = {
	kind: string;
	path: string;
	name: string;
	text?: string;
	url?: string;
	message?: string;
	truncated?: boolean;
	entries?: { name: string; directory: boolean; link: boolean }[];
};
export function FilesPanel({ sessionId }: { sessionId: string }) {
	const [cache, setCache] = useState<Record<string, FileResult>>({});
	const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
	const [preview, setPreview] = useState<FileResult | null>(null);
	const [error, setError] = useState("");
	const [search, setSearch] = useState("");
	const generation = useRef(0);
	const read = async (path: string) => {
		const owner = generation.current;
		try {
			const file = await nativeRequest(
				`/api/files?path=${encodeURIComponent(path)}`,
				undefined,
				sessionId,
			);
			if (owner !== generation.current) return;
			setError("");
			if (file.kind === "directory") setCache((value) => ({ ...value, [path]: file }));
			else setPreview(file);
		} catch (reason) {
			if (owner === generation.current) setError((reason as Error).message);
		}
	};
	useEffect(() => {
		void read("");
		return () => {
			generation.current++;
		};
	}, [sessionId]);
	const render = (path: string, depth = 0): React.ReactNode =>
		cache[path]?.entries
			?.filter(
				(row) => row.directory || !search || row.name.toLowerCase().includes(search.toLowerCase()),
			)
			.map((row) => {
				const full = path ? `${path}/${row.name}` : row.name;
				const open = expanded.has(full);
				return (
					<div key={full}>
						<button
							type="button"
							className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-ui-12 text-ink-dim hover:bg-hover hover:text-ink"
							style={{ paddingLeft: 8 + depth * 14 }}
							aria-expanded={row.directory ? open : undefined}
							onClick={() => {
								if (row.directory) {
									setExpanded((value) => {
										const next = new Set(value);
										open ? next.delete(full) : next.add(full);
										return next;
									});
									if (!open) void read(full);
								} else void read(full);
							}}
						>
							{row.directory ? (
								<>
									<ChevronRightIcon size={12} className={open ? "rotate-90" : ""} />
									<FolderOpenIcon size={14} />
								</>
							) : (
								<FileTextIcon size={14} />
							)}
							<span className="truncate">{row.name}</span>
							{row.link && <span className="text-ink-faint">↗</span>}
						</button>
						{row.directory && open && render(full, depth + 1)}
					</div>
				);
			});
	return (
		<section aria-label="项目文件" className="flex h-full min-h-0 flex-col">
			<div className="flex items-center gap-2 p-3">
				<input
					aria-label="筛选文件"
					placeholder="筛选文件"
					className={inputClass}
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
				<Button size="sm" onClick={() => void read("")}>
					刷新
				</Button>
			</div>
			<Feedback error={error} />
			<div className="min-h-0 flex-1 overflow-auto px-2">
				{render("")}
				{cache[""]?.truncated && (
					<p className="p-2 text-ui-11 text-ink-faint">目录过大，仅显示前 500 项。</p>
				)}
				{!cache[""] && !error && (
					<p role="status" className="p-2 text-ui-12 text-ink-faint">
						读取项目文件…
					</p>
				)}
			</div>
			{preview && (
				<section
					aria-label="文件预览"
					className="flex max-h-[60%] min-h-40 flex-col border-t border-border"
				>
					<header className="flex items-center gap-2 p-3">
						<span className="min-w-0 flex-1 truncate text-ui-12 text-ink" title={preview.path}>
							{preview.path}
						</span>
						<Button size="sm" aria-label="关闭文件预览" onClick={() => setPreview(null)}>
							<CloseIcon size={13} />
						</Button>
					</header>
					<div className="min-h-0 overflow-auto px-3 pb-3">
						{preview.kind === "image" ? (
							<img alt={preview.name} src={preview.url} className="max-w-full" />
						) : preview.kind === "text" ? (
							<pre tabIndex={0} className="whitespace-pre text-ui-11 text-ink-dim">
								{preview.text}
							</pre>
						) : (
							<p className="text-ui-12 text-ink-faint">{preview.message}</p>
						)}
					</div>
				</section>
			)}
		</section>
	);
}

type BrowserTab = { id: string; url: string; title: string; active?: boolean };
type BrowserState = { tabs: BrowserTab[]; connected?: boolean };
function webAddress(value: string) {
	const text = value.trim();
	if (!text) throw new Error("请输入网址或搜索内容");
	const candidate =
		/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[\w.-]+:\d+(?:\/|$)/.test(text)
			? text
			: /^(localhost|127\.0\.0\.1|\[[\da-f:]+\]|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:\/|$)/i.test(text)
				? `${/^(localhost|127\.|\[)/.test(text) ? "http" : "https"}://${text}`
				: `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
	const url = new URL(candidate);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new Error("只支持不含凭据的 HTTP / HTTPS 网址");
	return url.href;
}
export function BrowserPanel({ sessionId }: { sessionId: string }) {
	const { snapshot, error: stateError } = useNativeSession(sessionId);
	const viewport = useRef<HTMLDivElement>(null);
	const controller = useRef<any>(null);
	const [state, setState] = useState<BrowserState>({ tabs: [] });
	const [address, setAddress] = useState("");
	const [error, setError] = useState("");
	const [resolution, setResolution] = useState("");
	const native =
		Boolean((window as any).piDesk?.browserCommand) && !snapshot?.capabilities?.agentBrowser;
	const active = state.tabs.find((row) => row.active) ?? state.tabs.at(-1);
	const update = (value: BrowserState) => {
		setState(value);
		const selected = value.tabs?.find((row) => row.active) ?? value.tabs?.at(-1);
		if (selected) setAddress(selected.url);
	};
	const run = async (action: string, extra: Record<string, unknown> = {}) => {
		try {
			if (!native && !controller.current) throw new Error("浏览器正在连接，请稍后重试");
			setError("");
			const value = native
				? await (window as any).piDesk.browserCommand({ action, id: active?.id, ...extra })
				: await controller.current?.execute(action, { id: active?.id, ...extra });
			if (value?.tabs) update(value);
		} catch (reason) {
			setError((reason as Error).message);
		}
	};
	useEffect(() => {
		if (!snapshot) return;
		let disposed = false;
		let view: any;
		let resize: ResizeObserver | undefined;
		let observer: MutationObserver | undefined;
		let off: (() => void) | undefined;
		const host = (window as any).piDesk;
		void (async () => {
			if (snapshot.capabilities?.agentBrowser) {
				const framePath = await desktopSessions.path("/_browser/frame", sessionId);
				const { createAgentBrowserView } = await loadShared("/agent-browser-view.js");
				if (disposed) return;
				view = createAgentBrowserView({
					viewport: viewport.current,
					framePath,
					request: (path: string, input: unknown) => nativeRequest(path, input, sessionId),
					onState: (value: BrowserState) => {
						if (!disposed) {
							update(value);
							const selected = value.tabs.find((row) => row.active) ?? value.tabs.at(-1);
							if (selected) view?.select(selected.id);
						}
					},
					onError: (reason: Error) => {
						if (!disposed) setError(reason.message);
					},
					onResolution: ({ width, height }: { width: number; height: number }) => {
						if (!disposed) setResolution(`${width} × ${height}`);
					},
				});
				controller.current = view;
				view.configure(true);
				view.attach(true);
				resize = new ResizeObserver(() => view.attach(true));
				resize.observe(viewport.current!);
			} else if (host?.browserCommand) {
				off = host.onBrowserState?.((value: BrowserState) => {
					if (!disposed) update(value);
				});
				let lastLayout = "";
				const layout = () => {
					const box = viewport.current?.getBoundingClientRect();
					const modal = document.querySelector('[role="dialog"][aria-modal]');
					const input =
						box?.width && !modal
							? {
									action: "layout",
									bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
								}
							: { action: "hide" };
					const signature = JSON.stringify(input);
					if (lastLayout === signature) return;
					lastLayout = signature;
					void host.browserCommand(input).catch((reason: Error) => {
						if (!disposed) setError(reason.message);
					});
				};
				resize = new ResizeObserver(layout);
				resize.observe(viewport.current!);
				observer = new MutationObserver(layout);
				observer.observe(document.body, { childList: true, subtree: true });
				layout();
			}
		})().catch((reason: Error) => {
			if (!disposed) setError(reason.message);
		});
		return () => {
			disposed = true;
			view?.close();
			controller.current = null;
			resize?.disconnect();
			observer?.disconnect();
			off?.();
			if (host?.browserCommand && native)
				void host.browserCommand({ action: "hide" }).catch(console.error);
		};
	}, [sessionId, Boolean(snapshot?.capabilities?.agentBrowser), native]);
	const available = snapshot?.capabilities?.agentBrowser || native;
	return (
		<section aria-label="网页浏览器" className="flex h-full min-h-0 flex-col">
			<form
				className="flex items-center gap-1 p-2"
				onSubmit={(event) => {
					event.preventDefault();
					try {
						const url = webAddress(address);
						if (available) void run(active ? "navigate" : "new", { url });
						else
							void getPi()
								.openExternal({ url })
								.catch((reason: Error) => setError(reason.message));
					} catch (reason) {
						setError((reason as Error).message);
					}
				}}
			>
				<Button size="sm" aria-label="后退" disabled={!active} onClick={() => void run("back")}>
					←
				</Button>
				<Button size="sm" aria-label="前进" disabled={!active} onClick={() => void run("forward")}>
					→
				</Button>
				<Button
					size="sm"
					aria-label="刷新网页"
					disabled={!active}
					onClick={() => void run("reload")}
				>
					↻
				</Button>
				<input
					aria-label="搜索或输入网址"
					className={inputClass}
					placeholder="搜索或输入网址"
					value={address}
					onChange={(event) => setAddress(event.target.value)}
				/>
				<Button size="sm" type="submit">
					打开
				</Button>
			</form>
			<Feedback error={error || stateError} />
			<div
				className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 pb-1"
				role="tablist"
				aria-label="网页标签"
			>
				{state.tabs.map((row) => (
					<div key={row.id} className="flex min-w-0 items-center">
						<Button
							size="sm"
							role="tab"
							aria-selected={row.id === active?.id}
							className="max-w-32 truncate"
							onClick={() => void run("select", { id: row.id })}
						>
							{row.title || row.url}
						</Button>
						<Button
							size="sm"
							aria-label={`关闭网页 ${row.title || row.url}`}
							onClick={() => void run(native ? "close" : "close-tab", { id: row.id })}
						>
							<CloseIcon size={11} />
						</Button>
					</div>
				))}
				{available && (
					<Button size="sm" onClick={() => void run("new", { url: "https://pi.dev" })}>
						新标签页
					</Button>
				)}
			</div>
			<div
				ref={viewport}
				className="native-browser-viewport relative min-h-0 flex-1 overflow-hidden"
			>
				{!available && (
					<p className="p-4 text-ui-12 leading-relaxed text-ink-faint">
						当前宿主未提供内嵌浏览器，可从上方在系统浏览器打开网页。
					</p>
				)}
			</div>
			{resolution && <p className="px-3 py-1 text-ui-10 text-ink-faint">Chromium · {resolution}</p>}
		</section>
	);
}

/**
 * 浏览器侧的 `window.pi`：把 Percho 渲染层的传输契约接到本 Host 的 HTTP 上。
 *
 * 接口：导入即安装（副作用幂等）；`window.pi` 与 Percho 桌面版同形。
 * 不变量：
 *   - 通道状态来自 `support.mjs`；未实现的通道抛 `HostApiUnsupported`，不返回假数据；
 *   - 处理函数来自 `http-handlers.mjs`，与测试共用同一份实现；
 *   - 本层只做传输，不复制 Percho 的 store 语义。
 * 为什么在渲染层内构建：我们以 HTTP 提供页面，没有 Electron IPC；保留 `window.pi` 这个名字，
 *   Percho 的 store 与组件无需改动。
 */
import { UI_CHANNELS } from "../../../channels.mjs";
import { UI_SUPPORT, UI_SUBSCRIPTION_SUPPORT } from "../../../support.mjs";
import { buildHostApi } from "../../../host-api.mjs";
import { createSessionTransport } from "../../../session-transport.mjs";
import { createSubscriptions } from "../../../subscriptions.mjs";
import { createProviderLogins } from "../../../native-contracts.mjs";
import { createHttpHandlers } from "../../../http-handlers.mjs";

/** 与 Host 通信；非 2xx 转成带 status 的错误。 */
async function request(path, input?, options?: { signal?: AbortSignal }) {
	const response = await fetch(path, {
		method: input === undefined ? "GET" : "POST",
		headers:
			input === undefined
				? { Accept: "application/json" }
				: { Accept: "application/json", "Content-Type": "application/json" },
		...(input === undefined ? {} : { body: JSON.stringify(input) }),
		credentials: "same-origin",
		signal: options?.signal,
	});
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		body = text;
	}
	if (!response.ok)
		throw Object.assign(
			new Error(
				String(
					body?.error?.message ?? body?.error ?? `HTTP ${response.status}`,
				),
			),
			{ status: response.status, body },
		);
	return body;
}

const get = (path) => request(path);
const post = (path, input) => request(path, input ?? {});

const localListeners = new Map<string, Set<(event: unknown) => void>>();
const emit = (name: string, event: unknown) => {
	for (const listener of localListeners.get(name) ?? []) listener(event);
};
let installed;
export const desktopSessions = createSessionTransport({ get, post });
const sessions = desktopSessions;
const logins = createProviderLogins({ sessions, emit });
export { request as desktopRequest };

export async function nativeRequest(
	path: string,
	input?: unknown,
	sessionId?: string,
) {
	return input === undefined
		? sessions.get(path, sessionId)
		: sessions.post(path, input, sessionId);
}

export async function removeDesktopProject(cwd: string): Promise<void> {
	if (!(await sessions.detect()))
		throw new Error("兼容模式的工作目录由 Pi TUI／SDK 拥有，请在原宿主管理");
	const workspace = await get("/api/workspace");
	const project = workspace.projects.find((row) => row.cwd === cwd);
	if (project)
		await post("/api/workspace/command", {
			command: "project.remove",
			id: project.id,
			revision: workspace.revision,
		});
}

export function mirrorComposerText(
	sessionId: string,
	text: string,
): Promise<unknown> {
	return sessions.mirrorComposer(sessionId, text);
}

export function installHostApi() {
	if (installed) return installed;
	installed = buildHostApi({
		channels: UI_CHANNELS,
		handlers: createHttpHandlers({
			get,
			post,
			sessions,
			emit,
			logins,
			parseCatalog: async (value) => {
				const path = "/package-settings.js";
				return (await import(/* @vite-ignore */ path)).parseCatalogPage(value);
			},
			confirmTrust: async (cwd) =>
				window.confirm(
					`信任项目 ${cwd}？\n该项目的扩展和工具可能在本机执行程序。`,
				),
			confirmGit: async (plan) =>
				window.confirm(
					`确认切换 Git 分支？\n${JSON.stringify(plan.request)}\n${plan.warning ?? ""}`,
				),
		}),
		support: UI_SUPPORT,
		subscriptionSupport: UI_SUBSCRIPTION_SUPPORT,
		subscribe: (() => {
			const subscribe = createSubscriptions({
				sessions,
				ownsInteraction: (id, jobId) => logins.owns(id, jobId),
			});
			return (name, channel, listener) => {
				if (name !== "onProviderLoginEvent")
					return subscribe(name, channel, listener);
				if (!localListeners.has(name)) localListeners.set(name, new Set());
				localListeners.get(name)!.add(listener);
				return () => localListeners.get(name)?.delete(listener);
			};
		})(),
		platform: "linux",
	});
	window.pi = installed;
	return installed;
}

installHostApi();

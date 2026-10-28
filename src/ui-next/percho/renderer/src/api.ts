import type { CHANNEL_TABLE, PiApi } from "@percho/shared";
type InvokeChannel = (typeof CHANNEL_TABLE)[keyof typeof CHANNEL_TABLE]["channel"];

declare global {
	interface Window {
		pi: PiApi;
	}
}

/** Optional Percho services must not be probed against unrelated native endpoints. */
export function supportsHostChannel(channel: InvokeChannel): boolean {
	return (
		(getPi() as PiApi & { supports?: (channel: string) => boolean }).supports?.(channel) ?? true
	);
}

/** window.pi 类型化访问（未在 preload 注入时给出可读错误） */
export function getPi(): PiApi {
	if (!window.pi) {
		throw new Error("window.pi 未注入：preload 未加载或 contextBridge 失败");
	}
	return window.pi;
}

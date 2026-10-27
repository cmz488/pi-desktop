// Host 传输：在 http(s) 下用本仓库的 window.pi（Percho 桌面版由 preload 注入）。
import { installHostApi } from "./pi-http-bridge";
installHostApi();

// Startup migration never imports workbench stores or starts execution IPC.
if (new URLSearchParams(location.search).has("storage-startup")) {
	void import("./storage-startup").then(({ renderStorageStartup }) => renderStorageStartup());
} else {
	void import("./workbench");
}

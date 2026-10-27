import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Percho 渲染层（React 19 + Tailwind 4 + Zustand）的移植构建。
 *
 * 接口：`npm run build:ui` 产出 `build/ui-next/`；构建脚本随后把产物登记进
 *   `src/ui-next/generated-assets.mjs`，由 `asset-manifest.mjs` 按白名单提供。
 * 不变量：产物名单由构建生成，不手写——白名单必须与真实文件一致，否则页面 404 而测试看不出来。
 * 为什么用 vite：我们原有 UI 无 bundler，而 Percho 的渲染层依赖 JSX、Tailwind 4 与 worker 资源；
 *   擅自重写会丢掉它的组件与状态实现。
 */
const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here("./percho/renderer"),
  base: "/ui-next/",
  resolve: {
    alias: {
      // Percho 的渲染层通过这两个别名引用共享契约与自身目录。
      "@percho/shared": here("./percho/shared/index.ts"),
      "@renderer": here("./percho/renderer/src"),
    },
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: here("../../build/ui-next"),
    emptyOutDir: true,
    // Electron 版以 file:// 加载；我们由 HTTP 提供，所以用相对资源前缀。
    assetsDir: "assets",
    sourcemap: false,
    rollupOptions: {
      output: {
        // 白名单需要稳定可枚举的名单，所以不用内容 hash。
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});

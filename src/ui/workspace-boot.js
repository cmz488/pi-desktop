/* 首屏引导必须是同源外部脚本：页面的 CSP 是 `script-src 'self'`，内联脚本会被
 * 直接拦截（securitypolicyviolation: script-src-elem），外壳就会先按浅色绘制。 */
(() => {
  const root = document.documentElement;
  try {
    const preference = localStorage.getItem("pi-web-theme") ?? "light";
    const dark =
      preference === "dark" ||
      (preference === "system" &&
        matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.theme = dark ? "dark" : "light";
    if (dark) root.classList.add("boot-dark");
  } catch {}
})();

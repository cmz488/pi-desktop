/* 首屏引导必须是同源外部脚本：页面的 CSP 是 `script-src 'self'`，内联脚本会被
 * 直接拦截（securitypolicyviolation: script-src-elem）。而 chat.js 是放在 body
 * 末尾的延迟模块，静态占位内容会先上屏，因此主题、嵌入布局和占位隐藏都要在这里
 * 以同步脚本的方式在首次绘制前落到 <html> 上。 */
(() => {
  const root = document.documentElement;
  // 深色偏好的用户否则会先看到一帧浅色的 Agent 画布。
  try {
    const preference = localStorage.getItem("pi-web-theme") || "light";
    const dark =
      preference === "dark" ||
      (preference === "system" &&
        matchMedia("(prefers-color-scheme: dark)").matches);
    // design-tokens.css 同时支持 :root[data-theme="dark"]，这里不依赖 body。
    root.dataset.theme = dark ? "dark" : "light";
    if (dark) root.classList.add("boot-dark");
  } catch {}
  // 嵌入画布的底色由 Desktop 外壳的磨砂背景提供；先声明透明，避免首帧绘制出
  // 一块独立底色。
  try {
    if (new URL(location.href).searchParams.has("embed"))
      root.dataset.embed = "";
  } catch {}
  /* 静态 HTML 里的示例会话标题、演示状态文字和未启用的输入区在 chat.js 运行前
   * 不应该出现在屏幕上。chat.js 首次渲染后解除；定时器只是兜底，让脚本异常时仍
   * 能看到静态页面而不是空白画布。 */
  root.dataset.booting = "";
  setTimeout(() => delete root.dataset.booting, 4000);
})();

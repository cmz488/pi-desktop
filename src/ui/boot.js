/* 两个页面共用同步首屏引导：CSP 不允许内联脚本，而延迟模块无法阻止首次绘制。
 * 这里只确定主题与聊天加载面，运行状态仍由各自的页面控制器接管。 */
(() => {
  const root = document.documentElement;
  let preference = "light";
  try {
    preference = localStorage.getItem("pi-web-theme") || "light";
  } catch {
    // 禁用浏览器存储时仍可按默认主题加载，不让外观偏好阻断页面。
  }
  root.dataset.theme =
    preference === "dark" ||
    (preference === "system" &&
      matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark"
      : "light";
  if (!document.querySelector('meta[name="pi-desk-mode"]')) return;
  if (new URL(location.href).searchParams.has("embed")) root.dataset.embed = "";
  // 加载慢不等于失败；只有控制器就绪才能解除隐藏，不能按时间暴露演示内容。
  root.dataset.booting = "";
  window.addEventListener(
    "error",
    (event) => {
      if (
        root.hasAttribute("data-booting") &&
        (event.target instanceof HTMLScriptElement ||
          event instanceof ErrorEvent)
      )
        root.dataset.bootError = "";
    },
    true,
  );
})();

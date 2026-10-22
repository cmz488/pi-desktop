/**
 * 聊天对话框：拥有单个共享 dialog 的保存尝试与目标身份，不让迟到保存关闭新表单。
 *
 * 接口：createChatDialog({getIdentity,onError}) 返回 open／close／isCurrent／dispose；
 *   open 返回该次展示令牌，异步详情必须先用 isCurrent 核验再写入。
 * 不变量：保存只作用于打开时的请求目标；替换、关闭或销毁使旧令牌失效。
 * 错误：当前保存失败交给 onError，保留表单；过期保存不重置新表单。
 */
export function createChatDialog({ getIdentity, onError }) {
  const root = document.querySelector("#dialog");
  const form = document.querySelector("#dialog-form");
  const submit = document.querySelector("#dialog-submit");
  const listeners = new AbortController();
  let current,
    save,
    disposed = false;
  function isCurrent(token) {
    return (
      !disposed &&
      !!token &&
      token === current &&
      root.open &&
      token.identity === getIdentity()
    );
  }
  function close() {
    current = undefined;
    save = undefined;
    if (root.open) root.close();
  }
  root.addEventListener(
    "close",
    () => {
      // close 事件排队派发；同一回合立即重开时不能使新展示失效。
      if (!root.open) {
        current = undefined;
        save = undefined;
      }
    },
    { signal: listeners.signal },
  );
  root.addEventListener(
    "cancel",
    () => {
      current = undefined;
      save = undefined;
    },
    { signal: listeners.signal },
  );
  form.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      const token = current;
      if (!isCurrent(token)) {
        onError(new Error("当前会话或工作区已变化，请重新打开表单"));
        return;
      }
      if (token.saving) return;
      token.saving = true;
      submit.disabled = true;
      try {
        await save?.(new FormData(form));
        if (!isCurrent(token)) return;
        close();
        form.reset();
      } catch (error) {
        if (isCurrent(token)) onError(error);
      } finally {
        token.saving = false;
        if (current === token || !current) submit.disabled = false;
      }
    },
    { signal: listeners.signal },
  );
  return {
    open(title, html, onSave, label = "保存") {
      if (disposed) return undefined;
      const token = { identity: getIdentity(), saving: false };
      current = token;
      save = onSave;
      document.querySelector("#dialog-title").textContent = title;
      document.querySelector("#dialog-body").innerHTML = html;
      submit.textContent = label;
      submit.disabled = false;
      if (!root.open) root.showModal();
      return token;
    },
    close,
    isCurrent,
    dispose() {
      if (disposed) return;
      close();
      disposed = true;
      listeners.abort();
    },
  };
}

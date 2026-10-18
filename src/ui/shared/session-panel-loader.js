/**
 * 会话面板加载器：合并只读请求、身份失效与节流补刷，不拥有业务数据或命令。
 *
 * 接口：`createSessionPanelLoader({ read, onChange, onReset })` 返回 setContext、
 *   refresh、capture／isCurrent、setActive／dispose 与只读状态；见
 *   docs/architecture/interfaces/read-panels.md。
 * 不变量：每代身份最多一个请求；会话／目标／权限变化立即清空旧数据并中止旧读取；
 *   即使读取忽略 abort，旧回调也不能发布；补刷和销毁各自只有一个资源生命周期。
 * 错误：当前读取失败保存 error，过期或主动中止的失败不显示；不把失败当作空任务成功。
 */
const REFRESH_INTERVAL_MS = 1500;

export function createSessionPanelLoader({ read, onChange, onReset }) {
  let context = Object.freeze({
    owner: "",
    sessionId: "",
    enabled: false,
    canManage: false,
  });
  let identity = {},
    data,
    task,
    retry;
  let error = "",
    loading = false,
    pending = false,
    active = true,
    closed = false;
  let lastStarted = -Infinity;
  function reset(reason) {
    identity = Object.freeze({ ...context });
    const previous = task;
    task = undefined;
    previous?.controller.abort();
    clearTimeout(retry);
    retry = undefined;
    pending = false;
    loading = false;
    data = undefined;
    error = "";
    lastStarted = -Infinity;
    onReset?.(reason);
  }
  const available = () =>
    !closed && active && context.enabled && data?.supported !== false;
  const current = (request) =>
    task === request && request.identity === identity && available();
  function schedule() {
    if (retry !== undefined || !available()) return;
    retry = setTimeout(
      () => {
        retry = undefined;
        void refresh({ force: true });
      },
      Math.max(0, lastStarted + REFRESH_INTERVAL_MS - Date.now()),
    );
  }
  async function refresh({ force = false } = {}) {
    if (!available() || !context.sessionId) return;
    if (task) {
      pending = true;
      return task.promise;
    }
    if (!force && Date.now() - lastStarted < REFRESH_INTERVAL_MS) {
      pending = true;
      schedule();
      return;
    }
    clearTimeout(retry);
    retry = undefined;
    pending = false;
    const request = {
      identity,
      controller: new AbortController(),
      promise: undefined,
    };
    task = request;
    loading = true;
    lastStarted = Date.now();
    onChange?.();
    request.promise = (async () => {
      try {
        const value = await read(request.identity.sessionId, {
          signal: request.controller.signal,
        });
        if (!current(request)) return;
        if (
          value?.supported !== false &&
          value?.sessionId !== undefined &&
          String(value.sessionId) !== request.identity.sessionId
        )
          throw new Error("会话读模型目标不一致，请重新读取");
        data = value;
        error = "";
      } catch (failure) {
        if (!current(request) || request.controller.signal.aborted) return;
        error = failure?.message ?? "面板读取失败，请重试";
      } finally {
        if (task === request && request.identity === identity) {
          task = undefined;
          loading = false;
          onChange?.();
          if (pending) {
            pending = false;
            schedule();
          }
        }
      }
    })();
    return request.promise;
  }
  return {
    setContext(next) {
      if (closed) return false;
      const value = {
        owner: String(next.owner ?? ""),
        sessionId: String(next.sessionId ?? ""),
        enabled: next.enabled === true,
        canManage: next.canManage === true,
      };
      if (Object.keys(value).every((key) => value[key] === context[key]))
        return false;
      context = Object.freeze(value);
      reset("identity");
      return true;
    },
    refresh,
    capture() {
      return available() && data !== undefined ? identity : undefined;
    },
    isCurrent(token) {
      return !!token && token === identity && available() && data !== undefined;
    },
    get context() {
      return context;
    },
    get data() {
      return data;
    },
    get error() {
      return error;
    },
    get loading() {
      return loading;
    },
    get available() {
      return available();
    },
    get canManage() {
      return available() && context.canManage;
    },
    setActive(value) {
      if (closed || active === value) return;
      active = value;
      reset("activity");
    },
    dispose() {
      if (closed) return;
      closed = true;
      reset("dispose");
    },
  };
}

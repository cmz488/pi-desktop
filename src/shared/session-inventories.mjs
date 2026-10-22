/**
 * 会话清单：合并与缓存独立资源读取，不让慢清单阻塞聊天。
 *
 * 接口：refresh(snapshot, options)、invalidate()、dispose()；load(kind, owner, {signal}) 可响应取消。
 * 不变量：身份／版本失效先撤观察；忽略 signal 的旧结果也不发布，销毁后不再读取。
 * 错误：当前读取错误交给 onError，并沿用短暂退避；失效读取不报告新会话错误。
 */
export function createSessionInventories({
  load,
  apply,
  onError = () => {},
  onReset = () => {},
  now = Date.now,
  maxAgeMs = 30000,
}) {
  let key,
    owner,
    generation = 0,
    disposed = false;
  const entries = new Map();
  function invalidate() {
    generation++;
    for (const entry of entries.values()) entry.controller.abort();
    entries.clear();
  }
  function refresh(
    snapshot,
    { force = false, kinds = ["plugins", "providers"] } = {},
  ) {
    if (disposed) return Promise.resolve();
    const next = JSON.stringify([
      snapshot.backend?.id,
      snapshot.epoch,
      snapshot.sessionId,
      snapshot.cwd,
      snapshot.pending,
      snapshot.initializing,
      snapshot.models,
      snapshot.idle,
      snapshot.agents?.map((agent) => [
        agent.id,
        agent.name,
        agent.cwd,
        agent.idle,
        agent.revision,
      ]),
    ]);
    if (key !== next || force) {
      key = next;
      const changedOwner = owner !== snapshot.sessionId;
      owner = snapshot.sessionId;
      invalidate();
      if (changedOwner) onReset(owner);
    }
    const version = generation,
      target = owner;
    return Promise.all(
      kinds.map((kind) => {
        const existing = entries.get(kind);
        if (
          existing &&
          ((existing.value && now() - existing.loadedAt < maxAgeMs) ||
            existing.pending ||
            existing.retryAt > now())
        )
          return existing.pending;
        const entry = { controller: new AbortController() };
        entries.set(kind, entry);
        entry.pending = Promise.resolve()
          .then(() => {
            if (version !== generation) return;
            return load(kind, target, { signal: entry.controller.signal });
          })
          .then((value) => {
            if (version !== generation) return;
            entry.value = value;
            entry.loadedAt = now();
            apply(kind, value, target);
          })
          .catch((error) => {
            if (version !== generation) return;
            entry.retryAt = now() + 5000;
            onError(kind, error);
          })
          .finally(() => {
            entry.pending = undefined;
          });
        return entry.pending;
      }),
    );
  }
  return {
    refresh,
    invalidate,
    dispose() {
      disposed = true;
      invalidate();
    },
  };
}

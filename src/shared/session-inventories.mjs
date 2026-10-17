// Resource listings have their own lifecycle; a slow listing never holds up chat.
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
    generation = 0;
  const entries = new Map();
  function invalidate() {
    generation++;
    entries.clear();
  }
  function refresh(
    snapshot,
    { force = false, kinds = ["plugins", "providers"] } = {},
  ) {
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
        const entry = {};
        entries.set(kind, entry);
        entry.pending = Promise.resolve()
          .then(() => load(kind, target))
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
  return { refresh, invalidate };
}

// One event stream per page. Reconnect its replay cursor first; snapshots and
// slow resource reads must not hold the stream or foreground recovery hostage.
export function createSessionConnection({
  readSnapshot,
  applySnapshot,
  onEvent,
  onStatus,
  openStream,
  isOnline = () => true,
  retryDelays = [180, 350, 700, 1400, 2500],
  snapshotTimeoutMs = 8000,
  connectTimeoutMs = 5000,
  heartbeatTimeoutMs = 26000,
  stableMs = 10000,
  now = Date.now,
  random = Math.random,
}) {
  let stream, task, retryTimer, refreshTimer, watchdog, stableTimer;
  let epoch = "",
    cursor = 0,
    retries = 0,
    paused = false,
    stopped = false;
  let opened = false,
    unauthorized = false,
    buffered = [],
    refreshWanted = false;
  let lastActivity = now(),
    streamStarted = now();
  const clearRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  function disconnect() {
    clearTimeout(watchdog);
    clearTimeout(stableTimer);
    const old = stream;
    stream = undefined;
    opened = false;
    old?.close();
  }
  function cancelRead() {
    const old = task;
    task = undefined;
    old?.controller.abort();
    buffered = [];
  }
  function authFailure(error) {
    if (![401, 403].includes(error?.status)) return false;
    unauthorized = true;
    clearRetry();
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    cancelRead();
    disconnect();
    onStatus("unauthorized");
    return true;
  }
  function retry(snapshot = false) {
    if (paused || stopped || unauthorized || retryTimer) return;
    if (!opened) onStatus(isOnline() ? "reconnecting" : "offline");
    const delay = retryDelays[Math.min(retries++, retryDelays.length - 1)];
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined;
        if (!isOnline()) {
          retry(snapshot);
          return;
        }
        if (!epoch || snapshot || retries > 3) void refresh();
        else connect();
      },
      Math.round(delay * (0.85 + random() * 0.3)),
    );
  }
  function scheduleRefresh(delay = 100) {
    if (paused || stopped || unauthorized) return;
    if (refreshTimer !== undefined && delay > 0) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, delay);
  }
  function receive(record) {
    if (
      record.kind === "resync_required" ||
      (record.epoch && record.epoch !== epoch)
    ) {
      refreshWanted = true;
      disconnect();
      cancelRead();
      epoch = "";
      cursor = 0;
      scheduleRefresh(0);
      return;
    }
    if (record.seq <= cursor) return;
    if (task) {
      if (buffered.length >= 128) {
        buffered.shift();
        refreshWanted = true;
        task.followUp = true;
      }
      buffered.push(record);
      return;
    }
    cursor = record.seq;
    retries = 0;
    if (record.kind === "state_changed") {
      refreshWanted = true;
      scheduleRefresh();
    } else onEvent(record);
  }
  function connect() {
    if (stream || paused || stopped || unauthorized || !isOnline()) return;
    let current;
    const fail = (error) => {
      if (stream !== current) return;
      if (authFailure(error)) return;
      if (task || refreshTimer !== undefined) refreshWanted = true;
      cancelRead();
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
      disconnect();
      retry();
    };
    const watch = (delay) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        () => fail(new Error("Event stream timeout")),
        delay,
      );
    };
    streamStarted = now();
    current = openStream(
      { epoch, after: cursor },
      {
        record(record) {
          if (stream === current) receive(record);
        },
        activity() {
          if (stream !== current) return;
          lastActivity = now();
          if (opened) watch(heartbeatTimeoutMs);
        },
        open() {
          if (stream !== current) return;
          opened = true;
          lastActivity = now();
          clearRetry();
          watch(heartbeatTimeoutMs);
          stableTimer = setTimeout(() => {
            if (stream === current) retries = 0;
          }, stableMs);
          onStatus("connected");
          if (refreshWanted) scheduleRefresh(0);
        },
        error: fail,
      },
    );
    stream = current;
    watch(connectTimeoutMs);
  }
  function refresh() {
    if (paused || stopped || unauthorized) return Promise.resolve(false);
    if (task) {
      task.followUp = true;
      return task.promise;
    }
    clearRetry();
    const job = {
      controller: new AbortController(),
      started: now(),
      followUp: false,
    };
    task = job;
    job.promise = (async () => {
      let timeout, abort;
      try {
        if (!isOnline()) throw new Error("offline");
        const cancelled = new Promise((_, reject) => {
          abort = () =>
            reject(
              job.controller.signal.reason ?? new Error("Request cancelled"),
            );
          job.controller.signal.addEventListener("abort", abort, {
            once: true,
          });
        });
        timeout = setTimeout(
          () => job.controller.abort(new Error("Snapshot timeout")),
          snapshotTimeoutMs,
        );
        const snapshot = await Promise.race([
          readSnapshot({ signal: job.controller.signal }),
          cancelled,
        ]);
        if (task !== job || paused || stopped) return false;
        if (epoch === snapshot.epoch && snapshot.seq < cursor) {
          flushBuffered();
          retry(true);
          return false;
        }
        if (epoch && epoch !== snapshot.epoch) disconnect();
        epoch = snapshot.epoch;
        // A snapshot can lag deltas that have already been rendered.
        cursor = snapshot.seq;
        refreshWanted = false;
        await applySnapshot(snapshot);
        if (task !== job || paused || stopped) return false;
        flushBuffered();
        connect();
        return true;
      } catch (error) {
        if (task !== job || paused || stopped) return false;
        if (authFailure(error)) return false;
        flushBuffered();
        if (!isOnline()) disconnect();
        // Keep a healthy stream when only a snapshot request fails.
        retry(true);
        return false;
      } finally {
        clearTimeout(timeout);
        if (abort) job.controller.signal.removeEventListener("abort", abort);
        if (task === job) {
          task = undefined;
          if ((refreshWanted || job.followUp) && !retryTimer) scheduleRefresh();
        }
      }
    })();
    return job.promise;
  }
  function flushBuffered() {
    const pending = buffered;
    buffered = [];
    for (const record of pending) {
      if (record.epoch !== epoch || record.seq <= cursor) continue;
      cursor = record.seq;
      if (record.kind === "state_changed") refreshWanted = true;
      else onEvent(record);
    }
  }
  function pause() {
    paused = true;
    clearRetry();
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    if (task) refreshWanted = true;
    cancelRead();
    disconnect();
  }
  function resume() {
    if (stopped) return Promise.resolve(false);
    const waking = paused || unauthorized;
    paused = unauthorized = false;
    retries = 0;
    clearRetry();
    if (waking) cancelRead();
    if (epoch) connect();
    return refresh();
  }
  function reconnect() {
    pause();
    return resume();
  }
  return {
    refresh,
    pause,
    resume,
    reconnect,
    check() {
      if (stopped || paused || unauthorized) return;
      if (
        (opened && now() - lastActivity >= heartbeatTimeoutMs) ||
        (stream && !opened && now() - streamStarted >= connectTimeoutMs) ||
        (task && now() - task.started >= snapshotTimeoutMs)
      )
        return reconnect();
      if (!stream && !task && isOnline()) return resume();
    },
    stop() {
      stopped = true;
      pause();
    },
  };
}

// Fetch exposes heartbeat comments and HTTP status codes that EventSource hides.
// This works with the existing gzip SSE protocol and requires no host restart.
export function openSessionStream(
  url,
  handlers,
  {
    fetcher = (...args) => fetch(...args),
    maxFrameChars = 8 * 1024 * 1024,
  } = {},
) {
  const controller = new AbortController();
  let reader;
  void (async () => {
    await Promise.resolve();
    try {
      const response = await fetcher(url, {
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      });
      if (!response.ok)
        throw Object.assign(new Error(`Event stream HTTP ${response.status}`), {
          status: response.status,
        });
      if (
        !/^text\/event-stream(?:;|$)/i.test(
          response.headers.get("content-type") ?? "",
        ) ||
        !response.body
      )
        throw new Error("Invalid event stream");
      if (controller.signal.aborted) return;
      handlers.open();
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "",
        data = [],
        event = "",
        frameSize = 0;
      while (!controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Event stream ended");
        if (!chunk.value.length) continue;
        handlers.activity?.();
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = /\r\n|\r|\n/.exec(buffer))) {
          if (boundary[0] === "\r" && boundary.index === buffer.length - 1)
            break;
          const line = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          frameSize += line.length;
          if (frameSize > maxFrameChars)
            throw new Error("Event stream frame too large");
          if (!line) {
            if (data.length && (!event || event === "message"))
              handlers.record(JSON.parse(data.join("\n")));
            data = [];
            event = "";
            frameSize = 0;
          } else if (!line.startsWith(":")) {
            const colon = line.indexOf(":"),
              field = colon < 0 ? line : line.slice(0, colon);
            const value =
              colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
            if (field === "data") data.push(value);
            else if (field === "event") event = value;
          }
        }
        if (buffer.length + frameSize > maxFrameChars)
          throw new Error("Event stream frame too large");
      }
    } catch (error) {
      if (!controller.signal.aborted) handlers.error(error);
    } finally {
      try {
        await reader?.cancel();
      } catch {
        /* The closed transport is already handled. */
      }
      reader?.releaseLock();
      controller.abort();
    }
  })();
  return {
    close() {
      controller.abort();
      void reader?.cancel().catch(() => {});
    },
  };
}

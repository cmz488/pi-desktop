import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createSessionPanelLoader } from "../src/ui/shared/session-panel-loader.js";

const context = (owner, extra = {}) => ({
  owner,
  sessionId: owner,
  enabled: true,
  canManage: true,
  ...extra,
});
const value = (sessionId, version = 1) => ({
  supported: true,
  sessionId,
  version,
});
function fixture(t) {
  const requests = [],
    changes = [];
  const loader = createSessionPanelLoader({
    read(sessionId, { signal }) {
      const request = { sessionId, signal, ...Promise.withResolvers() };
      requests.push(request);
      return request.promise;
    },
    onChange: () => changes.push([loader.data, loader.error, loader.loading]),
  });
  t.after(() => loader.dispose());
  return { loader, requests, changes };
}

test("未声明不读取，unsupported 隐藏且不补刷；新身份重新判断支持", async (t) => {
  const { loader, requests } = fixture(t);
  await loader.refresh();
  assert.equal(requests.length, 0);
  assert.equal(loader.available, false);
  loader.setContext(context("1"));
  const first = loader.refresh();
  requests[0].resolve({ supported: false });
  await first;
  assert.equal(loader.available, false);
  await loader.refresh({ force: true });
  assert.equal(requests.length, 1);
  loader.setContext(context("2"));
  const second = loader.refresh();
  requests[1].resolve(value("2"));
  await second;
  assert.equal(loader.available, true);
});

test("新身份立即清数据和错误，中止旧读取；忽略 abort 的旧响应也不发布", async (t) => {
  const { loader, requests, changes } = fixture(t);
  loader.setContext(context("1"));
  const old = loader.refresh();
  loader.setContext(context("2"));
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(loader.data, undefined);
  assert.equal(loader.error, "");
  const next = loader.refresh();
  requests[1].resolve(value("2"));
  await next;
  const count = changes.length;
  requests[0].resolve(value("1"));
  await old;
  assert.equal(loader.data.sessionId, "2");
  assert.equal(changes.length, count);
});

test("A/B/A 使用不同代际，旧 A 成功或失败不能覆盖新 A", async (t) => {
  const { loader, requests } = fixture(t);
  loader.setContext(context("1"));
  const a = loader.refresh();
  loader.setContext(context("2"));
  const b = loader.refresh();
  loader.setContext(context("1"));
  const fresh = loader.refresh();
  requests[2].resolve(value("1", 3));
  await fresh;
  requests[0].resolve(value("1", 1));
  requests[1].reject(new Error("late error"));
  await Promise.all([a, b]);
  assert.equal(loader.data.version, 3);
  assert.equal(loader.error, "");
});

test("拥有者、显示目标或权限改变都使旧命令令牌失效", async (t) => {
  const { loader, requests } = fixture(t);
  loader.setContext(context("1"));
  const first = loader.refresh();
  requests[0].resolve(value("1"));
  await first;
  const token = loader.capture();
  assert.equal(loader.isCurrent(token), true);
  assert.equal(Object.isFrozen(token), true);
  loader.setContext(context("1", { canManage: false }));
  assert.equal(loader.isCurrent(token), false);
  assert.equal(loader.canManage, false);
  loader.setContext(context("1", { sessionId: "2" }));
  assert.equal(loader.context.sessionId, "2");
  assert.equal(loader.data, undefined);
  loader.setContext(context("3", { sessionId: "2" }));
  assert.equal(loader.context.owner, "3");
});

test("快速刷新节流只补一次，不成为持续轮询", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const { loader, requests } = fixture(t);
  loader.setContext(context("1"));
  const first = loader.refresh();
  requests[0].resolve(value("1"));
  await first;
  for (let i = 0; i < 10; i++) void loader.refresh();
  t.mock.timers.tick(1499);
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1);
  assert.equal(requests.length, 2);
  requests[1].resolve(value("1", 2));
  await setImmediate();
  t.mock.timers.tick(10000);
  assert.equal(requests.length, 2);
});

test("读取进行中合并补刷意图，完成后仅补一次", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const { loader, requests } = fixture(t);
  loader.setContext(context("1"));
  const first = loader.refresh();
  for (let i = 0; i < 10; i++) void loader.refresh();
  assert.equal(requests.length, 1);
  requests[0].resolve(value("1"));
  await first;
  t.mock.timers.tick(1500);
  assert.equal(requests.length, 2);
  requests[1].resolve(value("1", 2));
  await setImmediate();
  t.mock.timers.tick(10000);
  assert.equal(requests.length, 2);
});

test("暂停中止读取并阻止补刷，恢复读取新一代；销毁后不再发布或读取", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const { loader, requests, changes } = fixture(t);
  loader.setContext(context("1"));
  const old = loader.refresh();
  void loader.refresh();
  loader.setActive(false);
  assert.equal(requests[0].signal.aborted, true);
  t.mock.timers.tick(10000);
  await loader.refresh();
  assert.equal(requests.length, 1);
  loader.setActive(true);
  const next = loader.refresh();
  assert.equal(requests.length, 2);
  loader.dispose();
  loader.dispose();
  assert.equal(requests[1].signal.aborted, true);
  const count = changes.length;
  requests[0].resolve(value("1", 1));
  requests[1].resolve(value("1", 2));
  await Promise.all([old, next]);
  await loader.refresh();
  t.mock.timers.tick(10000);
  assert.equal(requests.length, 2);
  assert.equal(changes.length, count);
  assert.equal(loader.available, false);
});

test("当前读取失败或目标错配显示错误，不当作空数据或成功", async (t) => {
  const { loader, requests } = fixture(t);
  loader.setContext(context("1"));
  const first = loader.refresh();
  requests[0].reject(new Error("read failed"));
  await first;
  assert.equal(loader.error, "read failed");
  assert.equal(loader.data, undefined);
  const next = loader.refresh({ force: true });
  requests[1].resolve(value("2"));
  await next;
  assert.equal(loader.error, "会话读模型目标不一致，请重新读取");
  assert.equal(loader.capture(), undefined);
});

test("销毁撤销已排定的补刷定时器，不仅阻止其回调读取", async (t) => {
  const handles = new Set();
  const schedule = globalThis.setTimeout,
    cancel = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const handle = schedule(() => {
      handles.delete(handle);
      callback();
    }, delay);
    handles.add(handle);
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle) => {
    handles.delete(handle);
    cancel(handle);
  });
  const { loader, requests } = fixture(t);
  loader.setContext(context("1"));
  const first = loader.refresh();
  requests[0].resolve(value("1"));
  await first;
  for (let i = 0; i < 5; i++) void loader.refresh();
  assert.equal(handles.size, 1);
  loader.dispose();
  assert.equal(handles.size, 0);
});

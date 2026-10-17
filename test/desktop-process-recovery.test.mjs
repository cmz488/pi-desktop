import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopFixture, until } from "./desktop-fixture.mjs";

test(
  "a crashed Pi worker does not stop other agents and can reopen its durable history",
  { timeout: 35000 },
  async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    const projectId = (await f.call("/api/workspace")).projects[0].id;
    const a = await f.command("agent.save", {
      projectId,
      name: "Crash target",
    });
    const b = await f.command("agent.save", { projectId, name: "Unaffected" });
    await f.command("agent.start", { id: a.id });
    await f.command("agent.start", { id: b.id });
    const prior = await f.call(`/agents/${a.id}/api/state`);
    await f.call(`/agents/${a.id}/api/prompt`, {
      message: "before crash",
      sessionId: prior.sessionId,
      requestId: "before-crash",
    });
    const transcript = await until(
      () => f.call(`/agents/${a.id}/api/state`),
      (value) =>
        value.idle && value.messages.some((row) => row.role === "assistant"),
    );
    const catalog = await f.call("/api/workspace");
    const victim = catalog.agents.find((row) => row.id === a.id);
    const survivor = catalog.agents.find((row) => row.id === b.id);
    process.kill(victim.pid, "SIGKILL");
    await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.find((row) => row.id === a.id).status === "failed",
    );
    assert.equal(
      (await f.call("/api/workspace")).agents.find((row) => row.id === b.id)
        .pid,
      survivor.pid,
    );
    const surviving = await f.call(`/agents/${b.id}/api/state`);
    assert(surviving.idle);
    // A real crashed owner's lease expires; never remove another owner's lock.
    await new Promise((resolve) => setTimeout(resolve, 10500));
    await f.command("agent.start", { id: a.id });
    assert.deepEqual(
      (await f.call(`/agents/${a.id}/api/state`)).messages,
      transcript.messages,
    );
    assert.notEqual(
      (await f.call("/api/workspace")).agents.find((row) => row.id === a.id)
        .pid,
      victim.pid,
    );
  },
);

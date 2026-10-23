import { patchRequestSource } from "./durable-request-source.mjs";

/**
 * Durable 1.0.2 的源码补丁：增加提交后边界、partial 与请求运行时的 hook。
 *
 * 接口：patchGenerationSource(source)；契约见 docs/architecture/interfaces/durable-boundaries.md。
 * 不变量：由版本／摘要门禁的 installer 调用；模型、工具、重试与调度仍使用原任务及其 helper。
 * 错误：锚点不存在／重复时抛错，不尝试猜测新 SDK 的实现。
 */
function replaceOnce(source, before, after) {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0)
    throw new Error("Durable 边界补丁锚点不匹配");
  return source.slice(0, at) + after + source.slice(at + before.length);
}

export function patchGenerationSource(source) {
  for (const name of ["answer", "finishToolRound", "classify"])
    source = replaceOnce(
      source,
      `async function ${name}(`,
      `async function ${name}Uncommitted(`,
    );
  source = replaceOnce(
    source,
    'assignJson(live.generation, "message", message);\n                return undefined;\n            }, context);',
    'assignJson(live.generation, "message", message);\n                return undefined;\n            }, context);\n            await runtime.hooks.each("afterPartial", (hook) => hook(message, runtime, context));',
  );
  return patchRequestSource(source + COMMITTED_BOUNDARY_SOURCE);
}

// 在原模块词法作用域中使用原有 helper；不复制模型／工具循环或修改 node_modules。
const COMMITTED_BOUNDARY_SOURCE = String.raw`

const COMMITTED_BOUNDARY_API_VERSION = 1;
const LEGACY_GENERATION_VERSION = 1;
const COMMITTED_GENERATION_VERSION = 2;
async function hasCommittedBoundary(runtime, names = ["afterTurn", "beforeSettle"]) {
    let present = false;
    for (const name of names)
        await runtime.hooks.each(name, () => { present = true; });
    return present;
}
async function stageCommittedBoundary(runtime, fields, context) {
    await runtime.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, runtime.conversationId);
        let assistant = fields.assistant;
        if (fields.message) assistant = (await appendAssistant(tx, runtime.conversationId, fields.message)).id;
        delete live.generation;
        const { message, ...state } = fields;
        return { status: "running", checkpoint: { phase: "committedBoundary", step: "turn", ...state, assistant } };
    }, context);
}
async function answer(runtime, message, context) {
    if (!await hasCommittedBoundary(runtime)) return answerUncommitted(runtime, message, context);
    let continuation;
    await runtime.hooks.each("onYield", async (hook) => {
        if (continuation === undefined) continuation = (await hook(message, runtime, context))?.continue;
    });
    await stageCommittedBoundary(runtime, { kind: "answer", message, results: [], ...(continuation === undefined ? {} : { continuation }) }, context);
}
async function finishToolRound(runtime, assistant, tools, context) {
    if (!await hasCommittedBoundary(runtime)) return finishToolRoundUncommitted(runtime, assistant, tools, context);
    const outcomes = await runtime.outcomes(tools, context);
    const controls = new Map(tools.map((id, index) => [id, outcomes[index].status === "completed" ? outcomes[index].result.control : undefined]));
    const slots = (await runtime.snapshot(LiveDoc, runtime.conversationId, context))?.tools ?? [];
    const results = slots.flatMap((slot) => slot.entry === undefined ? [] : [slot.entry]);
    await runtime.hooks.each("afterTools", (hook) => hook(assistant, results, runtime, context));
    const terminate = slots.length > 0 && slots.every((slot) => slot.taskId !== undefined && controls.get(slot.taskId)?.terminate === true);
    const added = [...controls.values()].flatMap((control) => control?.addTools ?? []);
    const handoff = [...controls.values()].findLast((control) => control?.handoff !== undefined)?.handoff;
    await stageCommittedBoundary(runtime, { kind: "tools", assistant, results, terminate, added, ...(handoff === undefined ? {} : { handoff }) }, context);
}
async function classify(runtime, request, message, context) {
    if (message.stopReason === "deferred" || !await hasCommittedBoundary(runtime))
        return classifyUncommitted(runtime, request, message, context);
    runtime.signal.throwIfAborted();
    await runtime.hooks.each("afterResponse", (hook) => hook(message, runtime, context));
    // message_end 可以改变 stopReason，随后仍由原分类器裁决，且不重复分发 afterResponse。
    if (!["error", "aborted"].includes(message.stopReason)) {
        const hooks = runtime.hooks;
        return classifyUncommitted(new Proxy(runtime, { get(target, key) {
            if (key === "hooks") return { each: (name, invoke) => name === "afterResponse" ? Promise.resolve() : hooks.each(name, invoke) };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
        }}), request, message, context);
    }
    const { attempt, compacted, model: ref, cutoff } = request;
    const settings = runtime.settings;
    const overflow = message.stopReason === "error" && isContextOverflow(message);
    let recovery;
    if (overflow && compacted === undefined && settings.compaction.enabled) {
        const view = await runtime.context(runtime.conversationId, context, cutoff);
        if (selectCut(view, settings.compaction.keepRecentTokens) !== undefined)
            recovery = { kind: "compaction", attempt, ref, cutoff, overflow: message.errorMessage ?? "Context overflow" };
    }
    const policy = settings.retry;
    if (!recovery && message.stopReason === "error" && !overflow && isRetryableAssistantError(message) && policy.enabled && attempt <= policy.maxRetries)
        recovery = { kind: "retry", attempt, until: runtime.now() + retryDelayMs(policy, attempt), ...(compacted === undefined ? {} : { compacted }) };
    const failure = message.errorMessage ?? "Model response ended with stop reason " + message.stopReason;
    await stageCommittedBoundary(runtime, { kind: "error", message, results: [], outcome: message.stopReason === "aborted" ? "aborted" : "error", failure, ...(recovery ? { recovery } : {}) }, context);
}
async function committedBoundary(task, runtime, context) {
    const state = task.state.checkpoint;
    // 进程在副作用 handler 内退出时，不猜测它是否执行过；保守终止而不是重放未知副作用。
    if (state.dispatched) return failModelError(runtime, "扩展边界在上次运行中被中断，未重复执行；请显式继续会话", context);
    const event = state.step === "turn" ? "afterTurn" : "beforeSettle";
    if (await hasCommittedBoundary(runtime, [event]))
        await runtime.commit(() => ({ status: "running", checkpoint: { ...state, dispatched: true } }), context);
    const entries = [];
    let continuation = false;
    const automatic = !!state.recovery || state.continuation !== undefined || (state.kind === "tools" && !state.terminate && state.handoff === undefined);
    await runtime.hooks.each(event, async (hook) => {
        const result = await hook({ assistant: state.assistant, results: state.results, outcome: state.outcome ?? "completed", automatic }, runtime, context);
        if (result?.entries !== undefined) {
            if (!Array.isArray(result.entries)) throw new TypeError("边界 entries 无效");
            entries.push(...result.entries);
        }
        continuation ||= result?.continue === true;
    });
    runtime.signal.throwIfAborted();
    await runtime.commit(async (tx) => {
        const id = runtime.conversationId;
        const boundary = await prepareBoundary(tx, id, runtime.settings);
        const live = await tx.doc(LiveDoc, id);
        for (const draft of entries) {
            const entry = await tx.appendEntry(id, draft);
            if (draft.head !== undefined) boundary.head = draft.head === "self" ? entry.id : draft.head;
        }
        const terminal = { status: "terminal", outcome: { status: "completed", result: { entryId: state.assistant } } };
        if (state.recovery) {
            const recovery = state.recovery;
            if (recovery.kind === "retry") {
                live.generation = { attempt: recovery.attempt, retry: { at: recovery.until, error: state.failure } };
                return { status: "running", checkpoint: { phase: "retry", attempt: recovery.attempt, until: recovery.until, ...(recovery.compacted === undefined ? {} : { compacted: recovery.compacted }) } };
            }
            const child = await createCompaction(tx, id, { reason: "overflow" }, runtime.taskId);
            return { status: "waiting", checkpoint: { phase: "prepare", attempt: recovery.attempt, compacted: child, overflow: recovery.overflow }, on: [child], policy: "allSettled" };
        }
        if (state.kind === "error" && !continuation) {
            if (state.step === "turn" && state.outcome !== "aborted")
                return { status: "running", checkpoint: { ...state, step: "settle", dispatched: false } };
            // 原生失败策略保留 inbox，只有新的提交或显式 continuation 才唤醒它。
            endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "model_error", detail: state.failure });
            return { status: "terminal", outcome: { status: "failed", error: { message: state.failure, detail: { reason: "model_error" } } } };
        }
        if (state.kind === "tools" && state.added.length) await addTools(tx, id, state.added);
        if (state.handoff !== undefined) {
            const message = { role: "user", content: state.handoff, timestamp: runtime.now() };
            boundary.head = (await tx.appendEntry(ResetEntry, id, { head: "self", model: [message] })).id;
        }
        const postTools = state.kind === "tools" && !state.terminate && state.handoff === undefined;
        const { users, reset } = await applyBoundary(tx, boundary, postTools ? "postTools" : "final", runtime.now());
        if (postTools && !reset) {
            delete live.tools;
            if (live.run?.taskId === runtime.taskId) live.run.inputs.push(...users);
            handOver(live, runtime.taskId, await createGeneration(tx, id));
            return terminal;
        }
        const mayContinue = !reset && users.length === 0 && state.handoff === undefined && state.outcome !== "aborted";
        const turnTerminated = state.step === "turn" && state.kind === "tools" && state.terminate;
        if (mayContinue && !turnTerminated && (continuation || state.continuation !== undefined)) {
            if (state.continuation !== undefined) await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: state.continuation, timestamp: runtime.now() }] });
            delete live.generation;
            delete live.tools;
            handOver(live, runtime.taskId, await createGeneration(tx, id));
            return terminal;
        }
        if (state.step === "turn" && mayContinue) {
            return { status: "running", checkpoint: { ...state, ...(state.kind === "tools" ? { added: [] } : {}), step: "settle", dispatched: false } };
        }
        if (reset && postTools) endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "reset" });
        else if (state.kind === "error") endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "model_error", detail: state.failure });
        else endRun(tx, live, runtime.taskId, { status: "done", answer: state.assistant });
        if (users.length) await startRun(tx, id, live, users);
        return state.kind === "error" ? { status: "terminal", outcome: { status: "failed", error: { message: state.failure, detail: { reason: "model_error" } } } } : terminal;
    }, context);
}
GenerationTask.definition.phases.committedBoundary = committedBoundary;
GenerationTask.definition.version = COMMITTED_GENERATION_VERSION;
GenerationTask.definition.migrate = (input, checkpoint, fromVersion) => {
    if (fromVersion !== LEGACY_GENERATION_VERSION && fromVersion !== COMMITTED_GENERATION_VERSION) throw new Error("Durable generation 检查点版本无效");
    return { input, checkpoint };
};
GenerationTask.definition.capabilities = { ...GenerationTask.definition.capabilities, committedBoundary: COMMITTED_BOUNDARY_API_VERSION };
`;

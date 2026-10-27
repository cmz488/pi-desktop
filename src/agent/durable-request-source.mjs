/**
 * Durable 请求运行时补丁：在原任务内选择会话 Models，并补上原生缺失的「最终答案提交后」边界。
 *
 * 接口：patchRequestSource(source)；由已核实摘要的 installer 在 Harness 创建前使用。
 * 不变量：不创建任务／循环／存储；Models 只活在当前 phase，检查点继续保存原生模型引用；
 *   模型请求、工具、重试、压缩与 applyBoundary 仍由原生承担。
 * 错误：Models 解析失败向原生调度器传播，不能静默退回另一会话的模型集合。
 */
export function patchRequestSource(source) {
  source = replaceAnswer(source);
  source += REQUEST_RUNTIME_SOURCE;
  source += ANSWER_BOUNDARY_SOURCE;
  source +=
    "\nGenerationTask.definition.phases.committedAnswer = committedAnswer;\n" +
    "GenerationTask.definition.version = Math.max(2, GenerationTask.definition.version);\n" +
    'if (typeof GenerationTask.definition.migrate !== "function")\n' +
    "    GenerationTask.definition.migrate = (input, checkpoint) => ({ input, checkpoint });\n" +
    "GenerationTask.definition.capabilities = { ...GenerationTask.definition.capabilities, answerBoundary: 1 };\n";
  return source;
}

export function replaceOnce(source, before, after) {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0)
    throw new Error("Durable 边界补丁锚点不匹配");
  return source.slice(0, at) + after + source.slice(at + before.length);
}

/**
 * 原生 answer() 的收尾：endRun 终结本次 run 并结算 submission。
 *
 * 两个实测结论决定了改道位置（1.4.0）：
 * 1. phase 函数的返回值被调度器丢弃（scheduler.js:1608 只 await、不接收），状态推进只能经
 *    runtime.commit 写入；TaskRuntime.commit 自身也不返回回调结果。
 * 2. endRun 之后 task 已终结，此时再写 running checkpoint 不会让调度器复活它
 *    （实测 inspect() 的 tasks 变空、新 phase 不执行）。
 *
 * 所以改道必须发生在 endRun **之前**：进入 committedAnswer 后先分发边界，再由该 phase 自己
 * endRun 结算。没有边界处理器时完全不改道，行为与 1.4.0 逐字节一致。
 *
 * queue／reset／continuation 的原生分流仍在此处判定（它读 boundary 的当前队列状态），只把
 * 「如何结算」交给改道后的 phase。
 */
const ANSWER_COMMIT_NATIVE = `        const { users, reset } = await applyBoundary(tx, boundary, "final", runtime.now());
        if (continuation !== undefined && users.length === 0 && !reset) {
            const user = { role: "user", content: continuation, timestamp: runtime.now() };
            await tx.appendEntry(UserEntry, conversationId, { model: [user] });
            handOver(live, runtime.taskId, await createGeneration(tx, conversationId));
            delete live.generation;
            return result;
        }
        endRun(tx, live, runtime.taskId, { status: "done", answer: entry.id });
        if (users.length > 0)
            await startRun(tx, conversationId, live, users);
        return result;
    }, context);
}`;

const ANSWER_COMMIT_PATCHED = `        const { users, reset } = await applyBoundary(tx, boundary, "final", runtime.now());
        if (continuation !== undefined && users.length === 0 && !reset) {
            const user = { role: "user", content: continuation, timestamp: runtime.now() };
            await tx.appendEntry(UserEntry, conversationId, { model: [user] });
            handOver(live, runtime.taskId, await createGeneration(tx, conversationId));
            delete live.generation;
            return result;
        }
        // 有边界处理器时先改道：endRun 会终结 task，之后写 running checkpoint 无法让调度器
        // 复活它。延迟结算的入参（answer entry、排队输入、既有 continuation）随检查点保存。
        if (hasAnswerBoundary(runtime)) {
            delete live.generation;
            return {
                status: "running",
                checkpoint: {
                    phase: "committedAnswer",
                    step: "turn",
                    assistant: entry.id,
                    settle: { users, continuation },
                },
            };
        }
        endRun(tx, live, runtime.taskId, { status: "done", answer: entry.id });
        if (users.length > 0)
            await startRun(tx, conversationId, live, users);
        return result;
    }, context);
}`;

function replaceAnswer(source) {
  return replaceOnce(source, ANSWER_COMMIT_NATIVE, ANSWER_COMMIT_PATCHED);
}

const REQUEST_RUNTIME_SOURCE = String.raw`
async function selectRequestRuntime(runtime, context) {
    const selectors = [];
    await runtime.hooks.each("modelRuntime", (select) => { selectors.push(select); });
    for (const select of selectors) {
        // 这是引擎资源解析而非通知；选择失败必须在 HookRunner 的普通异常捕获之外抛出。
        const models = await select(runtime, context);
        if (models === undefined) continue;
        return new Proxy(runtime, {
            get(target, key) {
                if (key === "models") return models;
                const value = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    }
    return runtime;
}
function installRequestRuntime(task) {
    const definition = task.definition;
    for (const [name, phase] of Object.entries(definition.phases))
        definition.phases[name] = async (task, runtime, context) => phase(task, await selectRequestRuntime(runtime, context), context);
    if (definition.abort) {
        const abort = definition.abort;
        definition.abort = async (task, runtime, context) => abort(task, await selectRequestRuntime(runtime, context), context);
    }
    definition.capabilities = { ...definition.capabilities, requestRuntime: 1 };
}
GenerationTask.definition.phases.request = async (task, runtime, context) => {
    const { attempt, compacted, model: ref, thinkingLevel, streamOptions, cutoff } = task.state.checkpoint;
    const conversationId = runtime.conversationId;
    await runtime.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, conversationId);
        await convertPartial(tx, live, conversationId);
        live.generation = { attempt };
        return undefined;
    }, context);
    let model = runtime.models.getModel(ref.provider, ref.modelId);
    if (model === undefined) return failNoModel(runtime, ref, context);
    const view = await runtime.context(conversationId, context, cutoff);
    let messages = view.messages;
    const sessionId = await ensureProviderSessionId(runtime, context);
    let options = { ...streamOptions, signal: runtime.signal, sessionId, ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }) };
    await runtime.hooks.each("beforeRequest", async (hook) => {
        const changed = await hook({ model, messages, options, entries: view.entries }, runtime, context);
        if (changed === undefined) return;
        if (changed.messages !== undefined) messages = changed.messages;
        if (changed.model !== undefined) model = changed.model;
        if (changed.options !== undefined) options = { ...options, ...changed.options };
    });
    runtime.signal.throwIfAborted();
    // 扩展可调整请求选项，但不能切断 Durable 的取消或更换其持久缓存身份。
    options = { ...options, signal: runtime.signal, sessionId };
    const message = await streamResponse(runtime, model, messages, options, attempt, context);
    const request = { attempt, compacted, model: ref, cutoff, messages };
    return classify(runtime, request, message, context);
};
installRequestRuntime(GenerationTask);
export { installRequestRuntime };
`;

/**
 * 边界改道与分发。
 *
 * committedAnswer 接管原生 answer() 的收尾：先分发 afterTurn／beforeSettle，再按原生规则结算
 * submission（endRun done，或为排队输入开新 run）。
 */
const ANSWER_BOUNDARY_SOURCE = String.raw`

const ANSWER_BOUNDARY_EVENTS = ["afterTurn", "beforeSettle"];
/** 当前会话是否注册了最终答案后的边界处理器。 */
function hasAnswerBoundary(runtime) {
    for (const extension of runtime.registry.installed())
        for (const registration of extension.hooks ?? []) {
            if (registration.task !== "pi.generation") continue;
            for (const name of ANSWER_BOUNDARY_EVENTS)
                if (typeof registration.handlers[name] === "function") return true;
        }
    return false;
}
/**
 * committedAnswer：分发提交后边界，再执行原生答案的收尾。
 *
 * 进程在 handler 副作用内中断时不重放：dispatched 标记先落库，恢复时保守失败。
 */
async function committedAnswer(task, runtime, context) {
    const state = task.state.checkpoint;
    if (state.dispatched)
        return failModelError(runtime, "扩展边界在上次运行中被中断，未重复执行；请显式继续会话", context);
    await runtime.commit(() => ({ status: "running", checkpoint: { ...state, dispatched: true } }), context);
    const conversationId = runtime.conversationId;
    const entries = [];
    let continuation = false;
    for (const phase of ANSWER_BOUNDARY_EVENTS) {
        await runtime.hooks.each(phase, async (hook) => {
            const result = await hook({
                assistant: state.assistant,
                results: [],
                outcome: "completed",
                automatic: false,
            }, runtime, context);
            if (result?.entries !== undefined) {
                if (!Array.isArray(result.entries)) throw new TypeError("边界 entries 无效");
                entries.push(...result.entries);
            }
            if (result?.continue === true) continuation = true;
        });
        runtime.signal.throwIfAborted();
    }
    const settle = state.settle ?? { users: [] };
    return runtime.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, conversationId);
        if (entries.length > 0) {
            const boundary = await prepareBoundary(tx, conversationId, runtime.settings);
            for (const draft of entries) {
                const entry = await tx.appendEntry(conversationId, draft);
                if (draft.head !== undefined)
                    boundary.head = draft.head === "self" ? entry.id : draft.head;
            }
        }
        // 边界要求继续：把 run 交给后继 generation，submission 保持未结束（原生 continuation 同义）。
        if (continuation && live.run?.taskId === runtime.taskId) {
            handOver(live, runtime.taskId, await createGeneration(tx, conversationId));
            delete live.generation;
            return { status: "terminal", outcome: { status: "completed", result: { entryId: state.assistant } } };
        }
        endRun(tx, live, runtime.taskId, { status: "done", answer: state.assistant });
        if (settle.users.length > 0)
            await startRun(tx, conversationId, live, settle.users);
        return { status: "terminal", outcome: { status: "completed", result: { entryId: state.assistant } } };
    }, context);
}
`;

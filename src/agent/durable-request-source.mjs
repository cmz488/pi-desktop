/**
 * Durable 请求运行时补丁：在原任务内选择会话 Models 并消费请求级变换。
 *
 * 接口：patchRequestSource(source)；由已核实摘要的 installer 在 Harness 创建前使用。
 * 不变量：不创建任务／循环／存储；Models 只活在当前 phase，检查点继续保存原生模型引用。
 * 错误：Models 解析失败向原生调度器传播，不能静默退回另一会话的模型集合。
 */
export function patchRequestSource(source) {
  return source + REQUEST_RUNTIME_SOURCE;
}

const REQUEST_RUNTIME_SOURCE = String.raw`
import { CompactionTask as RequestCompactionTask } from "./compaction.js";

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
        const changed = await hook({ model, messages, options }, runtime, context);
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
    await classify(runtime, request, message, context);
};
installRequestRuntime(GenerationTask);
installRequestRuntime(RequestCompactionTask);
`;

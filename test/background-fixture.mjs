import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTask,
  defineTool,
} from "@earendil-works/pi-durable";

/**
 * 受控后台任务夹具：让 API 与浏览器验证会话拥有的真实 Durable 后台任务。
 *
 * 接口：createBackgroundFixture() 返回 { extension, Anchor }；安装 extension 后可
 *   用 background_work 派生任务，见 docs/architecture/interfaces/task-graph.md。
 * 不变量：任务带 background 标记、由会话拥有；普通空闲／中止不影响它，持续时间有界；
 *   仅在临时 Harness 中运行，不启动外部子代理。
 * 错误：sleep 的中止或失败交给 Durable 结算，工具创建失败原样抛出，不伪造成功。
 */
const BACKGROUND_HOLD_MS = 20000;

export function createBackgroundFixture() {
  const Anchor = defineTask({
    name: "fixture.anchor",
    version: 1,
    initial: () => ({ phase: "hold" }),
    phases: {
      hold: async (task, runtime, context) => {
        // 锚点必须跨过普通回合的终态；有界 sleep 避免失败测试永久遗留后台任务。
        await runtime.sleep(Date.now() + BACKGROUND_HOLD_MS, context);
      },
    },
  });
  const extension = defineExtension({
    name: "background-fixture",
    tasks: [Anchor],
    tools: [
      defineTool({
        name: "background_work",
        description: "派生一个会话拥有的后台任务（锚点）",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, api, context) => {
          const id = await api.commit(
            (tx) =>
              tx.createTask(
                Anchor,
                {},
                { ownership: { kind: "conversation" }, background: true },
              ),
            context,
          );
          return { output: [{ type: "text", text: `anchor ${id}` }] };
        },
      }),
    ],
  });
  return { extension, Anchor };
}

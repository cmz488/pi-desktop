import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTask,
  defineTool,
} from "@earendil-works/pi-durable";

/* 真实后台任务的夹具：一个「锚点」任务持有 20 秒（被中止时立刻结算），由工具以
 * `background: true` 创建成会话拥有的任务。Durable 因此把它排除在普通空闲等待与
 * 会话中止之外——正好用来验证「取消后台任务」这条路径，以及面板上的后台标记。 */

export function createBackgroundFixture() {
  const Anchor = defineTask({
    name: "fixture.anchor",
    version: 1,
    initial: () => ({ phase: "hold" }),
    phases: {
      hold: async (task, runtime, context) => {
        // sleep 在调用被中止时会拒绝，任务因此进入终态；没有中止则 20 秒后自己结束。
        await runtime.sleep(Date.now() + 20000, context);
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
          return { content: [{ type: "text", text: `anchor ${id}` }] };
        },
      }),
    ],
  });
  return { extension, Anchor };
}

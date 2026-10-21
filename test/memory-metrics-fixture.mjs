import { Session } from "node:inspector/promises";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

/**
 * 内存测量夹具：让临时 worker 通过真实模型工具回合报告自己的运行时指标。
 *
 * 接口：default 是仅供 desktop-performance-check 使用的 Durable 扩展。
 * 不变量：不替换执行循环；定时采样不拥有工作，随临时 worker 退出；不装入生产配置。
 * 错误：采样与原生工具执行错误原样抛出，不把失败当成零内存。
 */
const SAMPLE_MS = 50;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
let peak = {},
  count = 0,
  overheadNs = 0;

function sample() {
  const start = process.hrtime.bigint();
  const memory = process.memoryUsage();
  for (const [key, value] of Object.entries(memory))
    peak[key] = Math.max(peak[key] ?? 0, value);
  count++;
  overheadNs += Number(process.hrtime.bigint() - start);
  return memory;
}

// 独立于浏览器轮询采样，避免把两个边界快照的最大值误报成操作期间的峰值。
setInterval(sample, SAMPLE_MS).unref();

export default defineExtension({
  name: "fixture-memory",
  tools: [
    defineTool({
      name: "fixture_process_memory",
      description: "报告临时 worker 的进程内存，不访问用户数据",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        const memory = sample();
        const inspector = new Session();
        inspector.connect();
        try {
          // 不开放调试端口；边界处的完整 GC 让重复操作的保留量不依赖随机 GC 时机。
          await inspector.post("HeapProfiler.collectGarbage");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  pid: process.pid,
                  ...memory,
                  afterGc: process.memoryUsage(),
                  cpu: process.cpuUsage(),
                  observedPeak: peak,
                  sampleCount: count,
                  samplingOverheadMs: overheadNs / NANOSECONDS_PER_MILLISECOND,
                }),
              },
            ],
          };
        } finally {
          inspector.disconnect();
        }
      },
    }),
  ],
});

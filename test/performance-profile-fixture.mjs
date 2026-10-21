import { Session } from "node:inspector/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

/**
 * 仅供临时性能调查的进程内采样工具，不装入正常会话配置。
 *
 * 接口：fixture_profile_start／fixture_profile_stop；通过真实工具回合启停。
 * 不变量：不打开调试端口、不记录消息内容、不拥有 Durable 工作；只写临时采样文件。
 * 错误：Inspector 或落盘错误原样交给原生工具回执，不能报告空 profile 成功。
 */
const ALLOCATION_SAMPLE_BYTES = 64 * 1024;
let inspector;
export default defineExtension({
  name: "fixture-profile",
  tools: [
    defineTool({
      name: "fixture_profile_start",
      description: "开始临时 worker 的 CPU 与分配采样",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        if (inspector) throw new Error("采样已开始");
        inspector = new Session();
        inspector.connect();
        try {
          await inspector.post("Profiler.enable");
          await inspector.post("Profiler.start");
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: ALLOCATION_SAMPLE_BYTES,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        } catch (error) {
          inspector.disconnect();
          inspector = undefined;
          throw error;
        }
        return { content: [{ type: "text", text: "PROFILE_STARTED" }] };
      },
    }),
    defineTool({
      name: "fixture_profile_stop",
      description: "保存临时 worker 的 CPU 与分配采样",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        if (!inspector) throw new Error("采样尚未开始");
        try {
          const cpu = await inspector.post("Profiler.stop");
          const heap = await inspector.post("HeapProfiler.stopSampling");
          const path = join(tmpdir(), `pi-desktop-profile-${process.pid}.json`);
          await writeFile(
            path,
            JSON.stringify({ cpu: cpu.profile, heap: heap.profile }),
          );
          return { content: [{ type: "text", text: path }] };
        } finally {
          inspector.disconnect();
          inspector = undefined;
        }
      },
    }),
  ],
});

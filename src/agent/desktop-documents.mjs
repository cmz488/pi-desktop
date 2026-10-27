import { defineDoc } from "@earendil-works/pi-durable";

// Native tool state belongs to the Durable conversation, including at a fork.
export const DesktopResources = defineDoc({
  kind: "desk.resources",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ entries: [] }),
  // 1.4.0 新增：决定何时把增量 ops 固化为 base。资源清单是小对象，每次提交固化代价低，
  // 与内建 pi.usage／pi.agent 的 always-checkpoint 语义一致。
  checkpointWhen: () => true,
});

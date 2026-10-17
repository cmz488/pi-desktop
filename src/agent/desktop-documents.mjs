import { defineDoc } from "@earendil-works/pi-durable";

// Native tool state belongs to the Durable conversation, including at a fork.
export const DesktopResources = defineDoc({
  kind: "desk.resources",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ entries: [] }),
});

import { serviceMain } from "./process.mjs";
import { defaultAgentRuntime } from "./agent-runtime.mjs";

serviceMain((options) => defaultAgentRuntime.start(options));

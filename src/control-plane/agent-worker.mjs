import { startDurableDesk } from "../server/durable-server.mjs";
import { serviceMain } from "./process.mjs";

serviceMain((options) =>
  startDurableDesk({
    ...options,
    singleAgent: true,
    host: "127.0.0.1",
    port: 0,
  }),
);

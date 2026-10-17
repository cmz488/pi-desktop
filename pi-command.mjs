#!/usr/bin/env node
import { deskMain } from "./desk.mjs";
deskMain().catch((error) => {
  process.stderr.write(`Pi Desk 启动失败：${error.message}\n`);
  process.exitCode = 1;
});

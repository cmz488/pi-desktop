> 历史验收记录：保留本版本的交付与验证证据，不代表未来版本行为。当前说明见 [文献入口](../README.md)。

# 0.26.13 · 折叠与滚动持久化恢复

## 交付

- 恢复客户端折叠阅读状态：展开的扩展卡片、思考／工具折叠栏按稳定 disclosure key 记录。
- 恢复折叠正文偏移：工具参数与长输出各自保存滚动位置，流式重绘后继续使用同一偏移。
- 恢复会话滚动位置：按 Agent session 记录 transcript 位置，切换或刷新后回到原阅读位置。
- 状态写入当前客户端的 `sessionStorage`（`pi-web-fold-state`），不进入 Pi 数据、SQLite 或服务端消息。
- `pagehide`、toggle、scroll 与重绘都会合并写入，避免刷新前丢失最后一次阅读操作；存储不可用时仅退化为内存状态。

## 验证

- `node test/conversation-timeline-browser-check.mjs`：真实页面刷新后重新展开折叠项，恢复折叠正文偏移与 transcript 滚动位置。
- `npm test` 与 `npm run format:check` 通过；浏览器回归继续覆盖流式重绘、折叠摘要和扩展卡片回退。

## 边界

这是用户明确要求的客户端阅读状态恢复，不改变 Pi 会话、消息、HTTP/SSE 或服务端持久化格式。

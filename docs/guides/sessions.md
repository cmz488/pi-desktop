# 项目与会话

左侧添加项目时使用系统文件夹选择器；会话按 Pi 的 cwd 归入项目，也支持无项目对话。选择另一个 Agent 会保留后台进程和各自草稿；聊天“停止”取消当前任务，右键“停止进程”关闭 Agent。

Pi TUI 与 Desktop 的活跃记录均使用 `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl`；兼容发现已有 `session/` 目录。Desktop 能查看 TUI 历史，在退出该文件的原 TUI writer 后选择“在 Desktop 中继续”。继续对话保持原 session ID，仍使用 Pi 的模型与工具运行链。

## 归档与恢复

归档先在 Desktop 数据目录的 `session-archives.sqlite` 保存完整 JSONL 树，成功后移除原 JSONL，使 Desktop 与 Pi TUI 都默认隐藏。归档查看只读 SQLite；恢复将原记录原子写回原目录和文件名，保持 session ID，遇到内容不同的已存在文件时拒绝覆盖。

运行中、启动中、停止中的 Desktop Agent 或被 Pi TUI 占用的会话不能归档，须先停止对应进程。Pi TUI 不遵守 Desktop 写锁；同一个 JSONL 不应同时由两个 writer 修改。外部更新后的接管沿用现有冲突检查。

历史发现只读索引，进入后加载有界消息页；工具与思考正文展开时再取，切换客户端不会停止其他 Agent。

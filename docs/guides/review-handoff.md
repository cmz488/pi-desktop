# 只读审查交接与工具契约

已提交范围交给只读审查者时，由父会话先制作并检查不可变产物。Git 命令是父会话的准备步骤，不是交接材料；审查者只需读文件，不增加 Shell 权限。本目标仍禁止启动子代理。

## 参数校验

`pi-subagents` 的安装包版本与实际工具 schema 是调用契约，旧技能示例不能覆盖它。当前核验版本为 **0.77.0**：

| 字段                      | 类型与含义                                         |
| ------------------------- | -------------------------------------------------- |
| `options.includeProgress` | boolean；是否在完整结果中附带 progress             |
| `options.chatProgress`    | `"auto"`／`"off"`／`"live-card"`；聊天进度展示策略 |
| `options.progress`        | 不存在；当前严格校验拒绝                           |

关闭上述两类进度的参数片段：

```json
{ "options": { "includeProgress": false, "chatProgress": "off" } }
```

`chatProgress:false` 也不合法。字段依据安装包的 `src/extension/schemas.js` 与 `subagent-options.js`，不是参考文档中的 `progress:false`。

## 交接步骤

1. **固定身份**：把基点与目标解析为完整 commit SHA，声明比较范围、规格／规范判据和不在范围内的内容；记录提交数。准备期间不让其他 writer 改变审查输入。
2. **准备产物**：父会话使用关闭外部 diff／textconv 的 `git diff --binary --full-index` 生成补丁，附变更路径与 manifest。上下文取同一基点／目标的源码快照；旧 HEAD 的审查不能读取已变化的当前工作树冒充旧源码。
3. **检查可读性**：交付绝对路径前，用只读文件操作读 manifest、完整补丁及所需上下文；核对字节数与 SHA-256。二进制补丁或超出单次读取上限时明确其类型并分段读取，不能只看截断开头。
4. **封存**：产物与源码快照设为只读，manifest 的摘要作为身份。任何重生成或内容变化都是新交接，重新核对；审查期间不覆盖旧产物。
5. **交付**：给出 manifest／patch／base／head 快照绝对路径、准确范围与判据。先确认能读到这些文件再开始结论；缺少任何输入时由父会话补齐，不要求审查者自行执行 Git。

最小 manifest：

```json
{
  "version": 1,
  "kind": "committed-range",
  "base": "完整的基点 commit SHA",
  "head": "完整的目标 commit SHA",
  "commitCount": 10,
  "patch": "changes.patch",
  "sha256": "补丁的 SHA-256",
  "bytes": 158215
}
```

父会话准备源码快照时检查符号链接／路径边界，避免只读工具沿链接读取产物外部内容。摘要验证失败、文件不可读或输入身份变化，都表示交接无效，不得据此声称已审查。`watchdog_diff` 不提供 committed range；“仅给 Git 命令”仍是不完整交接。

## 不启动子代理的核验

在仓库根运行 `test/toolchain-contract-check.mjs`，显式提供已安装扩展目录与宿主 package.json：

```bash
PI_SUBAGENTS_ROOT=/absolute/path/to/pi-subagents \
PI_TOOL_HOST_PACKAGE=/absolute/path/to/host/package.json \
node test/toolchain-contract-check.mjs
```

该脚本只调用纯参数校验／历史解析函数、准备本次 10 个提交的只读产物并验证可读性与篡改拒绝；不调用子代理工具、执行器或主管通道。扩展的 peer dependencies 从显式宿主解析，不安装依赖或修改安装包。临时文件位置会打印，真实用户配置与会话不参与。

E3 的条件模型仅说明：没有其他 async／nested 定位记录时，detached 前台记录可在内存中查询，但不进入可恢复历史；新状态因此可能查不到。它不能证明历史事件确有 reload，也不能证明任务停止。遇到实际 detached／status／reply 不一致，保留原始回执、父会话身份、时间线和生命周期日志，再按权限调查；本次实际调查与阻塞见[修复记录](../history/pi-audit-remediation.md)。

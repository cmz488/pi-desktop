# 模型目录与认证读取契约

## 位置与职责

`src/agent/durable-models.mjs` 为 Pi AI 公开 models 注册表绑定 Desktop／继承配置与凭据存储；不实现认证协议或模型循环。目录读模型复用一次操作内的文件视图，真正请求仍由原注册表认证。`agent-workspace.mjs` 可注入目录读取函数，默认调用方式保持兼容。

## 签名

```js
openDurableModels({ agentDir, directory }); // async -> facade
// facade.models：原 Pi AI 注册表，不替换其 getAuth／请求行为。
facade.availableModels(); // async -> 原生可用模型数组，仅目录读取共享本次凭据文件视图
facade.desktopInventory(); // async -> {revision,rows,catalog}，不返回凭据
facade.inventory(); // async -> 非敏感配置
facade.save(input); facade.remove(input); // 配置 revision 校验不变
facade.reload({network=false}?); facade.refresh();
facade.resourceOptions(); // 既有 SDK credentials／modelsStore／modelsPath／refreshOnCreate

openAgentWorkspace({ models, availableModels?, ...options });
// availableModels?: () => Promise<Model[]>，只用于 read() 的目录投影。
// 未提供时仍 models.getAvailable()；Harness 与实际模型调用始终使用原 models。
```

## 不变量

- 每次目录操作开始时，各读一次继承与 Desktop 认证文件；同次 SDK 可用性检查和目录行共用该视图。Desktop 的显式 null 仍遮盖继承凭据，不因无值而回退。
- 视图只在该异步操作尚未结束时生效，完成或失败时立即释放；由该操作创建但稍后才执行的异步后代也不能延长有效期。不按 TTL 缓存，不跨目录操作或 worker 共享，不存储于浏览器。
- 作用域外的 `models.getAuth` 与实际请求每次重新取值。目录尚在等待时，并发认证也不能借用目录视图。
- `credentials.modify` 在明确退出目录视图的作用域内串行读当前值、变更并按 revision 落盘；删除与配置写路径不采用旧视图。OAuth 刷新、注销覆盖与认证失败语义不降低。
- 权限、TLS、沙箱、请求目标／generation、路径隔离和单 writer 不改变；返回的模型列表与原生可用性规则不改变。没有删除目录的认证检查，只合并其重复文件读取。

## 顺序约束

1. 每次目录调用重新读取两个文件 → 合并所有权覆盖 → 在局部视图中调用原 SDK 目录能力 → 投影非敏感目录 → 退出作用域。
2. 并发真实认证不进入上述作用域；凭据修改先退出局部视图，再走原串行写队列。
3. 调用方未提供 `availableModels` 时使用原路径；提供者自身仍保留 `models` 对象供 Harness／SDK 请求使用。

## 错误模式

- 文件或原 SDK 读取失败向调用方传播，不用空目录冒充成功，不回退到旧凭据快照。
- 配置冲突仍返回 409；端点、凭据表达式和敏感字段裁剪沿用既有规则。
- 本次目录读取不是认证承诺；调用模型时依旧可能因新的注销或凭据变化而失败。

## 性能特征

- 单次目录读取的认证文件 I/O 从按提供商重复变为固定两次。操作结束后不由本适配持有合并对象，不增加常驻目录缓存。
- 原生认证解析和可用模型过滤仍执行；只减少反复文件读取、解析与对应短命分配。
- 真实采样及三轮同拓扑测量见 [性能记录](../../references/session-redesign-performance.md)，不把一次采样或 GC 后值当作自然稳态的全部结果。

## 可执行证据

- `test/durable-models.test.mjs`：读取实际临时文件，计数钩子透传原 fs 实现。目录读取由 253 次减少为 2 次；验证列表内容、下一次枚举的注销覆盖、实际原生认证读取新值、目录等待时的并发认证，目录回调中的凭据修改仍取当前值，以及枚举结束后的真实 SDK resolver 异步后代也重新认证。
- `test/desktop-profile-check.mjs`／`performance-profile-fixture.mjs`：通过已注册工具和真实模型回合做进程内 CPU／分配采样，无调试端口、不装入生产配置。
- `test/desktop-performance-check.mjs`：固定双 worker、60 轮与 87 个实际 provider 请求，保留前后各三轮的原始数据；不是减少工作量后的对比。

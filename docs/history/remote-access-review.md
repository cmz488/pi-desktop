> 历史验收记录：保留原始结论与环境信息，不代表当前版本全部行为。当前说明见 [文献入口](../README.md)。

# 0.15.0 · Tailscale Funnel 手机扫码连接

## 2026-10-16：已连接但手机页面空白

Pi Desktop 0.26.6 的本机工作区、静态资源和 Agent 状态均正常；真实 Chromium 手机视口能完成配对并显示输入框。该路径通过 MagicDNS 解析到主机的 Tailscale 内网地址，不能作为未安装 Tailscale 的手机公网验收。强制使用公共 DNS 返回的地址后，HTTPS 建连超时；临时独立 443 Funnel 也未通过，因此没有把换端口作为修复。

系统 tailscaled 反复记录新加坡中继连接超时。保持直连和严格 TLS 校验，对多个官方中继进行 HTTPS 实测：新加坡、东京的抽样节点均在 5 秒内未连通，旧金山 `derp2d` 返回 200 约 634 ms，其他可达区域更慢。使用本机 CLI `tailscale debug force-prefer-derp 2` 临时偏好旧金山；随后日志确认 `derp-2 connected`，中继断连告警消失。没有使用代理、重置信任、修改证书校验或重启 Desktop／Agent，原扫码授权继续保留。该 debug 偏好只作用于本次 daemon 运行，重启会复位，不应当作适用于所有网络的固定区域配置。

用户在未连接 Tailscale 的手机浏览器上刷新后明确确认“页面已正常加载”。手机端确认是本次公网恢复的依据；电脑自身到公网 Funnel 地址的探针仍未连通，不能用内网测通替代或声称所有公网路由都已恢复。临时 443 Funnel 和浏览器诊断均已清理。原有 30 项远程／连接测试及手机扫码浏览器回归通过；没有部署未经实网证明的 DNS／端口改动。

## 2026-10-13：扫码中途切换浏览器模式

隔离 HTTP 复现：手机已有有效 Cookie，但重新访问 `/_pi/scan?agent=7` 仍返回配对 HTML；链接 fragment 在 POST 成功之前已清除，因此桌面／手机预览切换并重载会丢失正在兑换的二维码凭据，页面误报需要重新扫描。二维码并没有因扫描而被消费或自动轮换。

修复：登录成功后才跳转并移除 fragment；未成功时原链接可继续重载，不新增浏览器持久化密钥。扫码页识别有效 Cookie，以 303 回到所选 Agent；同一 Cookie 再次兑换不会产生新设备授权。关闭共享、主动旋转二维码、Host 重启及连接故障仍撤销旧凭据，Cookie 仍是 HttpOnly／Secure／SameSite=Strict，12 小时期限与严格 TLS 校验保持原设置。

新增 HTTP 回归先得到 200 而非期望的 303，修复后通过。手机 Chromium 夹具延迟配对 2.5 秒，并在 POST 未完成时改变 User-Agent／视口后重载；另验证配对成功后再次切换模式、无 fragment 访问扫码页、原二维码重复扫描及设备计数仍为 1。完整 196 项测试、两套远程浏览器与原生 Pi/TUI、源码／格式检查通过。旧单宿主浏览器验收同时更新为 0.26.0 的 Brotli／按需资源协议，并保留清单等待不阻塞聊天的断言。

部署复核：原 Host 已更新至 0.26.1，重新启用原扫码入口。严格 TLS 的真实公网配对返回 200，有效 Cookie 重载扫码页返回 303 并保留所选 Agent，重复配对返回 200 且不重新签发 Cookie，授权读取 200；重复 prepare/start 的二维码保持不变。一次公网 TLS 建连遇到临时 ECONNRESET，有界重试后通过，没有更改证书验证或信任。

## 2026-10-12：恢复真实中继 TLS 与公网扫码

重新执行真实 `createTailscaleFunnel().prepare()`，首先稳定复现 TLS Health 拦截失败。分开比较直连与本机 HTTP CONNECT 代理：`derp3g`／`derp3h` 的直连超时，但现有 `127.0.0.1:7897` 代理上的 HTTPS 严格校验成功；控制面 HTTPS 两条路径均正常。系统 tailscaled 未配置代理，仍记录 `Web secure CA` 替换证书。这次证据与 10 月 5 日不同，不能沿用上次代理不可用的结论。

用户在自己的终端执行 [configure-tailscale-proxy.sh](../../scripts/configure-tailscale-proxy.sh)，管理员密码未交给 Agent。脚本先严格验证中继／控制面，只接受现有本机 HTTP 代理，然后安装独立 systemd drop-in 并短暂重启 tailscaled；没有重置节点身份、Serve 配置或 tailnet 权限。重新执行原始复现得到 `BackendState=Running`、`Health=[]`，日志显示中继连接建立。没有添加拦截 CA，也没有关闭证书校验。

Desktop 的公网 HTTPS 检查原来忽略代理环境。`tailscale-network.mjs` 复用锁定版本 `https-proxy-agent` 和 `proxy-from-env`，按 `HTTPS_PROXY`／`https_proxy`／`NO_PROXY` 等环境配置发送 CONNECT；仅作用于公网检查，不修改回环代理、模型全局 dispatcher 或系统代理。代理与目标 TLS 都显式启用证书验证；即使父进程误设 `NODE_TLS_REJECT_UNAUTHORIZED=0`，仍拒绝测试拦截证书。请求结束、超时和取消会终止正在等待 CONNECT 的 socket。

真实 Funnel 开启后，公共 DNS 起初为 NXDOMAIN，旧的三次检查会过早关闭隧道。现在仅对 DNS／网络暂时失败重试，整体最多 10 分钟，每次请求最多 10 秒，等待可取消；证书异常、错误网关实例和异常内容立即失败。等待期间不发布扫码密钥或二维码。该上限依据 [Tailscale 官方 DNS 传播说明](https://tailscale.com/docs/features/tailscale-funnel#dns-propagation)。实际保持同一前台隧道后，公网入口通过了严格 HTTPS 检查，Desktop 显示共享已开启。

实际解码了当前二维码，通过公网 `/_pi/connect` 兑换 HttpOnly／Secure／SameSite=Strict Cookie，并验证：健康检查 200、未授权工作区读取 401、授权工作区读取 200（两个 Agent）、页面与 Agent 状态读取 200；远程客户端无法取得二维码／发布密钥。没有发送真实模型消息，也没有把扫码密钥、Cookie 或会话内容写入日志。

用户随后确认手机能打开公网页面，但会话输入区域未加载且网络慢。真实关键资源检查均为 200，iframe CSP 允许同源嵌入，gzip 已生效；请求常见约 2.5 秒，个别约 10 秒。使用 2.7 秒延迟的浏览器夹具进一步复现轮询重叠（工作区峰值 2）。工作区周期轮询现在跳过已有请求，交互轮询共用当前请求。手机回归增加可见／启用的输入框检查，并验证慢网络下两类轮询峰值均为 1、仍可发送本机模型夹具消息和切换会话。用户刷新原手机页面后已确认“输入框和会话已正常出现”，不需重新扫码。未要求发送真实模型测试消息；实际网络延迟与吞吐仍取决于手机、代理和 Funnel 中继路径。

最终全量测试 169 项通过，静态检查、手机慢网扫码回归、共用浏览器、工作区浏览器、Electron、原生 Pi/TUI 与附加 Desktop 回归通过。并行高负载下曾出现原生 MCP 发现超时，单独重跑全量通过；Electron 检查发现 CDP resize 先返回、iframe resize handler 后执行的测试竞态，改为等待实际布局与按钮状态一致再切换面板，没有放宽布局断言。

回归包括 `test/tailscale-network.test.mjs` 的真实本机 HTTPS／CONNECT 握手、拦截证书拒绝、NO_PROXY 与卡住连接取消；`test/remote-access.test.mjs` 的多次 DNS 失败后恢复／取消，以及 `test:remote:desktop` 的慢网络、可见输入框、扫码与多 Agent 行为。所有临时证书只在隔离测试进程使用，不修改系统信任。

Linux Tailscale 直连诊断与修复：

```bash
bash scripts/configure-tailscale-proxy.sh --check
bash scripts/configure-tailscale-proxy.sh
```

第二条由用户在自己的终端完成管理员授权。该脚本只为 tailscaled 清除代理环境变量，不更改其他系统流量、节点身份或 Serve/Funnel 规则。撤销时只删除脚本管理的 `/etc/systemd/system/tailscaled.service.d/50-pi-desktop-proxy.conf`，再执行 `systemctl daemon-reload` 与重启 tailscaled，不能删除其他 drop-in 或执行 Funnel reset。该脚本不会添加 CA 或关闭证书校验。

## 2026-10-15：Tailscale 直连

用户要求 Tailscale 不走系统代理。`configure-tailscale-proxy.sh` 现在预检直连控制面和最近 DERP 区域后，用 systemd `UnsetEnvironment` 清除 tailscaled 的大／小写 HTTP、HTTPS、ALL proxy 变量；不改变节点身份或 Serve/Funnel 配置。真实主机验证为 `BackendState=Running`、`Self.Online=true`、`Health=[]`，并已连上 Singapore DERP。`tailscale-network.mjs` 对 `*.ts.net` Funnel 公网探测也强制直连，证书校验保持开启。

Funnel 入口仍未发布：直连 DNS 查询持续返回 `ENOTFOUND`，10 分钟公网检查后 Desktop 正确停止发布二维码并显示 DNS 错误。Tailscale 官方 Funnel 要求 tailnet 启用 MagicDNS、HTTPS 证书并允许 Funnel 节点属性，见 [Funnel requirements](https://tailscale.com/docs/features/tailscale-funnel) 与 [Enabling HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates)。后续排查应确认 tailnet DNS／HTTPS 设置及该机器的 Funnel 公网域名是否已发布。

## 2026-10-15：无代理连通性与速度复测

Pi Desktop 启动的 Tailscale CLI、用户态守护进程和 Funnel 子进程现在都会清除大小写形式的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`；测试确认其它环境变量保留。系统 tailscaled 原有 systemd `UnsetEnvironment` 继续生效。严格 TLS 的直连请求到控制面和 `derp3g.tailscale.com` 均返回 HTTP 200；一次 5 MB Cloudflare 下载为 7.83 秒（约 0.61 MiB/s），第二次在 20 秒超时内仅收到 2.22 MB（约 0.11 MiB/s），说明当前普通公网吞吐明显波动。该下载只衡量主机到 Cloudflare 的公网链路，不代表 Tailscale peer 或手机实际吞吐。

无代理 `tailscale netcheck` 显示 UDP、IPv4、IPv6 均可用，最近 DERP 为 Singapore（约 128 ms），Tokyo 约 146 ms、Los Angeles 约 189 ms；`MappingVariesByDestIP=true` 表明 NAT 映射因目标地址变化，不能保证手机与电脑之间能建立直连。当前 tailnet 没有在线的其它 peer（`lckfb` 是 Linux 节点，离线 42 天），因此没有真实手机 peer 可用于测量 Tailscale 直连吞吐。电脑端配置的 `127.0.0.1:7897` 代理端口本次测试连接超时，控制面和 DERP 的代理路径均不可用；当前保留无代理直连。

手机只通过普通浏览器打开二维码时，连接使用 Tailscale Funnel 公网入口；Funnel 由 Tailscale 的 TCP proxy 和 relay servers 转发，不能作为手机到电脑的 Tailscale peer-to-peer 直连。若要求手机与电脑在 tailnet 内直连，手机需要安装并登录 Tailscale；随后应以 `tailscale ping`／`tailscale status` 确认显示 `direct`，实际吞吐也需要在手机 peer 在线时测量。浏览器扫码模式仍需 Funnel；同一局域网的浏览器可另走局域网地址。

选择 Tailscale Funnel 单一路径，复用原连接页面、聊天、Agent 管理和 SSE。开启后手机通过公网 HTTPS 扫码进入，不要求手机安装客户端。Cloudflare 没有实现为另一种选项。

电脑首次需安装并登录 Tailscale，以及 HTTPS／Funnel 权限；页面会显示初次设置入口、CLI 返回的授权链接或具体启动失败原因。最初交付时，本机守护进程未运行，验收仅使用本地夹具；当时没有启用系统服务或更改 tailnet 策略。2026-10-05 的实际运行故障与公网检查记录见下节。

## 2026-10-05：实际扫码页面打不开

实际检查了正在运行的 Durable Desktop 与 TUI 附加模式。两个回环扫码网关均返回 HTTP 200，前台 Serve 配置也指向正确端口；公网扫码入口连续两次在 TLS 阶段失败，Node 报 `ECONNRESET`，curl 报 `unexpected eof while reading`。临时、带授权的独立网关改用空闲 443 端口仍失败，检查结束后已关闭；没有重置其他 Funnel。

`tailscale status --json` 的 Health 和 tailscaled 日志反复记录：中继 `derp3g`／`derp3h` 的加密连接被拦截，证书被替换为 `Web secure CA`。电脑直连和现有本机代理的探针都未建立正常中继 TLS；因此不能断言仅设置代理环境变量就能解决。实际公网目前仍未恢复，需修复电脑网络／代理的 Tailscale HTTPS 路径，或换到可正常访问的网络；没有关闭证书校验、修改系统信任或系统代理。

应用曾只检查 BackendState=Running 和 CLI 的 Available 输出，错误显示“共享已开启”。修复后，启动先检测相关 TLS Health；CLI 配置完成后进入 `checking`，通过严格 HTTPS 请求读取 `/_pi/health`，核对当前网关的随机实例值。响应最多 1 KiB、每次最多 10 秒、最多三次尝试，取消可中断。成功才提供二维码；失败关闭本次子进程与网关，保留可重试的网络诊断。每 30 秒检查已启动子进程的 daemon Health，发现证书拦截则撤销手机授权与流并关闭共享。`/_pi/health` 只返回非授权用的随机实例值，不开放 Agent 数据或操作。

新增失败回归先复现假就绪，随后验证等待／失败不生成二维码、错误网关实例不通过、取消验证、运行后 Health 恶化的撤销，以及浏览器显示失败／验证状态后重新开启并完成真实 TLS 夹具握手。在当前电脑使用新 Module 的独立诊断已确认：phase=error、显示 TLS 拦截原因、scanUrl 不存在。此结果是故障检测生效，不是公网已经恢复。

本轮 `npm test` 141 项、`test:remote` 12 项、`test:remote:browser`、`check`、`format:check` 和 `git diff --check` 均通过。浏览器验收覆盖先显示连接失败、验证期间隐藏二维码，再重新开启并扫码成功。

Tailscale 中继依赖正常 HTTPS 连接，依据 [官方网络要求](https://tailscale.com/docs/reference/faq/firewall-ports)；系统 daemon 独立于 shell 的环境配置，依据 [tailscaled 文档](https://tailscale.com/docs/reference/tailscaled)。保留 Tailscale Funnel 单一路径，没有加入第二种隧道。

## 原交付验证

- `npm test`：129 项通过，包含 5 项远程连接回归、2 项扩展依赖回归、连续流式刷新与 gzip 结束回归。
- `test:remote`：二维码 PNG 解码、无授权读写拒绝、自动 Cookie 兑换、同源写入、恶意 Host／Origin、控制仅限本机、真实 HTTP／SSE gzip 转发、即时逐帧解压、编码拒绝协商、撤销旧密钥和流、关闭与重新开启、等待授权时取消及异常子进程退出。
- CLI Adapter 实际运行临时可执行文件，核对仅使用前台 `funnel --yes`、避开已占用端口、授权链接、进程退出和缺少 CLI 的提示。
- `test:remote:browser`：Chromium 通过本地 TLS 代理扫码进入，自动兑换 Secure Cookie、移除连接密钥、选择目标 Agent、320／360／390px 布局、真实 Durable／Pi AI 本地 faux 流式回答、页面刷新恢复、限速网络离线再连接与草稿保留、浏览器自动解压会话 JSON、手机无法管理发布、旋转二维码重新进入以及停止共享后原宿主继续可用。
- 原 `test:browser`、`test:durable:browser`、`test:durable:desktop` 和静态／格式检查回归。

浏览器夹具仅对临时自签名测试证书使用忽略证书检查和本机 DNS 映射；生产网关没有关闭 TLS 校验，也不使用测试 DNS。外部 Tailscale 在夹具中替换为本地 TLS 代理，不表示公网已经开通。未调用真实付费模型。

本轮先用失败回归确认宿主包被错误声明为运行依赖、会话响应缺少 gzip、连续更新反复推迟页面刷新。宿主包已改为星号 peer，独立 Desktop 固定 SDK 放在开发依赖中，并同步实际安装的 coding SDK 至锁定的 1.0.0；原生 Pi ResourceLoader 实测加载该包且不再产生宿主包重复运行时警告。会话压缩集中在 `http-transfer.mjs`，SSE 每帧刷新，编码器队列计入背压，宿主正常关闭先发送 gzip 尾部再关闭 socket。长会话重复文本通过授权网关约 204,527 B → 1,724 B；不代表真实手机公网测速。

## 依据与边界

CLI 语义依据 [Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel) 和 [Funnel 使用条件](https://tailscale.com/docs/features/tailscale-funnel)。前台会话的临时配置依据上游 [serve_v2.go](https://github.com/tailscale/tailscale/blob/main/cmd/tailscale/cli/serve_v2.go)；TCP HTTP 代理保留客户端 Host 的行为依据 [serve.go](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go)。没有复制上游实现。首次公网 DNS 可能延迟；现在就绪还要求电脑的 HTTPS 探针得到当前网关的实例值；本机探针仍不能替代蜂窝网络端到端验证，特别是本机使用 MagicDNS 时。

共享默认关闭；二维码密钥只存在当前进程和电脑连接页面，手机会话只存在网关内存。关闭或重开共享后需重新扫码，旧二维码不会恢复。授权手机具备操作此 Pi 工作区的能力，设置写入、Git 确认及 Agent 运行冲突仍遵守原模块规则。原局域网兼容入口的访问语义保持不变。

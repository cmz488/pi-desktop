# 手机远程连接

设置中的“远程连接”管理现有 Tailscale 入口；完成电脑登录、HTTPS／Funnel 授权后生成二维码，手机浏览器扫码访问同一工作空间。二维码发布前进行严格公网 HTTPS 校验，不关闭证书校验。

当前 Tailscale 守护进程、CLI 与 Funnel 探测采用直连策略；普通 Pi 模型代理设置独立生效。诊断脚本 `scripts/configure-tailscale-proxy.sh --check` 只读检查直连，实际系统服务配置仍需要系统授权。脚本见 [源码](../../scripts/configure-tailscale-proxy.sh)。

导航只传项目／会话索引；聊天默认读取近期消息，思考与工具正文按展开加载。右侧文件栏只列当前目录，点开文件才由 Host 返回预览。JSON 和静态资源协商 Brotli／gzip，未变 GET 使用 ETag，私有响应仅暂存于页面有界内存。断线按事件游标重连；授权失效提示重新扫码，不无限重试。

浏览器自动化画面只在本地提供，手机远程不会传输浏览器画面。实网速度受路由和 Tailscale 中继影响，本地夹具通过不代表所有公网网络已验证。

远程添加上下文文件时上传手机上的文件；本地连接使用主机文件索引。两者由后端区分，远程不能通过伪造文件索引读取主机路径或触发主机选择器。详见 [文件上下文](configuration.md#文件上下文)。

实网检查、先前证书与代理排查保存在 [历史连接验收](../history/remote-access-review.md)和[传输测量](../history/performance-check.md)，其中环境与日期不可泛化为当前连接保证。

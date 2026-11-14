# 0.6.3 自动获取官网会话设备上下文

## 原因与修复范围

0.5.1–0.6.2 的自动获取依赖本机豆包客户端的默认 `Local State` 文件。浏览器登录只保存 Cookie，调用时统一使用桌面客户端的应用 ID、平台和版本参数。用户没有安装客户端、资料位于自定义目录或把仅含 Cookie 的旧账号迁入服务器时，设备号仍会缺失。0.6.2 修复了本地验证状态的持续拦截，并增加设备存在性诊断，自动获取路径的这处缺口仍然存在。

截图中的 `710022004` 来自上游，`缺少设备上下文` 来自插件检查实际发送会话的结果。此前声称自动获取已覆盖所有设备，覆盖范围有误。

0.6.3 同步更新独立网关和 Magpie 插件，使用同一个会话准备入口完成上下文获取。

## 会话与请求流程

1. 浏览器登录记录实际 User-Agent 和 Chromium 版本，并标记为 Web 会话。
2. 使用该账号 Cookie 请求官网 `/chat/`，解析初始化数据中的 `launchCore.web_id`、应用 ID 和客户端版本。官网签发的 `ttwid` 同步保存，浏览器指纹使用该会话 Cookie 中的 `s_v_web_id` 或 `fp`。
3. 模型、聊天、额度和签到使用同一套 Web 请求参数，包括官网 Web ID、应用 ID、版本及 `web_platform=browser`。
4. 旧账号已有完整桌面设备信息时继续使用该上下文。缺少设备信息且本机默认客户端文件不可用时，首次实际使用自动取得官网 Web 上下文并持久保存。
5. v2/v3 备份完整保留 `clientProfile`、`deviceId`、`webId`、`appId`、版本、浏览器元数据和 Cookie。目标设备直接使用保存的会话上下文。

官网会话初始化结果按账号和 User-Agent 共享短期缓存，同时到达的模型查询和登录加载共用一次网络读取。失败的初始化可以在后续正常操作中重新执行，取消一个等待者会释放该等待而保留其他正在使用的查询。持久账号只保存所需上下文。

Web ID、应用 ID和版本取自官网返回值。设备信息随各用户自己的会话获取和迁移。

## 更新与使用

Magpie 更新本插件后，旧的缺失上下文账号在正常加载时自动补齐。新登录通过专用浏览器完成，并保存完整 Web 会话。若既有完整桌面会话持续收到上游验证要求，可重新浏览器登录取得当前官网会话。

网关更换为 0.6.3 后正常启动。旧 Cookie 账号在聊天、额度或签到操作前准备并保存上下文。仅含 Cookie 的旧备份可直接导入和核验，服务器通过官网初始化取得上下文。备份会话失效时需要重新登录。

上游明确要求人工验证时，仍由账号持有人在官网完成验证。随后重新测试模型或发送新请求，完整成功后清除旧验证状态。

## 验证记录

2026-11-14，使用真实账号、DeepSeek V4.1 Flash，禁用测试路径中的全部本机客户端设备读取。输入仅保留网页登录 Cookie，显式选择 Web 会话。

| 入口 | 结果 | 官网初始化 | 本机客户端设备读取 |
| --- | --- | --- | --- |
| Magpie 插件导入与正常 loader / fetch | HTTP 200，完整 `OK`，`stop`，旧状态恢复 ready | 1 次 | 0 次 |
| Windows 网关导出、空白目录导入核验、重启后正常 HTTP SSE | HTTP 200，文本及 `[DONE]` | 源环境 1 次，目标 0 次 | 0 次 |
| Windows Web 会话迁入隔离 WSL Ubuntu，网关正常 HTTP | HTTP 200，完整 `OK` | 目标 0 次 | 0 次 |
| 隔离 Ubuntu 中真实 Magpie Bun 1.4.4 宿主导入与 SSE | HTTP 200，完整 `OK` 及 `[DONE]`，保存的上下文一致 | 目标 0 次 | 使用独立 HOME / XDG |

Windows 上的真实 Magpie Bun 1.4.4 宿主通过 Web 账号导入、上下文保存、聊天和重启联调，并覆盖已有模型名称、短答、工具回合、额度、签到与账号隔离。

回归测试覆盖官网数据解析、初始化 Cookie、各账号独立上下文、并发共享、取消、失败后重试、Web/桌面目录缓存、旧账号持久化、登录代次保护、v2/v3 备份及网关 HTTP 迁移。本地全量基线和受影响模块补验通过。当前插件 73 项、网关 121 项回归在 Windows / Ubuntu / macOS × Node.js 22 / 24 共 12 个 CI 任务全部通过。[插件 CI](https://github.com/3294798852/magpie-doubao-work/actions/runs/43562430545) · [网关 CI](https://github.com/3294798852/doubao-work-gateway/actions/runs/43562453867)

本机已通过 GitHub 定向安装 0.6.3。已安装包通过真实 Bun 宿主的 Web 会话聊天和重启联调，正在运行的 Magpie 正常 HTTP 入口返回 200、完整 `OK` 与 `stop`。

Ubuntu 位于同一物理电脑的 WSL 环境。该环境 DNS 返回 `EAI_AGAIN`，验收进程使用临时 HTTP CONNECT 代理，经 Windows 进程解析 DNS，TLS 证书仍由实际请求端校验。Windows 命令行测试使用独立进程 DNS 解析。两项网络配置仅用于本轮验收工具。

远程反馈账号的完整会话和原始报文未取得，该账号的发布后复测结果待用户反馈。其他实体设备、不同网络出口和 macOS 真实账号尚待实际验证。

## English

Earlier releases discovered device metadata only in the native client's default profile files and used a desktop request profile for cookie-only browser sessions. Version 0.6.3 captures browser metadata, obtains the website-issued Web ID, application ID and client version from the signed-in page bootstrap, and preserves the issued `ttwid` cookie. All API operations use the corresponding browser profile. Existing cookie-only accounts acquire and persist this context during normal use when native metadata is absent. Complete native sessions retain their saved context.

Both backup formats preserve the full session profile for another computer or a headless server. Live plugin and native-gateway checks passed with native-device lookup disabled, including import, restart, text completion and SSE termination. Migration to an isolated WSL Ubuntu home also passed for the gateway and the real Magpie Bun host. That environment used a temporary CONNECT proxy to resolve its DNS failure. A remote user's original account capture remains unavailable. The account holder completes any verification explicitly requested by Doubao.

官网初始化字段和浏览器参数来自本轮实际获取的官网页面及第一方脚本。[豆包官网](https://www.doubao.com/chat/) · [本轮浏览器参数脚本](https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/chat/static/js/chat.e5816045e5.js)

# 0.6.4 浏览器登录启动排查与修复

## 已确认的问题

原远端反馈仅提供了“浏览器启动失败，请检查 Chrome / Edge 安装”的截图，推测系统为 Windows 11，Magpie 较新。其浏览器版本、Bun 版本、启动耗时、退出码和启动日志尚未取得，原设备的具体原因继续列为待定位。

0.6.3 在创建浏览器进程后，通过扩展标准管道 fd 3/4 发送 `Browser.getVersion`。进程执行失败、进程早退和 7 秒握手超时均被改写为同一条错误，stderr 被丢弃，随后关闭专用浏览器。

2026-11-27，在同一台 Windows 电脑、同一 Chrome 158 上对照运行，确认旧 Bun 的扩展管道写入问题可以触发完全相同的错误。

| 运行时 | 0.6.3 启动路径 | 0.6.4 插件登录入口 |
| --- | --- | --- |
| Node.js 24.18.0 | Chrome 正常 | Chrome、Edge 启动、等待登录、取消和清理通过 |
| Bun 1.3.14 | Chrome 握手失败，返回截图中的原错误 | Chrome、Edge 完整启动和取消流程通过 |
| Bun 1.4.4 | Chrome 正常 | 沿用已确认的旧版正常对照结果 |
| Bun 1.4.5 | Chrome 正常 | Chrome、Edge 完整启动和取消流程通过 |

上游记录说明，旧 Bun 在 Windows 上采用扩展管道时，连接状态会让父进程写入停留在缓冲区，浏览器收不到初始化命令。该缺陷于 Bun 1.4.0 修复。本次实际复现与该机制一致。[Bun 上游问题和修复记录](https://github.com/oven-sh/bun/issues/27977)

## 统一启动流程

1. 创建当前用户私有的临时浏览器资料目录。
2. 启动 Chrome / Edge，由浏览器分配临时调试端口，地址使用 `127.0.0.1`。
3. 在 30 秒启动窗口内等待专用资料目录中的 `DevToolsActivePort` 完整写入，从中读取端口和浏览器连接路径。
4. 通过运行时原生 WebSocket 建立 CDP 连接，取得浏览器元数据，再进入既有 Cookie 检测和账号接入流程。
5. 取消时中止启动等待，关闭本次浏览器并清理资料目录。诊断写入期间取消也保留用户的取消状态。

登录控制连接采用独立的本机直连通道。对照发现，Node 开启 `NODE_USE_ENV_PROXY` 且 `NO_PROXY` 为空时，全局代理会使默认 WebSocket 连接失败；显式的本机 HTTP 升级连接修复了该路径。真实浏览器 CI 使用不可用代理验证这项行为。

两版使用相同实现。进程退出会关闭待处理通信请求。正常登录完成后关闭专用浏览器，临时端口随浏览器退出释放。临时资料目录和诊断文件沿用项目已有的私有权限处理。

## 获取现场诊断

失败信息包含错误码、阶段、系统、运行时、耗时和已取得的退出码。诊断 JSON 保存相同信息及有限长度的启动日志，路径和 URL 经脱敏处理。每个入口保留最近一份记录，原子替换旧文件。

- Magpie 插件保存到 `~/.cache/doubao-work/magpie-browser-startup.json`。
- 独立网关保存到运行目录的 `browser-tmp/browser-startup-error.json`。

| 错误码 | 定位方向 |
| --- | --- |
| `DW_BROWSER_NOT_FOUND` | 浏览器发现或选择失败 |
| `DW_BROWSER_EXECUTABLE_MISSING` | 发现后程序已移除 |
| `DW_BROWSER_EXECUTABLE_DENIED` | 系统拒绝执行浏览器 |
| `DW_BROWSER_POLICY` | 浏览器管理策略禁止调试通信 |
| `DW_BROWSER_DISPLAY` | 图形桌面连接失败 |
| `DW_BROWSER_SANDBOX` | 浏览器沙箱组件的安装或权限异常 |
| `DW_BROWSER_EXITED` | 浏览器在初始化完成前退出，检查退出码和启动日志 |
| `DW_BROWSER_ENDPOINT_TIMEOUT` / `DW_BROWSER_ENDPOINT_INVALID` | 调试端点未及时生成或格式有误 |
| `DW_BROWSER_PROFILE_ACCESS` | 临时资料目录读取失败 |
| `DW_BROWSER_CONNECT_TIMEOUT` / `DW_BROWSER_PROTOCOL_TIMEOUT` / `DW_BROWSER_DISCONNECTED` | 连接或协议握手失败 |
| `DW_BROWSER_CLOSE_TIMEOUT` | 关闭等待超时，资料目录保留以继续排查 |
| `DW_BROWSER_PROFILE_CLEANUP` | 浏览器退出后的资料目录删除失败，检查文件系统错误码 |

远端用户更新后，再次失败时提供错误码和诊断中的运行时、阶段、退出码及启动日志，即可区分当前候选原因。管理策略类错误需要设备管理员确认相应策略。

## 验收与待查事项

新增回归覆盖端点部分写入、外部地址拒绝、执行权限、提前退出、管理策略、启动取消、错误私有保存、旧记录替换、删除重试及取消并发。现有完整回归基线和后续受影响模块补验通过。当前测试总数为插件 84 项、网关 132 项。

真实浏览器验收通过 `magpie/login.mjs` 的 `browserSignIn` 入口，使用空白页验证启动、元数据、等待、取消和资料清理。Node.js 24.18.0、Bun 1.3.14 / 1.4.5 均通过 Chrome 与 Edge 的六组对照。本轮浏览器测试使用临时会话，账号持有人的扫码或手机登录完成情况仍需现场确认。

新增 CI 的启动日志定位到 Ubuntu 预装 Edge 的 SUID 沙箱文件权限错误，浏览器因此以 `SIGABRT` 退出。CI 在浏览器测试前恢复该安装要求的 root 属主和 4755 权限，并在专用 D-Bus 会话中运行 Linux 浏览器测试。这些步骤作用于 GitHub 临时运行器。

一次初始并行测试中，Edge 出现关闭等待超时。后续逐进程跟踪正常退出；Windows CI 进一步捕获了 Bun 1.3.14 / 1.4.5 删除临时资料时的 `EBUSY`，并确认传入原生重试选项仍立即失败。两版现使用统一删除重试处理可恢复的文件系统错误，最多五次重试、累计等待 1.5 秒。终止失败保留原错误及目录。`close` 和 `cleanup` 阶段均留存诊断，Magpie 宿主 stderr 同步保留摘要。

## English

Version 0.6.4 uses the browser's temporary loopback WebSocket endpoint for the shared login flow. The old Windows Bun pipe failure was reproduced under Bun 1.3.14 and repaired through this path. Real Chrome and Edge startup, metadata, cancellation and cleanup passed under Node 24 and Bun 1.3.14 / 1.4.5. Startup failures now retain stage, runtime, exit information and a private diagnostic file. The original remote device's cause remains pending a new diagnostic capture.

# 模型名称与验证状态修复

## 模型目录

2026-11-14，使用账号的正常模型发现请求读取豆包 `/alice/slot/action_bar_v3/brief_list`，上游 HTTP 200。当前目录确认以下条目。

| 请求 ID | 上游名称 | 目录模式 |
| --- | --- | --- |
| `5` | 豆包 2.1 Pro | 工作任务 |
| `9` | 自动 | 工作任务 |

`9` 是自动选择入口，具体后端由豆包决定。插件原先已经解析上游名称，随后用 ID 覆盖了模型显示名称。0.6.2 将同一目录里的名称传递到 Magpie 模型元数据和插件 `/v1/models`，显示名随目录更新。请求继续使用上游 ID。

Magpie 的模型按钮优先读取模型名称，接口 ID 单独保存在模型元数据中。[Magpie 模型按钮实现](https://github.com/yetone/magpie/blob/main/internal/gui/assets/app.js)

## 429 的执行路径

截图中的“此账号已暂停……再在 Magpie 重新登录”来自 0.6.1 的本地 `ready()` 分支。账号保存为 `needs_verification` 后，该分支会在发送上游聊天前返回 429，并重新附上 `710022004`。

0.5.1 / 0.5.2 修复了设备号、配套指纹与账号迁移。旧的暂停门槛继续存在，设备参数修正或官网验证完成后，原账号仍可能被这段本地逻辑拦截。网关还会将待验证账号复测时的登录过期或普通限流重新覆盖成待验证，进一步保留错误状态。

上游直接返回 `710022004` 或明确的验证决定时，属于当次上游验证要求。设备上下文缺失、会话和出口差异需要依据那次请求排查。远端最初触发验证时的报文与设备情况缺失，初次触发因素仍待核实。

## 实施方案

1. 共用上游模型详情，传递真实名称，兼容现有数字 ID。
2. 记录验证状态，同时让用户发起的新聊天或面板复测取得当次上游结果。每次客户端请求发送一次上游请求。
3. 完整文本或工具回复成功后清除旧验证状态。断流、取消及空输出保留待处理状态。并发产生的新失败与替换登录按原账号代次和请求记录保留。
4. 自动签到继续读取自动任务就绪条件。新聊天复测成功后恢复正常状态，普通限流和登录过期按当次实际结果保存。
5. 面板提供“打开豆包官网”和“复测此账号”。已有恢复接口保留兼容调用。
6. 实际验证错误增加 `device_context`，取值为 `present` 或 `missing`。缺少设备上下文时给出重新接入或导入完整备份的操作说明，诊断只返回存在性。

上游要求验证时，使用同一账号在官网或客户端完成人工验证，再重新测试模型或发送新请求。账号会话失效时重新登录。成功复测是清除旧状态的依据。

## 验证记录

真实账号会话复制到隔离内存，并人为设置旧待验证标记。用户账号配置保持独立，临时网关状态在测试结束后清理。

| 入口 | 实际结果 | 聊天上游调用数 | 最终状态 |
| --- | --- | --- | --- |
| 已安装 0.6.1 插件 | 本地 HTTP 429 | 0 | 待验证 |
| 0.6.2 插件 | HTTP 200，完整文本 `OK` | 1 | ready |
| 0.6.2 网关正常 HTTP | HTTP 200，完整文本 `好` | 1 | ready |

本次工具进程的系统 DNS 查询返回 `EAI_MEMORY`。联网验证与发布进程使用独立 DNS 解析，HTTPS 执行证书校验。独立解析属于本次验证与发布工具配置。

真实 Magpie Bun 1.4.4 宿主通过模型显示名称、旧状态恢复、账号隔离、工具回合及既有短答联调。回归覆盖重复真实验证、官网验证后原会话恢复、并发状态更新、断流、自动签到以及正常 HTTP 和面板复测入口。

插件 64 项、网关 110 项本地测试通过，受影响模块补验通过。两仓库的 Windows / Ubuntu / macOS × Node.js 22 / 24 共 12 个 CI 任务全部通过。[插件 CI](https://github.com/3294798852/magpie-doubao-work/actions/runs/43553147362) · [网关 CI](https://github.com/3294798852/doubao-work-gateway/actions/runs/43553236472)

本机已定向安装 0.6.2。Magpie 保存的模型目录显示“豆包 2.1 Pro”和“自动”，正在运行的 Magpie 正常 HTTP 入口返回 200、完整文本 `OK` 及 `stop`。该请求由本机 Magpie 的网络路径完成。

## English

The live catalog names ID `5` as Doubao 2.1 Pro and ID `9` as Auto. Version 0.6.2 forwards those upstream display names while preserving request IDs. It also repairs the permanent local verification gate. A new user-initiated chat obtains a fresh upstream result, and a complete successful reply clears the stale state. Actual verification errors retain their upstream code and device-context presence. Automated check-in remains governed by account readiness. The initial remote challenge has no raw capture, so its original trigger remains unverified.

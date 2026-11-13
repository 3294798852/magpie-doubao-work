# 独立插件验证记录 / Standalone plugin verification

验证日期为 2026-11-13，当前版本为 0.6.1。

## 来源与改动范围

源代码来自 [网关 v0.5.0](https://github.com/3294798852/doubao-work-gateway/tree/v0.5.0)。拆分保留原生协议、会话、浏览器登录和账号状态实现，提取插件需要的北京时间、账号备份与浏览器路径函数。供应商名称使用中英文显示，包与仓库名称为 `magpie-doubao-work`。

The plugin uses the gateway v0.5.0 implementation. The extraction keeps native protocol, sessions, browser sign-in and account state. Calendar, backup and browser-path functions are limited to the plugin's call paths. Provider and package metadata carry bilingual names.

## 本地运行

| 环境 | 方法 | 结果 |
| --- | --- | --- |
| Windows 11，Node.js 24.18.0 | `npm run check`、`npm test` | 语法通过，60 项测试通过 |
| Windows，Bun 1.4.4，0.6.1 | 真实 Magpie `internal/plugin/host.js` 加载独立插件 | 模拟上游的短答快照、用量、工具调用、结果回传、设备保存、模型、文本、流式、额度、签到和状态隔离通过 |
| 中英文搜索字段 | `test/metadata.test.mjs` | 34 个检索词或词组在 zh/en 两种语言中均匹配，共 68 项匹配检查 |

宿主基线为 Magpie 提交 `11ab58c5874268d2607ff43f6ce13abb366c518b`。宿主回归使用合成账号，真实账号结果记录如下。

The host regression uses synthetic accounts. Live Windows and isolated Linux account results follow.

## 0.6.1 短回复与 SSE 输出

0.6.0 的八项协议回归中七项失败，修复后连同 Magpie 正常入口共九项通过。修复按消息、答案和回复层级结束读取，接入 JSON 编码快照，统一直接文本增量和块状态，并传递上游标准用量。

三份真实“解释缓存”响应来自 DeepSeek V4.1 Flash、豆包 2.1 Pro、豆包 2.1 Lite。每份原报文经流式与非流式插件入口均完整返回，上游未提供标准 token 用量。远端反馈的模型、版本和六帧报文无法取得，原反馈的具体故障仍待确认。[问题、方案与验收](sse-output.md)

## 0.6.0 客户端工具调用

0.5.2 的请求校验、工具消息、能力声明和响应编码均缺少工具链路。0.6.0 通过共用的客户端 function 工具适配解决这些问题，实施与范围见 [工具调用排查记录](tool-calling.md)。

| 正常入口 | 客户端 | 真实结果 |
| --- | --- | --- |
| 独立网关 `/v1/chat/completions` | dsh 0.2.0-rc.2 headless | 客户端读取临时文件，结果回传后，模型正确返回文件随机值。两次模型请求均完成 |
| 本机 Magpie `/v1/chat/completions` | 同上 | `read` 调用与结果使用同一 ID，最终回答与文件随机值一致 |
| Magpie Bun 宿主 | 合成账号联调 | 纯工具回复、结果回传、流式结束和既有状态回归通过 |

真实调用使用 `person-deepseek-v4-1-flash-261017`。测试采用独立 DSH_HOME 与只读工作区，临时文件只用于回合验收。工具由 dsh 执行。严格约束解码、自定义 grammar 工具、旧版函数接口及其他客户端版本、其他模型的真实工具行为待验收。

Live dsh function-tool round trips passed through both the native HTTP gateway and the running local Magpie gateway. Each client read a temporary file and used its result in the final answer. Strict constrained decoding, custom grammar tools and the legacy function interface remain pending.

## 0.5.2 跨环境账号迁移

源环境为 Windows 11，目标为同一物理电脑上的 WSL Ubuntu，运行 Bun 1.4.4。Windows 网关通过正常的面板导出入口生成账号备份，自动保存本机客户端的设备上下文。备份通过本机进程标准输入传入 Ubuntu，验收结束后清理临时凭据目录。

| 目标入口 | 操作 | 真实结果 |
| --- | --- | --- |
| Ubuntu 原生网关 | 面板预览、导入、核验后调用 HTTP 文本接口 | HTTP 200，文本 `OK`，目标设备文件查询 0 次 |
| Ubuntu Magpie Bun 宿主 | 全新 HOME / XDG 目录，正常账号导入后调用流式接口 | HTTP 200，文本 `OK`，包含 `[DONE]`，保存的设备上下文与源备份一致 |
| 本机 Magpie 0.1.3620 | 定向安装插件 0.5.2，执行 `provider test` | 非流式文本通过，5363 ms |

新增回归覆盖账号设备优先级、v2/v3 元数据保留、新登录保存、旧登录升级，以及设备查询期间替换登录。网关另外覆盖正常 HTTP 导出、空白目标导入与重启。每个账号使用自己携带的设备信息，目标环境取得完整上下文后直接使用该会话。

其他实体设备和不同网络出口的真实调用、macOS 真实账号、其余 9 个模型及真实签到待验收。

Live migration from Windows to isolated WSL Ubuntu passed for the native gateway and the real Magpie Bun host. The gateway made zero destination-device lookups. The plugin used a fresh home directory and preserved the imported account context. Separate physical computers and network exits remain outside this live validation.

## 0.5.1 真实账号与设备参数

Windows 11、Magpie 0.1.3620、Bun 1.4.4。账号持有人手工完成登录和官网验证，模型目录返回 10 个 ID。仅保存 Cookie 时，文本请求持续返回 `710022004`。本机客户端的设备号位于 `%LOCALAPPDATA%\Doubao\User Data\Local State`，补齐 `device_id` 与 `fp=verify_<device_id>` 后通过以下检查。

| 入口 | 模型 | 结果 |
| --- | --- | --- |
| 原生客户端 | `person-deepseek-v4-1-flash-261017` | 完整文本 `OK` |
| `magpie provider test doubaowork …` | 同上 | 非流式聊天通过，6916 ms |
| 本机 Magpie `/v1/chat/completions` | `doubaowork/person-deepseek-v4-1-flash-261017` | HTTP 200，SSE 返回 `OK` 和 `[DONE]`，9900 ms |

该阶段账号恢复为 `ready`，旧社区豆包插件已停用。5 项新增回归覆盖设备优先级、配套指纹、平台路径及查询缓存。Linux 迁移的后续结果见 0.5.2 记录。

设备参数处理参考现有上游协议实现，并用本机真实账号完成复测。[Agent2Providers 的设备上下文实现](https://github.com/ProvidersPlugin/Agent2Providers/blob/3055f416841c1393ec04294a702603fd41e840aa/crates/providers/src/providers/doubaowork/client.rs)

With device context supplied, live native text, Magpie CLI non-streaming and the local Magpie SSE endpoint passed. Subsequent Linux migration results are recorded under version 0.5.2.

## 搜索机制

Magpie 的发现列表从 GitHub 的 `magpie-plugin` 主题读取仓库，取得 `package.json` 的名称、语言摘要与入口。客户端将名称、安装标识、当前语言摘要、供应商和发布者字段拼接，转为小写后匹配完整查询词组。

Both localized summaries contain the tested Chinese and English aliases. The regression test mirrors Magpie's substring matcher, including multi-word phrases such as `Doubao Work Plugin` and `Magpie provider plugin`.

| 项目 | 当前值 |
| --- | --- |
| 名称 | `Magpie 豆包工作插件 / Doubao Work Plugin` |
| 名称长度 | 46 UTF-8 bytes |
| English summary | 274 UTF-8 bytes |
| 中文摘要 | 270 UTF-8 bytes |
| 名称 / 摘要上限 | 80 / 300 UTF-8 bytes |

搜索来源见 [Magpie 仓库发现](https://github.com/yetone/magpie/blob/main/internal/plugin/github.go) 和 [客户端检索](https://github.com/yetone/magpie/blob/main/internal/gui/assets/plugins.js)。

## 持续集成

[CI](https://github.com/3294798852/magpie-doubao-work/actions/workflows/ci.yml) 在 Windows、Ubuntu、macOS 上分别使用 Node.js 22 和 24 运行语法与测试检查。发行验收数据保存在 [verification.json](verification.json)。

[0.6.1 运行 43412890988](https://github.com/3294798852/magpie-doubao-work/actions/runs/43412890988) 的全部 6 个任务通过，代码提交为 `1227efc4e2c553b94647902bbe8e7104a16f1420`。本机实际 Magpie 网关已通过流式与非流式短答。

[0.6.0 运行 43409547828](https://github.com/3294798852/magpie-doubao-work/actions/runs/43409547828) 的全部 6 个任务通过，验证代码提交为 `8219662479e4faae7a6feee915f5dffeb6fcbb0c`。0.5.0 的 GitHub 安装基线记录保留在 `verification.json`。

All six version 0.6.0 CI jobs passed. The version 0.5.0 GitHub installation remains a baseline record. Subsequent publication-record updates affect documentation.

## GitHub 与市场检索

以下 8 组实际 GitHub 查询均返回本仓库。查询使用公开仓库名称、描述和主题，结果见 `verification.json`。

| 查询用途 | 查询内容 |
| --- | --- |
| 市场发现 | `repo:3294798852/magpie-doubao-work topic:magpie-plugin archived:false fork:false` |
| 完整仓库名 | `magpie-doubao-work in:name` |
| 中文名称组合 | `豆包工作 magpie in:name,description` |
| 中文别名组合 | `豆包插件 magpie in:name,description` |
| 英文名称组合 | `Doubao Work Magpie in:name,description` |
| 连写别名组合 | `doubaowork magpie in:name,description` |
| 中文短名称组合 | `豆包 magpie in:name,description` |
| 英文短名称组合 | `doubao plugin in:name,description` |

All eight live GitHub search queries returned this repository. Magpie's discovery topic is attached to the standalone repository. The gateway repository's plugin documentation points here, and its plugin-discovery topic was removed.

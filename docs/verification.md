# 独立插件验证记录 / Standalone plugin verification

验证日期为 2026-11-13，当前版本为 0.5.1。

## 来源与改动范围

源代码来自 [网关 v0.5.0](https://github.com/3294798852/doubao-work-gateway/tree/v0.5.0)。拆分保留原生协议、会话、浏览器登录和账号状态实现，提取插件需要的北京时间、账号备份与浏览器路径函数。供应商名称使用中英文显示，包与仓库名称为 `magpie-doubao-work`。

The plugin uses the gateway v0.5.0 implementation. The extraction keeps native protocol, sessions, browser sign-in and account state. Calendar, backup and browser-path functions are limited to the plugin's call paths. Provider and package metadata carry bilingual names.

## 本地运行

| 环境 | 方法 | 结果 |
| --- | --- | --- |
| Windows 11，Node.js 24.18.0 | `npm run check`、`npm test` | 语法通过，37 项测试通过 |
| Windows，Bun 1.4.4，0.5.0 基线 | 真实 Magpie `internal/plugin/host.js` 加载独立插件 | 模拟上游的账号导入、模型、文本、流式、额度、签到、验证状态与重启隔离通过 |
| 中英文搜索字段 | `test/metadata.test.mjs` | 31 个检索词或词组在 zh/en 两种语言中均匹配，共 62 项匹配检查 |

宿主基线为 Magpie 提交 `11ab58c5874268d2607ff43f6ce13abb366c518b`。基线联调使用合成账号，0.5.1 的真实账号结果记录如下。

The baseline host smoke test uses synthetic accounts. Version 0.5.1 adds live Windows account validation below.

## 0.5.1 真实账号与设备参数

Windows 11、Magpie 0.1.3620、Bun 1.4.4。账号持有人手工完成登录和官网验证，模型目录返回 10 个 ID。仅保存 Cookie 时，文本请求持续返回 `710022004`。本机客户端的设备号位于 `%LOCALAPPDATA%\Doubao\User Data\Local State`，补齐 `device_id` 与 `fp=verify_<device_id>` 后通过以下检查。

| 入口 | 模型 | 结果 |
| --- | --- | --- |
| 原生客户端 | `person-deepseek-v4-1-flash-261017` | 完整文本 `OK` |
| `magpie provider test doubaowork …` | 同上 | 非流式聊天通过，6916 ms |
| 本机 Magpie `/v1/chat/completions` | `doubaowork/person-deepseek-v4-1-flash-261017` | HTTP 200，SSE 返回 `OK` 和 `[DONE]`，9900 ms |

账号恢复为 `ready`，旧社区豆包插件已停用。其余 9 个模型、Linux/macOS 真实账号和真实签到仍待逐项验收。5 项新增回归覆盖设备优先级、配套指纹、平台路径及查询缓存。

设备参数处理参考现有上游协议实现，并用本机真实账号完成复测。[Agent2Providers 的设备上下文实现](https://github.com/ProvidersPlugin/Agent2Providers/blob/3055f416841c1393ec04294a702603fd41e840aa/crates/providers/src/providers/doubaowork/client.rs)

With device context supplied, live native text, Magpie CLI non-streaming and the local Magpie SSE endpoint passed. The other models, live Linux/macOS accounts and live check-in remain pending.

## 搜索机制

Magpie 的发现列表从 GitHub 的 `magpie-plugin` 主题读取仓库，取得 `package.json` 的名称、语言摘要与入口。客户端将名称、安装标识、当前语言摘要、供应商和发布者字段拼接，转为小写后匹配完整查询词组。

Both localized summaries contain the tested Chinese and English aliases. The regression test mirrors Magpie's substring matcher, including multi-word phrases such as `Doubao Work Plugin` and `Magpie provider plugin`.

| 项目 | 当前值 |
| --- | --- |
| 名称 | `Magpie 豆包工作插件 / Doubao Work Plugin` |
| 名称长度 | 46 UTF-8 bytes |
| English summary | 241 UTF-8 bytes |
| 中文摘要 | 238 UTF-8 bytes |
| 名称 / 摘要上限 | 80 / 300 UTF-8 bytes |

搜索来源见 [Magpie 仓库发现](https://github.com/yetone/magpie/blob/main/internal/plugin/github.go) 和 [客户端检索](https://github.com/yetone/magpie/blob/main/internal/gui/assets/plugins.js)。

## 持续集成

[CI](https://github.com/3294798852/magpie-doubao-work/actions/workflows/ci.yml) 在 Windows、Ubuntu、macOS 上分别使用 Node.js 22 和 24 运行语法与测试检查。发行验收数据保存在 [verification.json](verification.json)。

[0.5.1 运行 43396251416](https://github.com/3294798852/magpie-doubao-work/actions/runs/43396251416) 的全部 6 个任务通过，验证代码提交为 `94b27fbfbb140573c09e2c53555befc68230e2c7`。0.5.0 的 GitHub 安装与宿主基线记录保留在 `verification.json`。

All six version 0.5.1 CI jobs passed. Version 0.5.0 GitHub installation and synthetic host results remain as baseline records. Subsequent publication-record updates affect documentation.

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

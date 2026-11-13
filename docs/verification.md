# 独立插件验证记录 / Standalone plugin verification

验证日期为 2026-11-13，版本为 0.5.0。

## 来源与改动范围

源代码来自 [网关 v0.5.0](https://github.com/3294798852/doubao-work-gateway/tree/v0.5.0)。拆分保留原生协议、会话、浏览器登录和账号状态实现，提取插件需要的北京时间、账号备份与浏览器路径函数。供应商名称使用中英文显示，包与仓库名称为 `magpie-doubao-work`。

The plugin uses the gateway v0.5.0 implementation. The extraction keeps native protocol, sessions, browser sign-in and account state. Calendar, backup and browser-path functions are limited to the plugin's call paths. Provider and package metadata carry bilingual names.

## 本地运行

| 环境 | 方法 | 结果 |
| --- | --- | --- |
| Windows 11，Node.js 24.18.0 | `npm run check`、`npm test` | 语法通过，32 项测试通过 |
| Windows，Bun 1.4.4 | 真实 Magpie `internal/plugin/host.js` 加载独立插件 | 模拟上游的账号导入、模型、文本、流式、额度、签到、验证状态与重启隔离通过 |
| 中英文搜索字段 | `test/metadata.test.mjs` | 31 个检索词或词组在 zh/en 两种语言中均匹配，共 62 项匹配检查 |

宿主基线为 Magpie 提交 `11ab58c5874268d2607ff43f6ce13abb366c518b`。联调使用合成账号。真实账号登录、调用及签到由账号持有人完成联调。

The host smoke test uses synthetic accounts. Live account login, inference and check-in validation remain with an account holder.

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

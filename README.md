# Magpie 豆包工作插件 · Doubao Work Plugin

[English](README.en.md)

`magpie-doubao-work` 为 Magpie 提供豆包工作供应商 `doubaowork`，支持 Windows、Linux 和 macOS。通过豆包网页登录或账号 JSON 导入接入，提供模型发现、文本对话、流式输出、额度查询和每日签到。

## 安装

安装近期版本的 [Magpie](https://github.com/yetone/magpie)，运行以下命令。

```sh
magpie plugin add github:3294798852/magpie-doubao-work
magpie plugin login doubaowork
```

在 Magpie 的「插件 → 发现」中，也可搜索本插件并安装。供应商显示为「豆包工作 Doubao Work」。模型 ID 从账号实际目录获取，在客户端选择 `doubaowork/<模型ID>`。

## 搜索名称与关键词

中文与英文界面均可使用以下名称、别名和常用词组。

| 用途 | 可检索的词 |
| --- | --- |
| 中文名称 | `豆包`、`豆包工作`、`豆包插件`、`豆包工作插件` |
| 英文名称 | `Doubao`、`Doubao Work`、`Doubao Work Plugin` |
| 项目标识 | `magpie-doubao-work`、`doubao-work`、`doubaowork` |
| 供应商插件 | `Magpie 豆包工作`、`Magpie provider plugin`、`provider plugin`、`供应商插件` |
| 登录与导入 | `browser login`、`浏览器登录`、`JSON`、`导入` |
| 文本与流式 | `OpenAI`、`text chat`、`SSE`、`streaming`、`流式` |
| 额度与签到 | `quotas`、`额度`、`daily check-in`、`自动签到` |
| 系统 | `Windows`、`Linux`、`macOS` |

仓库描述、README、GitHub 主题和包关键词包含中英文检索信息。Magpie 的名称及两种语言摘要均包含上述检索词，并按其实际搜索规则做回归验证。Magpie 当前按连续词组匹配，可直接使用表中词组。发现列表通过 GitHub 的 `magpie-plugin` 标签收录，刷新后的列表使用最新元数据。

## 登录与账号

图形桌面需要 Chrome 或 Edge，Linux 也可使用 Chromium。登录会打开独立临时浏览器窗口。完成扫码或手机验证后，插件核验账号身份并交给 Magpie 保存。

无桌面的 Linux 可从 [豆包工作独立网关](https://github.com/3294798852/doubao-work-gateway) 导出账号 JSON，再导入 Magpie。

```sh
magpie accounts import doubaowork /absolute/path/doubao-accounts.json --yes
```

支持 v2/v3 豆包工作账号备份，每个文件最多 20 个账号、512 KB。备份包含登录凭据，应保存在私有目录。浏览器绝对路径可通过启动 Magpie 时的 `DW_CHROME_BIN` 或 `DW_EDGE_BIN` 环境变量指定。

账号开关、代理、路由和签到在 Magpie 中管理。开启签到后，由 Magpie 调度，插件在领取请求前持久记录当日提交状态。结果待确认时，后续操作回查上游状态。

上游要求人工验证时，账号进入暂停状态。使用同一个账号在豆包官网完成验证后，在 Magpie 重新登录该账号。

## 从网关内置插件迁移

已通过旧仓库安装插件的用户，安装本仓库后，可指定由本插件提供 `doubaowork`。

```sh
magpie plugin add github:3294798852/magpie-doubao-work
magpie plugin use github:3294798852/magpie-doubao-work doubaowork
```

在 Magpie 的供应商页面核对账号和模型。独立网关的说明与发行版位于 [doubao-work-gateway](https://github.com/3294798852/doubao-work-gateway)。

## 能力与验证

支持 OpenAI 风格 `chat/completions` 文本接口、流式与非流式回复，以及 `reasoning_content` 透传。取消会中止上游请求，输出按消费者读取速度推进。

工具调用、结构化输出、图片和工作流仍待实现。模型上下文与输出上限仍待补充。真实账号登录、模型调用和签到由账号持有人完成联调。

从源码验收可运行以下命令，需要 Node.js 22 或更高版本。

```sh
npm run check
npm test
```

真实 Magpie Bun 宿主的模拟联调通过 `MAGPIE_BUN_BIN` 和 `MAGPIE_HOST_FILE` 指定运行时与 `internal/plugin/host.js`，再运行 `npm run test:magpie-host`。结果与搜索覆盖见 [验证记录](docs/verification.md)。

## 来源与许可证

插件从 [doubao-work-gateway v0.5.0](https://github.com/3294798852/doubao-work-gateway/tree/v0.5.0) 拆分。新增 Magpie 集成采用 MIT 许可证，继承代码及品牌素材保留上游来源与声明。范围见 [LICENSE](LICENSE) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。

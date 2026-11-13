# 工具调用排查与修复

## 0.5.2 问题定位

- `native/completion.mjs` 拒绝 `tools`、`tool_choice`、`assistant.tool_calls` 和 `tool` 消息。
- `magpie/provider.mjs` 将工具能力声明为关闭，客户端可能隐藏工具入口。
- 原生适配只发送文本历史，流式解码只生成文本与推理增量。
- 两版的完成判断要求有文本，响应编码固定使用 `stop`，纯工具回复会失败。

## 实施方案

1. 两版共用工具参数和消息解析，保存工具声明、调用 ID、参数及客户端结果。
2. 将客户端 function 工具协议转换为豆包文本请求。用每回合唯一标记识别工具响应，再转换为标准 `tool_calls`。工具由客户端执行。
3. 共用响应编码器处理文本和工具回复，正确生成流式索引、调用 ID、JSON 参数字符串和 `finish_reason`。
4. 补齐工具能力元数据，保留现有账号上下文、取消与错误状态处理。

工具回合在完整响应校验后输出工具事件。普通文本回合继续使用既有流式路径。实现依据 [Chat Completions 协议](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) 和 [function calling 指南](https://developers.openai.com/api/docs/guides/function-calling)。

本轮范围为 function 工具协议。`strict=true` 的约束解码、自定义 grammar 工具和旧版 `functions/function_call` 接口返回明确的参数错误，后续兼容工作需分别验收。

## 验收范围

- `auto`、`none`、`required`、指定函数和并行开关。
- 空工具列表、纯工具回复、工具结果回传、多回合与多工具调用。
- 未声明工具、畸形 JSON、错误参数、断流和取消。
- 网关 HTTP、Magpie Bun 宿主与 dsh 的真实读文件回合。
- Windows / Linux / macOS 自动回归，保留既有账号迁移验收。

## 已有证据

2026-11-13，0.5.2 的阻断点已从代码确认。真实账号通过文本协议原型完成工具请求与结果回传，模型正确返回客户端提供的随机值。

网关版通过真实 dsh headless 回合，客户端使用 `read` 读取临时文件，并将包含随机字符串的结果回传给模型。第二次模型请求返回正确字符串，两次请求均完成。Magpie Bun 宿主的合成账号联调通过工具调用与结果回传。

本机 Magpie 正常网关入口也通过 dsh 0.2.0-rc.2 的同类验收。客户端发出一次 `read` 调用，工具结果关联到同一调用 ID，最终回答与测试文件的随机内容一致。测试使用独立 DSH_HOME、临时工作目录及只读权限模式。

0.6.0 的 Windows 本地检查通过，插件 51 项、网关 95 项测试全部通过。两仓库的 Windows、Ubuntu、macOS × Node.js 22 / 24 共 12 个 CI 任务全部通过。

真实工具回合使用 `person-deepseek-v4-1-flash-261017`。其他客户端版本与其余模型的真实工具行为待逐项验收。

# 短回复与 SSE 输出排查

## 反馈与复现

远端反馈称直调成功、插件返回“我还在学习中”，并显示零用量。该次请求的插件版本、模型、请求体及六帧原文无法取得，具体故障链路仍待确认。

2026-11-13，本机对 DeepSeek V4.1 Flash、豆包 2.1 Pro、豆包 2.1 Lite 分别发送“用一句话解释什么是缓存。”，三次真实 SSE 都包含有效答案。每份原始响应经过插件的流式和非流式入口后均完整返回。三份响应均未提供标准 token 用量。

## 已定位的缺陷

- 解码器遇到第一个 `SSE_REPLY_END` 就结束。官方前端定义 `end_type=1/2/3` 分别为消息、答案与回复完成，多消息回复会被提前截断，后续错误和用量也会被跳过。
- 完整消息只读取 `message.content_block`，遗漏 `message.content` 中 JSON 编码的块数组。
- `CHUNK_DELTA` 直接输出，未更新块状态。后续完整快照会再次输出已经发送的尾部，推理块元数据也可能丢失。
- 块状态未区分消息，复用块 ID 时可能错误判定为内容修订。
- SSE 分帧只处理 LF / CRLF。标准允许的 CR 行结束符会解析失败。
- 响应链路未传递上游用量，客户端显示的零值缺少实际用量依据。

官方前端的结束枚举见 [豆包前端协议定义](https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/chat/static/js/chat.40cc7bbbe5.js)。分帧规则见 [WHATWG SSE 标准](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)。

## 修复方案与实现

1. 两版使用同一解码器，显式层级结束事件等待 `end_type=3`。已有无层级结束事件继续按其原协议完成。
2. 将完整块数组和 JSON 编码的完整消息归一化到块解析路径，使用消息 ID 与块 ID 管理增量和快照。直接文本增量更新当前块及推理状态。
3. SSE 分帧支持三种行结束符及跨字节 UTF-8。断流、格式错误和真实验证错误通过原入口返回，协议错误保留 `upstream_stream_error` 类型与具体说明。
4. 将上游标准 `usage` 的三个 token 计数传到响应编码器。非流式结果携带用量，流式请求通过 `stream_options.include_usage=true` 接收最终用量帧。工具回合也传递同一元数据。

用量适配读取事件及消息、答案结束属性中的标准 `usage`。当前实测样本没有这些计数，返回字段保持缺省。远端所称 token 数据的字段来源待取得报文后核对。

## 验收

0.6.0 的八项协议回归中七项失败。修复后连同 Magpie 正常入口回归共九项通过，覆盖六帧短答、编码快照、混合增量、推理、跨消息、分帧、断流、错误和用量。网关额外通过正常 HTTP 入口的短答与用量回归。

Windows 本地语法检查通过，插件 60 项、网关 105 项测试通过。真实 Magpie Bun 1.4.4 宿主通过短答快照、流式用量、工具调用和工具结果回传。

两仓库在 Windows、Ubuntu、macOS 与 Node.js 22 / 24 的全部 12 个 CI 任务通过。[插件 CI](https://github.com/3294798852/magpie-doubao-work/actions/runs/43412890988) · [网关 CI](https://github.com/3294798852/doubao-work-gateway/actions/runs/43412901170)

本机 Magpie 0.1.3620 已安装插件 0.6.1。DeepSeek V4.1 Flash 通过真实 HTTP 入口分别完成流式与非流式“解释缓存”请求，均返回完整答案和正常结束。旧社区插件保持停用。

本次修复覆盖可复现的协议缺陷。远端“我还在学习中”这一文案的来源，以及其所用客户端和请求模式，仍缺少对应证据。

## English

Version 0.6.1 fixes premature termination at message-level end events, JSON-encoded full-message snapshots, mixed chunk/snapshot state, message-scoped block IDs and CR-only SSE framing. Standard upstream token usage is propagated through ordinary and function-tool turns. Live short replies from three models were replayed through both plugin response modes. The original remote report has no raw capture, so its exact failure remains unconfirmed.

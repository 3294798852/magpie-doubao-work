const fail = (status, message, type = 'invalid_request_error') =>
  Object.assign(new Error(message), {status, type});

export function parseChat(value) {
  if (typeof value.model !== 'string' || !value.model || value.model.length > 160)
    throw fail(400, '请提供模型 ID。');
  if (value.stream !== undefined && typeof value.stream !== 'boolean')
    throw fail(400, 'stream 应为布尔值。');
  if (value.tools !== undefined || value.functions !== undefined || value.tool_choice !== undefined ||
      value.response_format && value.response_format.type !== 'text' || value.n !== undefined && value.n !== 1)
    throw fail(400, '此版本仅支持单路纯文本；工具调用和结构化输出尚未接入。');
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 100)
    throw fail(400, '请提供 1–100 条消息。');
  const messages = value.messages.map(message => {
    if (!['system', 'developer', 'user', 'assistant'].includes(message?.role) || message.tool_calls)
      throw fail(400, '此版本仅支持文本对话角色。');
    const content = message.content;
    const text = Array.isArray(content) && content.every(part => part?.type === 'text' && typeof part.text === 'string')
      ? content.map(part => part.text).join('\n') : content;
    if (typeof text !== 'string') throw fail(400, '消息正文须为文本。');
    return {role: message.role, content: text};
  });
  if (!messages.some(message => message.role === 'user' && message.content.trim()))
    throw fail(400, '至少需要一条非空用户消息。');
  return {model: value.model, messages, stream: value.stream === true};
}

export function completionError(error, requestId) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
  const known = typeof error?.type === 'string';
  const code = error?.upstream_code;
  return {status, body: {error: {
    message: known ? error.message : '豆包工作请求未完成，请检查网关及账号状态。',
    type: known ? error.type : 'upstream_error',
    ...(Number.isSafeInteger(code) ? {code, upstream_code: code} : {}),
    request_id: requestId,
  }}};
}

// Both the HTTP gateway and Magpie consume this encoder with backpressure.
export async function* completionChunks(deltas, body, {requestId, signal, now = Date.now} = {}) {
  const info = {id: 'chatcmpl-' + requestId, created: Math.floor(now() / 1000), model: body.model};
  const chunk = (delta, finish_reason = null) => ({...info, object: 'chat.completion.chunk',
    choices: [{index: 0, delta, finish_reason}]});
  const event = value => 'data: ' + JSON.stringify(value) + '\n\n';
  let text = '', reasoning = '', size = 0, started = false;
  for await (const delta of deltas) {
    signal?.throwIfAborted();
    size += (delta.content || '').length + (delta.reasoning_content || '').length;
    if (size > 16 * 1024 * 1024) throw fail(502, '输出超过网关大小限制。', 'upstream_error');
    if (!body.stream) {
      text += delta.content || '';
      reasoning += delta.reasoning_content || '';
      continue;
    }
    if (!started) {
      started = true;
      yield event(chunk({role: 'assistant'}));
    }
    yield event(chunk(delta));
  }
  signal?.throwIfAborted();
  if (!size) throw fail(502, '豆包工作未返回文本。', 'upstream_empty_response');
  if (body.stream) {
    yield event(chunk({}, 'stop'));
    yield 'data: [DONE]\n\n';
  } else {
    yield {...info, object: 'chat.completion', choices: [{index: 0, message: {role: 'assistant', content: text,
      ...(reasoning ? {reasoning_content: reasoning} : {})}, finish_reason: 'stop'}]};
  }
}

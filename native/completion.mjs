import {parseToolOptions} from './tool-calling.mjs';

const fail = (status, message, type = 'invalid_request_error') =>
  Object.assign(new Error(message), {status, type});

export function parseChat(value) {
  if (typeof value.model !== 'string' || !value.model || value.model.length > 160)
    throw fail(400, '请提供模型 ID。');
  if (value.stream !== undefined && typeof value.stream !== 'boolean')
    throw fail(400, 'stream 应为布尔值。');
  if (value.response_format && value.response_format.type !== 'text' || value.n !== undefined && value.n !== 1)
    throw fail(400, '当前接口支持单路文本与 function 工具。');
  const tools = parseToolOptions(value);
  const streamOptions = value.stream_options;
  if (streamOptions != null && (typeof streamOptions !== 'object' || Array.isArray(streamOptions) ||
      streamOptions.include_usage !== undefined && typeof streamOptions.include_usage !== 'boolean'))
    throw fail(400, 'stream_options.include_usage 应为布尔值。');
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 100)
    throw fail(400, '请提供 1–100 条消息。');
  const messages = value.messages.map(message => {
    if (!['system', 'developer', 'user', 'assistant','tool'].includes(message?.role))
      throw fail(400, '消息角色有误。');
    const content = message.content;
    const text = Array.isArray(content) && content.every(part => part?.type === 'text' && typeof part.text === 'string')
      ? content.map(part => part.text).join('\n') : content;
    if (typeof text !== 'string' && !(message.role === 'assistant' && content == null && message.tool_calls?.length))
      throw fail(400, '消息正文须为文本，工具调用助手消息可使用 null。');
    const row = {role: message.role, content: text ?? null};
    if (message.tool_calls != null) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls))
        throw fail(400,'tool_calls 须位于助手消息中。');
      row.tool_calls = message.tool_calls.map(call => {
        if (typeof call?.id !== 'string' || !call.id || call.type !== 'function' ||
            typeof call.function?.name !== 'string' || !call.function.name || typeof call.function.arguments !== 'string')
          throw fail(400,'工具调用记录缺少 ID、函数名称或参数字符串。');
        return {id:call.id,type:'function',function:{name:call.function.name,arguments:call.function.arguments}};
      });
    }
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) throw fail(400,'工具结果缺少 tool_call_id。');
      row.tool_call_id = message.tool_call_id;
    }
    for (const key of ['name','reasoning_content']) if (typeof message[key] === 'string') row[key] = message[key];
    return row;
  });
  if (!messages.some(message => message.role === 'user' && message.content.trim()))
    throw fail(400, '至少需要一条非空用户消息。');
  return {model: value.model, messages, stream: value.stream === true,...tools,
    ...(streamOptions?.include_usage !== undefined ? {stream_options:{include_usage:streamOptions.include_usage}} : {})};
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
    choices: [{index: 0, delta, finish_reason}],...(body.stream_options?.include_usage ? {usage:null} : {})});
  const event = value => 'data: ' + JSON.stringify(value) + '\n\n';
  let text = '', reasoning = '', size = 0, started = false, usage;
  const calls = [];
  for await (const {usage: nextUsage,...delta} of deltas) {
    signal?.throwIfAborted();
    if (nextUsage) usage = nextUsage;
    if (!Object.keys(delta).length) continue;
    size += (delta.content || '').length + (delta.reasoning_content || '').length;
    if (delta.tool_calls?.length) {
      size += JSON.stringify(delta.tool_calls).length;
      calls.push(...delta.tool_calls.map(({index,...call}) => call));
    }
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
  if (!size) throw fail(502, '豆包工作未返回文本或工具调用。', 'upstream_empty_response');
  const finish = calls.length ? 'tool_calls' : 'stop';
  if (body.stream) {
    yield event(chunk({}, finish));
    if (body.stream_options?.include_usage && usage)
      yield event({...info,object:'chat.completion.chunk',choices:[],usage});
    yield 'data: [DONE]\n\n';
  } else {
    yield {...info, object: 'chat.completion', choices: [{index: 0, message: {role: 'assistant', content: text || (calls.length ? null : ''),
      ...(calls.length ? {tool_calls:calls} : {}),...(reasoning ? {reasoning_content: reasoning} : {})}, finish_reason: finish}],
      ...(usage ? {usage} : {})};
  }
}

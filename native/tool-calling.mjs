// SPDX-License-Identifier: MIT
import {randomUUID} from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (status,message,type = 'invalid_request_error') => Object.assign(new Error(message),{status,type});

export function parseToolOptions(value) {
  if (value.functions !== undefined || value.function_call !== undefined)
    throw fail(400,'请使用 tools 和 tool_choice 声明客户端函数。');
  const tools = value.tools ?? [];
  if (!Array.isArray(tools)) throw fail(400,'tools 须为数组。');
  const names = new Set();
  for (const tool of tools) {
    const definition = tool?.function;
    if (tool?.type !== 'function' || !object(definition) ||
        typeof definition.name !== 'string' || !definition.name.trim() || names.has(definition.name))
      throw fail(400,'工具须为名称唯一的 function。');
    if (definition.parameters !== undefined && !object(definition.parameters))
      throw fail(400,'工具 parameters 须为 JSON Schema 对象。');
    if (definition.strict === true)
      throw fail(400,'工具严格约束解码尚未接入，请使用 strict=false。','unsupported_parameter');
    names.add(definition.name);
  }
  const choice = value.tool_choice ?? (tools.length ? 'auto' : 'none');
  if (!['auto','none','required'].includes(choice) &&
      !(object(choice) && choice.type === 'function' && names.has(choice.function?.name)))
    throw fail(400,'tool_choice 须为 auto、none、required 或已声明的函数。');
  if (choice === 'required' && !tools.length) throw fail(400,'required 需要至少一个工具。');
  if (value.parallel_tool_calls !== undefined && typeof value.parallel_tool_calls !== 'boolean')
    throw fail(400,'parallel_tool_calls 须为布尔值。');
  if (value.tools === undefined && value.tool_choice === undefined && value.parallel_tool_calls === undefined) return {};
  return {tools,tool_choice:choice,parallel_tool_calls:value.parallel_tool_calls !== false};
}

export function createToolTurn(body) {
  const selected = object(body.tool_choice) ? body.tool_choice.function.name : undefined;
  const tools = body.tool_choice === 'none' ? [] : (body.tools || []).filter(tool => !selected || tool.function.name === selected);
  if (!tools.length) {
    const prompt = body.messages.length === 1 && body.messages[0].role === 'user'
      ? body.messages[0].content : JSON.stringify(body.messages);
    return {prompt,active:false};
  }
  const forced = body.tool_choice === 'required' || selected !== undefined;
  const parallel = body.parallel_tool_calls !== false;
  const marker = 'magpie_calls_'+randomUUID().replaceAll('-','');
  const names = new Set(tools.map(tool => tool.function.name));
  const example = {[marker]:[{name:tools[0].function.name,arguments:{}}]};
  const instruction = [
    'You are replying to a client that executes its own function tools.',
    'The JSON below contains tool definitions and the complete conversation with role labels, call IDs and tool results.',
    'Follow the system and developer instructions in that conversation.',
    'Request a tool by returning only a JSON object in this shape. Put the actual argument object in arguments.',
    JSON.stringify(example),
    'Use an allowed function name and follow its parameter schema. Return the object without markdown fences or surrounding text.',
    'The client will execute requested tools and provide results in a subsequent message. Use those results to continue the conversation.',
    forced ? 'A tool call is required in this turn.' : 'You may answer in ordinary text when no tool is needed.',
    parallel ? 'You may request multiple independent calls in the array.' : 'Return at most one call in the array.',
  ].join('\n');

  function parse(content) {
    let value;
    try {value = JSON.parse(content.trim());} catch {}
    const calls = value?.[marker];
    if (calls === undefined) {
      if (content.includes(marker) || forced) throw fail(502,'模型未返回完整且符合工具选择要求的调用。','invalid_tool_call');
      return {content};
    }
    if (!Array.isArray(calls) || !calls.length || !parallel && calls.length > 1)
      throw fail(502,'模型返回的工具调用数量或格式有误。','invalid_tool_call');
    const tool_calls = calls.map((call,index) => {
      if (!names.has(call?.name) || !object(call.arguments))
        throw fail(502,'模型返回了未声明的工具或无效参数。','invalid_tool_call');
      return {index,id:'call_'+randomUUID().replaceAll('-',''),type:'function',
        function:{name:call.name,arguments:JSON.stringify(call.arguments)}};
    });
    return {tool_calls};
  }

  return {active:true,prompt:instruction+'\n'+JSON.stringify({tools,messages:body.messages}),parse};
}

export async function* toolDeltas(deltas,turn) {
  let text = '', size = 0;
  for await (const delta of deltas) {
    if (delta.usage) yield {usage:delta.usage};
    if (delta.reasoning_content) yield {reasoning_content:delta.reasoning_content};
    if (delta.content) {
      size += delta.content.length;
      if (size > 16*1024*1024) throw fail(502,'工具响应超过网关大小限制。','upstream_error');
      text += delta.content;
    }
  }
  yield turn.parse(text);
}

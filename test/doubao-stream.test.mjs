import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeEvents} from '../native/doubao-stream.mjs';
import {completionChunks,parseChat} from '../native/completion.mjs';
import {toolDeltas} from '../native/tool-calling.mjs';
import {createDoubaoPlugin} from '../magpie/provider.mjs';

const frame = (event,value,eol = '\n') => `event: ${event}${eol}data: ${JSON.stringify(value)}${eol}${eol}`;
const block = (text,id = 'answer',extra = {}) => ({block_id:id,block_type:10000,
  content:{text_block:{...(text === undefined ? {} : {text}),...extra}}});
const notify = (blocks,id = 'message') => frame('STREAM_MSG_NOTIFY',{
  meta:{message_id:id,user_type:2},content:{content_block:blocks},
});
const snapshot = (blocks,id = 'message',encoded = false) => frame('FULL_MSG_NOTIFY',{
  message:{message_id:id,user_type:2,content_type:9999,
    ...(encoded ? {content:JSON.stringify(blocks)} : {content_block:blocks})},
});
const end = type => frame('SSE_REPLY_END',type === undefined ? {} : {end_type:type});
const body = {model:'fixture-model',messages:[{role:'user',content:'解释缓存'}]};
const collect = async source => {const rows=[];for await (const row of source) rows.push(row);return rows;};
const response = raw => new Response(raw,{headers:{'Content-Type':'text/event-stream'}});
const text = rows => rows.map(row=>row.content||'').join('');

test('消息结束和答案结束后继续读取，回复结束才完成六帧短响应',async()=>{
  const raw = end(1)+notify([block('缓存')])+frame('CHUNK_DELTA',{text:'保存数据'})+
    end(2)+frame('CHUNK_DELTA',{text:'副本。'})+end(3);
  assert.equal(text(await collect(decodeEvents(response(raw)))),'缓存保存数据副本。');
});

test('只有编码完整消息的短响应也返回答案，用户回显不进入输出',async()=>{
  const user = frame('FULL_MSG_NOTIFY',{message:{user_type:1,content:JSON.stringify([block('用户提示')])}});
  const raw = user+snapshot([block('缓存让重复读取更快。')],'message',true)+end(3);
  assert.deepEqual(await collect(decodeEvents(response(raw))),[{content:'缓存让重复读取更快。'}]);
});

test('块增量和 CHUNK_DELTA 共用状态，最终完整快照不会重复输出',async()=>{
  const raw = notify([block('缓存')])+frame('CHUNK_DELTA',{text:'保存副本。'})+
    snapshot([block('缓存保存副本。')])+end(3);
  assert.equal(text(await collect(decodeEvents(response(raw)))),'缓存保存副本。');
});

test('空块元数据决定后续文本增量的推理通道，跨消息块 ID 独立',async()=>{
  const raw = notify([block(undefined,'reason',{icon_url:'DEEP_THINK'})])+
    frame('CHUNK_DELTA',{text:'分析缓存'})+notify([block('第一段。')])+end(1)+
    snapshot([block('第二段。')],'message-two')+end(3);
  const rows = await collect(decodeEvents(response(raw)));
  assert.equal(rows.map(row=>row.reasoning_content||'').join(''),'分析缓存');
  assert.equal(text(rows),'第一段。第二段。');
});

test('CR、LF、CRLF 及逐字节 UTF-8 分片解析一致',async()=>{
  for (const eol of ['\r','\n','\r\n']) {
    const bytes = Buffer.from(frame('CHUNK_DELTA',{text:'缓存🙂'},eol)+frame('SSE_REPLY_END',{end_type:3},eol));
    const stream = new ReadableStream({start(controller){
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    }});
    assert.equal(text(await collect(decodeEvents(new Response(stream)))),'缓存🙂');
  }
});

test('消息结束后断流或返回错误仍报告失败',async()=>{
  await assert.rejects(collect(decodeEvents(response(notify([block('部分')])+end(1)))),/正式结束标记/);
  const raw = notify([block('部分')])+end(1)+frame('STREAM_ERROR',{error_code:710022004});
  await assert.rejects(collect(decodeEvents(response(raw))),error=>error.upstream_code===710022004);
});

test('上游 usage 元数据在非流式和请求用量的流式响应中透传',async()=>{
  const usage = {prompt_tokens:7,completion_tokens:3,total_tokens:10};
  const raw = notify([block('缓存')])+frame('SSE_REPLY_END',{end_type:1,usage})+end(3);
  const deltas = await collect(decodeEvents(response(raw)));
  assert.deepEqual(deltas.at(-1),{usage});
  const make = async function*(){yield* deltas;};
  const complete = await collect(completionChunks(make(),body,{requestId:'usage'}));
  assert.deepEqual(complete[0].usage,usage);
  const parsed = parseChat({...body,stream:true,stream_options:{include_usage:true}});
  assert.equal(parsed.stream_options.include_usage,true);
  const wire = (await collect(completionChunks(make(),parsed,{requestId:'usage'}))).join('');
  const events = wire.split('\n\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
  assert.deepEqual(events.at(-1).choices,[]);
  assert.deepEqual(events.at(-1).usage,usage);
  assert(events.every(event=>event.choices.every(choice=>choice.delta.usage===undefined)));
  const toolRows = await collect(toolDeltas(make(),{parse:content=>({content})}));
  assert.deepEqual(toolRows.find(row=>row.usage)?.usage,usage);
});

test('缺少上游用量时省略 usage，usage-only 回复仍报告空输出',async()=>{
  const make = async function*(){yield {content:'短答'};};
  const complete = await collect(completionChunks(make(),body,{requestId:'unknown-usage'}));
  assert.equal(complete[0].usage,undefined);
  const usageOnly = async function*(){yield {usage:{prompt_tokens:7,completion_tokens:0,total_tokens:7}};};
  await assert.rejects(collect(completionChunks(usageOnly(),body)),error=>error.type==='upstream_empty_response');
});

test('Magpie 正常入口将编码短回复和用量送到客户端，协议错误保留具体类型',async()=>{
  const usage = {prompt_tokens:7,completion_tokens:3,total_tokens:10};
  let raw = end(1)+snapshot([block('缓存保存数据副本。')],'message',true)+end(2)+
    frame('SSE_REPLY_END',{end_type:3,usage});
  const auth = {type:'oauth',uid:'fixture',access:'fixture',doubao:{state:'ready'},
    refresh:JSON.stringify({version:1,session:{cookieHeader:'sessionid=fixture'}})};
  const plugin = createDoubaoPlugin({client:{auth:{set:async()=>{throw Error('Unexpected auth write');}}}},
    {readDevice:async()=>undefined,doubao:{chat:()=>decodeEvents(response(raw))}});
  const loader = await plugin.auth.loader(async()=>auth);
  const ask = stream => loader.fetch('https://www.doubao.com/v1/chat/completions',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...body,stream,stream_options:{include_usage:true}}),
  });
  const complete = await ask(false);
  assert.equal(complete.status,200);
  const value = await complete.json();
  assert.equal(value.choices[0].message.content,'缓存保存数据副本。');
  assert.deepEqual(value.usage,usage);
  const stream = await ask(true);
  const wire = await stream.text();
  assert.match(wire,/缓存保存数据副本。/);assert.match(wire,/"choices":\[\],"usage"/);assert.match(wire,/\[DONE\]/);
  raw = snapshot([block('部分')])+end(1);
  const broken = await ask(false);
  assert.equal(broken.status,502);
  const error = (await broken.json()).error;
  assert.equal(error.type,'upstream_stream_error');assert.match(error.message,/正式结束标记/);
  assert.equal(auth.doubao.state,'ready');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseChat,completionChunks} from '../native/completion.mjs';
import {createToolTurn,toolDeltas} from '../native/tool-calling.mjs';
import {createDoubaoClient} from '../native/doubao-client.mjs';

const tool={type:'function',function:{name:'read',description:'Read a text file',
  parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}};
const input={model:'fixture',messages:[{role:'user',content:'read the file'}],tools:[tool]};
const marker=turn=>turn.prompt.match(/magpie_calls_[a-f0-9]+/)[0];
const wire=(turn,calls)=>JSON.stringify({[marker(turn)]:calls});
async function collect(generator){const values=[];for await(const value of generator)values.push(value);return values;}
async function* pieces(text){for(let index=0;index<text.length;index+=3)yield {content:text.slice(index,index+3)};}

test('工具声明和调用历史完整保留，空工具列表与禁用工具均可使用',()=>{
  const call={id:'call_history',type:'function',function:{name:'read',arguments:'{"path":"file.txt"}'}};
  const messages=[...input.messages,{role:'assistant',content:null,tool_calls:[call]},
    {role:'tool',tool_call_id:call.id,content:[{type:'text',text:'result'}]}];
  const body=parseChat({...input,messages});
  assert.deepEqual(body.tools,[tool]);
  assert.deepEqual(body.messages[1].tool_calls,[call]);
  assert.equal(body.messages[2].tool_call_id,call.id);
  assert.equal(body.messages[2].content,'result');
  assert.equal(createToolTurn(parseChat({...input,tools:[]})).active,false);
  const none=createToolTurn(parseChat({...input,tool_choice:'none'}));
  assert.equal(none.active,false);
  assert.equal(none.prompt,'read the file');
});

test('无效工具参数及缺失关联 ID 在请求边界返回明确错误',()=>{
  const invalid=[
    {tools:{}},{tools:[tool,tool]},{tools:[{type:'custom',custom:{name:'read'}}]},
    {tools:[{type:'function',function:{name:'read',parameters:[]}}]},
    {tools:[{...tool,function:{...tool.function,strict:true}}]},
    {tool_choice:'unknown'},{tools:[],tool_choice:'required'},
    {tool_choice:{type:'function',function:{name:'unknown'}}},
    {parallel_tool_calls:'false'},{functions:[]},
    {messages:[...input.messages,{role:'tool',content:'result'}]},
    {messages:[...input.messages,{role:'assistant',content:null,tool_calls:[{type:'function'}]}]},
  ];
  for(const value of invalid)assert.throws(()=>parseChat({...input,...value}),error=>error.status===400);
});

test('普通 JSON 回复保持文本，工具选择要求在解析回复时执行',()=>{
  const auto=createToolTurn(parseChat(input));
  assert.deepEqual(auto.parse('{"ok":true}'),{content:'{"ok":true}'});
  const required=createToolTurn(parseChat({...input,tool_choice:'required'}));
  assert.throws(()=>required.parse('I will read it.'),error=>error.type==='invalid_tool_call');
  assert.throws(()=>auto.parse('{"'+marker(auto)+'":['),error=>error.type==='invalid_tool_call');
  for(const calls of [[],[{name:'unknown',arguments:{}}],[{name:'read',arguments:'{}'}]])
    assert.throws(()=>auto.parse(wire(auto,calls)),error=>error.type==='invalid_tool_call');
});

test('指定工具和并行开关限定返回的调用，参数 JSON 与调用 ID 保持完整',()=>{
  const second={...tool,function:{...tool.function,name:'lookup'}};
  const selected=createToolTurn(parseChat({...input,tools:[tool,second],tool_choice:{type:'function',function:{name:'lookup'}}}));
  assert.throws(()=>selected.parse(wire(selected,[{name:'read',arguments:{}}])),error=>error.type==='invalid_tool_call');
  const turn=createToolTurn(parseChat({...input,tools:[tool,second]}));
  const requested=[{name:'read',arguments:{path:'C:\\工具\\文件.txt'}},{name:'lookup',arguments:{value:'line\n"quoted"'}}];
  const result=turn.parse(wire(turn,requested)).tool_calls;
  assert.deepEqual(result.map(call=>call.index),[0,1]);
  assert.notEqual(result[0].id,result[1].id);
  assert.deepEqual(result.map(call=>JSON.parse(call.function.arguments)),requested.map(call=>call.arguments));
  const single=createToolTurn(parseChat({...input,parallel_tool_calls:false}));
  assert.throws(()=>single.parse(wire(single,[requested[0],requested[0]])),error=>error.type==='invalid_tool_call');
});

test('纯工具非流式和 SSE 回复使用 tool_calls 结束，控制 JSON 不泄露为正文',async()=>{
  const body=parseChat(input),turn=createToolTurn(body);
  const raw=wire(turn,[{name:'read',arguments:{path:'文件.txt'}}]);
  const [reply]=await collect(completionChunks(toolDeltas(pieces(raw),turn),body,{requestId:'fixture'}));
  assert.equal(reply.choices[0].finish_reason,'tool_calls');
  assert.equal(reply.choices[0].message.content,null);
  const call=reply.choices[0].message.tool_calls[0];
  assert.equal(call.index,undefined);
  assert.equal(call.function.name,'read');
  assert.deepEqual(JSON.parse(call.function.arguments),{path:'文件.txt'});
  const events=await collect(completionChunks(toolDeltas(pieces(raw),turn),{...body,stream:true},{requestId:'fixture'}));
  const wireText=events.join('');
  assert(!wireText.includes(marker(turn)));
  assert.match(wireText,/"finish_reason":"tool_calls"/);
  assert.match(wireText,/"index":0,"id":"call_/);
  assert.equal(events.at(-1),'data: [DONE]\n\n');
});

test('原生请求包含工具定义和结果关联，下一回合可以继续返回文本',async()=>{
  let returnedCall;
  const client=createDoubaoClient({readDevice:async()=> 'fixture-device',fetchImpl:async(raw,options)=>{
    const url=new URL(raw);
    if(url.pathname==='/alice/user/launch')return Response.json({data:{assistant_bot_id:'fixture-bot'}});
    if(url.pathname==='/alice/slot/action_bar_v3/brief_list')return Response.json({data:{entry_list:[{
      active_switch_conf:{menu_conf:{item_list:[{model_item_key:'fixture'}]}}
    }]}});
    const prompt=JSON.parse(options.body).messages[0].content_block[0].content.text_block.text;
    const declaration=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));
    assert.deepEqual(declaration.tools,[tool]);
    let text;
    if(declaration.messages.at(-1).role==='tool'){
      assert.equal(declaration.messages.at(-1).tool_call_id,returnedCall.id);
      text='Completed '+declaration.messages.at(-1).content;
    }else text=JSON.stringify({[prompt.match(/magpie_calls_[a-f0-9]+/)[0]]:[{name:'read',arguments:{path:'file.txt'}}]});
    return new Response('event: CHUNK_DELTA\ndata: '+JSON.stringify({text})+'\n\nevent: SSE_REPLY_END\ndata: {}\n\n',
      {headers:{'Content-Type':'text/event-stream'}});
  }});
  const session={cookieHeader:'sessionid=fixture'};
  const first=await collect(client.chat(session,parseChat(input)));
  returnedCall=first[0].tool_calls[0];
  const next=parseChat({...input,messages:[...input.messages,
    {role:'assistant',content:null,tool_calls:[returnedCall]},
    {role:'tool',tool_call_id:returnedCall.id,content:'fixture-result'}]});
  assert.deepEqual(await collect(client.chat(session,next)),[{content:'Completed fixture-result'}]);
});

test('工具 JSON 等待期间取消请求会关闭上游，保持原始取消原因',async()=>{
  let started,cancelled=false;
  const waiting=new Promise(resolve=>{started=resolve;});
  const client=createDoubaoClient({readDevice:async()=> 'fixture-device',fetchImpl:async raw=>{
    const path=new URL(raw).pathname;
    if(path==='/alice/user/launch')return Response.json({data:{assistant_bot_id:'fixture-bot'}});
    if(path==='/alice/slot/action_bar_v3/brief_list')return Response.json({data:{entry_list:[{
      active_switch_conf:{menu_conf:{item_list:[{model_item_key:'fixture'}]}}
    }]}});
    return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('event: CHUNK_DELTA\ndata: {"text":"{"}\n\n'));started();
    },cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}});
  }});
  const abort=new AbortController();
  const pending=collect(client.chat({cookieHeader:'sessionid=fixture'},parseChat(input),{signal:abort.signal}));
  await waiting;const reason=new Error('fixture cancellation');abort.abort(reason);
  await assert.rejects(pending,error=>error===reason);
  assert.equal(cancelled,true);
});

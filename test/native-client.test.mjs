import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProviderError} from '../native/protocol.mjs';
test('710022004 与额度、普通限流分开，错误不回显上游凭据',()=>{
 const error=normalizeProviderError({code:710022004,message:'COOKIE_SECRET'});
 assert.equal(error.type,'account_verification_required');assert.equal(error.upstream_code,710022004);assert.equal(error.retryable,false);assert.equal(error.status,429);assert(!error.message.includes('COOKIE_SECRET'));
});

import {createDoubaoClient} from '../native/doubao-client.mjs';
const s={cookieHeader:'sessionid=fixture-only'};
const frame=(event,v)=>'event: '+event+'\r\ndata: '+JSON.stringify(v)+'\r\n\r\n';
const meta={data:{entry_list:[{active_switch_conf:{menu_conf:{item_list:[{model_item_key:'fixture-model',name:'Fixture Model'}]}}}]}};
const reply=v=>new Response(JSON.stringify(v),{headers:{'Content-Type':'application/json'}});
function mock(chat){
 const seen=[];
 return {seen,client:createDoubaoClient({readDevice:async()=>undefined,fetchImpl:async(raw,options)=>{
  const u=new URL(raw);assert.equal(u.origin,'https://www.doubao.com');
  assert.equal(options.redirect,'error');assert.equal(options.headers.Cookie,s.cookieHeader);
  seen.push(u.pathname);
  switch(u.pathname){
   case '/passport/account/info/v2/':
    assert.equal(options.method,'GET');return reply({message:'success',data:{user_id_str:'999999999999999999',name:'示例'}});
   case '/alice/user/launch':return reply({data:{assistant_bot_id:'fixture-bot',ug_campaign_info:{campaign_group_code:'fixture'}}});
   case '/alice/slot/action_bar_v3/brief_list':return reply(meta);
   case '/chat/completion':
    assert.equal(JSON.parse(options.body).client_meta.bot_id,'fixture-bot');return chat();
   default:throw Error('unexpected path');
  }
 }})};
}
const msg={model:'fixture-model',messages:[{role:'user',content:'你好'}]};
async function consume(g){const list=[];for await(const item of g)list.push(item);return list;}
test('自有豆包适配器固定 HTTPS 目的地；保留身份字符串与 UTF-8 分片',async()=>{
 const {client,seen}=mock(()=>{
  const raw=Buffer.from(frame('CHUNK_DELTA',{text:'你好'})+frame('SSE_REPLY_END',{}));
  const stream=new ReadableStream({start(c){for(const b of raw)c.enqueue(Uint8Array.of(b));c.close();}});
  return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8'}});
 });
 assert.deepEqual(await client.identity(s),{identity:'999999999999999999:0',name:'示例'});
 assert.deepEqual(await client.models(s),['fixture-model']);
 assert.deepEqual(await consume(client.chat(s,msg)),[{content:'你好'}]);
 assert.deepEqual(seen,['/passport/account/info/v2/','/alice/user/launch','/alice/slot/action_bar_v3/brief_list','/chat/completion']);
});
test('上游 JSON、SSE 验证错误均保留代码，断流不被当成正常完成',async()=>{
 const options={headers:{'Content-Type':'text/event-stream'}};
 for(const make of [
  ()=>reply({error_code:710022004,message:'COOKIE_SECRET'}),
  ()=>new Response(frame('SSE_REPLY_ERROR',{error:{code:710022004,message:'COOKIE_SECRET'}}),options),
 ]){
  const {client}=mock(make);
  await assert.rejects(consume(client.chat(s,msg)),e=>e.status===429&&e.upstream_code===710022004&&!e.message.includes('COOKIE_SECRET'));
 }
 const {client}=mock(()=>new Response(frame('CHUNK_DELTA',{text:'part'}),options));
 await assert.rejects(consume(client.chat(s,msg)),/正式结束标记/);
});

test('额度字段向 Magpie 保留未知百分比与免限状态',async()=>{
 const client=createDoubaoClient({readDevice:async()=>undefined,fetchImpl:async raw=>{
  if(new URL(raw).pathname.endsWith('/entry/config/'))return reply({data:{membership_display_name:'Fixture'}});
  return reply({data:{member_info:{hasActiveSubscription:true},window_limit_section:{window_limit_groups:[{
   feature_group_name:'文本',window_limits:[
    {window_type:1,exemption:{active:true},used_percent:100,used_amount:10,total_amount:10},
    {window_type:2},
    {window_type:4,used_amount:3,total_amount:12},
   ],
  }]}}});
 }});
 const data=await client.quota(s);
 assert.equal(data.windows[0].view,'不限');
 assert.equal(data.windows[0].used,undefined);
 assert.equal(data.windows[0].limit,undefined);
 assert.equal(data.windows[1].used,undefined);
 assert.equal(data.windows[2].used,25);
 assert.equal(data.windows[2].amount,3);
 assert.equal(data.windows[2].limit,12);
});

test('聊天请求保留账号设备优先级，并让 device_id 与 fp 使用同一设备',async()=>{
 const cases=[
  {session:{...s,deviceId:'account-device',fingerprint:'web-fingerprint'},device:'account-device'},
  {session:{cookieHeader:s.cookieHeader+'; device_id=cookie-device'},device:'cookie-device'},
  {session:{...s,fingerprint:'web-fingerprint'},device:'desktop-device'},
 ];
 for(const {session,device} of cases){
  const paths=[];
  const client=createDoubaoClient({readDevice:async()=>{
   assert.equal(device,'desktop-device');return 'desktop-device';
  },fetchImpl:async raw=>{
   const url=new URL(raw);
   assert.equal(url.searchParams.get('device_id'),device);
   assert.equal(url.searchParams.get('fp'),'verify_'+device);
   paths.push(url.pathname);
   if(url.pathname==='/alice/user/launch')return reply({data:{assistant_bot_id:'fixture-bot'}});
   if(url.pathname==='/alice/slot/action_bar_v3/brief_list')return reply(meta);
   return new Response(frame('CHUNK_DELTA',{text:'OK'})+frame('SSE_REPLY_END',{}),
    {headers:{'Content-Type':'text/event-stream'}});
  }});
  assert.deepEqual(await consume(client.chat(session,msg)),[{content:'OK'}]);
  assert.deepEqual(paths,['/alice/user/launch','/alice/slot/action_bar_v3/brief_list','/chat/completion']);
 }
});

test('未找到桌面设备时保留原会话的指纹参数',async()=>{
 const client=createDoubaoClient({readDevice:async()=>undefined,fetchImpl:async raw=>{
  const url=new URL(raw);
  assert.equal(url.searchParams.has('device_id'),false);
  assert.equal(url.searchParams.get('fp'),'web-fingerprint');
  return url.pathname==='/alice/user/launch'?reply({data:{assistant_bot_id:'fixture-bot'}}):reply(meta);
 }});
 assert.deepEqual(await client.models({...s,fingerprint:'web-fingerprint'}),['fixture-model']);
});

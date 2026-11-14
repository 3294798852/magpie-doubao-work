import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {access} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createDoubaoPlugin} from '../magpie/provider.mjs';
import DoubaoWorkPlugin from '../magpie/index.mjs';

const messages = [{role:'user',content:'你好'}];
const backup = (cookie = 'alpha', version = 3) => JSON.stringify(version === 3 ? {
  schema:'doubao-work-accounts/v1',version:3,
  accounts:[{id:'file-id',provider:'doubaowork',name:'文件中的名字',session:{cookieHeader:'sessionid='+cookie}}],
} : {version:2,accounts:[{id:'file-id',provider:'doubaowork',desktop:false,name:'旧账号',pluginIdentity:'fixture:'+cookie,
  pluginSecret:{cookieHeader:'sessionid='+cookie}}]});

function runtime(overrides = {},options = {}) {
  const auths = new Map(), scope = new AsyncLocalStorage();
  const doubao = {
    identity:async session => ({identity:session.cookieHeader.split('=')[1]+':0',name:'官方名字'}),
    models:async () => ['fixture-model'],
    quota:async () => ({plan:'测试计划',windows:[{label:'5 小时',view:'已用 25%',used:25}]}),
    async *chat() { yield {content:'你好'}; },
    ...overrides,
  };
  const input = {client:{auth:{async set({path,body}) {
    assert.equal(path.id,'doubaowork');
    assert(scope.getStore(),'auth.set must run in an account scope');
    auths.set(scope.getStore(),structuredClone(body));
  }}}};
  const settings = {doubao,readDevice:async () => undefined,...options};
  let plugin = createDoubaoPlugin(input,settings);
  const run = (key,operation) => scope.run(key,() => operation(async () => structuredClone(auths.get(key))));
  return {
    get plugin() { return plugin; }, auths,run,
    restart() { plugin = createDoubaoPlugin(input,settings); },
    async login(key = 'A',cookie = 'alpha',version = 3) {
      const [result] = await plugin.auth.import([backup(cookie,version)]);
      assert.equal(result.type,'success');
      auths.set(key,{...result,type:'oauth'});
      return result;
    },
    async ask(key = 'A',body = {},init = {}) {
      return run(key,async getAuth => {
        const loader = await plugin.auth.loader(getAuth);
        return loader.fetch('https://www.doubao.com/v1/chat/completions',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({model:'fixture-model',messages,...body}),...init,
        });
      });
    },
  };
}

test('Magpie 包入口、供应商配置与真实模型能力',async () => {
  const plugin = await DoubaoWorkPlugin({client:{}});
  const config = {};
  plugin.config(config);
  assert.equal(plugin.auth.provider,'doubaowork');
  assert.equal(plugin.auth.maxConcurrency,1);
  assert.equal(config.provider.doubaowork.npm,'@ai-sdk/openai-compatible');
  assert.deepEqual(config.provider.doubaowork.models,{});
  assert.deepEqual(await plugin.provider.models({},{}),{});
  const r = runtime(); await r.login();
  const models = await r.plugin.provider.models({},{auth:r.auths.get('A')});
  assert.deepEqual(Object.keys(models),['fixture-model']);
  assert.equal(models['fixture-model'].capabilities.toolcall,true);
  assert.equal(models['fixture-model'].capabilities.input.image,false);
  assert.equal(models['fixture-model'].api.id,'fixture-model');
});

test('v2/v3 账号导入向上游核验身份，错类文件与失效会话分别失败',async () => {
  const r = runtime({identity:async session => {
    if (session.cookieHeader.endsWith('bad')) throw Error('PRIVATE_FIXTURE');
    return {identity:'verified:0',name:'官方名字'};
  }});
  for (const version of [2,3]) {
    const result = await r.login('A','alpha',version);
    assert.equal(result.accountId,'verified:0');
    assert.equal(result.name,'官方名字');
    assert.equal(JSON.parse(result.refresh).session.cookieHeader,'sessionid=alpha');
  }
  const results = await r.plugin.auth.import(['{}',backup('bad'),backup('good')]);
  assert.deepEqual(results.map(result => result.type),['failed','failed','success']);
  assert(!JSON.stringify(results.slice(0,2)).includes('PRIVATE_FIXTURE'));
  const nodes = await r.plugin.auth.import([JSON.stringify({schema:'doubao-work-nodes/v1',nodes:[]})]);
  assert.equal(nodes[0].type,'failed');
});

test('新登录固化设备信息，迁入另一主机后使用账号自己的上下文',async()=>{
  const source=runtime({}, {readDevice:async()=> 'source-device'});
  const signed=await source.login();
  const session=JSON.parse(signed.refresh).session;
  assert.equal(session.deviceId,'source-device');
  assert.equal(session.fingerprint,'verify_source-device');
  const target=runtime({async *chat(received){
    assert.deepEqual(received,session);yield {content:'portable'};
  }},{readDevice:async()=>assert.fail('Destination device must not be read.')});
  const text=JSON.stringify({schema:'doubao-work-accounts/v1',version:3,
    accounts:[{id:'portable',provider:'doubaowork',session}]});
  const [result]=await target.plugin.auth.import([text]);
  assert.equal(result.type,'success');
  target.auths.set('A',{...result,type:'oauth'});
  assert.equal((await (await target.ask()).json()).choices[0].message.content,'portable');
});

test('旧 Magpie 登录补齐设备后持久保存，保留暂停和签到状态',async()=>{
  let lookups=0;
  const r=runtime({}, {readDevice:async()=>{lookups++;return 'legacy-device';}});
  r.auths.set('A',{type:'oauth',uid:'legacy:0',access:'legacy-generation',
    refresh:JSON.stringify({version:1,session:{cookieHeader:'sessionid=legacy'}}),
    doubao:{state:'needs_verification',attempt:{day:'2026-11-13',reserved:true,status:'pending'}}});
  const state=structuredClone(r.auths.get('A').doubao);
  await r.run('A',getAuth=>r.plugin.auth.loader(getAuth));
  assert.equal(JSON.parse(r.auths.get('A').refresh).session.deviceId,'legacy-device');
  assert.deepEqual(r.auths.get('A').doubao,state);
  r.restart();
  await r.run('A',getAuth=>r.plugin.auth.loader(getAuth));
  assert.equal(lookups,1);
});

test('设备查询期间替换登录，旧会话升级保持新登录资料',async()=>{
  let started,release;
  const waiting=new Promise(resolve=>{started=resolve;});
  const blocked=new Promise(resolve=>{release=resolve;});
  const r=runtime({}, {readDevice:async()=>{started();await blocked;return 'old-device';}});
  r.auths.set('A',{type:'oauth',uid:'same:0',access:'old-generation',
    refresh:JSON.stringify({version:1,session:{cookieHeader:'sessionid=old'}}),doubao:{state:'ready'}});
  const migration=r.run('A',getAuth=>r.plugin.auth.loader(getAuth));
  await waiting;
  const replacement={type:'oauth',uid:'same:0',access:'new-generation',
    refresh:JSON.stringify({version:1,session:{cookieHeader:'sessionid=new',deviceId:'new-device',fingerprint:'verify_new-device'}}),
    doubao:{state:'ready'}};
  r.auths.set('A',structuredClone(replacement));
  release();await migration;
  assert.deepEqual(r.auths.get('A'),replacement);
});

test('非流式文本与推理共用响应编码器，保留角色和文本分块',async () => {
  let received;
  const r = runtime({async *chat(session,body) {
    received = {session,body};
    yield {reasoning_content:'思考'}; yield {content:'你好'}; yield {content:'，世界'};
  }});
  await r.login();
  const response = await r.ask('A',{messages:[{role:'system',content:'简洁回答'},
    {role:'user',content:[{type:'text',text:'问候'}]}]});
  assert.equal(response.status,200);
  const value = await response.json();
  assert.equal(value.choices[0].message.content,'你好，世界');
  assert.equal(value.choices[0].message.reasoning_content,'思考');
  assert.deepEqual(received.body.messages,[{role:'system',content:'简洁回答'},{role:'user',content:'问候'}]);
  assert.equal(received.session.cookieHeader,'sessionid=alpha');
  assert(!JSON.stringify(value).includes('sessionid'));
  assert.equal((await r.ask('A',{tools:[]})).status,200);
  assert.equal((await r.ask('A',{messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.test'}}]}]})).status,400);
});

test('Magpie 纯工具回复和工具结果回传使用完整消息与结束原因',async()=>{
  const tool={type:'function',function:{name:'lookup',parameters:{type:'object'}}};
  const call={index:0,id:'call_fixture',type:'function',function:{name:'lookup',arguments:'{}'}};
  const r=runtime({async *chat(_session,body){
    assert.deepEqual(body.tools,[tool]);
    const last=body.messages.at(-1);
    if(last.role==='tool'){
      assert.equal(last.tool_call_id,call.id);yield {content:last.content};
    }else yield {tool_calls:[call]};
  }});
  await r.login();
  const first=await (await r.ask('A',{tools:[tool]})).json();
  assert.equal(first.choices[0].finish_reason,'tool_calls');
  assert.equal(first.choices[0].message.content,null);
  assert.equal(first.choices[0].message.tool_calls[0].id,call.id);
  const next=await r.ask('A',{tools:[tool],stream:true,messages:[...messages,
    first.choices[0].message,{role:'tool',tool_call_id:call.id,content:'client-result'}]});
  assert.equal(next.status,200);
  const text=await next.text();
  assert.match(text,/client-result/);assert.match(text,/"finish_reason":"stop"/);assert.match(text,/\[DONE\]/);
});

test('流式文本、推理与正式结束标记；断流输出错误事件',async () => {
  let broken = false;
  const r = runtime({async *chat() {
    yield {reasoning_content:'推理'}; yield {content:'回答'};
    if (broken) throw Error('PRIVATE_RAW');
  }});
  await r.login();
  const good = await (await r.ask('A',{stream:true})).text();
  assert.match(good,/reasoning_content/); assert.match(good,/回答/); assert.match(good,/\[DONE\]/);
  broken = true;
  const bad = await r.run('A',async () => (await r.ask('A',{stream:true})).text());
  assert.match(bad,/event: error/); assert(!bad.includes('[DONE]')); assert(!bad.includes('PRIVATE_RAW'));
});

test('验证状态跨重启保存，每个新聊天重新取得上游结果，额度查询保留状态',async () => {
  const calls = [];
  const r = runtime({async *chat(session) { calls.push(session.cookieHeader); throw {upstream_code:710022004}; }});
  await r.login('A','alpha'); await r.login('B','bravo');
  const response = await r.ask('A');
  assert.equal(response.status,429);
  assert.equal(response.headers.get('x-should-retry'),'false');
  assert.equal((await response.json()).error.code,710022004);
  assert.equal(r.auths.get('A').doubao.state,'needs_verification');
  assert.equal(r.auths.get('B').doubao.state,'ready');
  r.restart();
  const usage = await r.run('A',getAuth => r.plugin.auth.usage(getAuth));
  assert.equal(usage.windows[0].used,25);
  assert.equal(r.auths.get('A').doubao.state,'needs_verification');
  assert.equal((await r.ask('A')).status,429);
  assert.deepEqual(calls,['sessionid=alpha','sessionid=alpha']);
});

test('Magpie 模型菜单和 models API 使用上游名称，数字 ID 继续用于调用',async()=>{
  const r=runtime({modelDetails:async()=>({'5':{name:'豆包 2.1 Pro'},'9':{name:'自动'}}),
    async *chat(_session,body){assert.equal(body.model,'5');yield {content:'model-five'};}});
  await r.login();
  const models=await r.plugin.provider.models({},{auth:r.auths.get('A')});
  assert.equal(models['5'].name,'豆包 2.1 Pro');assert.equal(models['9'].name,'自动');
  assert.equal(models['5'].api.id,'5');assert.equal(models['9'].api.id,'9');
  const loader=await r.run('A',getAuth=>r.plugin.auth.loader(getAuth));
  const list=await (await loader.fetch('https://www.doubao.com/v1/models')).json();
  assert.deepEqual(list.data.map(({id,name})=>({id,name})),[{id:'5',name:'豆包 2.1 Pro'},{id:'9',name:'自动'}]);
  assert.equal((await (await r.ask('A',{model:'5'})).json()).choices[0].message.content,'model-five');
});

test('官网验证后原会话的新聊天成功即可恢复，签到记录和其他账号保留',async()=>{
  let verified=false,calls=0;
  const r=runtime({async *chat(){calls++;if(!verified)throw {upstream_code:710022004};yield {content:'recovered'};}});
  await r.login('A');await r.login('B','bravo');
  const attempt={day:'2026-11-14',reserved:true,status:'pending'};
  r.auths.get('A').doubao.attempt=attempt;
  assert.equal((await r.ask('A')).status,429);
  const refresh=r.auths.get('A').refresh;
  r.restart();verified=true;
  const response=await r.ask('A');
  assert.equal(response.status,200);assert.equal((await response.json()).choices[0].message.content,'recovered');
  assert.equal(calls,2);assert.equal(r.auths.get('A').refresh,refresh);
  assert.equal(r.auths.get('A').doubao.state,'ready');assert.equal(r.auths.get('A').doubao.upstreamCode,0);
  assert.deepEqual(r.auths.get('A').doubao.attempt,attempt);assert.equal(r.auths.get('B').doubao.state,'ready');
});

test('恢复中的聊天遇到断流保持验证状态，成功回合保留并发的新失败',async()=>{
  const interrupted=runtime({async *chat(){yield {content:'partial'};throw Error('fixture disconnect');}});
  await interrupted.login();interrupted.auths.get('A').doubao={state:'needs_verification',upstreamCode:710022004};
  assert.equal((await interrupted.ask()).status,502);
  assert.equal(interrupted.auths.get('A').doubao.state,'needs_verification');
  const stop=new AbortController(),reason=Error('fixture cancellation');
  const cancelled=runtime({async *chat(){yield {content:'partial'};stop.abort(reason);}});
  await cancelled.login();cancelled.auths.get('A').doubao={state:'needs_verification'};
  await assert.rejects(cancelled.ask('A',{}, {signal:stop.signal}),error=>error===reason);
  assert.equal(cancelled.auths.get('A').doubao.state,'needs_verification');
  let release;
  const wait=new Promise(resolve=>{release=resolve;});
  const r=runtime({async *chat(){yield {content:'first'};await wait;yield {content:'last'};},
    quota:async()=>{throw {upstream_code:710022004};}});
  await r.login();r.auths.get('A').doubao={state:'needs_verification',lastRequestId:'old'};
  const response=await r.ask('A',{stream:true}),result=response.text();
  await r.run('A',getAuth=>r.plugin.auth.usage(getAuth));
  const failure=r.auths.get('A').doubao.lastRequestId;
  release();assert.match(await result,/first/);
  assert.equal(r.auths.get('A').doubao.state,'needs_verification');assert.equal(r.auths.get('A').doubao.lastRequestId,failure);
});

test('流中验证错误不输出成功结尾，登录失效告知 Magpie',async () => {
  const r = runtime({async *chat() { yield {content:'partial'}; throw {upstream_code:710022004}; }});
  await r.login();
  const text = await r.run('A',async () => (await r.ask('A',{stream:true})).text());
  assert.match(text,/710022004/); assert(!text.includes('[DONE]'));
  assert.equal(r.auths.get('A').doubao.state,'needs_verification');
  const expired = runtime({async *chat() { throw {status:401}; }}); await expired.login();
  const response = await expired.ask();
  assert.equal(response.status,401); assert.equal(response.headers.get('x-magpie-sign-in'),'expired');
  assert.equal(expired.auths.get('A').doubao.state,'needs_login');
});

test('流式取消释放账号且按需拉取，调用者中止传递给豆包',async () => {
  let produced = 0,closed = 0;
  const r = runtime({async *chat(_session,_body,{signal}) {
    try { produced++; yield {content:'first'}; await delay(10000,undefined,{signal}); yield {content:'late'}; }
    finally { closed++; }
  }});
  await r.login();
  const response = await r.ask('A',{stream:true});
  await delay(10); assert.equal(produced,1);
  await response.body.cancel(); assert.equal(closed,1);
  const abort = new AbortController();
  const next = await r.ask('A',{stream:true},{signal:abort.signal});
  const reader = next.body.getReader();
  await reader.read(); await reader.read();
  const pending = reader.read(); abort.abort();
  await assert.rejects(pending); assert.equal(closed,2);
});

test('新登录覆盖期间旧请求失败不污染替换会话',async () => {
  let reject,started;
  const began = new Promise(resolve => { started = resolve; });
  const r = runtime({async *chat() { started(); await new Promise((_resolve,no) => { reject = no; }); }});
  await r.login();
  const request = r.ask(); await began;
  await r.login('A','fresh'); reject({upstream_code:710022004});
  assert.equal((await request).status,429);
  assert.equal(r.auths.get('A').doubao.state,'ready');
});

test('签到提交前持久预约，超时、重启及并发操作保持单次提交',async () => {
  let claims = 0,queries = 0;
  const r = runtime({async checkin(_session,{queryOnly,reserve}) {
    queries++;
    if (queryOnly) return {status:'pending'};
    await reserve(); claims++; throw Error('claim timeout');
  }},{now:() => Date.parse('2026-11-13T10:00:00+08:00')});
  await r.login();
  const check = () => r.run('A',getAuth => r.plugin.auth.checkin(getAuth));
  assert.equal((await check()).outcome,'failed');
  assert.equal(r.auths.get('A').doubao.attempt.reserved,true);
  r.restart();
  const results = await Promise.all([check(),check()]);
  assert(results.every(result => result.outcome === 'failed'));
  assert.equal(claims,1); assert.equal(queries,2);
});

test('浏览器登录复用隔离会话并清理临时目录，支持取消',async () => {
  let profile,closed = 0,loggedIn = true,onLaunch;
  const r = runtime({}, {browserOptions:{pollMs:1,discover:async () => [{id:'chrome',name:'Fixture Chrome'}],
    launch:async (_browser,path) => {
      profile = path;
      onLaunch?.();
      return {cookies:async () => loggedIn ? [{name:'sessionid',value:'fixture',domain:'.doubao.com',path:'/'}] : [],
        dispose:async () => { closed++; }};
    },
  }});
  const method = r.plugin.auth.methods[0];
  const auth = await method.authorize();
  assert.equal(auth.opened,true);
  assert.equal((await auth.callback()).type,'success');
  assert.equal(closed,1); await assert.rejects(access(profile));
  loggedIn = false;
  const abort = new AbortController();
  const launched = new Promise(resolve => { onLaunch = resolve; });
  const cancelled = auth.callback(undefined,{signal:abort.signal});
  await launched;
  abort.abort();
  await assert.rejects(cancelled);
  assert.equal(closed,2); await assert.rejects(access(profile));
});

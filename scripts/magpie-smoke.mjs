import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {desktopStatePaths} from '../native/desktop-device.mjs';

const bun = process.env.MAGPIE_BUN_BIN;
const hostFile = process.env.MAGPIE_HOST_FILE;
if (!bun || !hostFile) throw Error('请设置 MAGPIE_BUN_BIN 和 MAGPIE_HOST_FILE，分别指向 Bun 与 Magpie 源码 internal/plugin/host.js。');
const project = resolve(process.env.DW_PLUGIN_PACKAGE || fileURLToPath(new URL('../',import.meta.url)));
const root = await mkdtemp(join(tmpdir(),'doubaowork-magpie-host-'));
const authPath = join(root,'auth.json'), fixture = join(root,'fixture.mjs'), callsPath = join(root,'calls.jsonl');
const checks = [];
const deviceEnv = {...process.env,LOCALAPPDATA:join(root,'device-data'),HOME:root,XDG_CONFIG_HOME:join(root,'.config')};
let host;

function startHost() {
  const child = spawn(bun,['--preload',fixture,hostFile],{cwd:root,env:deviceEnv,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending = new Map();
  let sequence = 0, stderr = '';
  child.stderr.on('data',chunk => { stderr = (stderr+chunk).slice(-8192); });
  createInterface({input:child.stdout}).on('line',line => {
    let packet;
    try { packet = JSON.parse(line); } catch { return; }
    const waiter = pending.get(packet.id);
    if (!waiter) return;
    if (packet.event === 'head') { waiter.head = packet; return; }
    if (packet.event === 'chunk') { waiter.chunks.push(Buffer.from(packet.data,'base64')); return; }
    pending.delete(packet.id); clearTimeout(waiter.timer);
    if (packet.error) waiter.reject(Error(packet.error.message));
    else waiter.resolve(waiter.head ? {status:waiter.head.status,headers:waiter.head.headers,
      text:Buffer.concat(waiter.chunks).toString('utf8')} : packet.result);
  });
  child.on('error',error => { for (const waiter of pending.values()) waiter.reject(error); });
  child.on('exit',() => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error('Magpie 宿主已退出。'+stderr)); }
    pending.clear();
  });
  return {
    rpc(method,params = {}) {
      const id = ++sequence;
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error('Magpie 宿主调用超时。'+stderr)); },30000);
        pending.set(id,{resolve,reject,timer,chunks:[]});
        child.stdin.write(JSON.stringify({id,method,params})+'\n');
      });
    },
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill(),5000);
        child.once('exit',() => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
    },
  };
}

async function init() {
  host = startHost();
  const result = await host.rpc('init',{authPath,directory:join(root,'work'),
    plugins:[{spec:project,target:project}]});
  assert(!result.plugins[0].error,result.plugins[0].error);
  const rows = await host.rpc('providers');
  const row = rows.find(row => row.id === 'doubaowork');
  assert(row); assert.equal(row.importable,true); assert.equal(row.checkin,true); assert.equal(row.usage,true);
  checks.push('package-load');
}

const backup = JSON.stringify({schema:'doubao-work-accounts/v1',version:3,accounts:['alpha','bravo'].map(id => ({
  id,provider:'doubaowork',name:'Fixture',session:{cookieHeader:'sessionid='+id},
}))});
const ask = (account,content = 'ping',stream = false,extra = {}) => host.rpc('fetch',{
  provider:'doubaowork',account,model:'fixture-model',npm:'@ai-sdk/openai-compatible',
  url:'https://www.doubao.com/v1/chat/completions',method:'POST',headers:{'Content-Type':'application/json'},
  body:Buffer.from(JSON.stringify({model:'fixture-model',messages:[{role:'user',content}],stream,...extra})).toString('base64'),
});

try {
  await mkdir(join(root,'work'));
  const deviceFile = desktopStatePaths(process.platform,root,deviceEnv)[0];
  await mkdir(dirname(deviceFile),{recursive:true});
  await writeFile(deviceFile,JSON.stringify({aha:{device:{device_id:'fixture-device'}}}));
  await writeFile(fixture,`
import {appendFileSync} from 'node:fs';
const callsPath = ${JSON.stringify(callsPath)};
let claimed = false;
const json = value => Response.json(value);
const frame = (event,data) => 'event: '+event+'\\ndata: '+JSON.stringify(data)+'\\n\\n';
globalThis.fetch = async (url,options) => {
  const request = new Request(url,options);
  const u = new URL(request.url);
  if (u.origin !== 'https://www.doubao.com') throw Error('unexpected fixture destination');
  if (u.pathname !== '/passport/account/info/v2/' &&
      (u.searchParams.get('device_id') !== 'fixture-device' || u.searchParams.get('fp') !== 'verify_fixture-device'))
    throw Error('fixture device context missing');
  appendFileSync(callsPath,JSON.stringify({path:u.pathname})+'\\n');
  switch (u.pathname) {
    case '/passport/account/info/v2/': return json({message:'success',data:{
      user_id_str:request.headers.get('cookie').includes('alpha')?'111':'222',name:'Fixture'}});
    case '/alice/user/launch': return json({data:{assistant_bot_id:'fixture-bot',ug_campaign_info:{campaign_group_code:'pc_incentive_task_mvp_v3'}}});
    case '/alice/slot/action_bar_v3/brief_list': return json({data:{entry_list:[{active_switch_conf:{
      menu_conf:{item_list:[{model_item_key:'fixture-model',name:'Fixture Model'},
        {model_item_key:'5',name:'豆包 2.1 Pro'},{model_item_key:'9',name:'自动'}]}}}]}});
    case '/alice/commerce/sale/subscription/overview/': return json({data:{member_info:{hasActiveSubscription:true},
      window_limit_section:{window_limit_groups:[{feature_group_name:'文本',window_limits:[{window_type:1,used_percent:25}]}]}}});
    case '/alice/commerce/sale/subscription/entry/config/': return json({data:{membership_display_name:'Fixture Plan'}});
    case '/alice/ug/campaign/v3/detail/': return json({data:{tasks:[{campaign_code:'daily',reward_mode:2,task_status:2,
      daily_checkin:{checked_in_today:claimed}}]}});
    case '/alice/ug/campaign/item/reward/claim/': claimed = true; return json({code:0});
    case '/chat/completion': {
      const body = await request.json();
      const prompt = body.messages[0].content_block[0].content.text_block.text;
      if (prompt === 'challenge') return json({error_code:710022004});
      let text = '宿主验证通过';
      const marker = prompt.match(/magpie_calls_[a-f0-9]+/);
      if (marker) {
        const declaration = JSON.parse(prompt.slice(prompt.lastIndexOf('\\n')+1));
        text = declaration.messages.at(-1).role === 'tool' ? declaration.messages.at(-1).content
          : JSON.stringify({[marker[0]]:[{name:'lookup',arguments:{key:'fixture'}}]});
      }
      const content_block = [{block_id:'fixture-answer',block_type:10000,content:{text_block:{text}}}];
      return new Response(frame('SSE_REPLY_END',{end_type:1})+
        frame('STREAM_MSG_NOTIFY',{meta:{message_id:'fixture-message'},content:{content_block}})+
        frame('FULL_MSG_NOTIFY',{message:{message_id:'fixture-message',user_type:2,content:JSON.stringify(content_block)}})+
        frame('SSE_REPLY_END',{end_type:2})+
        frame('SSE_REPLY_END',{end_type:3,usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}),
        {headers:{'Content-Type':'text/event-stream'}});
    }
    default: throw Error('unexpected fixture path');
  }
};
`);
  await init();
  const imported = await host.rpc('importFiles',{provider:'doubaowork',texts:[backup]});
  assert.deepEqual(imported.results.map(row => row.status),['added','added']);
  const [alpha,bravo] = imported.results.map(row => row.account);
  assert.notEqual(alpha,bravo); checks.push('account-import');
  await host.stop(); host = undefined;
  const legacy = JSON.parse(await readFile(authPath,'utf8'));
  const refresh = JSON.parse(legacy[alpha].refresh);
  assert.equal(refresh.session.deviceId,'fixture-device');
  delete refresh.session.deviceId; delete refresh.session.fingerprint;
  legacy[alpha].refresh = JSON.stringify(refresh);
  await writeFile(authPath,JSON.stringify(legacy));
  await init();
  const providers = await host.rpc('providers');
  const model = providers[0].models.find(model => model.id === 'fixture-model');
  assert(model); assert.equal(model.image,false); assert.deepEqual(model.inputs,['text']); checks.push('model-discovery');
  assert.equal(providers[0].models.find(model => model.id === '5').name,'豆包 2.1 Pro');
  assert.equal(providers[0].models.find(model => model.id === '9').name,'自动'); checks.push('model-display-name');
  const plain = await ask(alpha);
  assert.equal(plain.status,200); assert.equal(JSON.parse(plain.text).choices[0].message.content,'宿主验证通过');
  assert.equal(JSON.parse(plain.text).usage.total_tokens,10); checks.push('short-sse-snapshot');
  const upgraded = JSON.parse(await readFile(authPath,'utf8'));
  assert.equal(JSON.parse(upgraded[alpha].refresh).session.deviceId,'fixture-device');
  checks.push('legacy-device-persistence');
  checks.push('nonstream-chat');
  const stream = await ask(bravo,'ping',true,{stream_options:{include_usage:true}});
  assert.equal(stream.status,200); assert.match(stream.text,/宿主验证通过/); assert.match(stream.text,/\[DONE\]/);
  assert.match(stream.text,/"choices":\[\],"usage"/); checks.push('token-usage');
  checks.push('stream-chat');
  const tools = [{type:'function',function:{name:'lookup',parameters:{type:'object'}}}];
  const toolReply = await ask(alpha,'request tool',false,{tools,tool_choice:'required'});
  assert.equal(toolReply.status,200);
  const toolChoice = JSON.parse(toolReply.text).choices[0];
  assert.equal(toolChoice.finish_reason,'tool_calls');assert.equal(toolChoice.message.content,null);
  const call = toolChoice.message.tool_calls[0];assert.equal(call.function.name,'lookup');
  checks.push('tool-call');
  const toolResult = await ask(alpha,'',true,{tools,messages:[{role:'user',content:'request tool'},
    toolChoice.message,{role:'tool',tool_call_id:call.id,content:'client-tool-result'}]});
  assert.equal(toolResult.status,200);assert.match(toolResult.text,/client-tool-result/);assert.match(toolResult.text,/\[DONE\]/);
  checks.push('tool-result-roundtrip');
  const usage = await host.rpc('usage',{provider:'doubaowork',account:alpha});
  assert.equal(usage.plan,'Fixture Plan'); assert.equal(usage.windows[0].used,25); checks.push('quota');
  assert.equal((await host.rpc('checkin',{provider:'doubaowork',account:alpha})).outcome,'claimed');
  assert.equal((await host.rpc('checkin',{provider:'doubaowork',account:alpha})).outcome,'done');
  const calls = (await readFile(callsPath,'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.filter(call => call.path.endsWith('/reward/claim/')).length,1); checks.push('checkin-once');
  const challenged = await ask(alpha,'challenge');
  assert.equal(challenged.status,429); assert.equal(JSON.parse(challenged.text).error.code,710022004);
  checks.push('verification-error');
  await host.stop(); host = undefined;
  await init();
  assert.equal((await ask(alpha)).status,200); assert.equal((await ask(bravo)).status,200);
  const recovered = JSON.parse(await readFile(authPath,'utf8'));
  assert.equal(recovered[alpha].doubao.state,'ready'); checks.push('verification-recovery');
  checks.push('restart-account-isolation');
  console.log(JSON.stringify({platform:process.platform,package:project,checks,passed:true},null,2));
} finally {
  await host?.stop();
  await rm(root,{recursive:true,force:true});
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readWebContext} from '../native/web-device.mjs';
import {createDoubaoClient} from '../native/doubao-client.mjs';
import {normalizeSession,withDeviceContext,backupRows} from '../native/session.mjs';

const session={cookieHeader:'sessionid=fixture;s_v_web_id=browser-fp',userAgent:'Fixture Chrome/147.0.0.0'};
const context={clientProfile:'web',deviceId:'fixture-web-device',webId:'fixture-web-device',
  appId:'497858',clientVersion:'3.45.6',fingerprint:'browser-fp'};
const noDevice=async()=>assert.fail('A web session must not read native client files.');
const html=(webId='fixture-web-device')=>'<script>window._ROUTER_DATA = '+JSON.stringify({
  loaderData:{chat_layout:{chat_layout:{aid:497858,pc_version:'3.45.6',launchCore:{web_id:webId},
    privateConversations:'PRIVATE_ACCOUNT_DATA'}}}})+';</script>';
const json=value=>Response.json(value);

test('官网初始化提取实际 Web ID、版本和浏览器指纹，丢弃页面账号数据',async()=>{
  const body=Buffer.from(html());
  const fetched=await readWebContext(session,{fetchImpl:async(url,options)=>{
    assert.equal(url,'https://www.doubao.com/chat/');
    assert.equal(options.redirect,'error');assert.equal(options.headers.Cookie,session.cookieHeader);
    assert.equal(options.headers['User-Agent'],session.userAgent);
    return new Response(new ReadableStream({start(c){for(const byte of body)c.enqueue(Uint8Array.of(byte));c.close();}}));
  }});
  assert.deepEqual(fetched,{cookieHeader:session.cookieHeader,...context});
  assert(!JSON.stringify(fetched).includes('PRIVATE_ACCOUNT_DATA'));
});

test('官网初始化签发的 ttwid 与 Web 上下文一并保存，其他账号 Cookie 保留',async()=>{
  const old={...session,cookieHeader:session.cookieHeader+'; ttwid=old-value'};
  const received=await readWebContext(old,{fetchImpl:async()=>new Response(html(),{
    headers:{'Set-Cookie':'ttwid=server-issued-value; Domain=.doubao.com; Path=/; Secure; HttpOnly'},
  })});
  assert.equal(received.cookieHeader,session.cookieHeader.replace(';','; ')+'; ttwid=server-issued-value');
  assert(!received.cookieHeader.includes('old-value'));
});

test('旧 Cookie 账号缺少本机客户端时自动初始化，同一会话共享一次查询',async()=>{
  let nativeReads=0,bootstraps=0;
  const client=createDoubaoClient({readDevice:async()=>{nativeReads++;return undefined;},
    fetchImpl:async()=>{bootstraps++;return new Response(html());}});
  const [one,two]=await Promise.all([client.prepareSession(session),client.prepareSession(session)]);
  assert.deepEqual(one,{...session,...context});assert.deepEqual(two,one);
  assert.equal(nativeReads,2);assert.equal(bootstraps,1);
  assert.equal(await client.prepareSession(one),one);
  assert.equal(bootstraps,1);
  client.close();
});

test('各账号分别获得官网上下文，失败查询可重试，取消等待保留其他调用',async()=>{
  let calls=0,release;
  const pending=new Promise(resolve=>{release=resolve;});
  const client=createDoubaoClient({readDevice:noDevice,fetchImpl:async(_url,options)=>{
    calls++;if(calls===1)return new Response('PRIVATE_COOKIE_DATA',{status:503});
    if(calls===2)await pending;
    return new Response(html(options.headers.Cookie.includes('second')?'second-device':'fixture-web-device'));
  }});
  const web={...session,clientProfile:'web'};
  await assert.rejects(client.prepareSession(web),e=>e.type==='device_context_unavailable'&&!e.message.includes('PRIVATE_COOKIE'));
  const abort=new AbortController();
  const cancelled=client.prepareSession(web,{signal:abort.signal});
  const retained=client.prepareSession(web);
  abort.abort();await assert.rejects(cancelled,e=>e.name==='AbortError');
  release();assert.equal((await retained).deviceId,'fixture-web-device');
  assert.equal((await client.prepareSession({...web,cookieHeader:'sessionid=second'})).deviceId,'second-device');
  assert.equal(calls,3);client.close();
});

test('Web 账号目录和聊天使用完整浏览器参数，原生账号目录另行缓存',async()=>{
  const seen=[];
  const client=createDoubaoClient({readDevice:noDevice,fetchImpl:async(raw,options)=>{
    const url=new URL(raw),web=url.searchParams.get('web_platform')==='browser';
    seen.push(url.pathname);
    if(url.pathname==='/chat/')return new Response(html());
    assert.equal(options.headers['User-Agent'],session.userAgent);
    if(web){
      for(const [key,value] of Object.entries({device_id:context.deviceId,web_id:context.webId,aid:context.appId,
        real_aid:context.appId,fp:'browser-fp',pc_version:context.clientVersion,doubao_device_platform:'web'}))
        assert.equal(url.searchParams.get(key),value);
      for(const key of ['client_platform','runtime','runtime_version'])assert.equal(url.searchParams.has(key),false);
    }else{
      assert.equal(url.searchParams.get('aid'),'1044603');
      assert.equal(url.searchParams.get('fp'),'verify_native-device');
    }
    if(url.pathname==='/alice/user/launch')return json({data:{assistant_bot_id:'fixture-bot'}});
    if(url.pathname==='/alice/slot/action_bar_v3/brief_list')return json({data:{entry_list:[{
      active_switch_conf:{menu_conf:{item_list:[{model_item_key:web?'web-model':'native-model'}]}}
    }]}});
    assert.equal(url.pathname,'/chat/completion');
    return new Response('event: CHUNK_DELTA\ndata: {"text":"web answer"}\n\nevent: SSE_REPLY_END\ndata: {}\n\n',
      {headers:{'Content-Type':'text/event-stream'}});
  }});
  const web={...session,clientProfile:'web'};
  assert.deepEqual(await client.models(web),['web-model']);
  const deltas=[];
  for await(const delta of client.chat(web,{model:'web-model',messages:[{role:'user',content:'ping'}]}))deltas.push(delta);
  assert.deepEqual(deltas,[{content:'web answer'}]);
  assert.deepEqual(await client.models({...session,deviceId:'native-device'}),['native-model']);
  assert.equal(seen.filter(path=>path==='/chat/').length,1);
  assert.equal(seen.filter(path=>path==='/alice/slot/action_bar_v3/brief_list').length,2);
  client.close();
});

test('Web 上下文在 v2/v3 备份、目标主机和重启后保留，指纹不被原生值覆盖',async()=>{
  const source=normalizeSession({...session,...context,chromiumVersion:'147.0.0.0'});
  assert.equal(await withDeviceContext(source,noDevice),source);
  for(const version of [2,3]){
    const rows=backupRows({schema:'doubao-work-accounts/v1',version,accounts:[{
      id:'fixture',provider:'doubaowork',desktop:false,pluginIdentity:'fixture:0',pluginSecret:source,session:source,
    }]});
    const client=createDoubaoClient({readDevice:noDevice,fetchImpl:async()=>assert.fail('Portable context must avoid bootstrap.')});
    assert.deepEqual(await client.prepareSession(rows[0].session),source);client.close();
  }
});

test('官网异常、无效 Web ID 和超大响应报告设备初始化错误且不泄露正文',async()=>{
  for(const body of ['PRIVATE_COOKIE_DATA',html('0'),html(''),'<script>window._ROUTER_DATA = invalid;</script>',
    'x'.repeat(4*1024*1024+1)]){
    await assert.rejects(readWebContext(session,{fetchImpl:async()=>new Response(body)}),
      e=>e.status===502&&e.type==='device_context_unavailable'&&!e.message.includes('PRIVATE_COOKIE_DATA'));
  }
  const abort=new AbortController();abort.abort();
  await assert.rejects(readWebContext(session,{signal:abort.signal,fetchImpl:async()=>{throw Error('PRIVATE');}}),
    e=>e.name==='AbortError');
});

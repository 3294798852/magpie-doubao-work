import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {BrowserLogin,launchIsolatedBrowser,removeLoginDirectory} from '../browser-login.mjs';
import {assertPrivate} from '../private-files.mjs';

const browser={id:'chrome',name:'Fixture Chrome',path:'/fixture/chrome'};
test('临时目录删除跨运行时重试可恢复错误，成功后停止等待',async()=>{
  let calls=0;const delays=[];
  await removeLoginDirectory('fixture',{async remove(path,options){
    assert.equal(path,'fixture');assert.deepEqual(options,{recursive:true,force:true});
    if(++calls<3)throw Object.assign(Error('locked'),{code:'EBUSY'});
  },wait:async ms=>{delays.push(ms);}});
  assert.equal(calls,3);assert.deepEqual(delays,[100,200]);
});

test('删除权限错误立即报告，持续占用耗尽重试后保留原错误',async()=>{
  for(const code of ['EACCES','EBUSY']){
    let calls=0;const error=Object.assign(Error('fixture'),{code});
    await assert.rejects(removeLoginDirectory('fixture',{async remove(){calls++;throw error;},wait:async()=>{}}),
      received=>received===error);
    assert.equal(calls,code==='EBUSY'?6:1);
  }
});
async function temporary(t){
  const root=await mkdtemp(join(tmpdir(),'dw-startup-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
function processFixture(onSpawn=()=>{}){
  const child=new EventEmitter();child.stderr=new PassThrough();child.exitCode=null;child.kills=0;
  child.kill=()=>{child.kills++;child.exitCode=0;child.emit('exit',0,'SIGTERM');return true;};
  return {child,spawnProcess(path,args,options){
    assert.equal(path,browser.path);assert.deepEqual(options.stdio,['ignore','ignore','pipe']);
    assert.equal(options.shell,false);assert.equal(options.windowsHide,false);
    queueMicrotask(()=>{child.emit('spawn');onSpawn(child,args);});return child;
  }};
}

test('等待完整端点文件后建立回环连接，元数据与正常关闭使用同一通信',async t=>{
  const root=await temporary(t),commands=[],fixture=processFixture();
  await writeFile(join(root,'DevToolsActivePort'),'12345\n');
  const completed=new Promise((resolve,reject)=>setTimeout(()=>
    writeFile(join(root,'DevToolsActivePort'),'12345\n/devtools/browser/fixture-token\n').then(resolve,reject),30));
  const handle=await launchIsolatedBrowser(browser,root,{spawnProcess:fixture.spawnProcess,
    async connect(url){
      assert.equal(url,'ws://127.0.0.1:12345/devtools/browser/fixture-token');
      return {closed:false,close(){this.closed=true;},async send(method){
        commands.push(method);
        if(method==='Browser.getVersion')return {userAgent:'Fixture Chrome/158.0.0.0'};
        assert.equal(method,'Browser.close');fixture.child.exitCode=0;fixture.child.emit('exit',0,null);return {};
      }};
    }});
  await completed;
  assert.equal(handle.metadata().chromiumVersion,'158.0.0.0');
  await handle.dispose();assert.deepEqual(commands,['Browser.getVersion','Browser.close']);
  assert.equal(fixture.child.kills,0);
});

test('拒绝文件中的外部地址，初始化超时后结束本次浏览器进程',async t=>{
  const root=await temporary(t),fixture=processFixture();
  await writeFile(join(root,'DevToolsActivePort'),'12345\nws://other.example/devtools/browser/token\n');
  await assert.rejects(launchIsolatedBrowser(browser,root,{spawnProcess:fixture.spawnProcess,startupTimeoutMs:60,
    connect:async()=>assert.fail('An invalid endpoint must not be contacted.')}),error=>{
    assert.equal(error.diagnostic.code,'DW_BROWSER_ENDPOINT_INVALID');assert.equal(error.diagnostic.phase,'endpoint');
    assert.equal(error.diagnostic.browser,'chrome');assert(!error.message.includes('other.example'));return true;
  });
  assert.equal(fixture.child.kills,1);
});

test('浏览器执行失败、早退和管理策略各自保留可区分的原因',async t=>{
  const root=await temporary(t);
  await assert.rejects(launchIsolatedBrowser(browser,root,{spawnProcess(){
    throw Object.assign(Error('PRIVATE_PATH'),{code:'EACCES'});
  }}),error=>error.diagnostic.code==='DW_BROWSER_EXECUTABLE_DENIED'&&error.diagnostic.phase==='spawn'&&!error.message.includes('PRIVATE_PATH'));
  for(const policy of [false,true,'sandbox']){
    const fixture=processFixture(child=>{
      if(policy==='sandbox')child.stderr.write('The SUID sandbox helper binary was found, but is not configured correctly.\n');
      else if(policy)child.stderr.write('Remote debugging is disallowed by the system admin policy.\n');
      child.exitCode=21;child.emit('exit',21,null);
    });
    await assert.rejects(launchIsolatedBrowser(browser,root,{spawnProcess:fixture.spawnProcess}),error=>
      error.diagnostic.code===(policy==='sandbox'?'DW_BROWSER_SANDBOX':policy?'DW_BROWSER_POLICY':'DW_BROWSER_EXITED')&&error.diagnostic.exitCode===21);
  }
});

test('启动期间取消立即释放等待，取消原因保持原样',async t=>{
  const root=await temporary(t),abort=new AbortController();
  const fixture=processFixture(()=>abort.abort());
  await assert.rejects(launchIsolatedBrowser(browser,root,{spawnProcess:fixture.spawnProcess,signal:abort.signal}),
    error=>error===abort.signal.reason);
  assert.equal(fixture.child.kills,1);
});

test('失败诊断私有保存并覆盖上一份，临时资料目录被清理',async t=>{
  const root=await temporary(t),file=join(root,'browser-startup-error.json');
  const login=new BrowserLogin({tmpRoot:root,discover:async()=>[browser],
    async launch(_browser,profile){
      throw Object.assign(Error('fixture'),{status:503,type:'browser_start_failed',diagnostic:{
        code:'DW_BROWSER_EXITED',phase:'endpoint',browser:'chrome',runtime:'Fixture',exitCode:21,
        stderr:profile+' '+homedir()+' https://www.doubao.com/chat/?private=fixture',
      }});
    }});
  await login.start();
  const status=login.status(),record=JSON.parse(await readFile(file,'utf8'));
  assert.equal(status.state,'error');assert.equal(status.diagnostic.exitCode,21);
  assert(!JSON.stringify(status).includes('private=fixture'));assert.equal(record.code,'DW_BROWSER_EXITED');
  assert(record.stderr.includes('<login-profile>'));assert(record.stderr.includes('<home>'));
  assert(!record.stderr.includes('private=fixture'));await assertPrivate(file);
  await login.start();assert.deepEqual(await readdir(root),['browser-startup-error.json']);
  await login.dispose();
});

test('BrowserLogin 启动取消保持取消状态，取消过程不生成故障记录',async t=>{
  const root=await temporary(t);let entered;
  const begun=new Promise(resolve=>{entered=resolve;});
  const login=new BrowserLogin({tmpRoot:root,discover:async()=>[browser],
    async launch(_browser,_profile,{signal}){
      entered();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    }});
  const start=login.start();await begun;await login.cancel();await start;
  assert.equal(login.status().state,'cancelled');assert.equal(login.status().active,false);
  assert.deepEqual(await readdir(root),[]);await login.dispose();
});

test('关闭失败保留退出诊断和临时资料，便于继续定位',async t=>{
  const root=await temporary(t);
  const login=new BrowserLogin({tmpRoot:root,pollMs:60000,discover:async()=>[browser],launch:async()=>({
    async dispose(){throw Object.assign(Error('fixture close failure'),{diagnostic:{code:'DW_BROWSER_CLOSE_TIMEOUT',phase:'close',exitCode:null}});}
  })});
  await login.start();await login.cancel();
  assert.equal(login.status().state,'cancelled');assert.equal(login.status().cleanupPending,true);
  assert.equal(login.status().diagnostic.code,'DW_BROWSER_CLOSE_TIMEOUT');
  const record=JSON.parse(await readFile(join(root,'browser-startup-error.json'),'utf8'));
  assert.equal(record.phase,'close');assert((await readdir(root)).some(name=>name.startsWith('doubao-login-')));
});

test('故障记录写入期间取消，完成写入后保持用户的取消状态',async t=>{
  const root=await temporary(t);let entered,release;
  const begun=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const login=new BrowserLogin({tmpRoot:root,discover:async()=>[browser],launch:async()=>{throw Error('fixture failure');}});
  login.diagnose=async()=>{entered();await gate;return {message:'fixture',diagnostic:{code:'DW_BROWSER_START_FAILED'}};};
  const start=login.start();await begun;const cancel=login.cancel();release();await Promise.all([start,cancel]);
  assert.equal(login.status().state,'cancelled');assert.equal(login.status().active,false);
  assert.deepEqual(await readdir(root),[]);await login.dispose();
});

test('取消时仍有 Cookie 查询，通信关闭后保持取消状态并释放资料',async t=>{
  const root=await temporary(t);let began,rejectCookies;
  const pending=new Promise(resolve=>{began=resolve;});
  const login=new BrowserLogin({tmpRoot:root,pollMs:60000,discover:async()=>[browser],launch:async()=>({
    async cookies(){began();return new Promise((_resolve,reject)=>{rejectCookies=reject;});},
    async dispose(){rejectCookies(Error('fixture disconnected'));}
  })});
  await login.start();clearTimeout(login.current.timer);
  const inspect=login.inspect(login.current);await pending;await login.cancel();await inspect;
  assert.equal(login.status().state,'cancelled');assert.equal(login.status().active,false);
  assert.deepEqual(await readdir(root),[]);await login.dispose();
});

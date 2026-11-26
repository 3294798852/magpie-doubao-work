import {spawn} from 'node:child_process';
import {access,mkdtemp,readFile,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {browserCandidates} from './platform.mjs';
import {ensurePrivateDir,securePrivate,writePrivate} from './private-files.mjs';

const LOGIN_URL='https://www.doubao.com/chat/';
const ACTIVE=new Set(['starting','waiting','awaiting_confirmation','importing']);
const failure=(status,message)=>Object.assign(new Error(message),{status});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const RETRY_REMOVE=new Set(['EBUSY','EPERM','ENOTEMPTY','EMFILE','ENFILE']);

// Match Node's bounded removal retries in runtimes that ignore rm's retry options.
export async function removeLoginDirectory(path,{remove=rm,wait=pause}={}){
  for(let attempt=0;;attempt++){
    try{await remove(path,{recursive:true,force:true});return;}
    catch(error){
      if(attempt===5||!RETRY_REMOVE.has(error.code))throw error;
      await wait((attempt+1)*100);
    }
  }
}

// Discover executable locations only. Never inspect the user's regular browser profile.
export async function availableBrowsers(platform=process.platform,home=homedir(),env=process.env) {
  if(platform==='linux'&&(!env.DISPLAY&&!env.WAYLAND_DISPLAY))return [];
  const result=[];
  for(const browser of browserCandidates(platform,home,env)){
    if(result.some(b=>b.id===browser.id))continue;
    if(await access(browser.path,platform==='win32'?constants.F_OK:constants.X_OK).then(()=>true,()=>false))result.push(browser);
  }
  return result;
}
export function isDoubaoPage(raw){
  try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&['doubao.com','www.doubao.com'].includes(u.hostname);}catch{return false;}
}
// Project only cookies for the official Doubao root, with a valid session marker.
export function doubaoCookies(input,now=Date.now()/1000){
  if(!Array.isArray(input))return [];
  const rows=input.filter(c=>c&&['doubao.com','www.doubao.com'].includes(String(c.domain||'').replace(/^\./,''))&&c.path==='/'&&
    typeof c.name==='string'&&c.name.length>0&&c.name.length<=256&&!/[\s\x00-\x1f\x7f=;,]/.test(c.name)&&
    typeof c.value==='string'&&c.value.length<=16384&&!/[\x00-\x1f\x7f;]/.test(c.value)&&!c.partitionKey&&
    (c.expires===undefined||c.expires===-1||c.expires===0||(Number.isFinite(c.expires)&&c.expires>now)))
    .map(c=>({name:c.name,value:c.value,domain:c.domain,path:'/'}));
  if(rows.length>200||Buffer.byteLength(JSON.stringify(rows))>65536)return [];
  return rows.some(c=>['sessionid','sessionid_ss'].includes(c.name)&&c.value.length>0)?rows:[];
}
export function browserArgs(profile){
  return ['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,
    '--no-first-run','--no-default-browser-check','--disable-background-mode','--new-window',LOGIN_URL];
}

// Give Node's WebSocket a direct localhost HTTP upgrade, independent of env proxies.
const browserDispatcher={
  dispatch(options,handler){
    const headers={Connection:'Upgrade',Upgrade:'websocket'};
    if(Array.isArray(options.headers)){
      for(let at=0;at<options.headers.length;at+=2)headers[options.headers[at]]=options.headers[at+1];
    }else Object.assign(headers,options.headers);
    const request=httpRequest(new URL(options.path,options.origin),{method:options.method,headers,agent:false});
    request.once('upgrade',(response,socket,head)=>{
      if(head.length)socket.unshift(head);
      handler.onUpgrade(response.statusCode,response.rawHeaders,socket);
    });
    request.once('response',response=>{response.destroy();request.destroy(Error('浏览器通信升级失败，HTTP '+response.statusCode));});
    request.once('error',error=>handler.onError(error));
    handler.onConnect(error=>request.destroy(error));request.end();return true;
  },
};

// The browser owns a temporary loopback port. CDP uses ordinary WebSocket frames.
export class DevToolsClient {
  static async connect(url,{timeoutMs=7000,signal}={}){
    signal?.throwIfAborted();
    const socket=new WebSocket(url,{dispatcher:browserDispatcher});
    try{
      await new Promise((resolve,reject)=>{
        const finish=error=>{
          clearTimeout(timer);
          socket.removeEventListener('open',opened);socket.removeEventListener('error',failed);
          socket.removeEventListener('close',failed);signal?.removeEventListener('abort',aborted);
          if(error)reject(error);else resolve();
        };
        const opened=()=>finish(),failed=()=>finish(Error('浏览器登录通信连接失败。'));
        const aborted=()=>finish(signal.reason);
        const timer=setTimeout(()=>finish(Object.assign(Error('浏览器登录通信连接超时。'),{code:'DW_BROWSER_CONNECT_TIMEOUT'})),timeoutMs);
        socket.addEventListener('open',opened,{once:true});socket.addEventListener('error',failed,{once:true});
        socket.addEventListener('close',failed,{once:true});signal?.addEventListener('abort',aborted,{once:true});
        if(signal?.aborted)aborted();
      });
      return new DevToolsClient(socket,{timeoutMs});
    }catch(error){socket.close();throw error;}
  }
  constructor(socket,{timeoutMs=7000,maxBytes=2*1024*1024}={}){
    this.socket=socket;this.timeoutMs=timeoutMs;this.maxBytes=maxBytes;
    this.pending=new Map();this.sequence=0;this.closed=false;
    socket.addEventListener('message',event=>this.receive(event.data));
    socket.addEventListener('close',()=>this.close());socket.addEventListener('error',()=>this.close());
  }
  receive(frame){
    if(this.closed)return;
    if(typeof frame!=='string'||Buffer.byteLength(frame)>this.maxBytes){this.close();return;}
    let data;try{data=JSON.parse(frame);}catch{this.close();return;}
    if(!data||typeof data!=='object'||Array.isArray(data)){this.close();return;}
    const waiter=this.pending.get(data.id);if(!waiter)return;
    clearTimeout(waiter.timeout);this.pending.delete(data.id);
    if(data.error)waiter.reject(Error('浏览器登录通信失败。'));else waiter.resolve(data.result||{});
  }
  send(method,params={},sessionId){
    if(this.closed)return Promise.reject(Object.assign(Error('浏览器登录窗口已断开。'),{code:'DW_BROWSER_DISCONNECTED'}));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{this.pending.delete(id);reject(Object.assign(Error('浏览器响应超时。'),{code:'DW_BROWSER_PROTOCOL_TIMEOUT'}));},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timeout});
      const packet=JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})});
      try{this.socket.send(packet);}catch{this.close();}
    });
  }
  close(){
    if(this.closed)return;this.closed=true;
    for(const w of this.pending.values()){clearTimeout(w.timeout);w.reject(Object.assign(Error('浏览器登录窗口已断开。'),{code:'DW_BROWSER_DISCONNECTED'}));}this.pending.clear();
    this.socket.close();
  }
}

function startupFailure(browser,phase,started,{error,code,signal,stderr='',cleanupPending=false}={}){
  const errorCode=typeof error?.code==='string'?error.code:'';
  const causes={ENOENT:['DW_BROWSER_EXECUTABLE_MISSING','浏览器程序已移除，请重新选择有效的 Chrome / Edge 安装。'],
    EACCES:['DW_BROWSER_EXECUTABLE_DENIED','系统拒绝启动浏览器，请检查浏览器程序的执行权限。'],
    EPERM:['DW_BROWSER_EXECUTABLE_DENIED','系统拒绝启动浏览器，请检查浏览器程序的执行权限。']};
  let [reason,message]=(phase==='spawn'?causes[errorCode]:undefined)||
    [errorCode.startsWith('DW_BROWSER_')?errorCode:'DW_BROWSER_START_FAILED','浏览器登录窗口初始化失败。'];
  if(/remote.?debugging.*(?:disallowed|disabled|not allowed|denied)/i.test(stderr))
    [reason,message]=['DW_BROWSER_POLICY','浏览器管理策略禁止登录通信，请联系设备管理员检查 RemoteDebuggingAllowed。'];
  else if(/Missing X server|no DISPLAY|cannot open display|failed to connect to.*Wayland/i.test(stderr))
    [reason,message]=['DW_BROWSER_DISPLAY','浏览器无法连接图形桌面，请在可用的桌面会话中登录。'];
  else if(/SUID sandbox.*not configured correctly|No usable sandbox|Running as root without --no-sandbox/i.test(stderr))
    [reason,message]=['DW_BROWSER_SANDBOX','浏览器沙箱组件安装或权限异常，请修复浏览器安装后重试。'];
  else if(Number.isInteger(code)||signal)
    [reason,message]=['DW_BROWSER_EXITED','浏览器在登录通信建立前退出。'];
  else if(reason==='DW_BROWSER_ENDPOINT_TIMEOUT')message='浏览器已启动，等待登录通信端点超时。';
  else if(reason==='DW_BROWSER_ENDPOINT_INVALID')message='浏览器返回的登录通信端点格式有误。';
  else if(reason==='DW_BROWSER_CONNECT_TIMEOUT'||reason==='DW_BROWSER_PROTOCOL_TIMEOUT')message='浏览器已启动，登录通信握手超时。';
  else if(reason==='DW_BROWSER_DISCONNECTED')message='浏览器登录通信在初始化时断开。';
  else if(reason==='DW_BROWSER_CLOSE_TIMEOUT')message='登录浏览器关闭等待超时，临时资料目录已保留。';
  else if(phase==='cleanup')
    [reason,message]=['DW_BROWSER_PROFILE_CLEANUP','登录浏览器临时资料目录清理失败，目录已保留。'];
  else if(phase==='endpoint'&&['EACCES','EPERM'].includes(errorCode))
    [reason,message]=['DW_BROWSER_PROFILE_ACCESS','无法读取登录浏览器的临时资料目录，请检查当前用户的目录权限。'];
  const diagnostic={code:reason,phase,platform:process.platform,runtime:process.versions.bun?'Bun '+process.versions.bun:'Node '+process.versions.node,
    browser:browser?.id||'unknown',elapsedMs:Date.now()-started,...(Number.isInteger(code)?{exitCode:code}:{}),...(signal?{exitSignal:signal}:{}),
    ...(/^[A-Z0-9_]{1,64}$/.test(errorCode)?{systemCode:errorCode}:{}),detail:String(error?.message||'').slice(0,2048),stderr};
  return Object.assign(failure(503,message+'（'+[reason,diagnostic.platform,diagnostic.runtime,'阶段='+phase,
    '耗时='+Math.round(diagnostic.elapsedMs/1000)+'秒',...(Number.isInteger(code)?['退出码='+code]:[])].join('，')+'）'),
    {type:'browser_start_failed',diagnostic,cleanupPending});
}

async function saveStartupDiagnostic(file,diagnostic,profile){
  const redact=value=>{
    let text=value||'';
    if(profile)text=text.split(profile).join('<login-profile>');
    return text.split(homedir()).join('<home>').replace(/(?:https?|wss?):\/\/[^\s]+/g,'<browser-url>');
  };
  const record={...diagnostic,at:new Date().toISOString(),stderr:redact(diagnostic.stderr),detail:redact(diagnostic.detail)};
  await ensurePrivateDir(dirname(file));
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{await writePrivate(temporary,JSON.stringify(record,null,2)+'\n');await rename(temporary,file);}
  catch(error){await rm(temporary,{force:true}).catch(()=>{});throw error;}
}

export async function launchIsolatedBrowser(browser,profile,{spawnProcess=spawn,connect=DevToolsClient.connect,
  startupTimeoutMs=30000,signal}={}){
  signal?.throwIfAborted();
  const started=Date.now(),stopped=new AbortController();
  let child,client,exited=false,exitCode,exitSignal,spawnError,stderr='',phase='spawn';
  const captureStderr=chunk=>{stderr=(stderr+chunk.toString()).slice(-8192);};
  const requestSignal=signal?AbortSignal.any([signal,stopped.signal]):stopped.signal;
  let attachment=null,version;
  let resolveExit;
  const exit=new Promise(resolve=>{resolveExit=resolve;});
  const onExit=(code,signal,error)=>{
    exited=true;exitCode=code;exitSignal=signal;spawnError=error;
    stopped.abort(Error('浏览器进程已退出。'));client?.close();resolveExit();
  };
  const abortStartup=()=>client?.close();
  requestSignal.addEventListener('abort',abortStartup,{once:true});
  async function dispose(){
    if(!child)return;
    const closing=Date.now();
    if(!exited&&client&&!client.closed)await Promise.race([client.send('Browser.close').catch(()=>{}),pause(700)]);
    if(!exited)await Promise.race([exit,pause(1200)]);
    if(!exited){child.kill('SIGTERM');await Promise.race([exit,pause(1200)]);}
    if(!exited){child.kill('SIGKILL');await Promise.race([exit,pause(1200)]);}
    client?.close();
    if(!exited)throw startupFailure(browser,'close',closing,{error:{code:'DW_BROWSER_CLOSE_TIMEOUT'},code:child.exitCode,signal:child.signalCode});
  }
  try{
    child=spawnProcess(browser.path,browserArgs(profile),{stdio:['ignore','ignore','pipe'],shell:false,detached:false,windowsHide:false});
    child.once('exit',(code,signal)=>onExit(code,signal));child.once('error',error=>onExit(null,null,error));
    child.stderr?.on('data',captureStderr);
    await Promise.race([once(child,'spawn',{signal:requestSignal}),exit.then(()=>{throw Error('浏览器启动失败。');})]);
    phase='endpoint';
    let endpoint,invalid=false;
    while(!endpoint){
      requestSignal.throwIfAborted();
      try{
        const raw=await readFile(join(profile,'DevToolsActivePort'),'utf8');
        const [port,path]=raw.trim().split(/\r?\n/);
        if(/^\d+$/.test(port)&&Number(port)>0&&Number(port)<=65535&&/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path))
          endpoint='ws://127.0.0.1:'+port+path;
        else invalid=true;
      }catch(error){if(!['ENOENT','EBUSY'].includes(error.code))throw error;}
      if(endpoint)break;
      if(Date.now()-started>=startupTimeoutMs)throw Object.assign(Error('Browser endpoint unavailable'),
        {code:invalid?'DW_BROWSER_ENDPOINT_INVALID':'DW_BROWSER_ENDPOINT_TIMEOUT'});
      await new Promise(resolve=>{const timer=setTimeout(done,50);function done(){clearTimeout(timer);requestSignal.removeEventListener('abort',done);resolve();}requestSignal.addEventListener('abort',done,{once:true});});
    }
    phase='connect';
    client=await connect(endpoint,{signal:requestSignal});
    requestSignal.throwIfAborted();
    phase='protocol';
    version=await client.send('Browser.getVersion');
  }catch(error){
    const failure=startupFailure(browser,phase,started,{error:spawnError||error,code:exitCode,signal:exitSignal,stderr});
    try{await dispose();}catch{failure.cleanupPending=true;}
    signal?.throwIfAborted();throw failure;
  }finally{requestSignal.removeEventListener('abort',abortStartup);}
  child.stderr?.removeListener('data',captureStderr);child.stderr?.resume();stderr='';
  return {
    metadata(){
      return {userAgent:version.userAgent,chromiumVersion:/Chrom(?:e|ium)\/([\d.]+)/.exec(version.userAgent||'')?.[1]};
    },
    async cookies(){
      const {targetInfos=[]}=await client.send('Target.getTargets');
      const pages=targetInfos.filter(p=>p.type==='page');
      if(!pages.length)throw Error('登录窗口已关闭。');
      const page=pages.find(p=>isDoubaoPage(p.url));
      if(!page)return [];
      if(attachment?.targetId!==page.targetId){
        if(attachment)await client.send('Target.detachFromTarget',{sessionId:attachment.sessionId}).catch(()=>{});
        const {sessionId}=await client.send('Target.attachToTarget',{targetId:page.targetId,flatten:true});
        attachment={targetId:page.targetId,sessionId};
      }
      const {cookies=[]}=await client.send('Network.getCookies',{urls:[LOGIN_URL]},attachment.sessionId);
      return cookies;
    },
    dispose,
  };
}

// One active login per panel; no arbitrary executable, URL, profile or callback input.
export class BrowserLogin {
  constructor({tmpRoot,importAccount,discover=availableBrowsers,launch=launchIsolatedBrowser,pollMs=2000,ttlMs=10*60_000,now=Date.now,
    diagnosticFile=join(tmpRoot,'browser-startup-error.json')}){
    this.tmpRoot=tmpRoot;this.importAccount=importAccount;this.discover=discover;this.launch=launch;this.pollMs=pollMs;this.ttlMs=ttlMs;this.now=now;
    this.current=null;this.disposed=false;this.state={id:'',state:'idle',message:'在浏览器完成登录后，将自动接入本机网关。',browserName:'',startedAt:0,expiresAt:0};
    this.diagnosticFile=diagnosticFile;
  }
  status(){return {...this.state,active:ACTIVE.has(this.state.state)||this.current!==null};}
  async options(){return (await this.discover()).map(({id,name})=>({id,name}));}
  update(session,state,message,extra={}){if(this.current===session)this.state={...this.state,state,message,...extra};}
  async diagnose(session,error){
    const diagnostic={...error.diagnostic};let message=error.message;
    try{
      await saveStartupDiagnostic(this.diagnosticFile,diagnostic,session.profile);
      diagnostic.file=this.diagnosticFile;message+=' 启动诊断已保存到 '+this.diagnosticFile;
    }catch(error){
      diagnostic.saved=false;
      diagnostic.fileError=typeof error.code==='string'?error.code:'private_file_error';
      message+=' 诊断文件未能保存（'+diagnostic.fileError+'）。';
    }
    delete diagnostic.stderr;delete diagnostic.detail;
    return {message,diagnostic};
  }
  async start(browserId,context={}){
    if(this.disposed)throw failure(503,'登录服务正在停止。');
    if(this.current){if((this.current.context.destination||'local')!==(context.destination||'local')||this.current.context.expectedId!==context.expectedId||!!this.current.context.manual!==!!context.manual)throw failure(409,'已有另一种保存目标的登录会话，请先完成或取消它。');return this.status();}
    const session={context,id:randomUUID(),cancelled:false,abort:new AbortController(),timer:null,handle:null,profile:null,finishing:null,busy:false,stable:'',ready:null};
    this.current=session;const startedAt=this.now();
    this.state={id:session.id,destination:context.destination||'local',state:'starting',message:'正在准备独立浏览器会话…',browserName:'',startedAt,expiresAt:startedAt+this.ttlMs};
    session.ready=this.prepare(session,browserId);
    await session.ready;
    return this.status();
  }
  async prepare(session,browserId){
    const started=Date.now();let browser,phase='discovery';
    try{
      const browsers=await this.discover();
      browser=browserId===undefined?browsers[0]:browsers.find(b=>b.id===browserId);
      if(!browser)throw failure(409,'未找到所选浏览器。请安装 Chrome / Edge，或在工作台导入账号 JSON。');
      if(session.cancelled)return;
      this.state.browserName=browser.name;
      session.browserId=browser.id;
      phase='profile';
      await ensurePrivateDir(this.tmpRoot);
      session.profile=await mkdtemp(join(this.tmpRoot,'doubao-login-'));await securePrivate(session.profile,{directory:true});
      if(session.cancelled)return;
      phase='spawn';
      session.handle=await this.launch(browser,session.profile,{signal:session.abort.signal});
      if(session.cancelled)return;
      this.update(session,'waiting','请在新打开的 '+browser.name+' 窗口登录豆包。完成后会自动接入，无需复制 Cookie。');
      this.schedule(session);
    }catch(error){
      if(!session.cancelled){
        const failure=error.diagnostic?error:startupFailure(browser,phase,started,{error});
        if(!browser)failure.diagnostic.code='DW_BROWSER_NOT_FOUND';
        session.cleanupPending=failure.cleanupPending===true;
        if(error.status&&!error.diagnostic)failure.message=error.message+'（'+failure.diagnostic.code+'，'+failure.diagnostic.runtime+'）';
        const result=await this.diagnose(session,failure);
        if(!session.cancelled)this.update(session,'error',result.message,{diagnostic:result.diagnostic});
      }
      await this.finish(session);
    }finally{
      if(session.cancelled)await this.finish(session);
    }
  }
  schedule(session){
    if(this.current!==session||session.cancelled)return;
    session.timer=setTimeout(()=>{void this.inspect(session);},this.pollMs);session.timer.unref?.();
  }
  async inspect(session){
    if(this.current!==session||session.cancelled||session.busy)return;
    session.busy=true;
    try{
      if(this.now()>=this.state.expiresAt){this.update(session,'expired','本次登录已超时，请重新打开浏览器登录。');await this.finish(session);return;}
      const cookies=doubaoCookies(await session.handle.cookies());
      if(this.current!==session||session.cancelled)return;
      if(!cookies.length){session.stable='';this.schedule(session);return;}
      const fingerprint=createHash('sha256').update(cookies.filter(c=>['sessionid','sessionid_ss'].includes(c.name)).map(c=>c.name+'='+c.value).sort().join(';')).digest('hex');
      if(fingerprint!==session.stable){session.stable=fingerprint;this.schedule(session);return;}
      if(session.context.manual&&session.confirmed!==fingerprint){
        this.update(session,'awaiting_confirmation','已检测到登录。请在窗口里完成官网验证，再回到面板确认接入。');
        this.schedule(session);return;
      }
      this.update(session,'importing','检测到豆包登录，正在核验账号并保存到本机…');
      // Exactly one import attempt. A timeout is uncertain, not a reason to retry silently.
      let result;
      try{result=await this.importAccount(cookies,session.context,await session.handle.metadata?.());}catch(error){
        this.update(session,'error',error?.type==='device_context_unavailable'?error.message:session.context.destination==='cloud'?'账号接入或同步结果待核对。请先检查本机和云端列表；确认结果后再操作。':'账号接入结果待核对。请先刷新账号列表；确认未接入后，再重新登录。');await this.finish(session);return;
      }
      if(!result||typeof result.name!=='string'||typeof result.updated!=='boolean')throw Error('账号核验结果异常。');
      this.update(session,'success',result.cloudSynced?'登录已完成，账号已自动接入云端。':result.updated?'已更新这个账号的登录状态；账号总数保持不变。':'新账号已接入，账号列表会自动刷新。',{accountName:result.name.slice(0,64),updated:result.updated,cloudSynced:result.cloudSynced===true,cloudOrigin:result.cloudOrigin||''});
      await this.finish(session);
    }catch{
      if(!session.cancelled)this.update(session,'error','浏览器会话已断开，请重新打开登录。已有账号不受影响。');
      await this.finish(session);
    }finally{session.busy=false;}
  }
  async finish(session){
    if(session.finishing)return session.finishing;
    clearTimeout(session.timer);session.stable='';
    session.finishing=(async()=>{
      let closed=!session.cleanupPending,closeError;
      if(session.handle)try{await session.handle.dispose();}catch(error){closed=false;closeError=error;}
      if(session.profile&&closed){
        const started=Date.now();
        try{await removeLoginDirectory(session.profile);}
        catch(error){closed=false;closeError=startupFailure({id:session.browserId},'cleanup',started,{error});}
      }
      if(!closed&&this.current===session){
        const result=closeError?.diagnostic?await this.diagnose(session,closeError):null;
        this.state={...this.state,message:this.state.message+' '+(result?.message||'临时会话清理未完成，请关闭专用窗口后检查。'),
          cleanupPending:true,...(result?{diagnostic:result.diagnostic}:{})};
      }
      if(this.current===session)this.current=null;
    })();
    return session.finishing;
  }
  async confirm(id){
    const session=this.current;
    if(!session||id!==session.id||!session.context.manual||this.state.state!=='awaiting_confirmation'||!session.stable)
      throw failure(409,'没有可确认的浏览器登录。');
    session.confirmed=session.stable;if(session.busy)return this.status();clearTimeout(session.timer);
    await this.inspect(session);return this.status();
  }
  async cancel({shutdown=false}={}){
    const session=this.current;if(!session)return this.status();
    if(this.state.state==='importing'&&!shutdown)throw failure(409,'账号正在核验，请等待本次结果后再关闭。');
    session.cancelled=true;clearTimeout(session.timer);
    session.abort.abort(Error('本次浏览器登录已取消。'));
    this.update(session,'cancelled','本次浏览器登录已取消，已有账号不受影响。');
    await session.ready;
    await this.finish(session);
    return this.status();
  }
  async dispose(){this.disposed=true;await this.cancel({shutdown:true});}
}

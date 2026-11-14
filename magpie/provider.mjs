import {randomUUID} from 'node:crypto';
import {dayTime} from '../native/calendar.mjs';
import {createDoubaoClient} from '../native/doubao-client.mjs';
import {normalizeSession,backupRows,withDeviceContext} from '../native/session.mjs';
import {readDesktopDeviceId} from '../native/desktop-device.mjs';
import {normalizeProviderError} from '../native/protocol.mjs';
import {onFailure,routable,chatRoutable,onChatSuccess} from '../native/account-state.mjs';
import {parseChat} from '../native/completion.mjs';
import {browserSignIn} from './login.mjs';
import {chatResponse,errorResponse} from './response.mjs';

const ID = 'doubaowork';
const API = 'https://www.doubao.com/v1';
const NPM = '@ai-sdk/openai-compatible';
const fail = (status,message,type = 'invalid_request_error') => Object.assign(new Error(message),{status,type});
const freshState = () => ({state:'ready'});

function sessionOf(auth) {
  if (auth?.type !== 'oauth') throw fail(401,'请先登录豆包工作账号。','account_login_required');
  let data;
  try { data = JSON.parse(auth.refresh); } catch { throw fail(401,'豆包登录资料无法读取，请重新登录。','account_login_required'); }
  if (data?.version !== 1 || typeof data.session?.cookieHeader !== 'string')
    throw fail(401,'豆包登录资料版本有误，请重新登录。','account_login_required');
  return data.session;
}

function ready(auth,now) {
  if (routable({...auth.doubao,enabled:true,state:auth.doubao?.state || 'ready'},now)) return;
  const state = auth.doubao?.state;
  const error = normalizeProviderError(state === 'needs_verification' ? {code:710022004} : {},
    {httpStatus:state === 'needs_login' ? 401 : 429});
  if (state === 'needs_verification')
    error.message = '此账号上次请求需要验证，自动签到已暂停。请在豆包官网或客户端完成验证后重新测试模型。';
  if (state === 'needs_login') error.signIn = 'expired';
  error.retryAt = auth.doubao?.retryAt;
  throw error;
}

function describeModel(id,name = id) {
  return {id,providerID:ID,name,api:{id,url:API,npm:NPM},temperature:false,
    capabilities:{temperature:false,reasoning:false,attachment:false,toolcall:true,
      input:{text:true,image:false,audio:false,video:false,pdf:false},
      output:{text:true,image:false,audio:false,video:false,pdf:false}},
  };
}

export function createDoubaoPlugin(input, {doubao = createDoubaoClient(), now = Date.now,
  browserOptions,readDevice = readDesktopDeviceId} = {}) {
  const updates = new Map(), active = new Set();
  const today = () => dayTime(new Date(now())).day;
  const tomorrow = () => new Date(Date.parse(today()+'T00:00:00+08:00')+86400000).toISOString();

  async function modelsFor(session,options) {
    if (doubao.modelDetails) {
      const models = await doubao.modelDetails(session,options);
      return Object.fromEntries(Object.entries(models).map(([id,model]) => [id,describeModel(id,model.name)]));
    }
    const ids = await doubao.models(session,options);
    return Object.fromEntries(ids.map(id => [id,describeModel(id)]));
  }

  async function updateAuth(auth,getAuth,change) {
    const previous = updates.get(auth.uid) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const current = await getAuth();
      // An old request must leave a replacement sign-in's state intact.
      if (!current || current.access !== auth.access) return false;
      const body = change(current);
      if (body === current) return false;
      await input.client.auth.set({path:{id:ID},body});
      return true;
    });
    updates.set(auth.uid,task);
    try { return await task; }
    finally { if (updates.get(auth.uid) === task) updates.delete(auth.uid); }
  }

  function updateState(auth,getAuth,change) {
    return updateAuth(auth,getAuth,current => {
      const previous = current.doubao || freshState(), next = change(previous);
      return next === previous ? current : {...current,doubao:next};
    });
  }

  async function sessionFor(getAuth) {
    const auth = await getAuth(), stored = sessionOf(auth);
    const session = await withDeviceContext(stored,readDevice);
    if (session !== stored) {
      const refresh = JSON.stringify({version:1,session});
      await updateAuth(auth,getAuth,current => current.refresh === refresh ? current : {...current,refresh});
    }
    return {auth,session};
  }

  async function failed(auth,getAuth,error,requestId) {
    const normalized = error?.type ? error : normalizeProviderError(error,{httpStatus:error?.status || 502});
    if (normalized.state) {
      await updateState(auth,getAuth,state => onFailure(state,normalized,{now:now(),requestId}));
      if (normalized.state === 'needs_login') normalized.signIn = 'expired';
    }
    return normalized;
  }

  function enter(auth) {
    if (active.has(auth.uid)) throw fail(429,'此豆包账号正在处理另一请求。','account_busy');
    active.add(auth.uid);
    return () => active.delete(auth.uid);
  }

  async function signIn(raw,{signal} = {}) {
    const session = await withDeviceContext(normalizeSession(raw),readDevice);
    const info = await doubao.identity(session,{signal});
    signal?.throwIfAborted();
    return {type:'success',refresh:JSON.stringify({version:1,session}),access:randomUUID(),expires:0,
      accountId:info.identity,uid:info.identity,name:info.name,doubao:freshState()};
  }

  async function* chat(getAuth,body,{signal,requestId}) {
    const {auth,session} = await sessionFor(getAuth);
    if (!chatRoutable({...auth.doubao,enabled:true,state:auth.doubao?.state || 'ready'},now())) ready(auth,now());
    const leave = enter(auth);
    let produced = false;
    try {
      for await (const delta of doubao.chat(session,body,{signal})) {
        signal?.throwIfAborted();
        if (delta.content || delta.tool_calls?.length) produced = true;
        yield delta;
      }
      signal?.throwIfAborted();
      if (!produced) throw fail(502,'豆包工作未返回文本或工具调用。','upstream_empty_response');
      if (auth.doubao?.state === 'needs_verification' || auth.doubao?.verificationRestored)
        await updateState(auth,getAuth,state => state.state === auth.doubao.state &&
          state.lastRequestId === auth.doubao.lastRequestId ? onChatSuccess(state) : state);
    } catch (error) {
      signal?.throwIfAborted();
      throw await failed(auth,getAuth,error,requestId);
    } finally { leave(); }
  }

  async function fetchRequest(getAuth,url,init) {
    const requestId = 'dw-'+randomUUID();
    let request;
    try {
      request = new Request(url,init);
      const target = new URL(request.url);
      if (target.origin !== 'https://www.doubao.com') throw fail(400,'豆包插件接口地址有误。');
      if (request.method === 'GET' && target.pathname === '/v1/models') {
        const {session} = await sessionFor(getAuth);
        const models = await modelsFor(session,{signal:request.signal});
        return Response.json({object:'list',data:Object.values(models).map(({id,name}) => ({id,name,object:'model',owned_by:ID}))});
      }
      if (request.method !== 'POST' || target.pathname !== '/v1/chat/completions')
        throw fail(404,'豆包插件仅提供 models 和 chat/completions。');
      if (Number(request.headers.get('content-length')) > 262144) throw fail(413,'请求体过大。');
      const text = await request.text();
      if (Buffer.byteLength(text) > 262144) throw fail(413,'请求体过大。');
      let value;
      try { value = JSON.parse(text); } catch { throw fail(400,'JSON 请求格式有误。'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400,'请提交 JSON 对象。');
      const body = parseChat(value);
      return await chatResponse(body,(body,options) => chat(getAuth,body,options),{signal:request.signal,now});
    } catch (error) {
      request?.signal.throwIfAborted();
      return errorResponse(error,requestId);
    }
  }

  return {
    config(config) {
      config.provider ??= {};
      config.provider[ID] = {...config.provider[ID],name:'豆包工作 Doubao Work',npm:NPM,api:API,models:{}};
    },
    provider: {
      id:ID,
      async models(_provider,{auth,signal} = {}) {
        if (!auth) return {};
        try {
          const session = await withDeviceContext(sessionOf(auth),readDevice);
          return await modelsFor(session,{signal});
        } catch (error) {
          if (error?.state === 'needs_login') error.signIn = 'expired';
          throw error;
        }
      },
    },
    auth: {
      provider:ID,
      maxConcurrency:1,
      methods:[{
        type:'oauth',label:'Sign in with an isolated browser',labels:{zh:'独立浏览器登录豆包工作'},
        async authorize() {
          return {url:'https://www.doubao.com/chat/',method:'auto',opened:true,
            instructions:'在新打开的专用浏览器窗口完成豆包登录。完成官网验证后重新登录可恢复暂停的账号。',
            callback:(_code,{signal} = {}) => browserSignIn(signIn,{signal,browserOptions})};
        },
      }],
      importFrom:'Choose a Doubao Work account backup (v2 or v3 JSON)',
      importFroms:{zh:'选择豆包工作账号备份 JSON（v2 或 v3）'},
      async import(texts,{signal} = {}) {
        const results = [];
        for (const text of texts) {
          let rows;
          try {
            if (Buffer.byteLength(text) > 524288) throw Error();
            rows = backupRows(JSON.parse(text));
          } catch { results.push({type:'failed',error:'请选择有效的豆包工作账号 JSON，单文件最多 20 个账号、512 KB。'}); continue; }
          for (const row of rows) {
            signal?.throwIfAborted();
            try { results.push(await signIn(row.session,{signal})); }
            catch (error) {
              signal?.throwIfAborted();
              results.push({type:'failed',error:error?.type ? error.message : '豆包账号身份核验未完成，请检查登录及网络。'});
            }
          }
        }
        return results;
      },
      async loader(getAuth) {
        await sessionFor(getAuth);
        return {apiKey:'doubaowork-plugin',baseURL:API,fetch:(url,init) => fetchRequest(getAuth,url,init)};
      },
      async usage(getAuth,_provider,{signal} = {}) {
        const {auth,session} = await sessionFor(getAuth);
        try {
          const data = await doubao.quota(session,{signal});
          return {plan:data.plan,user:auth.name || auth.accountId,
            windows:data.windows.map(({label,view,...window}) => ({name:label,display:view,...window}))};
        } catch (error) {
          signal?.throwIfAborted();
          const result = await failed(auth,getAuth,error,randomUUID());
          return {error:result.message,signIn:result.state === 'needs_login' ? 'expired' : 'kept'};
        }
      },
      async checkin(getAuth,_provider,{signal} = {}) {
        const {auth,session} = await sessionFor(getAuth);
        let leave;
        try {
          ready(auth,now());
          leave = enter(auth);
          const day = today(), previous = auth.doubao?.attempt;
          if (previous?.day === day && ['done','claimed'].includes(previous.status)) return {outcome:'done',until:tomorrow()};
          const queryOnly = previous?.day === day && previous.reserved === true;
          const result = await doubao.checkin(session,{signal,queryOnly,
            async reserve() {
              if (queryOnly || today() !== day) throw fail(409,'签到日期或领取状态已变化。');
              const saved = await updateState(auth,getAuth,state => {
                if (state.attempt?.day === day && state.attempt.reserved) throw fail(409,'今日已有领取提交记录。');
                return {...state,attempt:{day,reserved:true,status:'pending'}};
              });
              if (!saved) throw fail(409,'登录状态已变化，请重新查询签到。');
            },
          });
          await updateState(auth,getAuth,state => ({...state,attempt:{day,reserved:state.attempt?.day === day && state.attempt.reserved === true,status:result.status}}));
          const outcome = ['claimed','done','inactive','ineligible'].includes(result.status) ? result.status : 'failed';
          return {outcome,until:tomorrow(),...(outcome === 'failed' ? {message:'签到结果待核对，今日后续操作只回查。'} : {})};
        } catch (error) {
          signal?.throwIfAborted();
          const result = await failed(auth,getAuth,error,randomUUID());
          return {outcome:result.state === 'needs_verification' ? 'captcha' : 'failed',message:result.message};
        } finally { leave?.(); }
      },
    },
  };
}

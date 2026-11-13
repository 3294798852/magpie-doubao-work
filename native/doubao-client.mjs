import {createHash,randomUUID} from 'node:crypto';
import {normalizeProviderError,upstreamCode} from './protocol.mjs';
import {decodeEvents} from './doubao-stream.mjs';
import {readDesktopDeviceId} from './desktop-device.mjs';
import {withDeviceContext} from './session.mjs';
import {createToolTurn,toolDeltas} from './tool-calling.mjs';

const ORIGIN='https://www.doubao.com';
const ROUTES=Object.freeze({
 identity:'/passport/account/info/v2/',
 launch:'/alice/user/launch',
 models:'/alice/slot/action_bar_v3/brief_list',
 quota:'/alice/commerce/sale/subscription/overview/',
 quotaName:'/alice/commerce/sale/subscription/entry/config/',
 detail:'/alice/ug/campaign/v3/detail/',
 list:'/alice/ug/campaign/list/',
 claim:'/alice/ug/campaign/item/reward/claim/',
 chat:'/chat/completion',
});
const str=v=>typeof v==='string'?v:typeof v==='number'&&Number.isFinite(v)?String(v):'';
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const clean=v=>str(v).replace(/[\x00-\x1f\x7f]/g,'').slice(0,100);
const arr=v=>Array.isArray(v)?v:[];
export const fail=(status,message)=>Object.assign(Error(message),{status});
export function vendorError(status,v={}){
 let code=Number(upstreamCode(v));
 let decision=v?.extra?.decision??v?.decision;
 if(typeof decision==='string'&&decision.length<=65536)try{decision=JSON.parse(decision);}catch{decision=null;}
 if(decision?.type==='verify')code=710022004;
 const error=normalizeProviderError({code},{httpStatus:code===710012001?401:status});
 if(error.type==='upstream_rate_limited'&&Number.isFinite(v.retryAfterMs))error.retryAfterMs=v.retryAfterMs;
 return error;
}
function endpoint(route,s){
 const u=new URL(ROUTES[route],ORIGIN);
 const q=route==='identity'?{
  account_sdk_source:'web',sdk_version:'2.2.5',aid:'582478',real_aid:'582478',
  device_platform:'web',samantha_web:'1','use-olympus-account':'1',
 }:{
  aid:'1044603',real_aid:'1044603',device_platform:'web',version_code:'20800',
  samantha_web:'1',web_platform:'desktop',doubao_device_platform:'desktop',client_platform:'pc_client',
  pkg_type:'release_version',runtime:'web',runtime_version:'3.42.2',
  pc_version:s.clientVersion||'2.33.5',doubao_pc_version:s.clientVersion||'2.33.5',
  'use-olympus-account':'1',language:'zh',region:'CN',sys_region:'CN',
 };
 const cookies=new Map(s.cookieHeader.split('; ').map(k=>[k.slice(0,k.indexOf('=')),k.slice(k.indexOf('=')+1)]));
 for(const [k,v] of Object.entries({...q,device_id:s.deviceId||cookies.get('device_id'),web_id:s.webId||cookies.get('web_id'),
  fp:s.fingerprint||cookies.get('s_v_web_id')||cookies.get('fp'),chromium_version:s.chromiumVersion,channel:s.channel}))
  if(v)u.searchParams.set(k,v);
 return u.href;
}
async function limitedJson(response){
 const reader=response.body?.getReader();
 if(!reader)throw fail(502,'豆包工作响应为空。');
 const decoder=new TextDecoder('utf-8',{fatal:true});
 let text='',size=0;
 try{
  while(true){const r=await reader.read();if(r.done)break;if((size+=r.value.byteLength)>4*1024*1024)throw Error();text+=decoder.decode(r.value,{stream:true});}
  const value=JSON.parse(text+decoder.decode());if(!plain(value))throw Error();
  return value;
 }catch{await reader.cancel().catch(()=>{});throw fail(502,'豆包工作响应格式有误。');}
 finally{reader.releaseLock();}
}
// Interpret the option catalog as an index of (mode, model) pairs.
export function parseCatalog(reply){
 const index=new Map();
 function record(entry,mode={}){
  const id=str(entry?.model_item_key??entry?.item_id);
  if(!/^[\w.:/%+-]{1,160}$/.test(id)||['__proto__','prototype','constructor'].includes(id))return;
  const agentMode=Number(mode.agent_mode??entry.agent_mode)||0;
  const modeId=str(mode.mode_id??entry.default_mode);
  const depth=Number(entry.menu_type??entry.item_id??id)||0;
  let extra=entry.model_extra_params;
  if(typeof extra==='string')try{extra=JSON.parse(extra);}catch{extra=null;}
  const model={id,name:clean(entry.name)||id,modeId,agentMode,modeName:clean(mode.name),
   deepThink:modeId==='2'&&depth===4?3:depth,extra:plain(extra)?extra:{}};
  if(!index.has(id))index.set(id,new Map());
  index.get(id).set(modeId+'|'+agentMode,model);
 }
 for(const item of arr(reply?.data?.entry_list)){
  const config=item?.active_switch_conf;
  if(!config)continue;
  if(!config.use_menu_conf_v2){
   for(const entry of arr(config.menu_conf?.item_list))record(entry);
   continue;
  }
  const v2=config.menu_conf_v2,modes=arr(v2?.mode_list?.item_list);
  for(const mode of modes)for(const model of arr(mode?.model_list?.item_list))record(model,mode);
  for(const model of arr(v2?.model_list?.item_list)){
   const id=str(model?.model_item_key??model?.item_id);
   const supported=modes.filter(m=>{
    const modeId=str(m?.mode_id);
    const listedModel=r=>str(r?.model_item_key??r?.item_id??r);
    return (!Array.isArray(model?.conversation_mode_list)||model.conversation_mode_list.map(str).includes(modeId))&&
     (!Array.isArray(m?.support_models)||m.support_models.map(listedModel).includes(id));
   });
   const rank=m=>m.mode_id==null?0:str(m.mode_id)===str(model.default_mode)?3:str(m.mode_id)===str(v2?.default_select_mode_map?.new_chat?.mode_id)?2:Number(m.agent_mode)===2?1:0;
   if(supported.length)record(model,supported.reduce((a,b)=>rank(a)>=rank(b)?a:b));
   else if(!modes.length)record(model);
  }
 }
 const result=Object.create(null);
 for(const [id,group] of index){
  if(group.size===1){result[id]=group.values().next().value;continue;}
  for(const m of group.values()){
   const tag=encodeURIComponent(m.modeId||'agent-'+m.agentMode),key=tag+'::'+encodeURIComponent(id);
   result[key]=m;
  }
 }
 return result;
}
function quotaView(overview,entry){
 const data=overview?.data??overview;
 const limits=section=>arr(section?.window_limit_groups).flatMap(g=>arr(g?.window_limits).map(window=>({group:clean(g.feature_group_name),window})));
 const subscription=section=>limits(section).filter(({window})=>[1,2,4].includes(Number(window?.window_type)));
 const usable=section=>!section?.usage_exhausted&&subscription(section).length>0;
 const personal=data.member_info?.hasActiveSubscription===true;
 const enterprise=data.member_info?.hasEnterpriseSubscription===true&&(!personal||usable(data.enterprise_window_limit_section)||!usable(data.window_limit_section));
 const rows=subscription(enterprise?data.enterprise_window_limit_section:personal?data.window_limit_section:null);
 if(!enterprise)rows.push(...limits(data.quota_package_section).filter(({window})=>Number(window?.window_type)===3));
 const value=n=>n!=null&&n!==''&&Number.isFinite(Number(n))&&Number(n)>=0?Number(n):undefined;
 const windows=rows.map(({group,window:w})=>{
  const type=Number(w.window_type),time={1:'5 小时',2:'近 7 天',4:'每月'}[type]||'订阅额度';
  const pct=value(w.used_percent),used=value(w.used_amount),total=value(w.total_amount);
  const unlimited=w.unlimited===true||type===1&&w.exemption?.active===true;
  const view=unlimited?'不限':pct!==undefined?'已用 '+pct+'%':used!==undefined&&total!==undefined?used+' / '+total:'额度待同步';
  const share=unlimited?undefined:pct??(used!==undefined&&total>0?used/total*100:undefined);
  return {label:[group,time].filter(Boolean).join(' '),view,
   ...(share!==undefined?{used:share}:{}),
   ...(!unlimited&&used!==undefined&&total!==undefined?{amount:used,limit:total,unit:'credits'}:{})};
 });
 if(!enterprise){
  const bonus=limits(data.incentive_quota_section).find(({window})=>Number(window?.window_type)===3)?.window;
  if(bonus){
   const total=value(bonus.total_amount),used=value(bonus.used_amount);
   const balance=total!==undefined&&used!==undefined?Math.max(0,total-used):undefined;
   windows.push({label:'奖励额度',view:balance!==undefined?'剩 '+balance+' 额度':'余额待同步',
    ...(balance!==undefined?{balance,unit:'credits'}:{})});
  }
 }
 const plan=clean(entry?.data?.membership_display_name??entry?.data?.current_subscription?.display?.short_name??
  data.membership_display_name??data.current_subscription?.display?.short_name);
 return {plan,windows};
}

function dailyTasks(value,group){
 const results=new Map();
 const visit=(o,current,depth)=>{
  if(!plain(o)||depth>8||results.size>20)return;
  current=o.campaign_group_code||o.campaign_code||current;
  for(const key of ['tasks','campaigns','milestones'])for(const t of arr(o[key])){
   if(typeof t?.campaign_code!=='string'||typeof t.daily_checkin?.checked_in_today!=='boolean')continue;
   const g=t.campaign_group_code||current,code=t.campaign_code;
   const direct=Number(t.reward_mode)===2||key==='milestones',status=Number(t.task_status);
   const claimable=status===2||direct&&[1,4].includes(status);
   const body=claimable?(direct?{task_id:'',campaign_group_code:g,campaign_item_code:code}:t.task_id?{task_id:t.task_id}:null):null;
   results.set(g+':'+code,{group:g,code,checked:t.daily_checkin.checked_in_today,body});
  }
  visit(o.campaign_group,current,depth+1);
  for(const c of arr(o.campaign_groups))visit(c,current,depth+1);
 };
 visit(value.data||value,group,0);return [...results.values()];
}

export function createDoubaoClient({fetchImpl=fetch,now=Date.now,readDevice=readDesktopDeviceId}={}){
 // Only fixed Doubao endpoints are reachable; redirects are never followed.
 const catalogs=new Map();
 async function request(s,route,data,{signal}={}){
  const method=route==='identity'?'GET':'POST';
  const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(route==='chat'?600000:25000)]):AbortSignal.timeout(route==='chat'?600000:25000);
  let response;
  try{
   const session=route==='identity'?s:await withDeviceContext(s,readDevice);
   response=await fetchImpl(endpoint(route,session),{method,redirect:'error',signal:requestSignal,
    headers:{Cookie:s.cookieHeader,Origin:ORIGIN,Referer:ORIGIN+'/chat/','Agw-Js-Conv':'str',
     Accept:route==='chat'?'text/event-stream, application/json':'application/json','Content-Type':'application/json',
     ...(s.userAgent?{'User-Agent':s.userAgent}:{})},...(method==='POST'?{body:JSON.stringify(data)}:{})});
  }catch{signal?.throwIfAborted();throw fail(502,'连接豆包工作失败。');}
  if(route==='chat'&&response.ok&&/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type')||''))return response;
  let value;
  try{value=await limitedJson(response);}catch(error){if(!response.ok)throw vendorError(response.status,{});throw error;}
  const code=Number(upstreamCode(value)||0);
  if(!response.ok||code!==0||route==='chat'||value?.extra?.decision||value?.decision){
   const retry=response.headers.get('retry-after'),seconds=retry!==null?Number(retry):NaN;
   const delay=Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-now();
   const err=vendorError(response.status,{...value,retryAfterMs:delay});
   if(!response.ok||code!==0||route==='chat'||err.state)throw err;
  }
  return value;
 }
 const launch=(s,opts)=>request(s,'launch',{},opts);
 async function catalog(s,opts){
  const key=createHash('sha256').update(s.cookieHeader).digest('hex');
  const previous=catalogs.get(key);
  if(previous&&now()-previous.at<300000)return previous;
  const l=await launch(s,opts),bot=str(l.data?.assistant_bot_id||l.assistant_bot_id);
  if(!bot)throw fail(502,'豆包工作未返回助手信息。');
  const raw=await request(s,'models',{language_code:'zh',bot_id:bot},opts);
  const models=parseCatalog(raw);
  if(!Object.keys(models).length)throw fail(502,'豆包工作模型目录为空或已变化。');
  const data={bot,models,at:now()};
  if(catalogs.size>=64)catalogs.delete(catalogs.keys().next().value);
  catalogs.set(key,data);return data;
 }
 return {
  async identity(s,opts){
   const r=await request(s,'identity',undefined,opts),d=r.data||r;
   // Prefer lossless string form; refuse an imprecise numeric ID.
   const user=str(d.user_id_str)||(Number.isSafeInteger(d.user_id)?String(d.user_id):'');
   if(!user||r.message&&r.message!=='success')throw vendorError(401,r);
   return {identity:user+':'+(str(d.passport_enterprise_user_type)||'0'),name:clean(d.name)||'豆包工作账号'};
  },
  async models(s,opts){return Object.keys((await catalog(s,opts)).models);},
  async quota(s,opts){
   const overview=await request(s,'quota',{product_line:'membership'},opts);
   const entry=await request(s,'quotaName',{},opts).catch(e=>{if(e.state)throw e;return {};});
   return quotaView(overview,entry);
  },
  async checkin(s,{signal,queryOnly,reserve}){
   const l=await launch(s,{signal}),group=l.data?.ug_campaign_info?.campaign_group_code;
   if(typeof group!=='string'||!group)return {status:'inactive'};
   const detail=()=>request(s,group==='pc_incentive_task_mvp_v3'?'detail':'list',{campaign_group_code:group},{signal}).then(x=>dailyTasks(x,group));
   const tasks=await detail();
   if(tasks.length!==1)return {status:'inactive'};
   const task=tasks[0];
   if(task.checked)return {status:'done'};
   if(queryOnly)return {status:'pending'};
   if(!task.body)return {status:'ineligible'};
   await reserve();
   let err;
   try{await request(s,'claim',task.body,{signal});}catch(e){if(e.state||signal?.aborted)throw e;err=e;}
   const after=(await detail()).find(t=>t.group===task.group&&t.code===task.code);
   return {status:after?.checked?(err?'done':'claimed'):'pending'};
  },
  async *chat(s,body,{signal}={}){
   const {bot,models}=await catalog(s,{signal});
   const model=Object.hasOwn(models,body.model)?models[body.model]:undefined;
   if(!model)throw fail(404,'此账号的豆包模型目录已变化。');
   const id=randomUUID(),at=now(),mode=model.modeId||'3';
   const turn=createToolTurn(body);
   const message=turn.prompt;
   const block={block_type:10000,content:{text_block:{text:message,icon_url:'',icon_url_dark:'',summary:''},pc_event_block:''},
    block_id:randomUUID(),parent_id:'',meta_info:[],append_fields:[]};
   const option={create_time_ms:at,need_create_conversation:true,conversation_init_option:{need_ack_conversation:true},
    need_deep_think:model.deepThink,is_audio:false,answer_with_suggest:false,tts_switch:false,is_regen:false,is_replace:false,
    unique_key:randomUUID(),start_seq:0,sse_recv_event_options:{support_chunk_delta:true},
    recovery_option:{is_recovery:false,req_create_time_sec:Math.floor(at/1000),append_sse_event_scene:0},message_storage_type:0};
   const ext={use_deep_think:String(model.deepThink),sub_conv_firstmet_type:'1',commerce_credit_config_enable:'0'};
   if(model.agentMode||model.modeId){
    const extra=model.extra;
    Object.assign(option,{agent_mode:model.agentMode,model_config:{model_item_key:model.id,model_extra_params:extra},
     aggregate_params:{mode_id:mode,model_item_key:model.id,agent_mode:String(model.agentMode),...(extra.provider_id?{provider_id:extra.provider_id}:{})}});
    ext.agent_mode=String(model.agentMode);
    if([1,2].includes(model.agentMode)){
     const general={action:0,thread_local_message_id:[id],client_option:{enable_sandbox:false,os:{darwin:'macos',win32:'windows'}[process.platform]||'linux',shared_folder_path:[]},
      runtime_type:2,agent_task_param:{runtime_type:2},agent_task_param_change:{runtime_changed:true,device_changed:false,sandbox_auth_type_changed:false},
      need_modify_conversation:false,task_input_json:'{"project_context":{}}'};
     option.general_task_param=general;ext.general_task_param=JSON.stringify(general);ext.is_finish='1';
    }
   }
   const local=Array.from(randomUUID().replaceAll('-','').slice(0,16),c=>parseInt(c,16)%10).join('');
   const payload={client_meta:{local_conversation_id:'local_'+local,conversation_id:'',bot_id:bot,last_section_id:'',last_message_index:null},
    messages:[{local_message_id:id,content_block:[block],message_status:0}],option,user_context:[],ext};
   const response=await request(s,'chat',payload,{signal});
   const deltas=decodeEvents(response,{signal});
   yield* (turn.active ? toolDeltas(deltas,turn) : deltas);
  },
  close(){catalogs.clear();},
 };
}

import {upstreamCode} from './protocol.mjs';
import {vendorError} from './doubao-client.mjs';

const MAX_FRAME=1024*1024,MAX_WIRE=64*1024*1024;
const error=(message,status=502)=>Object.assign(Error(message),{status,type:'upstream_stream_error'});

async function* frames(reader,{signal,idleMs}){
 const decoder=new TextDecoder('utf-8',{fatal:true});
 let buf='',event='',data=[],size=0,received=0,skipLF=false;
 function* lines(next){
  buf+=next;let newline;
  if(skipLF&&buf.length){if(buf[0]==='\n')buf=buf.slice(1);skipLF=false;}
  while((newline=buf.search(/[\r\n]/))!==-1){
   const line=buf.slice(0,newline),cr=buf[newline]==='\r';
   const length=cr&&buf[newline+1]==='\n'?2:1;
   skipLF=cr&&newline===buf.length-1;buf=buf.slice(newline+length);
   if(!line){if(data.length)yield {event,data:data.join('\n')};event='';data=[];size=0;continue;}
   if(line.startsWith(':'))continue;
   if((size+=line.length)>MAX_FRAME)throw error('豆包工作流式事件超过大小限制。');
   const i=line.indexOf(':'),field=i<0?line:line.slice(0,i),value=i<0?'':line.slice(i+1).replace(/^ /,'');
   if(field==='event')event=value;
   else if(field==='data')data.push(value);
  }
  if(buf.length+size>MAX_FRAME)throw error('豆包工作流式事件超过大小限制。');
 }
 for(;;){
  signal?.throwIfAborted();
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('豆包工作流式响应等待超时。',504)),idleMs);timer.unref?.();});
  let packet;
  try{packet=await Promise.race([reader.read(),timeout]);}finally{clearTimeout(timer);}
  if(packet.done){yield* lines(decoder.decode());return;}
  if((received+=packet.value.byteLength)>MAX_WIRE)throw error('豆包工作响应超过大小限制。');
  yield* lines(decoder.decode(packet.value,{stream:true}));
 }
}

export async function* decodeEvents(response,{signal,idleMs=60000}={}){
 const reader=response.body?.getReader();
 if(!reader)throw error('豆包工作未返回流式响应。');
 const cancel=()=>void reader.cancel().catch(()=>{});
 signal?.addEventListener('abort',cancel,{once:true});
 const history=new Map();
 let message='default',activeBlock;
 function selectMessage(id){
  if(id==null||String(id)===message)return;
  message=String(id);activeBlock=undefined;
 }
 function* blocks(list,append){
  if(!Array.isArray(list))return;
  for(const item of list){
   if(Number(item?.block_type)!==10000)continue;
   const info=item.content?.text_block;
   if(!info||typeof info!=='object')continue;
   const key=message+'\0'+String(item.block_id||'default'),prior=history.get(key);
   activeBlock=key;
   const flags=[info.icon_url,info.icon_url_dark],tag=flags.some(x=>typeof x==='string'&&x.toLowerCase().includes('deep_think'));
   const thinking=tag||flags.every(x=>x===undefined)&&prior?.thinking===true;
   const before=prior?.thinking===thinking?prior.text:'';
   if(typeof info.text!=='string'){history.set(key,{thinking,text:before});continue;}
   const text=info.text;
   if(!append&&!text.startsWith(before))throw error('豆包工作修订了已输出的内容。');
   history.set(key,{thinking,text:append?before+text:text});
   const delta=append?text:text.slice(before.length);
   if(delta)yield thinking?{reasoning_content:delta}:{content:delta};
  }
 }
 function messageBlocks(value){
  if(Array.isArray(value?.content_block))return value.content_block;
  if(typeof value?.content!=='string')return;
  let list;
  try{list=JSON.parse(value.content);}catch{throw error('豆包工作完整消息正文格式有误。');}
  if(!Array.isArray(list))throw error('豆包工作完整消息正文格式有误。');
  return list;
 }
 try{
  for await(const f of frames(reader,{signal,idleMs})){
   let v;
   try{v=JSON.parse(f.data);}catch{throw error('豆包工作流式事件格式异常。');}
   const code=Number(upstreamCode(v)||0);
   if(/ERR|^(?:error|gateway-error)$/i.test(f.event)||v?.error||code!==0||v?.extra?.decision||v?.decision){
    const e=vendorError(200,v);
    if(e.state||code||v?.error||/error|err/i.test(f.event))throw e;
   }
   const usage=v?.usage??v?.msg_finish_attr?.usage??v?.answer_finish_attr?.usage;
   if(['prompt_tokens','completion_tokens','total_tokens'].every(key=>Number.isSafeInteger(usage?.[key])&&usage[key]>=0))
    yield {usage:{prompt_tokens:usage.prompt_tokens,completion_tokens:usage.completion_tokens,total_tokens:usage.total_tokens}};
   switch(f.event){
    case 'SSE_REPLY_END':if(v?.end_type==null||Number(v.end_type)===3)return;break;
    case 'CHUNK_DELTA':
     if(typeof v?.text==='string'&&v.text){
      const key=activeBlock||message+'\0default',prior=history.get(key)||{thinking:false,text:''};
      history.set(key,{...prior,text:prior.text+v.text});
      yield prior.thinking?{reasoning_content:v.text}:{content:v.text};
     }
     break;
    case 'STREAM_MSG_NOTIFY':selectMessage(v?.meta?.message_id);yield* blocks(v?.content?.content_block,true);break;
    case 'FULL_MSG_NOTIFY':
     if(Number(v?.message?.user_type)===2){selectMessage(v.message.message_id);yield* blocks(messageBlocks(v.message),false);}
     break;
    case 'STREAM_CHUNK':
     selectMessage(v?.message_id);
     for(const op of Array.isArray(v?.patch_op)?v.patch_op:[])if(Number(op?.patch_object)===1)yield* blocks(op.patch_value?.content_block,Number(op.patch_type)===1);
     break;
   }
  }
  signal?.throwIfAborted();
  throw error('豆包工作在正式结束标记之前断开了响应。');
 }catch(e){signal?.throwIfAborted();if(e?.status)throw e;throw error('豆包工作流式响应中断或编码有误。');}
 finally{signal?.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
}

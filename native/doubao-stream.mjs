import {upstreamCode} from './protocol.mjs';
import {vendorError} from './doubao-client.mjs';

const MAX_FRAME=1024*1024,MAX_WIRE=64*1024*1024;
const error=(message,status=502)=>Object.assign(Error(message),{status});

async function* frames(reader,{signal,idleMs}){
 const decoder=new TextDecoder('utf-8',{fatal:true});
 let buf='',event='',data=[],size=0,received=0;
 function* lines(next){
  buf+=next;let newline;
  while((newline=buf.indexOf('\n'))!==-1){
   const line=buf.slice(0,newline).replace(/\r$/,'');buf=buf.slice(newline+1);
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
 function* blocks(list,append){
  if(!Array.isArray(list))return;
  for(const item of list){
   if(Number(item?.block_type)!==10000)continue;
   const info=item.content?.text_block;
   if(typeof info?.text!=='string')continue;
   const key=String(item.block_id||'default'),prior=history.get(key);
   const flags=[info.icon_url,info.icon_url_dark],tag=flags.some(x=>typeof x==='string'&&x.includes('deep_think'));
   const thinking=tag||flags.every(x=>x===undefined)&&prior?.thinking===true;
   const before=prior?.thinking===thinking?prior.text:'';
   if(!append&&!info.text.startsWith(before))throw error('豆包工作修订了已输出的内容。');
   history.set(key,{thinking,text:append?before+info.text:info.text});
   const delta=append?info.text:info.text.slice(before.length);
   if(delta)yield thinking?{reasoning_content:delta}:{content:delta};
  }
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
   switch(f.event){
    case 'SSE_REPLY_END':return;
    case 'CHUNK_DELTA':if(typeof v?.text==='string'&&v.text)yield {content:v.text};break;
    case 'STREAM_MSG_NOTIFY':yield* blocks(v?.content?.content_block,true);break;
    case 'FULL_MSG_NOTIFY':if(Number(v?.message?.user_type)===2)yield* blocks(v.message.content_block,false);break;
    case 'STREAM_CHUNK':
     for(const op of Array.isArray(v?.patch_op)?v.patch_op:[])if(Number(op?.patch_object)===1)yield* blocks(op.patch_value?.content_block,Number(op.patch_type)===1);
     break;
   }
  }
  signal?.throwIfAborted();
  throw error('豆包工作在正式结束标记之前断开了响应。');
 }catch(e){signal?.throwIfAborted();if(e?.status)throw e;throw error('豆包工作流式响应中断或编码有误。');}
 finally{signal?.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
}

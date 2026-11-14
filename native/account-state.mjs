import {normalizeProviderError} from './protocol.mjs';
export function routable(account,now=Date.now()){
 return account?.enabled===true&&(account.state==='ready'||account.state==='rate_limited'&&Number.isFinite(account.retryAt)&&account.retryAt<=now);
}
export function chatRoutable(account,now=Date.now()){
 return routable(account,now)||account?.enabled===true&&account.state==='needs_verification';
}
export function onChatSuccess(account){
 return {...account,state:'ready',upstreamCode:0,failureType:'',retryAt:0,verificationRestored:false};
}
export function onFailure(account,error,{now=Date.now(),requestId=''}={}){
 const normalized=normalizeProviderError(error,{httpStatus:error.status||502});
 const state=normalized.state||account.state;
 return {...account,state,failureAt:now,failureType:normalized.type,upstreamCode:normalized.upstream_code||0,lastRequestId:requestId,verificationRestored:false,...(state==='rate_limited'?{retryAt:now+Math.min(86400000,Math.max(1000,Number(error.retryAfterMs)||60000))}:{retryAt:0})};
}
export function restore(account,{confirmed=false,now=Date.now()}={}){
 if(account?.state!=='needs_verification')throw Object.assign(Error('此账号当前不处于待验证状态。'),{status:409});
 if(confirmed!==true)throw Object.assign(Error('请确认已使用同一账号在官网发消息并完成人机验证。'),{status:400});
 return {...account,state:'ready',restoredAt:now,verificationRestored:true,retryAt:0};
}

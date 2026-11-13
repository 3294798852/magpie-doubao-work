const fail=(status,message)=>Object.assign(new Error(message),{status});
export const validId=id=>typeof id==='string'&&/^[\w-]{1,128}$/.test(id)&&!['__proto__','constructor','prototype'].includes(id);
export const label=value=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,64):'';
export function jsonShape(value){
 const stack=[[value,0]];let count=0;
 while(stack.length){const [v,depth]=stack.pop();if(++count>20000||depth>12)throw fail(400,'JSON 结构过深或字段过多。');
  if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(k))throw fail(400,'JSON 含不支持的字段。');stack.push([x,depth+1]);}
 }
 if(Buffer.byteLength(JSON.stringify(value))>512*1024)throw fail(413,'JSON 文件请控制在 512 KB 以内。');
}
export function parseAccountBackup(value){
 jsonShape(value);
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==2||(value.schema!==undefined&&value.schema!=='doubao-work-accounts/v1')||!Array.isArray(value.accounts)||!value.accounts.length||value.accounts.length>20)throw fail(400,'请选择豆包账号备份 JSON（version: 2），每次 1–20 个账号。');
 const identities=new Set(),ids=new Set();
 return value.accounts.map(a=>{
  if(!a||a.provider!=='doubaowork'||a.desktop===true||!validId(a.id)||typeof a.pluginIdentity!=='string'||!a.pluginIdentity||a.pluginIdentity.length>256||/[\u0000-\u001f\u007f]/.test(a.pluginIdentity)||typeof a.pluginSecret?.cookieHeader!=='string'||!a.pluginSecret.cookieHeader||/[\r\n\u0000]/.test(a.pluginSecret.cookieHeader))throw fail(400,'文件中存在其他提供商、桌面账号或不完整的豆包登录快照。');
  if(ids.has(a.id)||identities.has(a.pluginIdentity))throw fail(400,'文件内有重复账号，请先合并后导入。');ids.add(a.id);identities.add(a.pluginIdentity);
  // Import only the fields needed by the Doubao provider; never apply proxies or custom providers.
  const row={id:a.id,name:label(a.name)||'豆包工作账号',nickname:label(a.nickname),provider:'doubaowork',desktop:false,pluginIdentity:a.pluginIdentity,pluginSecret:a.pluginSecret,proxy:null};
  for(const k of ['pluginPublic','pluginLedger.dailyCheckin','pluginLedger.doubaowork-models'])if(a[k]&&typeof a[k]==='object'&&!Array.isArray(a[k]))row[k]=a[k];
  return row;
 });
}

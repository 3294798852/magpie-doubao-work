import path from 'node:path';
const envValue=(env,key)=>env[key]??Object.entries(env).find(([k])=>k.toLowerCase()===key.toLowerCase())?.[1];
export function browserCandidates(platform,home,env={}){
 const p=platform==='win32'?path.win32:path.posix,rows=[];
 const add=(id,name,files)=>{for(const file of files)if(file&&p.isAbsolute(file)&&!rows.some(r=>r.path===file))rows.push({id,name,path:file});};
 const chrome=envValue(env,'DW_CHROME_BIN'),edge=envValue(env,'DW_EDGE_BIN');
 if(platform==='darwin'){
  add('chrome','Google Chrome',[chrome,...['/Applications',p.join(home,'Applications')].map(d=>p.join(d,'Google Chrome.app/Contents/MacOS/Google Chrome'))]);
  add('edge','Microsoft Edge',[edge,...['/Applications',p.join(home,'Applications')].map(d=>p.join(d,'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'))]);
 }else if(platform==='win32'){
  const dirs=[envValue(env,'ProgramFiles')||'C:\\Program Files',envValue(env,'ProgramFiles(x86)')||'C:\\Program Files (x86)',envValue(env,'LOCALAPPDATA')||p.join(home,'AppData','Local')];
  add('chrome','Google Chrome',[chrome,...dirs.map(d=>p.join(d,'Google','Chrome','Application','chrome.exe'))]);
  add('edge','Microsoft Edge',[edge,...dirs.map(d=>p.join(d,'Microsoft','Edge','Application','msedge.exe'))]);
 }else if(platform==='linux'){
  add('chrome','Google Chrome / Chromium',[chrome,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/opt/google/chrome/chrome','/usr/bin/chromium','/usr/bin/chromium-browser',p.join(home,'.local/bin/google-chrome')]);
  add('edge','Microsoft Edge',[edge,'/usr/bin/microsoft-edge','/usr/bin/microsoft-edge-stable','/opt/microsoft/msedge/msedge']);
 }
 return rows;
}

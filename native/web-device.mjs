// SPDX-License-Identifier: MIT
import {deviceId} from './desktop-device.mjs';
import {cookieValue} from './session.mjs';
import {normalizeProviderError} from './protocol.mjs';

const fail = message => Object.assign(new Error(message),{status:502,type:'device_context_unavailable'});

export async function readWebContext(session,{fetchImpl = fetch,signal} = {}) {
  const timeout = AbortSignal.timeout(25000);
  let response;
  try {
    response = await fetchImpl('https://www.doubao.com/chat/',{
      redirect:'error',signal:signal ? AbortSignal.any([signal,timeout]) : timeout,
      headers:{Cookie:session.cookieHeader,Accept:'text/html',...(session.userAgent ? {'User-Agent':session.userAgent} : {})},
    });
  } catch {
    signal?.throwIfAborted();
    throw fail('无法从豆包官网获取会话设备上下文，请检查网络后重试。');
  }
  if (!response.ok) {
    await response.body?.cancel();
    if ([401,429].includes(response.status)) throw normalizeProviderError({}, {httpStatus:response.status});
    throw fail('豆包官网暂未提供会话设备上下文，请稍后重试。');
  }
  const reader = response.body?.getReader();
  if (!reader) throw fail('豆包官网会话初始化响应为空。');
  const decoder = new TextDecoder('utf-8',{fatal:true});
  let html = '', size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const packet = await reader.read();
      if (packet.done) break;
      size += packet.value.byteLength;
      if (size > 4 * 1024 * 1024) throw Error();
      html += decoder.decode(packet.value,{stream:true});
    }
    html += decoder.decode();
  } catch {
    signal?.throwIfAborted();
    throw fail('豆包官网会话初始化响应不完整或过大。');
  } finally {
    await reader.cancel().catch(()=>{});reader.releaseLock();
  }
  let layout;
  try {
    const match = /window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/.exec(html);
    layout = JSON.parse(match[1].trim().replace(/;$/,'')).loaderData.chat_layout.chat_layout;
  } catch {
    throw fail('豆包官网会话初始化结构已变化，未取得设备上下文。');
  }
  const device = deviceId(layout.launchCore?.web_id);
  const appId = String(layout.aid || '');
  if (!device || !/^\d+$/.test(appId) || typeof layout.pc_version !== 'string' || !layout.pc_version)
    throw fail('豆包官网未返回完整的会话设备上下文，请完成官网登录后重试。');
  const issued = response.headers.getSetCookie().find(row=>row.startsWith('ttwid='))?.split(';')[0];
  const cookieHeader = issued ? [...session.cookieHeader.split(';').map(part=>part.trim())
    .filter(part=>!part.startsWith('ttwid=')),issued].join('; ') : session.cookieHeader;
  return {cookieHeader,clientProfile:'web',deviceId:device,webId:device,appId,clientVersion:layout.pc_version,
    fingerprint:cookieValue(session,'s_v_web_id') || cookieValue(session,'fp') ||
      (session.clientProfile === 'web' ? session.fingerprint : undefined)};
}

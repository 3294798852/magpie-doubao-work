import {jsonShape,label,validId,parseAccountBackup} from './account-backup.mjs';
import {readDesktopDeviceId} from './desktop-device.mjs';

const fail = message => Object.assign(new Error(message), {status:400});

export function normalizeSession(s) {
  const raw = Array.isArray(s?.cookies) ? s.cookies.filter(cookie => cookie?.path === '/' &&
    ['doubao.com','www.doubao.com'].includes(String(cookie.domain).replace(/^\./,'')) &&
    (!cookie.expires || cookie.expires < 0 || cookie.expires > Date.now()/1000))
    .map(cookie => cookie.name + '=' + cookie.value).join('; ') : s?.cookieHeader;
  if (typeof raw !== 'string' || raw.length > 32000 || /[^\x20-\x7e]/.test(raw))
    throw fail('豆包网页登录快照格式有误。');
  const pairs = new Map();
  for (const part of raw.split(';')) {
    const match = /^\s*([!#$%&'*+.^_\x60|~A-Za-z0-9-]+)=([\x21-\x3a\x3c-\x7e]*)\s*$/.exec(part);
    if (!match) throw fail('豆包网页登录快照格式有误。');
    pairs.set(match[1], match[2]);
  }
  if (!pairs.get('sessionid') && !pairs.get('sessionid_ss')) throw fail('登录快照缺少豆包会话。');
  const session = {cookieHeader:[...pairs].map(([key,value]) => key + '=' + value).join('; ')};
  for (const key of ['deviceId','webId','fingerprint','clientVersion','userAgent','channel','chromiumVersion'])
    if (typeof s[key] === 'string' && s[key].length <= 512 && /^[\x20-\x7e]+$/.test(s[key])) session[key] = s[key];
  return session;
}

// Keep the account's device context when its session moves to another host.
export async function withDeviceContext(session,readDevice = readDesktopDeviceId) {
  let device = session.deviceId;
  if (!device) {
    const cookie = session.cookieHeader.split(';').find(part => part.trim().startsWith('device_id='));
    device = cookie?.trim().slice('device_id='.length) || await readDevice();
  }
  if (!device) return session;
  const fingerprint = 'verify_'+device;
  if (session.deviceId === device && session.fingerprint === fingerprint) return session;
  return {...session,deviceId:device,fingerprint};
}

// Shared with the standalone panel and Magpie's file-import hook.
export function backupRows(value) {
  jsonShape(value);
  if (value?.version === 2) return parseAccountBackup(value).map(account => ({
    id:account.id, name:account.name, session:normalizeSession(account.pluginSecret), identity:'',
    enabled:true, auto:false, alias:'',
  }));
  if (value?.schema !== 'doubao-work-accounts/v1' || value.version !== 3 || !Array.isArray(value.accounts) ||
      value.accounts.length < 1 || value.accounts.length > 20) throw fail('请选择豆包工作账号备份，每次 1–20 个账号。');
  const ids = new Set();
  return value.accounts.map(account => {
    if (account?.provider !== 'doubaowork' || !validId(account.id) || ids.has(account.id))
      throw fail('账号备份中有重复、无效或非豆包工作账号。');
    ids.add(account.id);
    return {id:account.id, name:label(account.name).slice(0,64) || '豆包工作账号',
      session:normalizeSession(account.session), identity:'', enabled:account.enabled !== false,
      auto:account.auto === true, alias:label(account.alias).slice(0,32)};
  });
}

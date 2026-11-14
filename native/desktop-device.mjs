import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

export function deviceId(value) {
  const text = typeof value === 'string' ? value.trim()
    : Number.isSafeInteger(value) ? String(value) : '';
  return text !== '0' && /^[A-Za-z0-9_-]{1,64}$/.test(text) ? text : undefined;
}

export function desktopStatePaths(platform,home,env) {
  const names = ['Doubao','DoubaoWork'];
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || join(home,'AppData','Local');
    return names.map(name => join(base,name,'User Data','Local State'));
  }
  const base = platform === 'darwin'
    ? join(home,'Library','Application Support')
    : env.XDG_CONFIG_HOME || join(home,'.config');
  return names.map(name => join(base,name,'Local State'));
}

// Share one pending read and cache both present and absent device metadata.
export function createDesktopDeviceReader({platform = process.platform,home = homedir(),
  env = process.env,read = readFile,now = Date.now} = {}) {
  const paths = desktopStatePaths(platform,home,env);
  let cached;

  async function findDevice() {
    for (const file of paths) {
      try {
        const data = JSON.parse(await read(file,'utf8'));
        const device = deviceId(data.aha?.device?.device_id);
        if (device) return device;
      } catch {
        // The client can be absent or updating its local metadata.
      }
    }
  }

  return function readDevice() {
    const at = now();
    if (!cached || at - cached.at >= 60000) cached = {at,value:findDevice()};
    return cached.value;
  };
}

export const readDesktopDeviceId = createDesktopDeviceReader();

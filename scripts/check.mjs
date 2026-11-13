import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root = fileURLToPath(new URL('../',import.meta.url));
for (const directory of ['.','magpie','native','scripts','test']) {
  for (const name of await readdir(join(root,directory))) {
    if (!name.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath,['--check',join(root,directory,name)],{
      stdio:'inherit',windowsHide:true,
    });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}

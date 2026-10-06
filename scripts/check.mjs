import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const file of await readdir(new URL('../src/',import.meta.url))) {
  if (!file.endsWith('.js')) continue;
  const result=spawnSync(process.execPath,['--check',new URL('../src/'+file,import.meta.url).pathname.replace(/^\/(\w:)/,'$1')],{stdio:'inherit'});
  if (result.status!==0) process.exit(result.status??1);
}

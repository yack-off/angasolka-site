import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const root=new URL('../test-results/frontend-qa/',import.meta.url);
const input=JSON.parse(process.argv[2]||'{"action":"snapshot"}');const id=randomUUID();
await writeFile(new URL('command.json',root),JSON.stringify({...input,id}));
for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));try{const state=JSON.parse(await readFile(new URL('state.json',root),'utf8'));if(state.commandId===id){console.log(JSON.stringify(state));process.exit(state.commandResult.ok?0:1);}}catch{}}
throw Error('QA control timed out');

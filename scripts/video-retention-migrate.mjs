import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBilibiliResults} from '../src/bilibili-results.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const r=createBilibiliResults({stateDir:path.join(root,'state'),getRoleVersion:()=>''});
const state=r.prune();
console.log(JSON.stringify({records:state.rows.length,summaries:state.rows.filter(x=>x.summary).length,indexCreated:true}));

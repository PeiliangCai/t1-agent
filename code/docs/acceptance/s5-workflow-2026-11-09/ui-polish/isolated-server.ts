/** Isolated SQLite clone, saved-source UI audit only. No runner or model configured. */
import { resolve } from 'node:path';
import { RunStore, ExtractionStore } from '@t1/agent';
import { buildApp } from '../../../../apps/server/src/app.ts';
import { WorkbenchWorkflow } from '../../../../apps/server/src/workflow.ts';
const code=process.cwd(),store=new RunStore(resolve('runtime-data/s5-ui-audit/workflow.sqlite')), extraction=new ExtractionStore(resolve('runtime-data/s5-ui-audit/workflow.sqlite'));
const workflow=new WorkbenchWorkflow(extraction,{codeRoot:code,directory:'runtime-data/s5-ui-audit/workbench',sources:false});
const app=buildApp(store,undefined,workflow);await app.listen({host:'127.0.0.1',port:3211});
console.log('Isolated UI audit: http://127.0.0.1:3211; saved-source clone, no model runner.');
const close=async()=>{await app.close();store.close();extraction.close();};process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());

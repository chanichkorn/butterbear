import 'dotenv/config';
import fs from 'node:fs/promises';
import newman from 'newman';
const args=process.argv.slice(2);
if(args.includes('--help')){console.log('npm run demo [-- --folder "1 Core steps 01-12" | "2 Extra credits step 15"]');process.exit(0);}
const folders=['1 Core steps 01-12','2 Extra credits step 15'];
if(args.length && (args.length!==2||args[0]!=='--folder'||!folders.includes(args[1])))throw new Error('Use --help for supported folders.');
const folder=args[1];
for(const key of ['ADMIN_EMAIL','ADMIN_PASSWORD','SMTP_USER'])if(!process.env[key])throw new Error(`Set ${key} in local .env first.`);
const collection=JSON.parse(await fs.readFile('postman/Butterbear-Presentation.postman_collection.json','utf8'));
await fs.mkdir('.local',{recursive:true,mode:0o700});
const statePath='.local/Butterbear-Presentation-state.json';
if(folder===folders[1]){
 let previous;try{previous=JSON.parse(await fs.readFile(statePath,'utf8'));}catch{throw new Error('Run the core folder first to create the user and save demo state.');}
 for(const v of collection.variable){const saved=previous.variable?.find(s=>s.key===v.key);if(saved)v.value=saved.value;}
 if(!collection.variable.find(v=>v.key==='EMAIL')?.value)throw new Error('Saved state has no user. Run the core folder first.');
}
const envVar=[{key:'URL',value:'http://localhost:5005'},{key:'ADMIN_EMAIL',value:process.env.ADMIN_EMAIL},{key:'ADMIN_PASSWORD',value:process.env.ADMIN_PASSWORD},{key:'DEMO_EMAIL',value:process.env.DEMO_EMAIL||process.env.SMTP_USER}];
console.log('Running '+(folder||'the complete rehearsal workflow')+'. Real booking emails go to the configured demo inbox.');
let runtimeVariables;
const result=await new Promise((resolve,reject)=>{
 const run=newman.run({collection,envVar,...(folder?{folder}:{}),reporters:['cli'],timeoutRequest:15000},(err,summary)=>err?reject(err):resolve(summary));
 // Newman exports the original collection; capture mutated sandbox variables instead.
 run.on('script',(_error,args)=>{if(args.execution?.collectionVariables)runtimeVariables=args.execution.collectionVariables.toJSON().values;});
});
if(!runtimeVariables?.find(v=>v.key==='EMAIL')?.value)throw new Error('Runner did not produce valid demo state.');
await fs.writeFile(statePath,JSON.stringify({variable:runtimeVariables},null,2),{mode:0o600});
await fs.chmod(statePath,0o600);
console.log('Saved local demo state under ignored .local/. It contains credentials and tokens.');
if(result.run.failures.length)process.exitCode=1;

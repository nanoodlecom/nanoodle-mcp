// Real local form + synthetic graph; every POST is fulfilled in the browser.
// Nothing is hosted, paid or sent to a provider. No user screenshot/graph is read.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {creatorPage} from '../src/creator-site.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=await import(process.env.NANOODLE_PLAYWRIGHT?pathToFileURL(resolve(process.env.NANOODLE_PLAYWRIGHT)).href:'playwright');
const pageParts=creatorPage({publicBase:'https://local.invalid',creatorScriptUrl:'/creator-site.js'});
const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${pageParts.css}</style></head><body>${pageParts.body}</body></html>`;
let networkPosts=0;const server=createServer((req,res)=>{if(req.method!=='GET'){networkPosts++;res.writeHead(405);return res.end();}res.setHeader('Content-Type',req.url==='/creator-site.js'?'text/javascript':'text/html');res.end(req.url==='/creator-site.js'?readFileSync(resolve(root,'assets/creator-site.js')):html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const graph={v:1,nodes:[{id:'note',type:'comment',fields:{text:'Synthetic workflow for a local form test.'}},{id:'idea',type:'text',name:'Idea',fields:{text:'A lighthouse at dawn'}},{id:'writer',type:'llm',fields:{model:'synthetic-test-model'}}],links:[{id:'1',from:{node:'idea',port:'text'},to:{node:'writer',port:'prompt'}}]};
const author='nano_1111111111111111111111111111111111111111111111111111hifc8npp';
let browser;try{
 browser=await chromium.launch({...process.env.NANOODLE_CHROMIUM?{executablePath:process.env.NANOODLE_CHROMIUM}:{}});const page=await browser.newPage({viewport:{width:390,height:844}}),posts=[],errors=[];let releaseHost;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==origin)return route.fulfill({status:200,body:''});if(req.method()==='GET')return route.continue();assert.ok(['/creators/check','/creators/workflows'].includes(u.pathname));const body=req.postDataJSON();posts.push({path:u.pathname,body});if(u.pathname==='/creators/workflows'&&!releaseHost)await new Promise(r=>releaseHost=r);return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:'wf_local_test',url:'https://local.invalid/workflows/wf_local_test',schema:{properties:{Idea:{}}},author:body.graph.x402?.author||null,estimatedCostUsd:.02})});});
 await page.goto(origin,{waitUntil:'networkidle'});
 const file=(name,g)=>page.locator('#creator-file').setInputFiles({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(g))});const hosts=()=>posts.filter(p=>p.path==='/creators/workflows').length;
 await file('Local native.json',graph);await page.waitForFunction(()=>document.getElementById('creator-name').value==='Local native');
 await page.locator('#creator-check').click();await page.waitForFunction(()=>!document.getElementById('creator-preview').hidden);assert.equal(posts.length,1);assert.equal(hosts(),0);assert.doesNotMatch(await page.locator('#creator-preview').innerText(),/payouts: null/);
 await page.locator('#creator-host').click();assert.equal(hosts(),0);assert.match(await page.locator('#creator-error').innerText(),/Users will still pay.*Press Host again/);
 await page.locator('#creator-description').fill('Changed description');await page.locator('#creator-host').click();assert.equal(hosts(),0,'edit resets acknowledgment');
 await page.locator('#creator-host').click();await page.waitForFunction(()=>document.getElementById('creator-host').disabled);await page.locator('#creator-form').evaluate(el=>el.requestSubmit());assert.equal(hosts(),1);releaseHost();await page.waitForFunction(()=>document.getElementById('creator-host').textContent==='Workflow hosted');assert.equal(await page.locator('#creator-host').isDisabled(),true);await page.locator('#creator-form').evaluate(el=>el.requestSubmit());assert.equal(hosts(),1,'completed repeat suppressed');
 // An async replacement clears the old acknowledgment before its bytes arrive.
 await page.locator('#creator-graph').fill(JSON.stringify(graph));await page.locator('#creator-name').fill('Replacement local workflow');await page.locator('#creator-host').click();assert.equal(hosts(),1);
 await page.evaluate(()=>{const original=File.prototype.text;File.prototype.text=function(){return this.name==='slow.json'?new Promise(r=>window.__finishFile=()=>original.call(this).then(r)):original.call(this);};});
 await file('slow.json',graph);await page.locator('#creator-host').click();assert.equal(hosts(),1);await page.evaluate(()=>window.__finishFile());await page.waitForFunction(()=>document.getElementById('creator-graph').value.includes('Synthetic workflow'));await page.locator('#creator-host').click();assert.equal(hosts(),1,'new file needs a new warning click');await page.locator('#creator-host').click();await page.waitForFunction(()=>document.getElementById('creator-host').textContent==='Workflow hosted');assert.equal(hosts(),2);
 await page.locator('#creator-graph').fill(JSON.stringify({...graph,x402:{author}}));await page.locator('#creator-name').fill('Opted-in local workflow');await page.locator('#creator-host').click();await page.waitForFunction(()=>document.getElementById('creator-host').textContent==='Workflow hosted');assert.equal(hosts(),3,'opted-in author uses one click');assert.equal(posts.at(-1).body.graph.x402.author,author);
 assert.deepEqual(errors,[]);assert.equal(networkPosts,0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 console.log('✓ real local Creators: free author-less check, warning-only first Host, one second-click submission, edit/async-file reset, duplicate suppression and opted-in one-click host; 390px, zero network POSTs or jobs');
}finally{await browser?.close();await new Promise(r=>server.close(r));}

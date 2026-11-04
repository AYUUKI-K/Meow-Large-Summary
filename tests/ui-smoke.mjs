// Local browser fixture. It never connects to ST, external APIs or user data.
// node tests/ui-smoke.mjs 8786
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const prefix = '/scripts/extensions/third-party/Meow-Large-Summary/';
const host = process.argv[3];
const books = {};
let modelCalls = 0;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>喵喵大总结 · 本地模拟宿主检查</title>
<link rel="stylesheet" href="${prefix}style.css">
<style>
*{box-sizing:border-box}body{margin:0;padding:16px;font:15px/1.5 system-ui;color:#e8e8ec;background:#202126;--SmartThemeBodyColor:#e8e8ec;--SmartThemeBlurTintColor:#202126;--SmartThemeBorderColor:#62636d;--SmartThemeQuoteColor:#91b5a9}
main{width:100%;max-width:460px;margin:auto}h1{font-size:18px}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}
/* Match ST 1.19's intrinsic button width so narrow Chinese labels catch host CSS conflicts. */
.text_pole{background:#2b2d34;border:1px solid #686a74;border-radius:5px;padding:7px;width:100%}.menu_button{background:#383c48;border:1px solid #7d8290;border-radius:5px;padding:8px;width:min-content}
button:disabled{opacity:.45;cursor:default}.inline-drawer-header{display:flex;justify-content:space-between;align-items:center;font-weight:600;padding:5px 0;cursor:pointer}.inline-drawer-content{display:flex;flex-direction:column}label{display:block}summary:focus-visible,button:focus-visible{outline:2px solid #b6ceff}#world_info{display:none}#send_textarea{width:100%;margin-top:20px}
/* Native extension rows for comparing title size, spacing and theme inheritance. */
#extensions_settings2 .inline-drawer-toggle.inline-drawer-header{margin-bottom:5px;border-radius:10px;padding:2px 5px;border:1px solid var(--SmartThemeBorderColor)}.inline-drawer-icon{font-size:1.5em;line-height:1}.fixture-chevron::before{content:'⊙'}
body.light{background:#f5f3ee;color:#303932;--SmartThemeBodyColor:#303932;--SmartThemeBlurTintColor:#f5f3ee;--SmartThemeBorderColor:#aaa99e;--SmartThemeQuoteColor:#527a68}.light .text_pole{background:white;color:inherit}.light .menu_button{background:#e8ebe6;color:inherit}
#theme,#fixture-new{color:inherit;background:transparent;border:1px solid #777;border-radius:5px;padding:6px}#fixture-controls{margin:12px 0;font-size:12px}#fixture-controls label{margin:8px 0}
</style><main><h1>本地模拟宿主 · 无真实 API 请求</h1><button id="theme">切换浅色主题</button><details id="fixture-controls"><summary>测试场景</summary><button id="fixture-new">新建测试存档</button><label><input type="checkbox" id="fixture-hide">模拟隐藏失败</label></details><section id="extensions_settings2"><div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>向量存储</b><span class="inline-drawer-icon fixture-chevron" aria-hidden="true"></span></div></div><div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>柏宝箱</b><span class="inline-drawer-icon fixture-chevron" aria-hidden="true"></span></div></div></section><select id="world_info" multiple></select><form id="form_sheld"><textarea id="send_textarea" placeholder="模拟聊天输入"></textarea><button type="button" id="send_but">发送</button></form><p id="notice" role="status"></p></main>
<script src="/fixture/purify.js"></script><script src="/fixture/showdown.js"></script>
<script type="module">
const hostMode = new URLSearchParams(location.search).get('host') || 'modern';
const legacy = hostMode === '1.14';
if(hostMode === 'tauri') window.__TAURITAVERN_HOST__={platform:'android',kind:'mobile'};
if(legacy || hostMode === 'tauri'){AbortSignal.any=undefined;AbortSignal.timeout=undefined;}
const handlers = new Map();
const eventSource = {
 on(event, fn) { if(!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
 removeListener(event, fn) { handlers.get(event)?.delete(fn); },
 makeLast(event, fn) { this.removeListener(event, fn); this.on(event, fn); },
 makeFirst(event, fn) { this.removeListener(event, fn); handlers.set(event,new Set([fn,...(handlers.get(event) ?? [])])); },
 async emit(event, ...args) { for(const fn of [...(handlers.get(event) ?? [])]) await fn(...args); }
};
const eventTypes=Object.fromEntries(['APP_READY','SETTINGS_UPDATED','GENERATION_STARTED','GENERATION_AFTER_COMMANDS','GENERATE_AFTER_DATA','CHAT_COMPLETION_PROMPT_READY','CHAT_COMPLETION_SETTINGS_READY','WORLDINFO_SCAN_DONE','MESSAGE_RECEIVED','MESSAGE_SENT','MESSAGE_DELETED','MESSAGE_UPDATED','MESSAGE_SWIPED','GENERATION_ENDED','CHAT_CHANGED','CHAT_CREATED'].map(x=>[x,x]));
if(legacy){delete eventTypes.WORLDINFO_SCAN_DONE;eventTypes.WORLDINFO_ENTRIES_LOADED='WORLDINFO_ENTRIES_LOADED';}
const saved=JSON.parse(localStorage.getItem('mewo-smoke-state') || 'null');
const context={
 chatId:saved?.chatId ?? 'smoke-chat',characterId:0,characters:[{name:'测试角色',avatar:'smoke.png',chat:'smoke-chat'}],groupId:null,
 chat:saved?.chat ?? Array.from({length:100},(_,i)=>({mes:'第 '+i+' 层的测试剧情和人物约定。',name:i%2?'测试角色':'用户',is_user:!(i%2),is_system:false})),
 chatMetadata:saved?.metadata ?? {integrity:'smoke-integrity'},extensionSettings:saved?.settings ?? {auto_large_summary:{enabled:true,autoEnabled:false}},
 eventSource,eventTypes,mainApi:'openai',chatCompletionSettings:{openai_max_context:128000,openai_max_tokens:8192,chat_completion_source:'custom'},powerUserSettings:{},name1:'用户',name2:'测试角色',
 getRequestHeaders:()=>({'Content-Type':'application/json'}),getCurrentChatId:()=>context.chatId,
 async saveMetadata(){persist()},saveMetadataDebounced(){persist()},saveSettingsDebounced(){},
 async updateWorldInfoList(){const names=await (await fetch('/fixture/books')).json(); context.worldNames=names;if(legacy)(await import('/scripts/world-info.js')).setNames(names);const select=document.querySelector('#world_info');const old=[...select.selectedOptions].map(o=>o.value);select.replaceChildren(...names.map(n=>{const o=new Option(n,n);o.selected=old.includes(n);return o}));},
 getWorldInfoNames:()=>context.worldNames ?? [],
 async saveWorldInfo(name,data){await fetch('/fixture/save',{method:'POST',headers:context.getRequestHeaders(),body:JSON.stringify({name,data})})},reloadWorldInfoEditor(){},
 substituteParamsExtended:value=>value.replaceAll('{{user}}','用户'),
 async executeSlashCommandsWithOptions(command){const m=/^\\/(hide|unhide) (\\d+)-(\\d+)$/.exec(command);if(!m)throw Error('unsupported fixture command');await context.SlashCommandParser.commands[m[1]].callback({},m[2]+'-'+m[3]);return{}},
 stopGeneration(){window.smoke.cancelled=true},
 async generate(type,options={},dryRun=false){
  await eventSource.emit(eventTypes.GENERATION_STARTED,type,options,dryRun);
  await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS,type,options,dryRun);
  const core=context.chat.filter(m=>!m.is_system).map((m,index)=>({...m,index}));
  if(!dryRun){let aborted=false;window.meowLargeSummaryGenerationInterceptor(core,100000,()=>{aborted=true},type);if(aborted)return '';}
  const messages=core.slice(window.smoke.trimSource?90:0).map(m=>({role:m.is_user?'user':'assistant',content:m.mes}));
  const {books}=await (await fetch('/fixture/metrics')).json();
  const entries=new Map();
  const lore={globalLore:[],characterLore:[],chatLore:[],personaLore:[]};
  for(const option of document.querySelector('#world_info').selectedOptions){
   for(const entry of Object.values(books[option.value]?.entries ?? {})){
    lore.globalLore.push({...entry,world:option.value});
   }
  }
  if(legacy)await eventSource.emit(eventTypes.WORLDINFO_ENTRIES_LOADED,lore);
  for(const entry of lore.globalLore){
   if(entry.disable || !entry.constant || window.smoke.failBudget)continue;
   entries.set(entry.world+'.'+entry.uid,entry);
   messages.unshift({role:'system',content:entry.content});
  }
  if(eventTypes.WORLDINFO_SCAN_DONE)await eventSource.emit(eventTypes.WORLDINFO_SCAN_DONE,{activated:{entries}});
  await eventSource.emit(eventTypes.CHAT_COMPLETION_PROMPT_READY,{chat:messages,dryRun});
  await eventSource.emit(eventTypes.GENERATE_AFTER_DATA,{prompt:messages},dryRun);
  if(dryRun)return;
  const data={type,messages,model:'fixture',stream:false,fixtureTruncated:window.smoke.truncated};
  await eventSource.emit(eventTypes.CHAT_COMPLETION_SETTINGS_READY,data);
  const response=await fetch('/api/backends/chat-completions/generate',{method:'POST',body:JSON.stringify(data)});
  const result=await response.json();
  if(window.smoke.cancelled){window.smoke.cancelled=false;return '';}
  return result.choices[0].message.content;
 }
};
function persist(){localStorage.setItem('mewo-smoke-state',JSON.stringify({chatId:context.chatId,chat:context.chat,metadata:context.chatMetadata,settings:context.extensionSettings}))}
context.SlashCommandParser={commands:Object.fromEntries(['hide','unhide'].map(name=>[name,{async callback(args,range){if(window.smoke.failHide&&name==='hide')throw Error('模拟隐藏失败');const [a,b]=range.split('-').map(Number);for(let i=a;i<=Math.min(b,context.chat.length-1);i++)context.chat[i].is_system=name==='hide';persist();return ''}}]))};
window.smoke={context,persist,failHide:false,failBudget:false,truncated:false,cancelled:false};
if(legacy)delete context.getWorldInfoNames;
window.SillyTavern={getContext:()=>context,libs:{DOMPurify:window.DOMPurify,showdown:window.showdown}};
window.toastr=Object.fromEntries(['info','success','warning','error'].map(kind=>[kind,(text)=>{document.querySelector('#notice').textContent=text;return{text}}]));window.toastr.clear=()=>{};
document.querySelector('#theme').onclick=()=>document.body.classList.toggle('light');
const deleteLast=document.createElement('button');deleteLast.type='button';deleteLast.textContent='删除末层';
deleteLast.onclick=async()=>{context.chat.pop();persist();await eventSource.emit(eventTypes.MESSAGE_DELETED,context.chat.length);};
document.querySelector('#fixture-controls').append(deleteLast);
document.querySelector('#fixture-hide').onchange=event=>{window.smoke.failHide=event.target.checked};
for(const [key,label] of [['failBudget','模拟世界书预算不足'],['truncated','模拟模型回复截断'],['trimSource','模拟上下文裁剪']]){
 const row=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.id='fixture-'+key;
 input.onchange=()=>{window.smoke[key]=input.checked};row.append(input,document.createTextNode(label));document.querySelector('#fixture-controls').append(row);
}
const editOld=document.createElement('button');editOld.id='fixture-edit-old';editOld.textContent='修改已总结的旧剧情';
editOld.onclick=async()=>{context.chat[0].mes+='旧剧情已纠正。';persist();await eventSource.emit(eventTypes.MESSAGE_UPDATED,0);};
document.querySelector('#fixture-controls').append(editOld);
document.querySelector('#fixture-new').onclick=async()=>{
 context.chatId='林间驿站 · '+Date.now().toString().slice(-5);
 context.chat=Array.from({length:100},(_,i)=>({mes:'第 '+i+' 层的测试剧情和人物约定。',name:i%2?'测试角色':'用户',is_user:!(i%2),is_system:false}));
 context.chatMetadata={integrity:'fixture-'+Date.now()};persist();await eventSource.emit(eventTypes.CHAT_CHANGED);
};
await import('${prefix}index.js');
await eventSource.emit(eventTypes.APP_READY);
</script></html>`;

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (body, type = 'application/json', status = 200) => {
        response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
        if (url.pathname === '/') return send(html, 'text/html; charset=utf-8');
        if (url.pathname === '/favicon.ico') return send('', 'text/plain', 204);
        if (['/fixture/purify.js', '/fixture/showdown.js'].includes(url.pathname)) {
            if (!host) return send('', 'text/javascript');
            const library = url.pathname.includes('purify') ? 'dompurify/dist/purify.min.js' : 'showdown/dist/showdown.min.js';
            return send(await readFile(path.join(host, 'node_modules', library), 'utf8'), 'text/javascript');
        }
        if (url.pathname === '/fixture/books') return send(Object.keys(books));
        if (url.pathname === '/api/extensions/discover') return send([{ name: 'third-party/Meow-Large-Summary', type: 'local' }]);
        if (url.pathname === '/api/extensions/version') return send({ isUpToDate: true });
        if (url.pathname === '/script.js') return send(`export const is_send_press=false;export const isGenerating=()=>false;export async function saveSettings(){window.smoke.persist();await window.smoke.context.eventSource.emit('SETTINGS_UPDATED')}`, 'text/javascript');
        if (url.pathname === '/scripts/world-info.js') return send(`export let world_names=[];export function setNames(names){world_names=names}`, 'text/javascript');
        if (url.pathname === '/scripts/openai.js') return send(`export const promptManager={render(){}};export const getChatCompletionModel=()=> 'fixture';export const createGenerationParameters=async(s,m,t,messages)=>({generate_data:{type:t,messages,model:m}});`, 'text/javascript');
        if (url.pathname === '/scripts/tokenizers.js') return send(`export const countTokensOpenAIAsync=async messages=>Math.ceil(JSON.stringify(messages).length/3);`, 'text/javascript');
        if (url.pathname === '/scripts/extensions/regex/engine.js') return send(`export const regex_placement={WORLD_INFO:5};export const getRegexedString=text=>text;`, 'text/javascript');
        if (url.pathname.startsWith(prefix)) {
            const file = path.resolve(root, decodeURIComponent(url.pathname.slice(prefix.length)));
            const contentTypes = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
            if (!file.startsWith(root) || !contentTypes[path.extname(file)]) return send({}, 'application/json', 403);
            return send(await readFile(file), contentTypes[path.extname(file)]);
        }
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        if (url.pathname === '/api/worldinfo/get') return send(books[body.name] ?? { entries: {} });
        if (url.pathname === '/fixture/save') { books[body.name] = body.data; return send({ ok: true }); }
        if (url.pathname === '/api/backends/chat-completions/generate') {
            modelCalls += 1;
            await new Promise(resolve => setTimeout(resolve, 600));
            return send({ choices: [{ finish_reason: body.fixtureTruncated ? 'length' : 'stop', message: { content: '<details><summary>第 '+modelCalls+' 次记忆 · 林间驿站</summary><p>10 月 6 日傍晚，旅行者与林青在驿站碰面。两人确认旧地图上的标记指向北侧渡口，决定等雨停后再出发。</p><ul><li><strong>重要约定：</strong>明早七点在旅店门口会合，出发前检查绳索与灯油。</li><li><strong>保留线索：</strong>铜钥匙由旅行者保管，林青收起了地图。</li><li><strong>待解决：</strong>渡口停航的原因尚未查明。</li></ul><p>关系变化：林青开始主动分享路线判断，但仍未解释自己为何熟悉这片山林。</p></details><details><summary>角色与物品</summary><p>旅行者：保管钥匙与灯具。林青：负责地图、补给与路线。</p></details>' } }] });
        }
        if (url.pathname === '/fixture/metrics') return send({ modelCalls, books });
        return send({ error: 'Unknown fixture path' }, 'application/json', 404);
    } catch (error) { send({ error: error.message }, 'application/json', 500); }
});
server.listen(Number(process.argv[2] ?? 8786), '127.0.0.1', () => console.log('UI fixture: http://127.0.0.1:' + server.address().port));

/** Returns the minified browser tracking script served at GET /script.js */
interface BrowserScriptGlobal {
  window?: unknown;
  document?: {
    createElement(tag: string): {
      src: string;
      setAttribute(name: string, value: string): void;
    };
    head: {
      appendChild(element: unknown): void;
    };
  };
}

export function getBrowserScript(serverUrl: string): string {
  return `(function(){
var cfg={url:'${serverUrl}',projectId:null,browserToken:null};
var el=document.currentScript;
if(el){cfg.projectId=el.getAttribute('data-project')||null;cfg.browserToken=el.getAttribute('data-browser-token')||el.getAttribute('data-write-token')||null;}
var q=[];
function flush(){if(!q.length)return;var b=q.splice(0);var h={'Content-Type':'application/json'};if(cfg.browserToken)h['X-Logs-Browser-Token']=cfg.browserToken;fetch(cfg.url+'/api/logs',{method:'POST',headers:h,body:JSON.stringify(b),keepalive:true}).catch(function(){});}
setInterval(flush,2000);
function push(level,msg,extra){
  q.push(Object.assign({level:level,message:String(msg),source:'script',url:location.href,timestamp:new Date().toISOString()},cfg.projectId?{project_id:cfg.projectId}:{},extra||{}));
  if(q.length>=10)flush();
}
var _ce=console.error.bind(console);
console.error=function(){_ce.apply(console,arguments);push('error',Array.from(arguments).join(' '));};
var _cw=console.warn.bind(console);
console.warn=function(){_cw.apply(console,arguments);push('warn',Array.from(arguments).join(' '));};
window.addEventListener('error',function(e){push('error',e.message,{stack_trace:e.error?e.error.stack:null,url:e.filename});});
window.addEventListener('unhandledrejection',function(e){push('error','Unhandled promise rejection: '+(e.reason&&e.reason.message||String(e.reason)),{stack_trace:e.reason&&e.reason.stack||null});});
window.addEventListener('beforeunload',flush);
window.__logs={push:push,flush:flush,config:cfg};
})();`;
}

export function initLogsScript(config: {
  projectId: string;
  url: string;
  browserToken?: string;
}): void {
  const browser = globalThis as unknown as BrowserScriptGlobal;
  if (!browser.window || !browser.document) return;
  const script = browser.document.createElement("script");
  script.src = `${config.url}/script.js`;
  script.setAttribute("data-project", config.projectId);
  if (config.browserToken)
    script.setAttribute("data-browser-token", config.browserToken);
  browser.document.head.appendChild(script);
}

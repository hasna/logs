/** Returns the minified browser tracking script served at GET /script.js */
export function getBrowserScript(serverUrl: string): string {
  return `(function(){
var cfg={url:'${serverUrl}',projectId:null};
var el=document.currentScript;
if(el){cfg.projectId=el.getAttribute('data-project')||null;}
var q=[];
function flush(){if(!q.length)return;var b=q.splice(0);fetch(cfg.url+'/api/logs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b),keepalive:true}).catch(function(){});}
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
})();`
}

export function initLogsScript(config: { projectId: string; url: string }): void {
  if (typeof window === "undefined") return
  const script = document.createElement("script")
  script.src = `${config.url}/script.js`
  script.setAttribute("data-project", config.projectId)
  document.head.appendChild(script)
}

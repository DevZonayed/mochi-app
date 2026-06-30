// Serves a design project's folder over the sidecar's loopback HTTP server, replacing the old
// Electron `maestro-design://` custom protocol. The WKWebView in the native Design workspace loads
//   http://127.0.0.1:<port>/design/<projectId>/design/index.html
// Read-only + path-guarded to the project root (no traversal / symlink escape). HTML gets the
// smooth-scrollbar CSS + a WKWebView-adapted comment harness injected.

import { existsSync, realpathSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Store } from '../../../apps/desktop/electron/store.js';

const DESIGN_MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

const DESIGN_CSP = "default-src 'self' data: blob: https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'";

const DESIGN_PLACEHOLDER = `<!doctype html><meta charset="utf8"><style>
  html,body{margin:0;height:100%;font:400 15px/1.6 -apple-system,system-ui,sans-serif;background:#0b0b0f;color:#9aa0ad;
  display:grid;place-items:center;text-align:center}.c{max-width:340px;padding:24px}
  .d{width:40px;height:40px;margin:0 auto 16px;border-radius:11px;background:linear-gradient(135deg,#6366f1,#a855f7)}
  h1{font-size:17px;color:#e8eaf0;margin:0 0 6px;font-weight:600}</style>
  <div class="c"><div class="d"></div><h1>Your design will appear here</h1>
  <p>Describe what you want in the chat — the agent builds a live, self-contained design you can refine and hand off to code.</p></div>`;

const DESIGN_SCROLLBAR_CSS = `
html{scroll-behavior:smooth}
*{scrollbar-width:thin;scrollbar-color:rgba(140,142,152,.45) transparent}
::-webkit-scrollbar{width:12px;height:12px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(140,142,152,.45);border-radius:10px;border:3px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:rgba(140,142,152,.72);background-clip:padding-box}
`;

// Mochi-style comment harness, WKWebView-adapted: page→Swift via webkit.messageHandlers.maestroDesign,
// Swift→page via a dispatched 'message' event (window.dispatchEvent(new MessageEvent('message',{data}))).
const DESIGN_COMMENT_HARNESS = `(function(){
  if (window.__maestroComments) return; window.__maestroComments = true;
  var mh=(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.maestroDesign)||null;
  function post(x){ try{ if(mh) mh.postMessage(x); }catch(_){} }
  var mode=false, hover=null, markers=[];
  var box=document.createElement('div');
  box.style.cssText='position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2f81f7;background:rgba(47,129,247,.12);border-radius:4px;display:none;box-sizing:border-box';
  var pins=document.createElement('div');
  pins.style.cssText='position:fixed;inset:0;z-index:2147483645;pointer-events:none';
  function ready(){ try{ document.body.appendChild(box); document.body.appendChild(pins); }catch(_){} }
  if (document.body) ready(); else document.addEventListener('DOMContentLoaded', ready);
  function esc(s){ try{ return CSS.escape(s); }catch(_){ return s; } }
  function cssPath(el){
    if(!(el instanceof Element)) return '';
    if(el.id) return '#'+esc(el.id);
    var parts=[];
    while(el && el.nodeType===1 && el!==document.body && parts.length<6){
      var sel=el.nodeName.toLowerCase(), p=el.parentNode;
      if(p){ var sibs=Array.prototype.filter.call(p.children,function(c){return c.nodeName===el.nodeName;});
        if(sibs.length>1) sel+=':nth-of-type('+(Array.prototype.indexOf.call(sibs,el)+1)+')'; }
      parts.unshift(sel); el=el.parentElement;
    }
    return parts.join(' > ');
  }
  function label(el){
    var tag=el.nodeName.toLowerCase();
    var t=(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,42);
    return tag+(t?' \\u00b7 \\u201c'+t+'\\u201d':'');
  }
  function frame(el){ var r=el.getBoundingClientRect(); box.style.display='block'; box.style.left=r.left+'px'; box.style.top=r.top+'px'; box.style.width=r.width+'px'; box.style.height=r.height+'px'; }
  function onMove(e){ if(!mode) return; var el=document.elementFromPoint(e.clientX,e.clientY); if(!el||el===box||el===pins) return; hover=el; frame(el); }
  function onClick(e){ if(!mode) return; e.preventDefault(); e.stopPropagation(); var el=hover||document.elementFromPoint(e.clientX,e.clientY); if(!el) return; post({type:'comment-pick',selector:cssPath(el),label:label(el)}); return false; }
  document.addEventListener('mousemove',onMove,true);
  document.addEventListener('click',onClick,true);
  document.addEventListener('keydown',function(e){ if(mode&&e.key==='Escape'){ setMode(false); post({type:'comment-cancel'}); } },true);
  function setMode(on){ mode=on; try{ document.documentElement.style.cursor=on?'crosshair':''; }catch(_){} if(!on) box.style.display='none'; }
  function renderPins(){
    pins.innerHTML='';
    markers.forEach(function(m){
      try{ var el=document.querySelector(m.selector); if(!el) return; var r=el.getBoundingClientRect();
        var pin=document.createElement('div');
        pin.style.cssText='position:absolute;transform:translate(-50%,-50%) rotate(45deg);width:20px;height:20px;border-radius:50% 50% 50% 0;background:'+(m.status==='resolved'?'#2da44e':'#fb8500')+';border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45)';
        var s=document.createElement('span'); s.textContent=m.n; s.style.cssText='display:block;transform:rotate(-45deg);color:#fff;font:700 11px/16px system-ui;text-align:center;width:100%';
        pin.appendChild(s); pin.style.left=(r.left+9)+'px'; pin.style.top=(r.top+9)+'px'; pins.appendChild(pin);
      }catch(_){}
    });
  }
  window.addEventListener('scroll',renderPins,true);
  window.addEventListener('resize',renderPins,true);
  window.addEventListener('message',function(e){
    var d=e.data; if(!d||!d.__maestro) return;
    if(d.type==='comment-mode') setMode(!!d.on);
    if(d.type==='comment-markers'){ markers=Array.isArray(d.items)?d.items:[]; renderPins(); }
    if(d.type==='flash'&&d.selector){ try{ var el=document.querySelector(d.selector); if(el){ el.scrollIntoView({behavior:'smooth',block:'center'}); frame(el); setTimeout(function(){ if(!mode) box.style.display='none'; },1300); } }catch(_){} }
  });
})();`;

function designRootFor(store: Store, projectId: string): string | null {
  const p = store.getProject(projectId);
  if (!p || p.kind !== 'design') return null;
  const safe = (p.name || 'default').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'default';
  const candidates = [p.path, path.join(os.homedir(), 'Maestro', safe)].filter((c): c is string => !!c);
  for (const c of candidates) if (existsSync(path.join(c, 'design', 'index.html'))) return c;
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0] ?? null;
}

export interface DesignResponse { status: number; contentType: string; body: Buffer | string; headers?: Record<string, string>; }

export async function serveDesign(store: Store, projectId: string, relPath: string): Promise<DesignResponse> {
  try {
    const root = designRootFor(store, projectId);
    if (!root) return { status: 404, contentType: 'text/plain', body: 'no such design project' };
    const rel = decodeURIComponent(relPath).replace(/^\/+/, '') || 'design/index.html';
    const rootReal = realpathSync(path.resolve(root));
    const target = path.resolve(rootReal, rel);
    if (!existsSync(target)) {
      if (rel === 'design/index.html') return { status: 200, contentType: 'text/html', body: DESIGN_PLACEHOLDER, headers: { 'content-security-policy': DESIGN_CSP } };
      return { status: 404, contentType: 'text/plain', body: 'not found' };
    }
    const real = realpathSync(target);
    const relReal = path.relative(rootReal, real);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) return { status: 403, contentType: 'text/plain', body: 'forbidden' };
    const buf = await fsp.readFile(real);
    const mime = DESIGN_MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream';
    if (mime === 'text/html') {
      let html = buf.toString('utf8');
      const styleTag = `<style id="maestro-scroll">${DESIGN_SCROLLBAR_CSS}</style>`;
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + styleTag) : styleTag + html;
      const tag = `<script>${DESIGN_COMMENT_HARNESS}</script>`;
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + '</body>') : html + tag;
      return { status: 200, contentType: 'text/html', body: html, headers: { 'content-security-policy': DESIGN_CSP, 'cache-control': 'no-cache' } };
    }
    return { status: 200, contentType: mime, body: buf, headers: { 'cache-control': 'no-cache' } };
  } catch {
    return { status: 500, contentType: 'text/plain', body: 'error' };
  }
}

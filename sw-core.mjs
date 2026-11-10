// No game bytes are sent to the host. Virtual game requests are answered from IndexedDB.
export const SHELL_VERSION='1.2.0';
export const SHELL_FILES=['index.html','styles.css','app.mjs','sw-core.mjs','store.mjs','zip.mjs','importer.mjs','saves.mjs','runtime.js','manifest.webmanifest','icon.svg','apple-touch-icon.png'];
export const GAME_CSP="default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
export function parseGameURL(input,scope){
  const url=new URL(input),base=new URL(scope);if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname+'play/'))return null;
  const pieces=url.pathname.slice((base.pathname+'play/').length).split('/');
  let decoded;try{decoded=pieces.map(p=>decodeURIComponent(p));}catch{throw Error('ゲームのパスを読み取れません。');}
  const [gameId,version,...parts]=decoded;
  if(!/^[a-z0-9][a-z0-9-]{0,60}$/.test(gameId||'')||! /^[a-zA-Z0-9_-]{1,150}$/.test(version||'')||!parts.length||parts.some(p=>!p||p==='.'||p==='..'||/[\\/%\x00-\x1f\x7f]/.test(p)))throw Error('ゲームのパスが不正です。');
  return {gameId,version,path:parts.join('/')};
}
export function mimeType(path){
  const ext=path.split('.').pop().toLowerCase();return ({html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',json:'application/json; charset=utf-8',css:'text/css; charset=utf-8',txt:'text/plain; charset=utf-8',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',svg:'image/svg+xml',ogg:'audio/ogg',m4a:'audio/mp4',mp3:'audio/mpeg',wav:'audio/wav',mp4:'video/mp4',webm:'video/webm',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf',ico:'image/x-icon',webmanifest:'application/manifest+json'})[ext]||'application/octet-stream';
}
export function parseRange(value,size){
  const match=/^bytes=(\d*)-(\d*)$/.exec(value||'');if(!match||(!match[1]&&!match[2])||size===0)return null;
  let start,end;if(!match[1]){const length=Number(match[2]);if(!Number.isSafeInteger(length)||length<1)return null;start=Math.max(0,size-length);end=size-1;}
  else{start=Number(match[1]);end=match[2]?Number(match[2]):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||start>end)return null;end=Math.min(end,size-1);}
  return {start,end};
}
function attr(value){return String(value).replace(/[&"<>]/g,c=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[c]));}
function startupError(){throw Error('標準のRPGツクールMVの同期起動HTMLではありません。スマホ用1Pビルドを作り直してください。');}
function tagEnd(html,start){
  let quote='';for(let i=start;i<html.length;i++){const c=html[i];if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='>')return i+1;}
  startupError();
}
function scriptAttributes(source){
  const attributes=new Map();let at=0;
  while(at<source.length){
    while(/[\t\n\f\r ]/.test(source[at]||'\0'))at++;
    if(at===source.length||source.slice(at).trim()==='/')break;
    const name=/^[^\s"'<>/=]+/.exec(source.slice(at));if(!name)startupError();
    const key=name[0].toLowerCase();at+=name[0].length;
    while(/[\t\n\f\r ]/.test(source[at]||'\0'))at++;
    let value='';if(source[at]==='='){
      at++;while(/[\t\n\f\r ]/.test(source[at]||'\0'))at++;
      if(source[at]==='"'||source[at]==="'"){const quote=source[at++],end=source.indexOf(quote,at);if(end<0)startupError();value=source.slice(at,end);at=end+1;}
      else{const found=/^[^\s"'`=<>]+/.exec(source.slice(at));if(!found)startupError();value=found[0];at+=value.length;}
    }
    // Browser duplicate-attribute handling must not disagree with validation.
    if(attributes.has(key))startupError();attributes.set(key,value);
  }
  return attributes;
}

/** Scan conventional MV HTML without evaluating it, retaining original offsets.
 * Both ZIP inspection and SW injection use this exact scanner. Inert markup and
 * raw text (including JS strings) cannot masquerade as the manager script.
 */
export function startupManagerEnd(html){
  if(typeof html!=='string')startupError();
  const inert=[],rawNames=new Set(['script','style','textarea','title','xmp','iframe','noembed','noframes','noscript']);
  let at=0,managerEnd=null;
  while(at<html.length){
    const start=html.indexOf('<',at);if(start<0)break;
    if(html.startsWith('<!--',start)){const end=html.indexOf('-->',start+4);if(end<0)startupError();at=end+3;continue;}
    if(/^<!doctype\b/i.test(html.slice(start))){at=tagEnd(html,start+2);continue;}
    const token=/^<(\/?)([a-z][a-z0-9:-]*)(?=[\t\n\f\r />])/i.exec(html.slice(start));
    if(!token){at=start+1;continue;}
    const closing=Boolean(token[1]),name=token[2].toLowerCase(),end=tagEnd(html,start+token[0].length);
    if(closing){if(inert.at(-1)===name)inert.pop();at=end;continue;}
    if(['template','svg','math'].includes(name)){inert.push(name);at=end;continue;}
    if(!inert.length&&name==='base')startupError();
    if(name==='plaintext')break;
    if(!rawNames.has(name)){at=end;continue;}
    const closePattern=new RegExp('</'+name+'(?=[\\t\\n\\f\\r />])','ig');closePattern.lastIndex=end;
    const close=closePattern.exec(html);if(!close)startupError();
    const closeEnd=tagEnd(html,close.index+close[0].length);
    if(name==='script'&&!inert.length){
      const attrs=scriptAttributes(html.slice(start+token[0].length,end-1)),src=attrs.get('src')||'';
      if(/^(?:\.\/)?js\/rpg_managers\.js(?:\?[^#]*)?$/.test(src)){
        const asciiTrim=value=>value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g,'');
        const type=asciiTrim(attrs.get('type')||'').toLowerCase(),language=asciiTrim(attrs.get('language')||'').toLowerCase();
        const classic=!type||['text/javascript','application/javascript','text/ecmascript','application/ecmascript','text/jscript','text/livescript','application/x-javascript','application/x-ecmascript'].includes(type)||/^text\/javascript1\.[0-5]$/.test(type);
        if(managerEnd!==null||!classic||attrs.has('async')||attrs.has('defer')||attrs.has('nomodule')||(!attrs.has('type')&&language&&!/^(?:javascript(?:1\.[0-5])?|ecmascript|jscript|livescript)$/.test(language)))startupError();
        managerEnd=closeEnd;
      }
    }
    at=closeEnd;
  }
  if(managerEnd===null)startupError();return managerEnd;
}
export function injectRuntime(html,gameId,scope){
  const end=startupManagerEnd(html),runtime='\n<script src="'+attr(new URL('runtime.js',scope).href)+'" data-game-id="'+attr(gameId)+'"></script>';
  return html.slice(0,end)+runtime+html.slice(end);
}
export function fileResponse(request,blob,path,extraHeaders={}){
  const headers=new Headers({'Content-Type':mimeType(path),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes',...extraHeaders});
  let body=blob,status=200;
  const range=request.headers.get('range');if(range){const parsed=parseRange(range,blob.size);if(!parsed){headers.set('Content-Range','bytes */'+blob.size);return new Response(null,{status:416,headers});}status=206;body=blob.slice(parsed.start,parsed.end+1);headers.set('Content-Range',`bytes ${parsed.start}-${parsed.end}/${blob.size}`);}
  headers.set('Content-Length',String(body.size));return new Response(request.method==='HEAD'?null:body,{status,headers});
}
export async function gameResponse(request,scope,getFile,getVersion){
  const loc=parseGameURL(request.url,scope);if(!loc)return null;
  if(request.method!=='GET'&&request.method!=='HEAD')return new Response('読み取り専用です。',{status:405,headers:{Allow:'GET, HEAD'}});
  const version=await getVersion(loc.gameId,loc.version);if(!version||version.status&&version.status!=='complete')return new Response('このゲームの保存データがありません。ライブラリでZIPを取り込み直してください。',{status:404});
  let blob=await getFile(loc.gameId,loc.version,loc.path);if(!blob)return new Response('ファイルが見つかりません: '+loc.path,{status:404,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
  const headers={};if(/\.html?$/i.test(loc.path)){headers['Content-Security-Policy']=GAME_CSP;if(loc.path==='index.html')blob=new Blob([injectRuntime(await blob.text(),loc.gameId,scope)],{type:'text/html'});}
  return fileResponse(request,blob,loc.path,headers);
}

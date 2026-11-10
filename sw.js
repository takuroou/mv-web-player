import {SHELL_VERSION,SHELL_FILES,gameResponse} from './sw-core.mjs';
import {getFile,getVersion} from './store.mjs';
const scope=self.registration.scope,CACHE='mv-pocket-shell-'+encodeURIComponent(new URL(scope).pathname)+'-'+SHELL_VERSION;
const shell=new Set(SHELL_FILES.map(file=>new URL(file,scope).href));
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);await cache.addAll([...shell].map(url=>new Request(url,{cache:'reload'})));
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  // Preserve older shell caches until all tabs have moved to a future version.
  await self.clients.claim();
})()));
self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_UPDATE')self.skipWaiting();});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);if(url.origin!==new URL(scope).origin)return;
  if(!url.pathname.startsWith(new URL(scope).pathname))return;
  event.respondWith((async()=>{
    try{
      const game=await gameResponse(event.request,scope,getFile,getVersion);if(game)return game;
      if(event.request.method!=='GET'&&event.request.method!=='HEAD')return new Response('読み取り専用です。',{status:405});
      let key=new URL(url);key.search='';key.hash='';if(key.href===scope)key=new URL('index.html',scope);
      if(!shell.has(key.href))return new Response('このプレイヤーでは配信しないファイルです。',{status:404});
      const cache=await caches.open(CACHE);const cached=await cache.match(key.href);
      if(cached)return event.request.method==='HEAD'?new Response(null,{status:cached.status,headers:cached.headers}):cached;
      const response=await fetch(new Request(key.href,{cache:'no-cache'}));if(response.ok)await cache.put(key.href,response.clone());return response;
    }catch(error){return new Response('読み込みに失敗しました。ライブラリに戻って再度取り込んでください。\n'+String(error.message||error),{status:500,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});}
  })());
});

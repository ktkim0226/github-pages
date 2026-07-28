const CACHE_NAME="asset-barcode-scanner-v1.0.14";
const CORE=["./","./index.html","./styles.css?v=1.0.14","./app.js?v=1.0.14","./manifest.webmanifest","./icon.svg"];
self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(CORE)));
});
self.addEventListener("message",event=>{
  if(event.data&&event.data.type==="SKIP_WAITING")self.skipWaiting();
});
self.addEventListener("activate",event=>{
  event.waitUntil(Promise.all([
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))),
    self.clients.claim()
  ]));
});
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET")return;
  const url=new URL(event.request.url);
  if(event.request.mode==="navigate"){
    event.respondWith(fetch(event.request,{cache:"no-store"}).then(response=>{
      if(response&&response.ok)caches.open(CACHE_NAME).then(cache=>cache.put("./index.html",response.clone()));
      return response;
    }).catch(()=>caches.match("./index.html")));
    return;
  }
  if(url.pathname.endsWith("/version.json")||url.pathname.endsWith("/sw.js")){
    event.respondWith(fetch(event.request,{cache:"no-store"}));return;
  }
  event.respondWith(fetch(event.request).then(response=>{
    if(response&&response.ok)caches.open(CACHE_NAME).then(cache=>cache.put(event.request,response.clone()));
    return response;
  }).catch(()=>caches.match(event.request)));
});

// Shared by the library UI and service worker. No game bytes are uploaded.
const DB_NAME='mv-web-player-v1',DB_VERSION=1,LEASE_MS=15*60*1000;
let databasePromise;
const runId=globalThis.crypto?.randomUUID?.()||String(Date.now())+Math.random();
let ownerSession=runId;
const importLocks=new Map();
let ownerLockPromise,ownerLockRelease,ownerLockUsers=0;
try{if(globalThis.sessionStorage){ownerSession=sessionStorage.getItem('mv-web-player-import-session')||runId;sessionStorage.setItem('mv-web-player-import-session',ownerSession);}}catch{}
function uuid(){return crypto.randomUUID();}
async function holdImportOwner(){
  if(!globalThis.navigator?.locks)return ()=>{};
  ownerLockUsers++;
  if(!ownerLockPromise){
    let ready,reject;
    ownerLockPromise=new Promise((resolve,fail)=>{ready=resolve;reject=fail;});
    const held=new Promise(resolve=>{ownerLockRelease=resolve;});
    navigator.locks.request('mv-player-import-owner:'+runId,{mode:'exclusive'},async()=>{ready();await held;}).catch(reject);
  }
  try{await ownerLockPromise;}catch(error){ownerLockUsers--;if(!ownerLockUsers){ownerLockPromise=null;ownerLockRelease=null;}throw error;}
  let released=false;
  return ()=>{if(released)return;released=true;ownerLockUsers--;if(!ownerLockUsers){ownerLockRelease();ownerLockPromise=null;ownerLockRelease=null;}};
}
function releaseImport(stage){const release=importLocks.get(stage.id);importLocks.delete(stage.id);release?.();}
export function storageError(error){if(error?.name==='QuotaExceededError')return Error('iPhoneの保存容量が不足しています。不要なゲームや端末のファイルを整理してから、もう一度取り込んでください。現在のゲームとセーブはそのままです');return error;}
function req(request){return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(storageError(request.error));});}
export function openDatabase(){
  if(!databasePromise)databasePromise=new Promise((resolve,reject)=>{
    if(!globalThis.indexedDB){reject(Error('このブラウザーでは端末内の保存機能を利用できません。Safariで開いてください'));return;}
    const r=indexedDB.open(DB_NAME,DB_VERSION);
    r.onupgradeneeded=()=>{const db=r.result;db.createObjectStore('games',{keyPath:'id'});const versions=db.createObjectStore('versions',{keyPath:['gameId','id']});versions.createIndex('game','gameId');const files=db.createObjectStore('files',{keyPath:['gameId','version','path']});files.createIndex('version',['gameId','version']);};
    r.onerror=()=>{databasePromise=undefined;reject(storageError(r.error));};r.onblocked=()=>{databasePromise=undefined;reject(Error('別のタブでプレイヤーを開いています。タブを閉じて再読み込みしてください'));};
    r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>{db.close();databasePromise=undefined;};resolve(db);};
  });return databasePromise;
}
async function transaction(stores,mode,fn){const db=await openDatabase(),tx=db.transaction(stores,mode);const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(storageError(tx.error||Error('端末への保存が中断されました')));tx.onerror=()=>{};});try{const result=await fn(tx);await done;return result;}catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw storageError(error);}}
function deleteVersion(tx,gameId,version){tx.objectStore('versions').delete([gameId,version]);return new Promise((resolve,reject)=>{const r=tx.objectStore('files').index('version').openCursor(IDBKeyRange.only([gameId,version]));r.onerror=()=>reject(r.error);r.onsuccess=()=>{const cursor=r.result;if(!cursor){resolve();return;}cursor.delete();cursor.continue();};});}
export async function listGames(){return transaction(['games'],'readonly',async tx=>(await req(tx.objectStore('games').getAll())).filter(g=>g.activeVersion).map(publicGame).sort((a,b)=>b.importedAt.localeCompare(a.importedAt)));}
function publicGame(game){if(!game)return null;const {pendingVersion,pendingOwner,pendingSession,leaseUntil,...value}=game;return value;}
export async function getGame(id){return transaction(['games'],'readonly',async tx=>publicGame(await req(tx.objectStore('games').get(id))));}
export async function getVersion(id,version){return transaction(['versions'],'readonly',async tx=>{const value=await req(tx.objectStore('versions').get([id,version]));return value?.status==='complete'?value:null;});}
export async function getFile(id,version,path){return transaction(['files','versions'],'readonly',async tx=>{const valid=await req(tx.objectStore('versions').get([id,version]));if(valid?.status!=='complete')return null;return (await req(tx.objectStore('files').get([id,version,path])))?.blob||null;});}
export async function beginImport(build,{expectedActiveVersion,totalBytes,fileCount}={}){
  const release=await holdImportOwner();
  try{const stage=await transaction(['games','versions'],'readwrite',async tx=>{
    const gs=tx.objectStore('games'),old=await req(gs.get(build.id)),active=old?.activeVersion??null;
    if(old?.pendingVersion)throw Error('このゲームは別の取り込み処理で更新中です。完了を待つか、そのタブを閉じてプレイヤーを開き直してください');
    if(expectedActiveVersion!==undefined&&active!==expectedActiveVersion)throw Error('別のタブでゲームが更新されました。取り込み内容を確認し直してください');
    const version=uuid(),now=new Date().toISOString();
    const stage={gameId:build.id,id:version,status:'staging',owner:runId,session:ownerSession,baseVersion:active,build,totalBytes,fileCount,writtenFiles:0,writtenBytes:0,importedAt:now,leaseUntil:Date.now()+LEASE_MS};
    tx.objectStore('versions').add(stage);gs.put({...old,id:build.id,pendingVersion:version,pendingOwner:runId,pendingSession:ownerSession,leaseUntil:stage.leaseUntil});return stage;
  });importLocks.set(stage.id,release);return stage;}catch(error){release();throw error;}
}
export async function putImportFile(stage,path,blob){return transaction(['games','versions','files'],'readwrite',async tx=>{
  const gs=tx.objectStore('games'),vs=tx.objectStore('versions'),game=await req(gs.get(stage.gameId)),current=await req(vs.get([stage.gameId,stage.id]));
  if(!current||current.status!=='staging'||current.owner!==runId||game?.pendingVersion!==stage.id)throw Error('取り込みが中断されています。ZIPを選び直してください');
  tx.objectStore('files').add({gameId:stage.gameId,version:stage.id,path,blob});current.writtenFiles++;current.writtenBytes+=blob.size;current.leaseUntil=Date.now()+LEASE_MS;vs.put(current);gs.put({...game,leaseUntil:current.leaseUntil});
});}
export async function commitImport(stage){const result=await transaction(['games','versions','files'],'readwrite',async tx=>{
  const gs=tx.objectStore('games'),vs=tx.objectStore('versions'),game=await req(gs.get(stage.gameId)),current=await req(vs.get([stage.gameId,stage.id]));
  if(!current||current.status!=='staging'||current.owner!==runId||game?.pendingVersion!==stage.id||(game.activeVersion??null)!==current.baseVersion)throw Error('取り込み中にゲームが更新されました。現在の版を保護するため保存を中止しました');
  if(current.writtenFiles!==current.fileCount||current.writtenBytes!==current.totalBytes)throw Error('必要なファイルがすべて保存されていません');
  const build=current.build,next={id:build.id,title:build.title,activeVersion:current.id,previousVersion:game.activeVersion||null,buildId:build.buildId,createdAt:build.createdAt,importedAt:current.importedAt,totalBytes:current.totalBytes,fileCount:current.fileCount};
  current.status='complete';delete current.owner;delete current.session;delete current.leaseUntil;vs.put(current);gs.put(next);
  if(game.previousVersion&&game.previousVersion!==next.previousVersion)await deleteVersion(tx,game.id,game.previousVersion);
  return next;
});releaseImport(stage);return result;}
export async function abortImport(stage){try{return await transaction(['games','versions','files'],'readwrite',async tx=>{
  const gs=tx.objectStore('games'),game=await req(gs.get(stage.gameId)),current=await req(tx.objectStore('versions').get([stage.gameId,stage.id]));
  if(current?.status!=='staging'||current.owner!==runId)return;
  await deleteVersion(tx,stage.gameId,stage.id);
  if(game?.pendingVersion===stage.id){if(game.activeVersion)gs.put(publicGame(game));else gs.delete(game.id);}
});}finally{releaseImport(stage);}}
export async function cleanupIncompleteImports(){
  const canLock=Boolean(globalThis.navigator?.locks),games=await transaction(['games'],'readonly',tx=>req(tx.objectStore('games').getAll()));let removed=0;
  // A live import owns this lock before its staging row exists. Acquiring it
  // proves that a reload or closed tab abandoned the row, including other tabs.
  const stale=game=>game.pendingVersion&&(canLock||game.leaseUntil<Date.now());
  for(const candidate of games){
    if(!stale(candidate))continue;
    const clean=async()=>transaction(['games','versions','files'],'readwrite',async tx=>{
      const gs=tx.objectStore('games'),game=await req(gs.get(candidate.id));
      if(!game||game.pendingVersion!==candidate.pendingVersion||!stale(game))return;
      await deleteVersion(tx,game.id,game.pendingVersion);if(game.activeVersion)gs.put(publicGame(game));else gs.delete(game.id);removed++;
    });
    if(canLock)await navigator.locks.request('mv-player-import-owner:'+candidate.pendingOwner,{ifAvailable:true,mode:'exclusive'},lock=>lock?clean():undefined);else await clean();
  }return removed;
}
export async function rollbackGame(id){return transaction(['games','versions'],'readwrite',async tx=>{
  const gs=tx.objectStore('games'),game=await req(gs.get(id));if(!game?.previousVersion)throw Error('戻せる前の版がありません');if(game.pendingVersion)throw Error('取り込み完了後に前の版へ戻してください');
  const previous=await req(tx.objectStore('versions').get([id,game.previousVersion]));if(previous?.status!=='complete')throw Error('前の版が見つかりません');
  const build=previous.build,next={...game,activeVersion:game.previousVersion,previousVersion:game.activeVersion,buildId:build.buildId,title:build.title,createdAt:build.createdAt,importedAt:new Date().toISOString(),totalBytes:previous.totalBytes,fileCount:previous.fileCount};gs.put(next);return next;
});}
export async function removeGame(id){return transaction(['games','versions','files'],'readwrite',async tx=>{
  const gs=tx.objectStore('games'),game=await req(gs.get(id));if(game?.pendingVersion)throw Error('取り込み完了後にゲームを削除してください');
  const versions=await req(tx.objectStore('versions').index('game').getAll(id));for(const v of versions)await deleteVersion(tx,id,v.id);gs.delete(id);
});}

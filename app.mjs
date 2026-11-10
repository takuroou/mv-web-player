import {listGames,getGame,rollbackGame,removeGame,cleanupIncompleteImports} from './store.mjs';
import {inspectGameZip,importGameZip} from './importer.mjs';
import {exportSaves,inspectSaves,importSaves,MAX_SAVE_BACKUP_BYTES} from './saves.mjs';
const $=id=>document.getElementById(id),scope=new URL('./',location.href).href;
let ready=false,busy=false,playing=null,registration,restoreId=null,releasePlayer=null,playTimer;
const bytes=n=>Number(n||0)<1024*1024?`${Math.round(Number(n||0)/1024)} KB`:`${(Number(n||0)/1024/1024).toFixed(1)} MB`;
const date=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'日付不明':d.toLocaleString('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});};
function notice(text,kind=''){const el=$('notice');el.replaceChildren(document.createTextNode(text));el.className=kind;}
function download(name,value){
  const file=new File([JSON.stringify(value,null,2)],name,{type:'application/json'}),url=URL.createObjectURL(file),link=$('export-link'),dialog=$('export-dialog');link.href=url;link.download=name;$('export-name').textContent=name;$('export-result').textContent='';
  link.onclick=()=>{$('export-result').textContent='保存先を選んでください。保存できない場合は「共有する」をお試しください。';};
  $('export-share').hidden=!navigator.canShare?.({files:[file]});$('export-share').onclick=async()=>{try{await navigator.share({files:[file],title:'MV Pocket セーブ'});$('export-result').textContent='共有先へ渡しました。';}catch(error){if(error.name!=='AbortError')$('export-result').textContent='共有できませんでした。「ファイルに保存」をお試しください。';}};
  dialog.onclose=()=>{setTimeout(()=>URL.revokeObjectURL(url),60000);};$('export-close').onclick=()=>dialog.close();dialog.showModal();link.focus();
}
function saveName(id){return `${id}-saves-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;}
function errorNotice(error){notice(error?.message||String(error),'error');if(error?.recovery){const b=document.createElement('button');b.textContent='操作前のセーブを救出';b.onclick=()=>download(saveName(error.recovery.gameId),error.recovery);$('notice').append(b);}}
function setBusy(value){busy=value;$('choose-zip').disabled=!ready||value;$('refresh').disabled=value;$('persist').disabled=value;$('update-app').disabled=value;document.querySelectorAll('#games button').forEach(b=>b.disabled=value);}
async function work(fn){if(busy||playing)return;setBusy(true);try{await fn();}catch(error){errorNotice(error);}finally{setBusy(false);$('progress-panel').hidden=true;await renderGames().catch(errorNotice);await storageStatus();}}
async function gameLock(id,fn){
  if(!navigator.locks)throw Error('このブラウザーでは安全な更新に必要な機能を利用できません。最新のSafariで開いてください。');
  return navigator.locks.request('mv-player-use:'+id,{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw Error('このゲームは別のタブで再生・更新中です。その画面を終了してからやり直してください。');return fn();});
}
function confirmAction(title,description,label='続ける',detail=''){
  return new Promise(resolve=>{const dlg=$('confirm-dialog');$('confirm-title').textContent=title;$('confirm-description').textContent=description;$('confirm-detail').textContent=detail;$('confirm-ok').textContent=label;
    const finish=result=>{dlg.oncancel=null;$('confirm-cancel').onclick=null;$('confirm-ok').onclick=null;dlg.close();resolve(result);};
    dlg.oncancel=e=>{e.preventDefault();finish(false);};$('confirm-cancel').onclick=()=>finish(false);$('confirm-ok').onclick=()=>finish(true);dlg.showModal();$('confirm-cancel').focus();
  });
}
async function renderGames(){
  const games=await listGames();$('game-count').textContent=String(games.length);const host=$('games');host.replaceChildren();
  if(!games.length){const empty=document.createElement('div');empty.className='empty';empty.innerHTML='<span aria-hidden="true">◇</span><h3>はじめの1本を、ここに。</h3><p>取り込んだゲームが並びます。<br>更新するときも、新しいZIPを選ぶだけ。</p>';host.append(empty);return;}
  for(const game of games){
    const card=document.createElement('article');card.className='game-card';card.innerHTML='<div class="game-cover" aria-hidden="true"><span>1P · OFFLINE</span></div><div class="game-body"><h3></h3><p class="game-meta"></p><button class="primary play">▶ プレイする</button><details><summary>更新・セーブ・管理</summary><div class="game-actions"><button data-action="backup">セーブを書き出す</button><button data-action="restore">セーブを読み込む</button><button data-action="rollback">前の版に戻す</button><button data-action="remove" class="danger">ゲームを削除</button></div><p class="build-id"></p></details></div>';
    card.querySelector('h3').textContent=game.title;card.querySelector('.game-meta').textContent=`${bytes(game.totalBytes)} · ${date(game.createdAt)} 作成`;
    card.querySelector('.build-id').textContent='ビルド: '+game.buildId+'\n'+(game.previousVersion?'前の版を保管しています。':'前の版はまだありません。');
    card.querySelector('.play').onclick=()=>work(()=>startGame(game.id));
    const button=name=>card.querySelector('[data-action="'+name+'"]');
    button('backup').onclick=()=>work(()=>gameLock(game.id,async()=>{const backup=exportSaves(game.id);download(saveName(game.id),backup);notice('バックアップを用意しました。「ファイルに保存」または「共有する」から保存してください。','success');}));
    button('restore').onclick=()=>{restoreId=game.id;$('save-file').value='';$('save-file').click();};
    button('rollback').onclick=()=>work(()=>gameLock(game.id,async()=>{const current=await getGame(game.id);if(!current?.previousVersion)throw Error('戻せる前の版がありません。');if(!await confirmAction('前のゲーム版に戻しますか？','ゲーム本体だけを前の版へ切り替えます。セーブは現在のものを保持します。新しい版で作ったセーブを古い版で使えない場合があります。','前の版に戻す'))return;await rollbackGame(game.id);notice('ゲームを前の版に戻しました。','success');}));
    if(!game.previousVersion)button('rollback').hidden=true;
    button('remove').onclick=()=>work(()=>gameLock(game.id,async()=>{if(!await confirmAction('ゲームを端末から削除しますか？','この端末に取り込んだゲーム本体と前の版を削除します。セーブは残り、同じゲームIDのZIPを取り込むと再利用できます。OneDriveのZIPは変更しません。','ゲームを削除',game.title))return;await removeGame(game.id);notice('ゲーム本体を削除しました。セーブは保持しています。','success');}));
    host.append(card);
  }
  if(busy)document.querySelectorAll('#games button').forEach(b=>b.disabled=true);
}
function progress(info){$('progress-panel').hidden=false;const value=info.totalBytes?Math.min(100,info.bytes/info.totalBytes*100):0;$('progress').value=value;$('progress-title').textContent=({inspect:'ZIPを確認しています',import:'検証しながら端末に保存しています',commit:'ゲームを切り替えています',complete:'取り込みが完了しました'})[info.phase]||'準備中';$('progress-count').textContent=info.total?`${info.done} / ${info.total} ファイル`:'';$('progress-file').textContent=info.path||'';}
$('choose-zip').onclick=()=>{$('zip-file').value='';$('zip-file').click();};
$('zip-file').onchange=()=>{const file=$('zip-file').files[0];if(!file)return;work(async()=>{
  notice('ZIPのビルド情報を確認しています…');const summary=await inspectGameZip(file),current=await getGame(summary.id);
  if(!await confirmAction(current?.activeVersion?'ゲームを更新しますか？':'このゲームを取り込みますか？',current?.activeVersion?'現在の版を1つ残して、新しい版に切り替えます。セーブは引き継ぎます。':'ゲームはこの端末に保存します。自分で作成したスマホ用1PビルドのZIPを選んでください。',current?.activeVersion?'更新する':'取り込む',`${summary.title}\n${bytes(summary.totalBytes)} · ${summary.fileCount}ファイル\n${date(summary.build.createdAt)} 作成`)){notice('取り込みをキャンセルしました。');return;}
  await gameLock(summary.id,async()=>{const estimate=await navigator.storage?.estimate?.();if(estimate?.quota&&estimate.quota-estimate.usage<summary.totalBytes*1.15)throw Error('安全な更新に必要な空き容量が足りません。不要なゲームや端末のファイルを整理してください。');await importGameZip(file,{expectedActiveVersion:current?.activeVersion??null,onProgress:progress});});
  notice('取り込みが完了しました。PCを起動せずに、オフラインでプレイできます。','success');
});};
$('save-file').onchange=()=>{const file=$('save-file').files[0],id=restoreId;if(!file||!id)return;work(()=>gameLock(id,async()=>{
  if(file.size>MAX_SAVE_BACKUP_BYTES)throw Error('セーブのバックアップファイルが大きすぎます。');let parsed;try{parsed=JSON.parse(await file.text());}catch{throw Error('セーブのJSONを読み取れません。MV Pocketで書き出したファイルを選んでください。');}
  const backup=inspectSaves(id,parsed);if(!await confirmAction('セーブをバックアップから復元しますか？','このゲームの現在のセーブ・設定を、選択したバックアップの内容に置き換えます。先に「セーブを書き出す」で現在の進行を残すことをおすすめします。','復元する',`${backup.entries.length}件 · ${date(backup.exportedAt)}`))return;
  importSaves(id,backup);notice('セーブを復元しました。ゲームを起動して「つづきから」を選んでください。','success');
}));};
async function startGame(id){
  await gameLock(id,async()=>{
    const game=await getGame(id);if(!game?.activeVersion)throw Error('ゲームが見つかりません。ZIPを取り込み直してください。');
    if(!navigator.serviceWorker.controller)throw Error('オフライン起動の準備が終わっていません。画面を再読み込みしてください。');
    playing=game;$('playing-title').textContent=game.title;$('playing-status').textContent='起動中…';$('library-view').hidden=true;$('player-view').hidden=false;document.body.classList.add('playing');
    const frame=document.createElement('iframe');frame.title=game.title;frame.id='game-frame';frame.allow='autoplay; fullscreen';frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-downloads');frame.src=new URL(`play/${encodeURIComponent(id)}/${encodeURIComponent(game.activeVersion)}/index.html`,scope).href;
    $('frame-host').replaceChildren(frame);playTimer=setTimeout(()=>{if(playing)$('playing-status').textContent='応答待ち・戻って再試行できます';},30000);
    await new Promise(resolve=>{releasePlayer=resolve;});
  });
}
function endGame(){clearTimeout(playTimer);$('frame-host').replaceChildren();$('player-view').hidden=true;$('player-view').classList.remove('immersive','in-game-settings');$('library-view').hidden=false;document.body.classList.remove('playing');playing=null;releasePlayer?.();releasePlayer=null;notice('ゲームを終了しました。セーブは端末内に保存されています。');}
$('exit-game').onclick=async()=>{if(!playing)return;if(await confirmAction('ライブラリへ戻りますか？','ゲーム内でセーブしてから終了してください。まだセーブしていない進行は失われます。','終了して戻る'))endGame();};
window.addEventListener('message',event=>{const frame=$('game-frame'),data=event.data;if(!playing||event.source!==frame?.contentWindow||event.origin!==location.origin||data?.type!=='mv-web-player-runtime'||data.gameId!==playing.id)return;
  if(data.event==='controls-layout'){$('player-view').classList.toggle('immersive',data.message==='overlay');$('player-view').classList.toggle('in-game-settings',data.exitInSettings===true);}
  if(data.event==='exit-request'&&!$('confirm-dialog').open)$('exit-game').click();
  if(data.event==='ready'){clearTimeout(playTimer);$('playing-status').textContent='1P · 端末内で再生';}else if(data.event==='save')$('playing-status').textContent='セーブしました';else if(data.event==='error'){$('playing-status').textContent='エラー・ゲーム内の確認を開いてください';}
});
async function storageStatus(){try{const estimate=await navigator.storage?.estimate?.(),protectedStorage=await navigator.storage?.persisted?.();$('storage-status').textContent=estimate?`${bytes(estimate.usage)} 使用 / 上限目安 ${bytes(estimate.quota)} · ${protectedStorage?'永続保存の許可あり':'バックアップをおすすめします'}`:'使用量の表示はこのブラウザーでは利用できません。';}catch{$('storage-status').textContent='使用量を確認できませんでした。';}}
$('persist').onclick=()=>work(async()=>{const persisted=await navigator.storage?.persist?.();notice(persisted?'保存の保護が許可されました。手動のデータ削除に備え、セーブのバックアップも残してください。':'この環境では保存の保護が許可されませんでした。ホーム画面から開き、セーブを定期的に書き出してください。',persisted?'success':'');});
$('refresh').onclick=()=>work(async()=>{await cleanupIncompleteImports();notice('ライブラリを更新しました。');});
function connection(){ $('connection').textContent=navigator.onLine?'端末でプレイ':'オフライン'; }
window.addEventListener('online',connection);window.addEventListener('offline',connection);
window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
function watchUpdate(){if(registration.waiting)$('update-app').hidden=false;registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)$('update-app').hidden=false;});});}
$('update-app').onclick=()=>work(async()=>{if(!registration?.waiting)return;if(!await confirmAction('プレイヤーを更新しますか？','ゲームとセーブを保持したまま、画面を再読み込みします。他のタブでゲームを再生している場合は、先にセーブして終了してください。','更新する'))return;navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});registration.waiting.postMessage({type:'ACTIVATE_UPDATE'});});
async function init(){
  connection();try{
    if(!isSecureContext||!('serviceWorker' in navigator))throw Error('HTTPSの公開URL、またはPCのlocalhostで開いてください。OneDrive上のHTMLを直接開いても起動できません。');
    if(!navigator.locks)throw Error('このブラウザーでは必要な保存機能を利用できません。最新のSafariで開いてください。');
    registration=await navigator.serviceWorker.register('./sw.js',{type:'module',scope:'./',updateViaCache:'none'});
    await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('オフライン起動の準備が完了しません。インターネット接続を確認して再読み込みしてください。')),20000))]);
    if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('プレイヤーの準備ができました。画面を再読み込みしてください。')),10000);navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timer);resolve();},{once:true});if(navigator.serviceWorker.controller){clearTimeout(timer);resolve();}});
    watchUpdate();await cleanupIncompleteImports();ready=true;setBusy(false);await renderGames();await storageStatus();$('offline-status').textContent='✓ オフライン起動の準備完了';notice('準備ができました。スマホ用1PビルドのZIPを選んでください。','success');
  }catch(error){errorNotice(error);$('offline-status').textContent='オフライン準備未完了';await renderGames().catch(()=>{});await storageStatus();}
}
init();

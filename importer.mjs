import {openZip,validatePath} from './zip.mjs';
import {beginImport,putImportFile,commitImport,abortImport,storageError,cleanupIncompleteImports} from './store.mjs';
import {startupManagerEnd} from './sw-core.mjs';
const jsonDecoder=new TextDecoder('utf-8',{fatal:true}),META_LIMIT=8*1024*1024;
async function digest(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
function parse(bytes,name){try{return JSON.parse(jsonDecoder.decode(bytes).replace(/^\uFEFF/,''));}catch{throw Error(name+' のJSONが壊れています。スマホ用ZIPを作り直してください');}}
function validateBuild(b){if(!b||b.format!==1||!/^[a-z0-9][a-z0-9-]{0,60}$/.test(b.id)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(b.buildId)||typeof b.title!=='string'||b.title.length>300||typeof b.createdAt!=='string'||!Number.isFinite(Date.parse(b.createdAt))||b.profile!=='localranch-1p'||JSON.stringify(b.players)!=='[1]'||b.offline!==true)throw Error('対応する1Pスマホ用ビルドではありません。エディターでスマホ用ZIPを作成してください');}
async function inspect(file){
  const zip=await openZip(file),byPath=new Map(zip.entries.map(e=>[e.path,e]));
  for(const name of ['index.html','mobile-build.json','mobile-manifest.json','data/System.json','data/MapInfos.json','js/main.js','js/rpg_core.js','js/rpg_managers.js','js/plugins.js'])if(!byPath.has(name))throw Error('必要なファイルがありません: '+name+'。エディターで作成したスマホ用ZIPを選んでください');
  for(const name of ['mobile-build.json','mobile-manifest.json'])if(byPath.get(name).bytes>META_LIMIT)throw Error('ビルド情報のサイズが大きすぎます');
  const buildBytes=await zip.read('mobile-build.json'),build=parse(buildBytes,'mobile-build.json'),manifest=parse(await zip.read('mobile-manifest.json'),'mobile-manifest.json');validateBuild(build);
  if(!manifest||JSON.stringify(manifest.build)!==JSON.stringify(build)||!Array.isArray(manifest.files))throw Error('ゲーム情報とファイル一覧のビルドが一致しません');
  const declared=new Map();
  for(const f of manifest.files){if(!f||typeof f!=='object')throw Error('ファイル一覧が不正です');validatePath(f.path);if(f.path==='mobile-manifest.json'||declared.has(f.path)||!Number.isSafeInteger(f.bytes)||f.bytes<0||!/^[0-9a-f]{64}$/.test(f.sha256))throw Error('ファイル一覧が不正または重複しています: '+f.path);const e=byPath.get(f.path);if(!e||e.bytes!==f.bytes)throw Error('必要なファイルが不足または容量が一致しません: '+f.path);declared.set(f.path,f);}
  if(declared.size!==zip.entries.length-1)throw Error('ファイル一覧に登録されていない余分なファイルが含まれています');
  if(!declared.has('mobile-build.json')||await digest(buildBytes)!==declared.get('mobile-build.json').sha256)throw Error('ビルド情報の検証に失敗しました（SHA-256不一致）');
  if(byPath.get('index.html').bytes>META_LIMIT)throw Error('起動HTMLのサイズが大きすぎます');
  const startup=await verifiedBytes(zip,declared,'index.html');let html;
  try{html=jsonDecoder.decode(startup);}catch{throw Error('index.htmlはUTF-8形式が必要です');}
  startupManagerEnd(html);
  return {zip,declared,build,summary:{id:build.id,title:build.title,buildId:build.buildId,build,fileCount:zip.entries.length,totalBytes:zip.totalBytes,compressedBytes:zip.compressedBytes}};
}
async function verifiedBytes(zip,declared,path){const data=await zip.read(path),f=declared.get(path);if(f&&await digest(data)!==f.sha256)throw Error('ファイルが破損しています（SHA-256不一致）: '+path);return data;}
export async function inspectGameZip(file,{verifyFiles=false}={}){const result=await inspect(file);if(verifyFiles)for(const e of result.zip.entries)await verifiedBytes(result.zip,result.declared,e.path);return result.summary;}
export async function importGameZip(file,{onProgress=()=>{},expectedActiveVersion}={}){
  let stage;
  try{
    onProgress({phase:'inspect',done:0,total:0,path:'',bytes:0,totalBytes:file.size});const {zip,declared,build,summary}=await inspect(file);
    await cleanupIncompleteImports();
    stage=await beginImport(build,{expectedActiveVersion,totalBytes:summary.totalBytes,fileCount:summary.fileCount});let done=0,bytes=0;
    for(const e of zip.entries){onProgress({phase:'import',done,total:summary.fileCount,path:e.path,bytes,totalBytes:summary.totalBytes});const data=await verifiedBytes(zip,declared,e.path);await putImportFile(stage,e.path,new Blob([data]));done++;bytes+=e.bytes;}
    onProgress({phase:'commit',done,total:summary.fileCount,path:'',bytes,totalBytes:summary.totalBytes});const game=await commitImport(stage);stage=null;onProgress({phase:'complete',done,total:summary.fileCount,path:'',bytes,totalBytes:summary.totalBytes});return game;
  }catch(error){if(stage)await abortImport(stage).catch(()=>{});throw storageError(error);}
}

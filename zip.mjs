// A bounded ZIP32 reader. Only one expanded file is held in memory at a time.
export const ZIP_LIMITS = Object.freeze({files:20000,totalBytes:1024*1024*1024,fileBytes:128*1024*1024,archiveBytes:1024*1024*1024,directoryBytes:16*1024*1024});
const decoder=new TextDecoder('utf-8',{fatal:true});
const crcTable=Array.from({length:256},(_,n)=>{for(let j=0;j<8;j++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(bytes){let n=0xffffffff;for(const b of bytes)n=crcTable[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
export function validatePath(path){
  if(typeof path!=='string'||!path||path.length>1024||/[\\%?#:\x00-\x1f\x7f]/.test(path)||path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..'||p.trim()!==p))throw Error('ZIP内のファイル名が安全な相対パスではありません: '+String(path).slice(0,160));
  return path;
}
function fail(message){throw Error('ゲームZIPを読み込めません: '+message);}
function extraCheck(bytes){const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;while(p<bytes.length){if(p+4>bytes.length)fail('追加情報が壊れています');const kind=v.getUint16(p,true),len=v.getUint16(p+2,true);p+=4;if(kind===1)fail('ZIP64には対応していません');if(p+len>bytes.length)fail('追加情報が壊れています');p+=len;}}
function decodeName(bytes,flags){if(!(flags&0x800)&&bytes.some(x=>x>=128))fail('ファイル名はUTF-8形式が必要です');try{return validatePath(decoder.decode(bytes));}catch(e){fail(e.message);}}
export async function openZip(blob,{limits={}}={}){
  limits={...ZIP_LIMITS,...limits};
  if(!blob||typeof blob.slice!=='function'||!Number.isSafeInteger(blob.size)||blob.size<22)fail('ZIPファイルではありません');
  if(blob.size>limits.archiveBytes)fail('ZIPの容量上限（1 GB）を超えています');
  const tail=new Uint8Array(await blob.slice(Math.max(0,blob.size-65557)).arrayBuffer()),tailView=new DataView(tail.buffer);let end=-1;
  for(let p=tail.length-22;p>=0;p--)if(tailView.getUint32(p,true)===0x06054b50&&p+22+tailView.getUint16(p+20,true)===tail.length){end=p;break;}
  if(end<0)fail('ZIPの末尾が見つかりません。OneDriveのダウンロードが完了しているか確認してください');
  const u16=n=>tailView.getUint16(end+n,true),u32=n=>tailView.getUint32(end+n,true),count=u16(10),dirSize=u32(12),dirAt=u32(16),endAt=blob.size-tail.length+end;
  if(u16(4)||u16(6)||u16(8)!==count)fail('分割ZIPには対応していません');
  if(count===65535||dirSize===0xffffffff||dirAt===0xffffffff)fail('ZIP64には対応していません');
  if(!count||count>limits.files)fail('ファイル数の上限を超えています（最大 '+limits.files+'）');
  if(dirSize>limits.directoryBytes||dirAt+dirSize!==endAt)fail('ZIPのファイル一覧が不正です');
  const bytes=new Uint8Array(await blob.slice(dirAt,dirAt+dirSize).arrayBuffer()),v=new DataView(bytes.buffer),entries=[],byPath=new Map();let p=0,totalBytes=0;
  for(let i=0;i<count;i++){
    if(p+46>bytes.length||v.getUint32(p,true)!==0x02014b50)fail('ZIPのファイル一覧が壊れています');
    const flags=v.getUint16(p+8,true),method=v.getUint16(p+10,true),crc=v.getUint32(p+16,true),packed=v.getUint32(p+20,true),size=v.getUint32(p+24,true),nameLen=v.getUint16(p+28,true),extraLen=v.getUint16(p+30,true),commentLen=v.getUint16(p+32,true),offset=v.getUint32(p+42,true);
    if(flags&~0x800)fail('暗号化・データ記述子付きZIPなど、このZIP形式には対応していません。エディターでスマホ用ZIPを作り直してください');
    if(method!==0&&method!==8)fail('このZIP圧縮方式には対応していません');
    if(v.getUint16(p+34,true)||packed===0xffffffff||size===0xffffffff||offset===0xffffffff)fail('分割ZIP・ZIP64には対応していません');
    if((v.getUint32(p+38,true)>>>16&0xf000)===0xa000)fail('リンクを含むZIPには対応していません');
    if(p+46+nameLen+extraLen+commentLen>bytes.length)fail('ファイル名の情報が壊れています');
    const path=decodeName(bytes.subarray(p+46,p+46+nameLen),flags);extraCheck(bytes.subarray(p+46+nameLen,p+46+nameLen+extraLen));
    if(byPath.has(path))fail('同じファイルが重複しています: '+path);
    if(size>limits.fileBytes)fail('1ファイルの容量上限（128 MB）を超えています: '+path);
    totalBytes+=size;if(totalBytes>limits.totalBytes)fail('展開後の容量上限（1 GB）を超えています');
    if(offset+30+nameLen+packed>dirAt||method===0&&packed!==size)fail('ファイルの位置・容量が不正です: '+path);
    const e=Object.freeze({path,bytes:size,compressedBytes:packed,crc,method,flags,offset});entries.push(e);byPath.set(path,e);p+=46+nameLen+extraLen+commentLen;
  }
  if(p!==dirSize)fail('ZIPのファイル一覧に余分なデータがあります');
  const ordered=[...entries].sort((a,b)=>a.offset-b.offset),bounds=new Map();ordered.forEach((e,i)=>{const end=ordered[i+1]?.offset??dirAt;if(e.offset+30+e.compressedBytes>end)fail('ZIP内のファイル領域が重複しています');bounds.set(e.path,end);});
  async function read(path){
    const e=byPath.get(path);if(!e)fail('必要なファイルがありません: '+path);
    const h=new DataView(await blob.slice(e.offset,e.offset+30).arrayBuffer());
    if(h.byteLength!==30||h.getUint32(0,true)!==0x04034b50||h.getUint16(6,true)!==e.flags||h.getUint16(8,true)!==e.method||h.getUint32(14,true)!==e.crc||h.getUint32(18,true)!==e.compressedBytes||h.getUint32(22,true)!==e.bytes)fail('ファイル情報が一致しません: '+path);
    const nameLen=h.getUint16(26,true),extraLen=h.getUint16(28,true),start=e.offset+30+nameLen+extraLen;
    if(start+e.compressedBytes>bounds.get(path))fail('ZIP内のファイル領域が重複しています: '+path);
    const names=new Uint8Array(await blob.slice(e.offset+30,start).arrayBuffer());if(decodeName(names.subarray(0,nameLen),e.flags)!==path)fail('ファイル名が一致しません: '+path);extraCheck(names.subarray(nameLen));
    const packed=blob.slice(start,start+e.compressedBytes);let result;
    if(e.method===0)result=new Uint8Array(await packed.arrayBuffer());
    else{
      let ds;try{ds=new DecompressionStream('deflate-raw');}catch{fail('このブラウザーはZIP展開に対応していません。iPhoneのiOSを更新してSafariで開いてください');}
      const reader=packed.stream().pipeThrough(ds).getReader(),chunks=[];let length=0;
      try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>e.bytes||length>limits.fileBytes){await reader.cancel();fail('展開後の容量が一致しません: '+path);}chunks.push(value);}}catch(error){if(error.message?.startsWith('ゲームZIP'))throw error;fail('圧縮データが壊れています: '+path);}
      result=new Uint8Array(length);let at=0;for(const chunk of chunks){result.set(chunk,at);at+=chunk.length;}
    }
    if(result.length!==e.bytes||crc32(result)!==e.crc)fail('ファイルが破損しています（CRC不一致）: '+path);
    return result;
  }
  return {entries,totalBytes,compressedBytes:blob.size,read};
}

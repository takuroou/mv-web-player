// MV keeps compressed save strings in localStorage. Keep them byte-for-byte so
// plugins that extend the standard save contents remain compatible.
export const SAVE_BACKUP_FORMAT = 'mv-web-player-saves';
export const MAX_SAVE_BACKUP_BYTES = 24 * 1024 * 1024;
const MAX_ENTRIES = 2004;
const MAX_VALUE_CHARS = 10 * 1024 * 1024;
const MAX_TOTAL_CHARS = 16 * 1024 * 1024;
const KEY = /^RPG (?:Config|Global|File(?:0|[1-9]\d{0,5}))(?:bak)?$/;
// A single character repetition avoids RegExp stack growth for large saves.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function savePrefix(gameId) {
  if (typeof gameId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(gameId)) {
    throw new Error('ゲームIDが不正です。');
  }
  return `MVWebPlayer:v1:${gameId}:`;
}

function storageOrDefault(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage; }
  catch { throw new Error('端末の保存領域を利用できません。Safariの設定や空き容量を確認してください。'); }
}

function readEntries(gameId, storage) {
  const prefix = savePrefix(gameId), entries = [];
  // Copy keys first: do not rely on iteration order while another tab is open.
  const keys = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (typeof key === 'string' && key.startsWith(prefix) && KEY.test(key.slice(prefix.length))) keys.push(key);
  }
  keys.sort();
  for (const key of keys) {
    const value = storage.getItem(key);
    if (value !== null) entries.push({key:key.slice(prefix.length),value});
  }
  return entries;
}

export function exportSaves(gameId, storage) {
  storage = storageOrDefault(storage);
  savePrefix(gameId);
  return {format:SAVE_BACKUP_FORMAT,version:1,gameId,exportedAt:new Date().toISOString(),entries:readEntries(gameId,storage)};
}

/** Validate a parsed JSON backup before showing its restore confirmation. */
export function inspectSaves(gameId, input) {
  savePrefix(gameId);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !own(input,'format') || input.format !== SAVE_BACKUP_FORMAT ||
      !own(input,'version') || input.version !== 1) {
    throw new Error('このプレイヤーが書き出したセーブJSON（形式1）を選択してください。');
  }
  if (!own(input,'gameId') || input.gameId !== gameId) throw new Error('別のゲームのセーブです。ゲームIDが一致するデータだけ復元できます。');
  if (!own(input,'entries') || !Array.isArray(input.entries) || input.entries.length > MAX_ENTRIES) {
    throw new Error('セーブの件数が不正、または上限を超えています。');
  }
  const seen = new Set(), entries = [];
  let chars = 0;
  for (const entry of input.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        !own(entry,'key') || typeof entry.key !== 'string' || !KEY.test(entry.key) ||
        !own(entry,'value') || typeof entry.value !== 'string' || !entry.value ||
        entry.value.length > MAX_VALUE_CHARS || entry.value.length % 4 !== 0 || !BASE64.test(entry.value)) {
      throw new Error('セーブのキーまたは圧縮データの形式が不正です。');
    }
    if (seen.has(entry.key)) throw new Error('セーブに同じキーが重複しています。');
    seen.add(entry.key);
    chars += entry.key.length + entry.value.length;
    if (chars > MAX_TOTAL_CHARS) throw new Error('セーブの容量が上限を超えています。');
    entries.push({key:entry.key,value:entry.value});
  }
  const exportedAt = own(input,'exportedAt') && typeof input.exportedAt === 'string' &&
    input.exportedAt.length <= 64 && Number.isFinite(Date.parse(input.exportedAt)) ? input.exportedAt : null;
  return {format:SAVE_BACKUP_FORMAT,version:1,gameId,exportedAt,entries};
}

function summary(entries) {
  return {
    slots:entries.filter(entry => /^RPG File(?:0|[1-9]\d*)$/.test(entry.key)).length,
    backups:entries.filter(entry => /bak$/.test(entry.key)).length,
    entries:entries.length,
    bytes:entries.reduce((sum, entry) => sum + 2 * (entry.key.length + entry.value.length),0),
    hasConfig:entries.some(entry => entry.key === 'RPG Config'),
    hasGlobal:entries.some(entry => entry.key === 'RPG Global')
  };
}

export function summarizeSaves(gameId, storage) {
  return summary(readEntries(gameId,storageOrDefault(storage)));
}

function replaceEntries(gameId, entries, storage) {
  const prefix = savePrefix(gameId);
  // A second complete copy may exceed localStorage's small quota. Retain the
  // original in memory, replace only this game's keys, then restore on failure.
  const recovery = exportSaves(gameId,storage);
  function replace(next) {
    for (const entry of readEntries(gameId,storage)) storage.removeItem(prefix + entry.key);
    for (const entry of next) storage.setItem(prefix + entry.key,entry.value);
  }
  try { replace(entries); }
  catch (cause) {
    try { replace(recovery.entries); }
    catch (restoreError) {
      const error = new Error('セーブの復元に失敗し、元の状態への復旧も完了できませんでした。復旧用JSONを保存し、空き容量を確保してから復元してください。',{cause});
      error.recovery = recovery;
      error.restoreError = restoreError;
      throw error;
    }
    throw new Error('セーブを復元できませんでした。変更前のセーブに戻しました。端末の空き容量や保存設定を確認してください。',{cause});
  }
  return summary(entries);
}

export function importSaves(gameId, input, storage) {
  const backup = inspectSaves(gameId,input);
  return replaceEntries(gameId,backup.entries,storageOrDefault(storage));
}

export function clearSaves(gameId, storage) {
  return replaceEntries(gameId,[],storageOrDefault(storage));
}

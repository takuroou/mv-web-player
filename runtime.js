/* Loaded synchronously immediately after js/rpg_managers.js by the player SW. */
(function(root) {
  'use strict';
  var script = document.currentScript;
  var gameId = script && script.getAttribute('data-game-id');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(gameId || '')) throw new Error('WebプレイヤーのゲームIDが不正です。');
  var prefix = 'MVWebPlayer:v1:' + gameId + ':';
  var storage = root.StorageManager;
  var reportedError;
  function notify(event, message) {
    if (root.parent === root) return;
    root.parent.postMessage({type:'mv-web-player-runtime',gameId:gameId,event:event,message:message || ''},root.location.origin);
  }
  function report(error) {
    if (error && reportedError === error) return;
    reportedError = error;
    notify('error', String(error && error.message || error || 'ゲームでエラーが発生しました。').slice(0,1000));
  }
  if (!storage || typeof storage.webStorageKey !== 'function') {
    var unsupported = new Error('RPGツクールMVの保存処理を確認できません。対応するスマホ用ZIPを取り込んでください。');
    report(unsupported);
    if (root.SceneManager) root.SceneManager.run = function() { throw unsupported; };
    throw unsupported;
  }
  if (root.MVWebPlayerRuntime) {
    if (root.MVWebPlayerRuntime.gameId !== gameId) throw new Error('保存先のゲームIDが一致しません。');
    return;
  }

  function ensureKey() {
    var original = storage.webStorageKey;
    if (original && original._mvWebPlayerGameId === gameId) return;
    if (typeof original !== 'function') throw new Error('ゲームの保存キーを確認できません。');
    var namespaced = function(savefileId) {
      var raw = String(original.apply(this,arguments));
      return raw.indexOf(prefix) === 0 ? raw : prefix + raw;
    };
    namespaced._mvWebPlayerGameId = gameId;
    storage.webStorageKey = namespaced;
  }
  ensureKey();

  // Plugins often alias these methods and webStorageKey. Checking on each
  // operation covers late key replacement without accessor/alias recursion.
  ['save','load','exists','remove','backup','backupExists','cleanBackup','restoreBackup',
   'saveToWebStorage','loadFromWebStorage','loadFromWebStorageBackup',
   'webStorageExists','webStorageBackupExists','removeWebStorage'].forEach(function(name) {
    var original = storage[name];
    if (typeof original !== 'function') return;
    storage[name] = function() {
      ensureKey();
      try {
        return original.apply(this,arguments);
      } catch (error) { report(error); throw error; }
    };
  });
  if (root.ConfigManager) ['load','save'].forEach(function(name) {
    var original = root.ConfigManager[name];
    if (typeof original !== 'function') return;
    root.ConfigManager[name] = function() { ensureKey(); return original.apply(this,arguments); };
  });

  // MV normally identifies saves by game title. The stable imported game ID
  // also identifies our saves, allowing title edits and build rollbacks.
  // Keep MV's globalId check and do not claim unrelated/legacy saves.
  if (root.DataManager) {
    var saveGame = root.DataManager.saveGame;
    if (typeof saveGame === 'function') root.DataManager.saveGame = function() {
      var result = saveGame.apply(this,arguments);
      // The save slot alone is insufficient: MV writes global metadata after it.
      if (result === true) notify('save');
      return result;
    };
    var makeInfo = root.DataManager.makeSavefileInfo;
    if (typeof makeInfo === 'function') root.DataManager.makeSavefileInfo = function() {
      var info = makeInfo.apply(this,arguments);
      if (info && typeof info === 'object') info._mvWebPlayerGameId = gameId;
      return info;
    };
    var isThisGame = root.DataManager.isThisGameFile;
    if (typeof isThisGame === 'function') root.DataManager.isThisGameFile = function(savefileId) {
      var globalInfo = this.loadGlobalInfo(), info = globalInfo && globalInfo[savefileId];
      if (info && Object.prototype.hasOwnProperty.call(info,'_mvWebPlayerGameId') && info._mvWebPlayerGameId !== gameId) return false;
      if (isThisGame.apply(this,arguments)) return true;
      return !!(info && info._mvWebPlayerGameId === gameId && info.globalId === this._globalId);
    };
  }
  root.MVWebPlayerRuntime = Object.freeze({version:1,gameId:gameId,prefix:prefix});
  root.addEventListener('load',function() { ensureKey(); notify('ready'); });
  root.addEventListener('error',function(event) { if (event.error || event.message) report(event.error || event.message); });
  root.addEventListener('unhandledrejection',function(event) { report(event.reason); });
})(window);

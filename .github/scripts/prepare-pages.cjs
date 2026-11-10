'use strict';
// Publish the player shell only. Imported games are private browser storage.
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_FILES = Object.freeze([
  'index.html', 'styles.css', 'app.mjs', 'sw.js', 'sw-core.mjs',
  'zip.mjs', 'store.mjs', 'importer.mjs', 'saves.mjs', 'runtime.js',
  'manifest.webmanifest', 'icon.svg', 'apple-touch-icon.png', '.nojekyll'
]);
const CONTROL_FILES = new Set([
  'README.md', '.gitignore', '.github/workflows/pages.yml',
  '.github/scripts/prepare-pages.cjs'
]);
const CONTROL_DIRS = new Set(['.github', '.github/workflows', '.github/scripts']);

function inventoryPlayer(source) {
  const root = fs.realpathSync(source), seen = new Set();
  function scan(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const relative = prefix + entry.name;
      const full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw Error('配布フォルダーにリンクや特殊ファイルは置けません: ' + relative);
      }
      if (relative === '.git' && stat.isDirectory()) continue;
      if (stat.isDirectory()) {
        if (!CONTROL_DIRS.has(relative)) throw Error('公開対象外のフォルダーがあります: ' + relative);
        scan(full, relative + '/');
      } else {
        if (!PUBLIC_FILES.includes(relative) && !CONTROL_FILES.has(relative)) {
          throw Error('公開対象外のファイルがあります: ' + relative + '（ゲームZIP・素材・セーブは公開リポジトリに置かないでください）');
        }
        seen.add(relative);
      }
    }
  }
  scan(root);
  for (const relative of PUBLIC_FILES) if (!seen.has(relative)) throw Error('プレイヤーの必要ファイルがありません: ' + relative);
  return {root, files: [...PUBLIC_FILES]};
}

function preparePages(source, destination) {
  const {root, files} = inventoryPlayer(source);
  const output = path.resolve(destination || path.join(root, '_site'));
  if (fs.existsSync(output)) throw Error('出力先は新しい空のパスにしてください: ' + output);
  fs.mkdirSync(output, {recursive: true});
  for (const relative of files) fs.copyFileSync(path.join(root, relative), path.join(output, relative), fs.constants.COPYFILE_EXCL);
  return {output, files};
}

if (require.main === module) {
  try {
    const source = path.resolve(__dirname, '../..');
    const result = preparePages(source, process.argv[2]);
    console.log('プレイヤー本体のみを配布用に準備しました: ' + result.files.length + ' files');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = {PUBLIC_FILES, inventoryPlayer, preparePages};

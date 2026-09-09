#!/bin/sh
# 产出发布物到 chrome/dist/：扩展 zip（版本取 manifest.json，商店上传格式）与 host 的 npm 包 tgz（npm pack）。
# 只打包，不上传：扩展上架商店、host 发 npm 都手动做。
# 商店要求 manifest.json 在 zip 根目录，且不接受 key 字段：源码里的 key 留给解压加载定 ID，打包时去掉。
set -e
cd "$(dirname "$0")"

ext_version=$(node -p "require('./extension/manifest.json').version")
mkdir -p dist

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -R extension/. "$stage"/
node -e "
const fs = require('fs')
const p = process.argv[1]
const m = JSON.parse(fs.readFileSync(p, 'utf8'))
delete m.key
fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n')
" "$stage/manifest.json"

zip_file="dist/sema-browser-control-${ext_version}.zip"
rm -f "$zip_file"
(cd "$stage" && zip -qr "$OLDPWD/$zip_file" . -x '*.DS_Store')

npm pack ./host --pack-destination dist --loglevel silent >/dev/null

echo "extension: $zip_file"
echo "host:      $(ls -t dist/sema-chrome-host-*.tgz | head -1)"

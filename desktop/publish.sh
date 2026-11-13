#!/usr/bin/env bash
# SemaWork 桌面版安装包的打包与发布。
#
#   ./publish.sh pack    [mac] [win] [linux]   构建页面与桌面产物，打出安装包到 desktop/release/
#   ./publish.sh release                       把 GitHub Release「SemaWork」的附件换成当前版本的四个安装包
#   caffeinate -i ./publish.sh release         同上，上传期间阻止系统睡眠（熄屏不影响，合盖仍会睡）
#
# 不带平台参数时三个平台都打（mac 出 arm64 / x64 两个 dmg）；某个平台失败后可只带该平台重跑。全程无交互，命令直接执行。
# 前置：npm 上已发布同版本 sema-core（桌面版用 npm 上的那份，桌面版版本 = core 版本）；
#       在 macOS 上执行（dmg 只能在 macOS 打），打 deb 需要 GNU tar，见 README 备注；
#       release 另需四个安装包都已 pack。
# 签名：脚本不处理，沿用 electron-builder 默认行为（钥匙串有 Developer ID 证书则签名，否则 ad-hoc），不做公证。
# 凭据：GitHub 用 gh 的登录态。
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")" && pwd)"
WEBUI="$DESKTOP/../webui"
OUT="$DESKTOP/release"
TAG="SemaWork"

die()  { echo "✗ $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

# ---------- 版本：桌面版与 webui 必须一致 ----------
ver_of() { sed -nE '/^  "version":/{s/.*"version": "([^"]+)".*/\1/p;q;}' "$1"; }
VER=$(ver_of "$DESKTOP/package.json")
ver_webui=$(ver_of "$WEBUI/package.json")
[ -n "$VER" ] || die "读不到 desktop/package.json 的版本号"
[ "$ver_webui" = "$VER" ] || die "版本不一致：desktop=$VER webui=$ver_webui"

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "当前版本：$VER"
}

# 每个平台对应的安装包（即 GitHub Release 的附件），一行一个
artifacts_of() {
  case "$1" in
    mac)   echo "$OUT/SemaWork-$VER-mac-arm64.dmg"; echo "$OUT/SemaWork-$VER-mac-x64.dmg" ;;
    win)   echo "$OUT/SemaWork-$VER-win-x64.exe" ;;
    linux) echo "$OUT/SemaWork-$VER-linux-amd64.deb" ;;
  esac
}

# ---------- 打包 ----------
build_app() {
  step "构建页面（webui/client）"
  cd "$WEBUI"
  [ -d node_modules ] || npm install
  npm run build --workspace=client

  step "构建桌面产物（desktop/dist）"
  cd "$DESKTOP"
  npm install
  local core_ver
  core_ver=$(node -p "require('./node_modules/sema-core/package.json').version")
  [ "$core_ver" = "$VER" ] || die "桌面版内 sema-core 是 ${core_ver}，桌面版是 ${VER}：先发布 npm 包 sema-core@${VER}"
  npm run build
}

# 先清该平台的旧安装包（含旧版本与 blockmap），再打新包；release/ 里每个平台只留当前版本
pack_platform() {
  local platform="$1" f
  step "打包 $platform"
  cd "$DESKTOP"
  rm -f "$OUT"/SemaWork-*-"$platform"-*
  npx electron-builder "--$platform"
  while IFS= read -r f; do
    [ -f "$f" ] || die "未产出 $f"
  done < <(artifacts_of "$platform")
}

do_pack() {
  build_app
  local p
  for p in "${PLATFORMS[@]}"; do pack_platform "$p"; done
  step "产物（${OUT}）"
  ls -lh "$OUT"/SemaWork-*
}

# ---------- GitHub Release ----------
# Release「SemaWork」固定不动（tag、标题、说明都不改，说明里的文件名用 <版本> 占位），只换附件：
# 先传新包，传完再删旧版本的包，中途失败时旧包仍可下载
do_release() {
  cd "$DESKTOP"
  local assets=() p f name
  for p in mac win linux; do
    while IFS= read -r f; do
      [ -f "$f" ] || die "缺少 $f：先执行 ./publish.sh pack $p"
      assets+=("$f")
    done < <(artifacts_of "$p")
  done
  gh release view "$TAG" >/dev/null || die "读不到 GitHub Release $TAG"

  step "上传 $VER 安装包到 GitHub Release $TAG"
  ls -lh "${assets[@]}"
  gh release upload "$TAG" "${assets[@]}" --clobber

  step "删除旧版本附件"
  gh release view "$TAG" --json assets --jq '.assets[].name' | while IFS= read -r name; do
    case "$name" in
      SemaWork-"$VER"-*) ;;
      SemaWork-*)
        gh release delete-asset "$TAG" "$name" --yes </dev/null
        echo "已删除 $name"
        ;;
    esac
  done

  step "完成：Release $TAG 的附件"
  gh release view "$TAG" --json assets --jq '.assets[] | "\(.name)\t\(.size)"'
}

# ---------- 入口 ----------
CMD="${1:-}"
[ $# -gt 0 ] && shift
PLATFORMS=("$@")
[ ${#PLATFORMS[@]} -gt 0 ] || PLATFORMS=(mac win linux)
for p in "${PLATFORMS[@]}"; do
  case "$p" in mac|win|linux) ;; *) die "未知平台 ${p}（可选 mac / win / linux）" ;; esac
done

case "$CMD" in
  pack)    do_pack ;;
  release) do_release ;;
  *)       usage; exit 1 ;;
esac

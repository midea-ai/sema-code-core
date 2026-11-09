#!/usr/bin/env bash
# 三端 SDK（Python / Java / C#）打包与发布。
#
#   ./publish.sh pack    [python] [java] [csharp]   构建桥产物并打包，每端一个安装包平铺到 sdks/dist/
#   ./publish.sh publish [python] [java] [csharp]   发布当前版本到 PyPI / Maven Central / NuGet
#   ./publish.sh all     [python] [java] [csharp]   pack 后接 publish
#   ./publish.sh release                            创建 GitHub Release v<版本>，附 npm / Python / Java / C# 四个安装包
#
# 不带语言参数时三端都做；某一端失败后可只带该语言重跑。全程无交互，命令直接执行。
# 前置：npm 上已发布同版本 sema-core（桥把它打进 sidecar，SDK 版本 = 桥版本 = core 版本）；
#       release 另需三端已 pack、该版本的提交已推到 origin/main（tag 打在 main 上）。
# 凭据：PyPI 读 ~/.pypirc；Maven Central token 与 GPG 口令读 ~/.m2/settings.xml；
#       NuGet key 读环境变量 NUGET_API_KEY；GitHub 用 gh 的登录态。
set -euo pipefail

SDKS="$(cd "$(dirname "$0")" && pwd)"
OUT="$SDKS/dist"
PY="$SDKS/python/.venv/bin/python"
NUGET_API_KEY="${NUGET_API_KEY:-}"

die()  { echo "✗ $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

# ---------- 版本：四处必须一致 ----------
ver_bridge=$(sed -nE '/^  "version":/{s/.*"version": "([^"]+)".*/\1/p;q;}' "$SDKS/shared/bridge/package.json")
ver_python=$(sed -nE '/^version = /{s/^version = "([^"]+)".*/\1/p;q;}' "$SDKS/python/pyproject.toml")
ver_java=$(sed -nE '/<version>/{s/.*<version>([^<]+)<\/version>.*/\1/p;q;}' "$SDKS/java/pom.xml")
ver_csharp=$(sed -nE '/<Version>/{s/.*<Version>([^<]+)<\/Version>.*/\1/p;q;}' "$SDKS/csharp/Semacore.csproj")
VER="$ver_bridge"
[ -n "$VER" ] || die "读不到 shared/bridge/package.json 的版本号"
if [ "$ver_python" != "$VER" ] || [ "$ver_java" != "$VER" ] || [ "$ver_csharp" != "$VER" ]; then
  die "版本不一致：bridge=$ver_bridge python=$ver_python java=$ver_java csharp=$ver_csharp"
fi

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "当前版本：$VER"
}

# ---------- 打包 ----------
build_bridge() {
  step "构建桥产物（shared/bridge）"
  cd "$SDKS/shared/bridge"
  npm install
  local core_ver
  core_ver=$(node -p "require('./node_modules/sema-core/package.json').version")
  [ "$core_ver" = "$VER" ] || die "桥内 sema-core 是 ${core_ver}，SDK 是 ${VER}：先发布 npm 包 sema-core@${VER}"
  npm run build
}

# dist/ 平铺、每端只收一个安装包（即 GitHub Release 的附件）：先清同类旧版本，再拷入新包。
# PyPI 的源码包、Java 的 sources / javadoc / 签名留在各自构建目录，发布时从那里取
collect() {
  mkdir -p "$OUT"
  rm -f "$OUT"/$1
  cp "$2" "$OUT/"
}

pack_python() {
  step "打包 Python"
  cd "$SDKS/python"
  if [ ! -x "$PY" ]; then
    python3 -m venv .venv
    "$PY" -m pip install -q build twine
  fi
  "$PY" scripts/embed_sidecar.py
  rm -rf dist build src/*.egg-info
  "$PY" -m build
  "$PY" -m twine check dist/*
  collect 'sema_core-*.whl' "dist/sema_core-$VER-py3-none-any.whl"
}

pack_java() {
  step "打包 Java（含 sources / javadoc / GPG 签名）"
  cd "$SDKS/java"
  mvn -DskipTests -P release clean verify
  collect 'sema-core-*.jar' "target/sema-core-$VER.jar"
}

pack_csharp() {
  step "打包 C#"
  cd "$SDKS/csharp"
  dotnet pack -c Release
  collect 'Semacore.*.nupkg' "bin/Release/Semacore.$VER.nupkg"
}

# ---------- 发布 ----------
publish_python() {
  step "发布 Python → PyPI"
  "$PY" -m twine upload --skip-existing "$SDKS/python/dist/sema_core-$VER"*
}

publish_java() {
  step "发布 Java → Maven Central"
  # Central 不允许覆盖已发布版本，重复上传会校验失败并中断后面的语言：已发布则跳过，与另两端一致
  if curl -fsI -m 20 -o /dev/null "https://repo1.maven.org/maven2/io/github/midea-ai/sema-core/$VER/sema-core-$VER.pom"; then
    echo "Maven Central 已有 ${VER}，跳过"
    return
  fi
  cd "$SDKS/java"
  mvn -DskipTests -P release deploy
  echo "Java 已上传，还需到 https://central.sonatype.com/publishing/deployments 点 Publish 才生效"
}

publish_csharp() {
  step "发布 C# → NuGet"
  [ -n "$NUGET_API_KEY" ] || die "未设置环境变量 NUGET_API_KEY"
  dotnet nuget push "$OUT/Semacore.$VER.nupkg" \
    --source https://api.nuget.org/v3/index.json --api-key "$NUGET_API_KEY" --skip-duplicate
}

artifact_of() {
  case "$1" in
    python) echo "$OUT/sema_core-$VER-py3-none-any.whl" ;;
    java)   echo "$OUT/sema-core-$VER.jar" ;;
    csharp) echo "$OUT/Semacore.$VER.nupkg" ;;
  esac
}

do_pack() {
  build_bridge
  local l
  for l in "${LANGS[@]}"; do "pack_$l"; done
  step "产物（${OUT}）"
  ls -lh "$OUT"
}

do_publish() {
  local l
  for l in "${LANGS[@]}"; do
    [ -f "$(artifact_of "$l")" ] || die "缺少 $(artifact_of "$l")：先执行 ./publish.sh pack $l"
  done
  step "发布 ${VER}：${LANGS[*]}"
  for l in "${LANGS[@]}"; do ls -lh "$(artifact_of "$l")"; done
  for l in "${LANGS[@]}"; do "publish_$l"; done
  step "完成：${VER} 已发布（${LANGS[*]}）"
}

# ---------- GitHub Release ----------
# 形态沿用 v2.1.6：tag v<版本> 打在 main，标题 Version <版本>，附四个安装包；说明里的 {版本号} 替换成实际版本
release_notes() {
  sed "s/{版本号}/$VER/g" <<'EOF'
### 📦 安装

按所用技术栈选择对应发行包进行本地安装。

#### Node.js (npm)

```bash
npm install ./sema-core-{版本号}.tgz
```

#### Python (pip)

```bash
pip install ./sema_core-{版本号}-py3-none-any.whl
```

#### .NET (NuGet)

```bash
dotnet add package Semacore --version {版本号} --source ./
```

#### Java (Maven)

```bash
mvn install:install-file \
  -Dfile=sema-core-{版本号}.jar \
  -DgroupId=io.github.midea-ai \
  -DartifactId=sema-core \
  -Dversion={版本号} \
  -Dpackaging=jar
```

然后在 `pom.xml` 中声明：

```xml
<dependency>
  <groupId>io.github.midea-ai</groupId>
  <artifactId>sema-core</artifactId>
  <version>{版本号}</version>
</dependency>
```
EOF
}

do_release() {
  cd "$SDKS"
  local tag="v$VER" l main_ver
  for l in python java csharp; do
    [ -f "$(artifact_of "$l")" ] || die "缺少 $(artifact_of "$l")：先执行 ./publish.sh pack $l"
  done
  git fetch -q origin main
  main_ver=$(git show origin/main:package.json | sed -nE 's/^  "version": "([^"]+)".*/\1/p')
  [ "$main_ver" = "$VER" ] || die "origin/main 的版本是 ${main_ver}：先把 ${VER} 的提交推到 main"
  if gh release view "$tag" >/dev/null 2>&1; then die "Release $tag 已存在"; fi

  # npm 包直接取 registry 上已发布的那份，与用户 npm install 到的一致
  step "取 npm 包 sema-core@$VER"
  rm -f "$OUT"/sema-core-*.tgz
  npm pack "sema-core@$VER" --pack-destination "$OUT" >/dev/null
  local assets=(
    "$OUT/sema-core-$VER.tgz"
    "$OUT/sema_core-$VER-py3-none-any.whl"
    "$OUT/sema-core-$VER.jar"
    "$OUT/Semacore.$VER.nupkg"
  )

  step "创建 GitHub Release ${tag}（main @ $(git rev-parse --short origin/main)）"
  ls -lh "${assets[@]}"
  release_notes | gh release create "$tag" "${assets[@]}" \
    --target main --title "Version $VER" --notes-file - --latest
}

# ---------- 入口 ----------
CMD="${1:-}"
[ $# -gt 0 ] && shift
LANGS=("$@")
[ ${#LANGS[@]} -gt 0 ] || LANGS=(python java csharp)
for l in "${LANGS[@]}"; do
  case "$l" in python|java|csharp) ;; *) die "未知语言 ${l}（可选 python / java / csharp）" ;; esac
done

case "$CMD" in
  pack)    do_pack ;;
  publish) do_publish ;;
  all)     do_pack; do_publish ;;
  release) do_release ;;
  *)       usage; exit 1 ;;
esac

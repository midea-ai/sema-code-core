#!/bin/bash

# ./download-ripgrep.sh
# 直接在当前目录（sema-core）下载 ripgrep

echo "下载 ripgrep 到当前目录..."

# 创建目标目录
mkdir -p node_modules/@vscode/ripgrep/bin

# 检查并下载 macOS 版本
if [ ! -f "node_modules/@vscode/ripgrep/bin/rg" ]; then
    echo "下载 macOS 版本..."
    curl -L "https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep-14.1.0-x86_64-apple-darwin.tar.gz" | tar xz
    mv ripgrep-*/rg node_modules/@vscode/ripgrep/bin/rg
    chmod +x node_modules/@vscode/ripgrep/bin/rg
    rm -rf ripgrep-*
    echo "✓ macOS 版本下载完成"
else
    echo "✓ macOS 版本已存在"
fi

# 检查并下载 Windows 版本
if [ ! -f "node_modules/@vscode/ripgrep/bin/rg.exe" ]; then
    echo "下载 Windows 版本..."
    curl -L "https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep-14.1.0-x86_64-pc-windows-msvc.zip" -o rg-win.zip
    unzip -q rg-win.zip
    mv ripgrep-*/rg.exe node_modules/@vscode/ripgrep/bin/rg.exe
    rm -rf ripgrep-* rg-win.zip
    echo "✓ Windows 版本下载完成"
else
    echo "✓ Windows 版本已存在"
fi

echo "完成！文件已保存到: node_modules/@vscode/ripgrep/bin/"
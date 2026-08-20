import { memo } from 'react';
import { getFileIconName } from './fileIconUtils';
import { fileIconSvgs } from './fileIconSvgs';
import { cn } from '../ui';

// Seti-UI 配色的浅色主题版：white/yellow 在白底不可见或对比不足，已替换加深，其余保持原值
const colors = {
    white: '#737373',
    grey: '#4D5A5E',
    greyLight: '#6D8086',
    red: '#CC3E44',
    orange: '#E37933',
    yellow: '#b3a125',
    green: '#7CA843',
    blue: '#519ABA',
    purple: '#A074C4',
    pink: '#F55385',
    ignore: '#8a9499'
};

// 图标颜色映射（SVG 统一为 fill="currentColor"，这里是颜色的唯一来源）
const iconColors: { [key: string]: string } = {
    // 文件夹
    folder: colors.greyLight,

    // JavaScript/TypeScript（测试文件橙色区分）
    javascript: colors.yellow,
    react: colors.blue,
    typescript: colors.blue,
    vue: colors.green,
    'javascript-test': colors.orange,
    'typescript-test': colors.orange,
    'react-test': colors.orange,

    // C/C++（头文件官方为紫色）
    c: colors.blue,
    cpp: colors.blue,
    'c-header': colors.purple,
    'cpp-header': colors.purple,

    // C#
    'c-sharp': colors.blue,

    // Go
    go: colors.blue,
    go2: colors.blue,

    // Rust
    rust: colors.greyLight,

    // PHP
    php: colors.purple,

    // Ruby
    ruby: colors.red,

    // Shell
    shell: colors.green,
    powershell: colors.blue,
    windows: colors.blue,

    // Web前端
    html: colors.orange,
    css: colors.blue,
    sass: colors.pink,
    less: colors.blue,
    svelte: colors.red,
    vite: colors.yellow,
    svg: colors.purple,

    // Python
    python: colors.blue,
    notebook: colors.blue,

    // Java相关
    java: colors.red,
    'java-class': colors.blue,
    kotlin: colors.orange,
    scala: colors.red,

    // 配置文件
    json: colors.yellow,
    yml: colors.purple,
    config: colors.greyLight,

    // 文档
    markdown: colors.blue,
    info: colors.blue,
    'time-cop': colors.blue,
    contributing: colors.red,
    pdf: colors.red,
    word: colors.blue,
    xls: colors.green,
    csv: colors.green,

    // 图片
    image: colors.purple,
    favicon: colors.yellow,

    // 音视频
    audio: colors.purple,
    video: colors.pink,

    // 压缩文件
    zip: colors.greyLight,
    jar: colors.red,

    // Git相关
    git_ignore: colors.ignore,
    git: colors.ignore,

    // 构建工具
    docker: colors.blue,
    'docker-ignore': colors.grey,
    'docker-compose': colors.red,
    makefile: colors.orange,
    cmake: colors.blue,
    gradle: colors.blue,
    xml: colors.orange,
    maven: colors.red,

    // 其他语言
    swift: colors.orange,
    perl: colors.blue,
    R: colors.blue,
    dart: colors.blue,
    lua: colors.blue,
    graphql: colors.pink,
    terraform: colors.purple,
    prisma: colors.blue,

    // 数据库
    db: colors.pink,

    // 许可证
    license: colors.yellow,

    // 包管理
    lock: colors.green,
    npm: colors.red,
    yarn: colors.blue,

    // 特殊文件
    eslint: colors.purple,
    'eslint-ignore': colors.grey,
    babel: colors.yellow,
    webpack: colors.blue,
    tsconfig: colors.blue,

    // 其他
    tex: colors.blue,
    font: colors.red,

    // 默认文件
    default: colors.white
};

/**
 * 文件类型图标：根据文件名渲染对应的 Seti SVG。
 * fileName 可以传完整相对路径（内部取 basename 匹配）；
 * Seti 文件图形在 viewBox 里留白大，非 folder 统一放大补偿（folder 图形本身占满，反而略缩）
 */
export const FileIcon = memo(function FileIcon({ fileName, isDirectory = false, size = 14, className }: {
    fileName: string; isDirectory?: boolean; size?: number; className?: string;
}) {
    const baseName = fileName.split(/[\\/]/).pop() || fileName;
    const iconName = getFileIconName(baseName, isDirectory);
    const svgContent = fileIconSvgs[iconName] || fileIconSvgs.default;
    const isFolder = iconName === 'folder';
    return (
        <span
            className={cn('inline-flex items-center justify-center shrink-0', className)}
            style={{ width: size, height: size, padding: isFolder ? 1 : 0, transform: isFolder ? undefined : 'scale(1.35)', color: iconColors[iconName] || colors.white }}
            dangerouslySetInnerHTML={{ __html: svgContent }}
        />
    );
});

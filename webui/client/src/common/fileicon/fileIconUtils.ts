// 文件类型图标映射工具
import { iconMap, specialFileNameMap, specialFileNamePrefixRules, specialFileNameSuffixMap } from './fileIconTypeMap';

/**
 * 根据文件名获取对应的图标名称
 * 匹配顺序：完整文件名 > 前缀规则（前缀+后缀双条件） > 文件名后缀 > 扩展名，均不命中返回 'default'
 */
export function getFileIconName(fileName: string, isDirectory: boolean): string {
    if (isDirectory) {
        return 'folder';
    }

    const baseName = stripLineRange(fileName).toLowerCase();

    if (specialFileNameMap[baseName]) {
        return specialFileNameMap[baseName];
    }

    for (const rule of specialFileNamePrefixRules) {
        if (
            baseName.startsWith(rule.prefix) &&
            (!rule.suffixes || rule.suffixes.some(suffix => baseName.endsWith(suffix)))
        ) {
            return rule.type;
        }
    }

    for (const suffix in specialFileNameSuffixMap) {
        if (baseName.endsWith(suffix)) {
            return specialFileNameSuffixMap[suffix];
        }
    }

    return iconMap[getFileExtension(baseName)] || 'default';
}

/**
 * 去掉文件名末尾携带的行号信息（如 main.py:12 / main.py:12-23）。
 * 仅匹配末尾的 :行号[-行号]，不会误伤 Windows 盘符路径（C:\repo\index.ts）里的冒号。
 */
function stripLineRange(fileName: string): string {
    return fileName.replace(/:\d+(?:-\d+)?$/, '');
}

/**
 * 获取文件扩展名（入参已是小写文件名）
 * 无扩展名返回空串（gradlew、makefile 等完整文件名走 specialFileNameMap），
 * 隐藏文件（.gitignore）返回点号后的部分
 */
function getFileExtension(fileName: string): string {
    const lastDotIndex = fileName.lastIndexOf('.');

    if (lastDotIndex === -1) {
        return '';
    }

    if (lastDotIndex === 0) {
        return fileName.substring(1);
    }

    return fileName.substring(lastDotIndex + 1);
}

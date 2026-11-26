// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

/**
 * 能否做文本比较：ok 可比较；binary 二进制；tooLarge 超出文本上限；
 * baselineUnavailable 基线缺失 / 读不出来 / 超过捕获上限；currentUnreadable 当前文件读不出来。
 */
public enum FileChangeStatus { ok, binary, tooLarge, baselineUnavailable, currentUnreadable }

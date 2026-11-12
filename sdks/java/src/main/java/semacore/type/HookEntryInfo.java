// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

// id：条目标识，removeHook / enableHook / disableHook 的入参；改了事件、matcher 或命令即变
// enabled：是否启用（settings 的 disabledHooks 控制；host 条目恒为 true）；与 status 独立
// filePath："绝对路径:起始行-结束行"（事件块粒度）；host 条目没有配置文件，为 null
public record HookEntryInfo(String id, Boolean enabled, String event, HookScope source, String pluginName, String matcher, String command, Integer timeout, HookEntryStatus status, String statusReason, String filePath) {
}

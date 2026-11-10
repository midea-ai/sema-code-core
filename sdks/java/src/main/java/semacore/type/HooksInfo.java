// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

// user / project 域没生效（scopes.hooks 未包含）时对应 ConfigPath 为空串、ConfigExists 恒为 false；events 按事件分组，host 在前、插件其次、用户级再次、项目级追加
public record HooksInfo(String userConfigPath, String projectConfigPath, boolean userConfigExists, boolean projectConfigExists, List<HookParseError> parseErrors, Map<String, List<HookEntryInfo>> events) {
}

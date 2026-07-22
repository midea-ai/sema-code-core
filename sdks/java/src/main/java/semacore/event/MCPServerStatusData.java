// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.event;

import java.util.List;
import java.util.Map;

public record MCPServerStatusData(semacore.type.MCPServerConfig config, semacore.type.MCPServerStatus connectStatus, boolean status, semacore.type.MCPServerCapabilities capabilities, Long connectedAt, String error, semacore.type.MCPScopeType scope, String filePath) {
}

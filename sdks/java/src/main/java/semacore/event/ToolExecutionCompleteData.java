// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.event;

import java.util.List;
import java.util.Map;

// interrupted：工具执行途中被用户中断、以部分/空结果正常结束（支持中断的工具才会带，其余为 null）
public record ToolExecutionCompleteData(String agentId, String toolId, String toolName, String title, String summary, Object content, Boolean interrupted) {
}

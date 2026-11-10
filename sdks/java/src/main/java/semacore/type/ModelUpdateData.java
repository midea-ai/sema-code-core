// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

// imageModelList：文生图模型列表（与 modelList 分开），旧版 core 可能为 null
// hostModels：来自宿主（host 域）的模型名，含对话与文生图模型；只读，不可删改
public record ModelUpdateData(String modelName, List<String> modelList, TaskConfig taskConfig, List<String> imageModelList, List<String> hostModels) {
}

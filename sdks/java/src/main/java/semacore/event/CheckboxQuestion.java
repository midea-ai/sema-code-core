// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.event;

import java.util.List;
import java.util.Map;

public record CheckboxQuestion(String type, String id, String label, List<String> options, Boolean required, Long maxSelections) implements PickOptionQuestion {
}

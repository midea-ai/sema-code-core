// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。
package semacore.event;

import java.util.ArrayList;

/** todos:update 事件数据（≙ core TodosUpdateData = TodoItem[]）。 */
public final class TodosUpdateData extends ArrayList<semacore.type.TodoItem> {}

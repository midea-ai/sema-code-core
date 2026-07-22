// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。
package semacore.type;

/** 镜像 sema-core 从 types 入口导出的常量（≙ import { MAIN_AGENT_ID } from 'sema-core/types'）。 */
public final class Constants {
    private Constants() {}

    /** 主代理 agentId；message:complete 等事件按此区分主/子代理。 */
    public static final String MAIN_AGENT_ID = "main";
}

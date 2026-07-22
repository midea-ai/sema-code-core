package semacore.runtime;

import java.io.IOException;

/**
 * Node 可执行文件供应器。SDK 默认实现走「本地优先 → 缓存 → 按需下载」（{@link NodeProviders#system()}）；
 * 需要「缓存 + 按需下载」等增强策略的宿主（如 IDE 插件）注入自己的实现。
 */
@FunctionalInterface
public interface NodeProvider {

    /**
     * 解析 node 可执行文件的绝对路径。
     *
     * @throws IOException 无法提供可用 node 时抛出（消息应包含引导用户的处置建议）
     */
    String resolveNode() throws IOException;
}

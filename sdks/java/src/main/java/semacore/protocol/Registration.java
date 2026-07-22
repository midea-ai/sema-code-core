package semacore.protocol;

/** 事件订阅句柄：{@link #unregister()} 取消订阅。 */
@FunctionalInterface
public interface Registration extends AutoCloseable {

    void unregister();

    @Override
    default void close() {
        unregister();
    }
}

// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

/**
 * 会话历史、hook 会话记录、快照加密；仅构造时生效，密钥只在内存。
 * key 为 32 字节随机密钥的 base64（44 个字符）；keyId 可选，写进密文开头，不能含 ':' 或换行。
 */
public record EncryptionConfig(String key, String keyId) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String key;
        private String keyId;
        private Builder() {}
        public Builder key(String key) { this.key = key; return this; }
        public Builder keyId(String keyId) { this.keyId = keyId; return this; }
        public EncryptionConfig build() { return new EncryptionConfig(key, keyId); }
    }
}

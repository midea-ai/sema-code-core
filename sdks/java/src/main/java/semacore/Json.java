package semacore;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonParser;

import java.util.LinkedHashMap;
import java.util.Map;

/** 镜像 API 层的 JSON 工具（包内使用）：payload 打包与 ack 解析，字段名与 core 完全一致。 */
final class Json {

    static final Gson GSON = new Gson();

    private Json() {
    }

    /** 对象 → JSON 字符串；null 原样返回（协议层把 null 当空 payload）。 */
    static String stringify(Object value) {
        return value == null ? null : GSON.toJson(value);
    }

    /** ack data（JSON 字符串，可为空）→ JsonElement；空视为 JsonNull。 */
    static JsonElement parse(String dataJson) {
        if (dataJson == null || dataJson.isEmpty()) return JsonNull.INSTANCE;
        return JsonParser.parseString(dataJson);
    }

    /** 按 (key, value, key, value, ...) 组装 payload，value 为 null 的键跳过（可选参数不发送）。 */
    static Map<String, Object> obj(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            if (pairs[i + 1] != null) map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }
}

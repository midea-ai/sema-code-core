package semacore;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * 事件/返回值 payload 的取值工具：JSON 级一致原则下（payload 不做类型化，字段名与 core 相同），
 * 宿主高频进行「取字段 + 判空 + 判类型」，本类把这段样板收进 SDK。
 *
 * <p>≙ Node 的解构：{@code ({ delta }) => ...} 对应 {@code SemaJson.str(data, "delta")}。
 * 所有方法对 null / 非对象 / 字段缺失 / 类型不符都返回缺省值，不抛异常。
 * 类型化 payload 由三期 manifest 代码生成提供，本类是其之前的过渡与补充。</p>
 */
public final class SemaJson {

    /** 取字符串字段；缺失/类型不符返回 null */
    public static String str(JsonElement data, String key) {
        return str(data, key, null);
    }

    public static String str(JsonElement data, String key, String fallback) {
        JsonElement v = get(data, key);
        return v != null && v.isJsonPrimitive() ? v.getAsString() : fallback;
    }

    public static boolean bool(JsonElement data, String key, boolean fallback) {
        JsonElement v = get(data, key);
        return v != null && v.isJsonPrimitive() && v.getAsJsonPrimitive().isBoolean()
                ? v.getAsBoolean() : fallback;
    }

    public static long i64(JsonElement data, String key, long fallback) {
        JsonElement v = get(data, key);
        return v != null && v.isJsonPrimitive() && v.getAsJsonPrimitive().isNumber()
                ? v.getAsLong() : fallback;
    }

    public static int i32(JsonElement data, String key, int fallback) {
        return (int) i64(data, key, fallback);
    }

    /** 取原始字段（JsonNull 视同缺失）；缺失返回 null */
    public static JsonElement get(JsonElement data, String key) {
        if (data == null || !data.isJsonObject()) return null;
        JsonObject obj = data.getAsJsonObject();
        JsonElement v = obj.get(key);
        return v == null || v.isJsonNull() ? null : v;
    }

    private SemaJson() {}
}

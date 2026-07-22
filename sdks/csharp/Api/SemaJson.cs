using System.Text.Json;

namespace Semacore;

/// <summary>
/// 事件 payload 的取值工具（≙ Java api/SemaJson）：事件回调 data 为 <see cref="JsonElement"/>（JSON 级一致，
/// 字段名与 core 相同），宿主高频进行「取字段 + 判空 + 判类型」，本类把这段样板收进 SDK。
///
/// <para>≙ Node 的解构：<c>({ delta }) => ...</c> 对应 <c>SemaJson.Str(data, "delta")</c>。
/// 所有方法对 null / 非对象 / 字段缺失 / 类型不符都返回缺省值，不抛异常。
/// 需要完整类型化时用 <c>Semacore.Events</c> 下对应 DTO 反序列化。</para>
/// </summary>
public static class SemaJson
{
    /// <summary>取字符串字段；缺失/类型不符返回 fallback（默认 null）。</summary>
    public static string? Str(JsonElement? data, string key, string? fallback = null)
    {
        var v = Get(data, key);
        return v switch
        {
            { ValueKind: JsonValueKind.String } e => e.GetString(),
            { ValueKind: JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False } e => e.GetRawText(),
            _ => fallback,
        };
    }

    public static bool Bool(JsonElement? data, string key, bool fallback)
    {
        return Get(data, key)?.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => fallback,
        };
    }

    public static long I64(JsonElement? data, string key, long fallback)
    {
        if (Get(data, key) is { ValueKind: JsonValueKind.Number } e)
        {
            if (e.TryGetInt64(out var n)) return n;
            if (e.TryGetDouble(out var d)) return (long)d;
        }
        return fallback;
    }

    public static int I32(JsonElement? data, string key, int fallback)
        => (int)I64(data, key, fallback);

    /// <summary>取原始字段（JSON null 视同缺失）；缺失返回 null。</summary>
    public static JsonElement? Get(JsonElement? data, string key)
    {
        if (data is not { ValueKind: JsonValueKind.Object } obj) return null;
        if (!obj.TryGetProperty(key, out var v) || v.ValueKind == JsonValueKind.Null) return null;
        return v;
    }
}

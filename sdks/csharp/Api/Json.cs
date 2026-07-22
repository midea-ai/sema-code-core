using System.Text.Json;
using System.Text.Json.Serialization;

namespace Semacore;

/// <summary>镜像 API 层的 JSON 工具（程序集内使用）：payload 打包与 ack 解析，wire 字段名与 core 完全一致（≙ Java api/Json）。</summary>
internal static class Json
{
    /// <summary>统一序列化配置：null 属性不上 wire（可选字段不发送，≙ Python _obj / Java Json.obj 跳 null）。</summary>
    internal static readonly JsonSerializerOptions Options = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>对象（DTO / 字典）→ JSON 字符串；null 原样返回（协议层把 null 当空 payload）。</summary>
    internal static string? Stringify(object? value)
        => value == null ? null : JsonSerializer.Serialize(value, Options);

    /// <summary>ack data（JSON 字符串，可为空）→ JsonElement；空视为 null（≙ Java 的 JsonNull）。</summary>
    internal static JsonElement? Parse(string? dataJson)
    {
        if (string.IsNullOrEmpty(dataJson)) return null;
        using var doc = JsonDocument.Parse(dataJson);
        return doc.RootElement.Clone();
    }

    /// <summary>JsonElement → 强类型 DTO；null / JSON null 返回 default。</summary>
    internal static T? To<T>(JsonElement? element)
        => element is { ValueKind: not JsonValueKind.Null } el
            ? el.Deserialize<T>(Options)
            : default;

    /// <summary>同上，列表形态；null 返回空列表（≙ Java callList）。</summary>
    internal static List<T> ToList<T>(JsonElement? element)
        => To<List<T>>(element) ?? new List<T>();

    /// <summary>按 (key, value) 对组装 payload，value 为 null 的键跳过（可选参数不发送，≙ Java Json.obj）。</summary>
    internal static Dictionary<string, object?> Obj(params (string Key, object? Value)[] pairs)
    {
        var map = new Dictionary<string, object?>();
        foreach (var (key, value) in pairs)
        {
            if (value != null) map[key] = value;
        }
        return map;
    }
}

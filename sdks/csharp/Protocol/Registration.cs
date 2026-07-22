namespace Semacore.Protocol;

/// <summary>事件订阅句柄：<see cref="Unregister"/> 取消订阅（≙ Java protocol/Registration）。</summary>
public sealed class Registration : IDisposable
{
    private Action? _unregister;

    public Registration(Action unregister) => _unregister = unregister;

    public void Unregister() => Interlocked.Exchange(ref _unregister, null)?.Invoke();

    public void Dispose() => Unregister();
}

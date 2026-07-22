using System.Diagnostics;
using System.IO.Compression;

namespace Semacore.Runtime;

/// <summary>
/// Node 可执行文件供应器（≙ Java runtime/NodeProvider）。SDK 默认实现走统一分发范式
/// 本地优先 → ~/.sema 缓存 → 按需下载（<see cref="NodeProviders.System"/>，与 Java / Python
/// SDK 对齐）；需要其他策略的宿主注入自己的实现。
/// </summary>
/// <returns>node 可执行文件的绝对路径；无法提供时抛 IOException（消息应包含引导用户的处置建议）。</returns>
public delegate string NodeProvider();

/// <summary><see cref="NodeProvider"/> 的内置实现（≙ Java runtime/NodeProviders）。</summary>
public static class NodeProviders
{
    /// <summary>sema-core 要求的最低 node 主版本。</summary>
    public const int MinMajor = 18;

    /// <summary>按需下载的 node 版本（LTS，与 Java / Python SDK 写死同值，升级时三处同步）。</summary>
    public const string NodeVersion = "20.18.0";

    private const string DefaultBase = "https://nodejs.org/dist";
    private static readonly string NodeExe = OperatingSystem.IsWindows() ? "node.exe" : "node";
    private static readonly object LoginPathLock = new();
    private static bool _loginPathResolved;
    private static string? _loginPathCached;

    /// <summary>固定路径（不做版本校验，由宿主保证可用）。</summary>
    public static NodeProvider Fixed(string node)
    {
        var path = Path.GetFullPath(node);
        return () =>
        {
            if (!File.Exists(path)) throw new IOException($"node 不可执行: {path}");
            return path;
        };
    }

    /// <summary>
    /// 统一分发范式：SEMA_NODE_PATH 环境变量 → 登录 shell PATH 里 ≥18 的 node →
    /// 常见绝对路径 → <c>~/.sema/node</c> 缓存 → 从 nodejs.org 官方 Release 下载到缓存
    /// （内网用 SEMA_NODE_BASE_URL 指镜像）。探测与下载均失败时抛 IOException 引导用户安装。
    /// </summary>
    public static NodeProvider System() => ResolveSystemNode;

    private static string ResolveSystemNode()
    {
        // 1) 显式指定
        var explicitPath = Environment.GetEnvironmentVariable("SEMA_NODE_PATH");
        if (!string.IsNullOrWhiteSpace(explicitPath))
        {
            if (File.Exists(explicitPath)) return Path.GetFullPath(explicitPath);
            throw new IOException($"SEMA_NODE_PATH 指定但不可执行: {explicitPath}");
        }

        // 2) 登录 shell PATH 探测（GUI 场景下进程 PATH 不全）
        var candidates = new List<string>();
        var searchPath = LoginShellPath() ?? Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in searchPath.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(dir)) candidates.Add(Path.Combine(dir, NodeExe));
        }
        // 3) 常见绝对路径 + ~/.sema/node 缓存兜底（缓存布局：<ver>/<triple>/bin/node）
        if (!OperatingSystem.IsWindows())
        {
            candidates.Add("/opt/homebrew/bin/node");
            candidates.Add("/usr/local/bin/node");
            candidates.Add("/usr/bin/node");
        }
        var cache = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".sema", "node");
        if (Directory.Exists(cache))
        {
            try
            {
                candidates.AddRange(Directory.EnumerateFiles(cache, NodeExe, SearchOption.AllDirectories));
            }
            catch (IOException) { }
        }

        foreach (var candidate in candidates)
        {
            if (File.Exists(candidate) && MajorVersionOf(candidate) >= MinMajor)
                return Path.GetFullPath(candidate);
        }

        // 5) 按需下载（一次性，落 ~/.sema/node 缓存后上面第 4 步即可命中）
        try
        {
            return DownloadNode();
        }
        catch (Exception e)
        {
            throw new IOException(
                $"未找到可用的 node（需 ≥{MinMajor}）且自动下载失败：{e.Message}。"
                + $"请安装 Node.js {MinMajor}+，设置环境变量 SEMA_NODE_PATH 指向 node 可执行文件，"
                + "或用 SEMA_NODE_BASE_URL 指定可达的下载镜像。", e);
        }
    }

    /// <summary>nodejs.org 资产名片段；win 用 .zip，其余 .tar.gz。不支持的平台返回 null。</summary>
    private static string? TripleFor()
    {
        var arm = global::System.Runtime.InteropServices.RuntimeInformation.OSArchitecture
            == global::System.Runtime.InteropServices.Architecture.Arm64;
        var x64 = global::System.Runtime.InteropServices.RuntimeInformation.OSArchitecture
            == global::System.Runtime.InteropServices.Architecture.X64;
        if (!arm && !x64) return null;
        if (OperatingSystem.IsMacOS()) return arm ? "darwin-arm64" : "darwin-x64";
        if (OperatingSystem.IsWindows()) return arm ? "win-arm64" : "win-x64";
        if (OperatingSystem.IsLinux()) return arm ? "linux-arm64" : "linux-x64";
        return null;
    }

    /// <summary>下载 node 到 <c>~/.sema/node/&lt;ver&gt;/&lt;triple&gt;/</c>，返回其中的可执行文件路径。</summary>
    private static string DownloadNode()
    {
        var triple = TripleFor()
            ?? throw new IOException($"不支持的平台: {Environment.OSVersion.Platform}/"
                + global::System.Runtime.InteropServices.RuntimeInformation.OSArchitecture);
        var cacheDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".sema", "node", NodeVersion, triple);

        var base_ = (Environment.GetEnvironmentVariable("SEMA_NODE_BASE_URL") ?? DefaultBase).TrimEnd('/');
        var zip = OperatingSystem.IsWindows();
        var fileName = $"node-v{NodeVersion}-{triple}.{(zip ? "zip" : "tar.gz")}";
        var url = $"{base_}/v{NodeVersion}/{fileName}";

        var tmp = Directory.CreateTempSubdirectory("sema-node").FullName;
        try
        {
            var archive = Path.Combine(tmp, fileName);
            using (var http = new HttpClient { Timeout = TimeSpan.FromSeconds(180) })
            {
                http.DefaultRequestHeaders.UserAgent.ParseAdd("sema-sdk");
                using var resp = http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead)
                    .GetAwaiter().GetResult();
                resp.EnsureSuccessStatusCode();
                using var input = resp.Content.ReadAsStream();
                using var output = File.Create(archive);
                input.CopyTo(output);
            }
            Directory.CreateDirectory(cacheDir);
            string node;
            if (zip)
            {
                // win：解到 cacheDir，node.exe 在 cacheDir/<stem>/ 下（缓存探测按递归查找命中）
                ZipFile.ExtractToDirectory(archive, cacheDir, overwriteFiles: true);
                node = Directory.EnumerateFiles(cacheDir, "node.exe", SearchOption.AllDirectories).First();
            }
            else
            {
                // unix：--strip-components=1 把 bin/ lib/ 直接落到 cacheDir，node 固定在 bin/node
                RunOrThrow("tar", "xzf", archive, "-C", cacheDir, "--strip-components=1");
                node = Path.Combine(cacheDir, "bin", "node");
                if (!File.Exists(node)) throw new IOException("解压后未找到 node 可执行文件");
                File.SetUnixFileMode(node, File.GetUnixFileMode(node)
                    | UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute);
                if (OperatingSystem.IsMacOS()) // 去隔离，避免 Gatekeeper 拦下载来的二进制
                    RunCapture(TimeSpan.FromSeconds(10), "xattr", "-dr", "com.apple.quarantine", node);
            }
            return node;
        }
        catch
        {
            try { Directory.Delete(cacheDir, recursive: true); } catch { } // 半成品清掉，避免下次误命中
            throw;
        }
        finally
        {
            try { Directory.Delete(tmp, recursive: true); } catch { }
        }
    }

    /// <summary>跑 <c>exe args...</c>，非 0 退出或超时抛 IOException（下载解压用）。</summary>
    private static void RunOrThrow(string exe, params string[] args)
    {
        if (RunCapture(TimeSpan.FromSeconds(180), exe, args) == null)
            throw new IOException($"{exe} {string.Join(' ', args)} 执行失败");
    }

    /// <summary>
    /// 通过登录 shell 取得真实 PATH，绕开桌面启动进程继承的精简 PATH（≙ Java Provisioner.loginShellPath）。
    /// Windows 返回 null。结果在进程内缓存一次。
    /// </summary>
    internal static string? LoginShellPath()
    {
        lock (LoginPathLock)
        {
            if (_loginPathResolved) return _loginPathCached;
            _loginPathResolved = true;
            if (OperatingSystem.IsWindows()) return null;
            var shell = Environment.GetEnvironmentVariable("SHELL");
            if (string.IsNullOrWhiteSpace(shell)) shell = "/bin/zsh";
            var output = RunCapture(TimeSpan.FromSeconds(5), shell, "-ilc", "printf '__SEMA_PATH__:%s\\n' \"$PATH\"");
            if (output != null)
            {
                foreach (var line in output.Split('\n'))
                {
                    if (line.StartsWith("__SEMA_PATH__:", StringComparison.Ordinal))
                    {
                        var path = line["__SEMA_PATH__:".Length..].Trim();
                        _loginPathCached = path.Length == 0 ? null : path;
                        return _loginPathCached;
                    }
                }
            }
            return null;
        }
    }

    /// <summary>运行 `node --version`（形如 "v20.18.0"）解析主版本号，失败返回 -1。</summary>
    private static int MajorVersionOf(string nodeExec)
    {
        var output = RunCapture(TimeSpan.FromSeconds(5), nodeExec, "--version");
        if (output == null) return -1;
        var v = output.Trim();
        if (v.StartsWith('v')) v = v[1..];
        var dot = v.IndexOf('.');
        return int.TryParse(dot > 0 ? v[..dot] : v, out var major) ? major : -1;
    }

    /// <summary>跑 <c>exe args...</c> 取 stdout，非 0 退出或超时返回 null。</summary>
    private static string? RunCapture(TimeSpan timeout, string exe, params string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo(exe)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi);
            if (p == null) return null;
            var stdout = p.StandardOutput.ReadToEndAsync();
            _ = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit((int)timeout.TotalMilliseconds))
            {
                try { p.Kill(entireProcessTree: true); } catch { }
                return null;
            }
            return p.ExitCode == 0 ? stdout.GetAwaiter().GetResult().Trim() : null;
        }
        catch
        {
            return null;
        }
    }
}

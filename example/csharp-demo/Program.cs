using System.Text;

namespace Sema.Example.Demo;

/// <summary>
/// 多入口分发（≙ java-demo 的 -Dexec.mainClass 切换 / python-demo 的多脚本）：
///   dotnet run -- &lt;项目目录&gt; [会话id]                         交互式 CLI（Cli.cs ≙ cli.ts）
///   dotnet run -- exec &lt;项目路径&gt; "&lt;用户输入&gt;" [档位]     一次性执行（Run.cs ≙ run.ts）
/// </summary>
public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        if (args.Length > 0 && args[0] == "exec") return await Run.Execute(args[1..]);
        return await Cli.Execute(args);
    }
}

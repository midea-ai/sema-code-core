using System.Text;

namespace Sema.Example.Demo;

/// <summary>
/// 多入口分发（≙ java-demo 的 -Dexec.mainClass 切换 / python-demo 的多脚本）：
///   dotnet run -- &lt;项目目录&gt; [会话id]                         交互式 CLI（Cli.cs ≙ cli.ts）
///   dotnet run -- run &lt;项目路径&gt; "&lt;用户输入&gt;" [档位]      一次性执行（Run.cs ≙ run.ts）
///   dotnet run -- test                                              类型导入冒烟（Test.cs ≙ Test.java）
/// </summary>
public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        if (args.Length > 0 && args[0] == "run") return await Run.Execute(args[1..]);
        if (args.Length > 0 && args[0] == "test") return Test.Execute();
        return await Cli.Execute(args);
    }
}

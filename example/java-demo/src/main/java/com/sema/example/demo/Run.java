package com.sema.example.demo;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import semacore.SemaCore;
import semacore.SemaJson;
import semacore.SemaSession;
import semacore.type.Constants;
import semacore.type.SemaCoreConfig;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;

/**
 * 入口 2：一次性执行（非交互）—— {@code example/demo/src/run.ts} 的 Java 镜像。
 *
 * 用法：
 *   mvn -q compile exec:java -Dexec.mainClass=com.sema.example.demo.Run \
 *       -Dexec.args="<项目路径> '<用户输入>' [verbose|medium|simple|minimal]"
 *
 * 详略档位（所有工具都只打印「标题」）：
 *   verbose  详细：AI 文本 + 全部工具标题 + 错误 + 子代理 + todos
 *   medium   中等：AI 文本 + 仅文件编辑/终端工具标题
 *   simple   简单：仅同步 AI 文本内容
 *   minimal  极简：仅同步最终结论
 *
 * 模型自动读取 ~/.sema/model.conf（见 README），代码里无需配置模型。
 */
public final class Run {

    // 文件编辑 / 终端类工具名（medium 档位只展示这些工具的标题）
    private static final Set<String> EDIT_TERMINAL_TOOLS = Set.of("write_file", "patch_file", "edit_notebook", "run_shell");
    // 文件编辑类（不含 run_shell）：标题后附带 +增 -删 行数
    private static final Set<String> FILE_EDIT_TOOLS = Set.of("write_file", "patch_file", "edit_notebook");

    // ── 展示状态：所有事件回调在同一条 gRPC 分发线程上串行执行，无需加锁 ──
    private static String verbosity = "verbose";
    private static volatile String finalText = "";
    private static boolean pendingNewline = false; // stdout 是否停在半行（流式写入后未换行）
    private static int subAgentDepth = 0; // message:text:chunk 不带 agentId，靠 task:agent:start/end 包裹判断
    private static final List<String> pendingReads = new ArrayList<>(); // 攒批的只读探查桶名

    public static void main(String[] args) throws Exception {
        // 取位置参数（过滤掉 - 开头的 flag，与 cli 一致）
        List<String> positional = Arrays.stream(args).filter(a -> !a.startsWith("-")).toList();
        String projectPath = positional.size() > 0 ? positional.get(0) : null;
        String userInput = positional.size() > 1 ? positional.get(1) : null;
        String rawVerbosity = positional.size() > 2 ? positional.get(2) : "verbose";
        if (projectPath == null || userInput == null) {
            System.err.println("用法: mvn -q compile exec:java -Dexec.mainClass=com.sema.example.demo.Run "
                    + "-Dexec.args=\"<项目路径> '<用户输入>' [verbose|medium|simple|minimal]\"");
            System.exit(1);
        }
        if (!Files.isDirectory(Path.of(projectPath))) {
            System.err.println("项目路径不存在或不是目录: " + projectPath);
            System.exit(1);
        }
        List<String> allowed = List.of("verbose", "medium", "simple", "minimal");
        if (!allowed.contains(rawVerbosity)) {
            System.err.println("未知档位 \"" + rawVerbosity + "\"，可选：" + String.join(" | ", allowed));
            System.exit(1);
        }
        verbosity = rawVerbosity;

        // ≙ Node: new SemaCore({...})，配置项一字不差。
        // 非交互：直接跳过所有权限检查，避免一次性执行卡在权限询问
        // （不同于 AutoRun——AutoRun 仍会用快速模型判断，命中风险会转人工，无人应答时会挂起）
        SemaCore core = SemaCore.start(SemaCoreConfig.builder()
                .workingDir(projectPath)
                .logLevel("none")
                .thinking(true)
                .disableTopicDetection(true)
                .disableBackgroundTasks(true)
                .disabledTools(List.of("ask_form", "plan_to_agent"))
                .skipShellExecPermission(true)
                .skipFileEditPermission(true)
                .skipSkillPermission(true)
                .skipMCPToolPermission(true)
                .skipFetchUrlPermission(true)
                .skipExternalFileReadPermission(true)
                .build());
        Runtime.getRuntime().addShutdownHook(new Thread(core::close));

        try (core) {
            SemaSession session = core.createSession();
            subscribe(session);

            // 完成信号：主代理回到 idle（整轮含工具调用结束后只发一次 idle）
            CompletableFuture<Void> done = new CompletableFuture<>();
            session.once("session:error", d -> {
                flushReadBatch();
                String msg = SemaJson.str(SemaJson.get(d, "error"), "message");
                done.completeExceptionally(new IllegalStateException(
                        msg != null ? msg : SemaJson.str(d, "type", String.valueOf(d))));
            });
            session.on("state:update", d -> {
                if ("idle".equals(SemaJson.str(d, "state"))) done.complete(null);
            });
            session.once("session:ready", d -> session.processUserInput(userInput));
            done.join();

            if (verbosity.equals("minimal")) {
                System.out.println(green(finalText.isEmpty() ? "(无结论)" : finalText));
            }
            session.close();
        } catch (Exception e) {
            Throwable root = e;
            while (root.getCause() != null) root = root.getCause();
            System.err.println("错误: " + (root.getMessage() != null ? root.getMessage() : root));
            System.exit(1);
        }
    }

    /** 事件订阅（对应 run.ts 各节）。回调只做打印/状态更新，禁 join/get。 */
    private static void subscribe(SemaSession session) {
        boolean isMinimal = verbosity.equals("minimal");
        boolean isVerbose = verbosity.equals("verbose");

        session.on("task:agent:start", d -> {
            subAgentDepth++;
            if (isVerbose) {
                flushNewline();
                System.out.println(gray("🤖 子代理开始: " + SemaJson.str(d, "title", "")));
            }
        });
        session.on("task:agent:end", d -> {
            if (subAgentDepth > 0) subAgentDepth--;
            if (isVerbose) System.out.println(gray("✅ 子代理结束: " + SemaJson.str(d, "title", "")));
        });

        // 文本流式（仅主代理）；minimal 不流式，只在 message:complete 记录结论
        if (!isMinimal) {
            session.on("message:text:chunk", d -> {
                String delta = SemaJson.str(d, "delta");
                if (subAgentDepth > 0 || delta == null || delta.isEmpty()) return;
                flushReadBatch(); // 主代理开始说话前，先把攒着的只读探查汇总打出来
                System.out.print(delta);
                System.out.flush();
                pendingNewline = true;
            });
        }

        session.on("message:complete", d -> {
            if (!isMain(SemaJson.str(d, "agentId"))) return;
            if (!isMinimal) flushNewline();
            // 只在本轮不再调工具（turn 结束）时冲刷；中间的纯工具轮不切断连续的只读探查
            if (!SemaJson.bool(d, "hasToolCalls", false)) {
                flushReadBatch();
                String content = SemaJson.str(d, "content");
                if (content != null && !content.isEmpty()) finalText = content;
            }
        });

        if (isVerbose || verbosity.equals("medium")) {
            session.on("tool:execution:complete", d -> {
                if (!isMain(SemaJson.str(d, "agentId"))) return;
                String toolName = SemaJson.str(d, "toolName", "");
                String title = SemaJson.str(d, "title", "").trim();
                // 只读探查类：verbose 攒着合并汇总；medium 不显示只读信息
                String bucket = readToolBucket(toolName, title);
                if (bucket != null) {
                    if (isVerbose) pendingReads.add(bucket);
                    return;
                }
                // medium 只展示文件编辑与终端工具，其余（skill / mcp / fetch 等）不外发
                if (verbosity.equals("medium") && !EDIT_TERMINAL_TOOLS.contains(toolName)) return;
                flushReadBatch();
                flushNewline();
                String label = title.isEmpty() ? toolName : title;
                String stat = FILE_EDIT_TOOLS.contains(toolName) ? formatDiffStat(SemaJson.get(d, "content")) : "";
                System.out.println(gray(toolIcon(toolName) + " " + label + (stat.isEmpty() ? "" : " " + stat)));
            });
        }
        if (isVerbose) {
            session.on("tool:execution:error", d -> {
                if (!isMain(SemaJson.str(d, "agentId"))) return;
                flushReadBatch();
                flushNewline();
                String label = SemaJson.str(d, "title", "").trim();
                if (label.isEmpty()) label = SemaJson.str(d, "toolName", "工具执行失败");
                System.out.println(gray("❌ " + label));
            });
            session.on("todos:update", d -> {
                flushReadBatch();
                flushNewline();
                int n = d != null && d.isJsonArray() ? d.getAsJsonArray().size() : 0;
                System.out.println(gray("📋 todos: " + n + " 项"));
            });
        }
    }

    private static boolean isMain(String agentId) {
        return agentId == null || Constants.MAIN_AGENT_ID.equals(agentId);
    }

    private static void flushNewline() {
        if (pendingNewline) {
            System.out.println();
            pendingNewline = false;
        }
    }

    /** 连续的只读探查工具合并成一条 🔍 汇总，避免逐条刷屏 */
    private static void flushReadBatch() {
        if (pendingReads.isEmpty()) return;
        List<String> parts = new ArrayList<>();
        long files = pendingReads.stream().filter("文件"::equals).count();
        long searches = pendingReads.stream().filter("搜索"::equals).count();
        long dirs = pendingReads.stream().filter("目录"::equals).count();
        long probes = pendingReads.stream().filter("探查"::equals).count();
        if (files > 0) parts.add("读取 " + files + " 个文件");
        if (searches > 0) parts.add("搜索 " + searches + " 次");
        if (dirs > 0) parts.add("列出 " + dirs + " 个目录");
        if (probes > 0) parts.add("探查 " + probes + " 次");
        pendingReads.clear();
        flushNewline();
        System.out.println(gray("🔍 " + String.join("、", parts)));
    }

    // ── 工具展示辅助（与 run.ts 逐函数对应） ─────────────────────────────

    /** 按工具类型给区分化图标，比单一 🔧 更易辨认 */
    private static String toolIcon(String toolName) {
        if (FILE_EDIT_TOOLS.contains(toolName)) return "📝";
        if (toolName.equals("run_shell")) return "💻";
        if (toolName.equals("skill")) return "🧩";
        if (toolName.startsWith("mcp__")) return "🔌";
        if (toolName.equals("fetch_url")) return "🌐";
        return "🔧";
    }

    /** 从工具 content（结构 {type, patch}）统计 +增 -删，如 "+12 -2" / "+12" / "" */
    private static String formatDiffStat(JsonElement content) {
        if (content == null || !content.isJsonObject()) return "";
        JsonObject c = content.getAsJsonObject();
        JsonElement patchEl = c.get("patch");
        if (patchEl == null || !patchEl.isJsonArray()) return "";
        JsonArray patch = patchEl.getAsJsonArray();
        int added = 0;
        int removed = 0;
        if ("new".equals(SemaJson.str(c, "type"))) {
            for (JsonElement h : patch) added += SemaJson.i32(h, "newLines", 0);
        } else {
            for (JsonElement h : patch) {
                JsonElement lines = SemaJson.get(h, "lines");
                if (lines == null || !lines.isJsonArray()) continue;
                for (JsonElement line : lines.getAsJsonArray()) {
                    String s = line.isJsonPrimitive() ? line.getAsString() : "";
                    if (s.startsWith("+")) added++;
                    else if (s.startsWith("-")) removed++;
                }
            }
        }
        List<String> parts = new ArrayList<>();
        if (added > 0) parts.add("+" + added);
        if (removed > 0) parts.add("-" + removed);
        return String.join(" ", parts);
    }

    /** 只读探查类工具归桶：查看文件 / 搜索 / ls 列目录 / find·pwd·探查链；其余返回 null 照常单条展示 */
    private static String readToolBucket(String toolName, String title) {
        if (toolName.equals("view_file")) return "文件";
        if (toolName.equals("search_files") || toolName.equals("search_content")) return "搜索";
        if (toolName.equals("run_shell")) {
            if (isLsCommand(title)) return "目录";
            if (isFindCommand(title) || isPwdCommand(title) || isExploratoryCommand(title)) return "探查";
        }
        return null;
    }

    private static final Pattern CD_SEG = Pattern.compile("^cd(?:\\s|$).*");
    private static final Pattern LS_SEG = Pattern.compile("^ls(?:\\s.*)?$");
    private static final Pattern FIND_SEG = Pattern.compile("^find(?:\\s.*)?$");
    private static final Pattern FIND_SIDE_EFFECT = Pattern.compile("(?:^|\\s)-(?:delete|exec|execdir|ok|okdir)(?:\\s|$)");
    private static final Pattern PWD_SEG = Pattern.compile("^pwd(?:\\s+-(?:L|P))*\\s*$");

    /** title 形如 `cd a && ls foo`：跳过开头的 cd 段后剩余命令以 ls 开头即视为列目录 */
    private static boolean isLsCommand(String title) {
        List<String> segs = splitAnd(title);
        int i = 0;
        while (i < segs.size() - 1 && CD_SEG.matcher(segs.get(i)).matches()) i++;
        return i < segs.size() && LS_SEG.matcher(segs.get(i)).matches();
    }

    /** find 查找（排除 -delete/-exec 等有副作用的破坏性用法） */
    private static boolean isFindCommand(String title) {
        String c = title.trim();
        if (!FIND_SEG.matcher(c).matches()) return false;
        return !FIND_SIDE_EFFECT.matcher(c).find();
    }

    private static boolean isPwdCommand(String title) {
        return PWD_SEG.matcher(title.trim()).matches();
    }

    /** 由 && 串起且每段都是 ls / find / pwd 的纯探查链 */
    private static boolean isExploratoryCommand(String title) {
        List<String> segs = splitAnd(title);
        if (segs.size() < 2) return false;
        return segs.stream().allMatch(s -> isLsCommand(s) || isFindCommand(s) || isPwdCommand(s));
    }

    private static List<String> splitAnd(String title) {
        return Arrays.stream(title.trim().split("\\s+&&\\s+")).map(String::trim).filter(s -> !s.isEmpty()).toList();
    }

    private static String gray(String s) { return "\u001B[90m" + s + "\u001B[0m"; }
    private static String green(String s) { return "\u001B[32m" + s + "\u001B[0m"; }

    private Run() {}
}

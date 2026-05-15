package com.semademo;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Scanner;
import java.util.concurrent.*;

public class Main {

    static String gray(String s)  { return "\u001b[90m" + s + "\u001b[0m"; }
    static String blue(String s)  { return "\u001b[34m" + s + "\u001b[0m"; }
    static String green(String s) { return "\u001b[32m" + s + "\u001b[0m"; }

    public static void main(String[] args) throws Exception {

        // ── 配置 ─────────────────────────────────────────────────────────
        final String BRIDGE_URL = "ws://localhost:3765";

        System.out.println("=== Sema Java Demo ===");
        System.out.println("Connecting to sema-bridge at " + BRIDGE_URL + "...\n");

        Scanner scanner = new Scanner(System.in);

        try (SemaCoreClient client = new SemaCoreClient()) {

            // ── 日志事件（灰色输出，对应 quickstart.mjs events 数组）────────
            for (String e : new String[]{
                    "tool:execution:start", "tool:execution:complete", "tool:execution:error", "tool:permission:request",
                    "task:agent:start", "task:agent:end", "todos:update", "session:interrupted"
            }) {
                final String eName = e;
                client.on(eName, data ->
                        System.out.println(gray(eName + "|" + (data != null ? data.toString() : ""))));
            }

            // ── 流式输出 ──────────────────────────────────────────────────
            client.on("message:text:chunk", data -> {
                if (data != null && data.has("delta"))
                    System.out.print(data.get("delta").asText());
            });

            client.on("message:complete", data -> System.out.println());

            // ── 权限交互（覆盖日志处理器，追加用户确认逻辑）─────────────────
            client.on("tool:permission:request", data -> {
                String toolId = data != null && data.has("toolId") ? data.get("toolId").asText() : "";
                String toolName = data != null && data.has("toolName") ? data.get("toolName").asText() : "";
                System.out.print(blue("👤 权限响应 (y=agree / a=allow / n=refuse): "));
                String answer = scanner.nextLine().trim();
                String selected = switch (answer) {
                    case "a" -> "allow";
                    case "n" -> "refuse";
                    default  -> "agree";
                };
                client.respondToPermissionAsync(toolId, toolName, selected);
            });

            // ── 问答请求 ──────────────────────────────────────────────────
            client.on("ask:question:request", data -> {
                String agentId = data != null && data.has("agentId") ? data.get("agentId").asText() : "";
                System.out.println("[Question] " + (data != null ? data.get("questions") : ""));
                System.out.print("Your answer: ");
                String input = scanner.nextLine();
                String firstQuestion = "";
                if (data != null && data.has("questions") && data.get("questions").isArray() && data.get("questions").size() > 0) {
                    firstQuestion = data.get("questions").get(0).has("question") ? data.get("questions").get(0).get("question").asText() : "";
                }
                client.respondToQuestionAsync(agentId, Map.of(firstQuestion, input));
            });

            // ── Plan 退出请求 ─────────────────────────────────────────────
            client.on("plan:exit:request", data -> {
                System.out.println("[Plan] Exit plan mode — approving");
                String agentId = data != null && data.has("agentId") ? data.get("agentId").asText() : "";
                client.respondToPlanExitAsync(agentId, "startEditing");
            });

            // ── 连接 ──────────────────────────────────────────────────────
            try {
                client.connectAsync(BRIDGE_URL).get(10, TimeUnit.SECONDS);
                System.out.println("Connected!\n");
            } catch (Exception ex) {
                System.err.println("Failed to connect: " + ex.getMessage());
                System.err.println("Make sure sema-bridge is running: cd sema-bridge && npm start");
                return;
            }

            // ── 核心配置（对应 quickstart.mjs 的 new SemaCore({...}) 选项）──────
            client.initCoreAsync(SemaCoreConfig.builder()
                    .workingDir("/path/to/your/project") // Agent 将操作的目标代码仓库路径
                    .logLevel("none")
                    .thinking(false)
                    .disableBackgroundTasks(true)
                    .disableTopicDetection(true)
                    // 按需启用其他选项：
                    // .skipFileEditPermission(true)
                    // .skipBashExecPermission(true)
                    // .agentMode("Plan")
                    // .systemPrompt("你是一个 Java 专家")
                    .build()
            ).get(15, TimeUnit.SECONDS);

            // ── 配置模型（以 qwen3.6-plus 为例，更多LLM服务商请见"新增模型"文档）──────
            // 只需要加一次，后面可以注释掉添加模型相关代码
            Map<String, Object> modelConfig = new LinkedHashMap<>();
            modelConfig.put("provider",      "custom");
            modelConfig.put("modelName",     "qwen3.5-plus");
            modelConfig.put("baseURL",       "https://aimpapi.midea.com/t-aigc/llm-openai-api");
            modelConfig.put("apiKey",        "sk-");
            modelConfig.put("maxTokens",     32000);
            modelConfig.put("contextLength", 256000);
            modelConfig.put("adapt",         "openai");

            client.addModelAsync(modelConfig, false).get(15, TimeUnit.SECONDS);
            String modelId = "qwen3.5-plus[custom]";
            client.applyTaskModelAsync(modelId, modelId).get(15, TimeUnit.SECONDS);
            System.out.println("Model configured: " + modelId + "\n");

            // ── 创建会话，等待 session:ready ──────────────────────────────
            CompletableFuture<String> sessionReadyFuture = new CompletableFuture<>();
            client.once("session:ready", data -> {
                String sid = data != null && data.has("sessionId") ? data.get("sessionId").asText() : "";
                sessionReadyFuture.complete(sid);
            });

            client.createSessionAsync().get(15, TimeUnit.SECONDS);
            String sessionId = sessionReadyFuture.get(30, TimeUnit.SECONDS);
            System.out.println("Session ready: " + sessionId + "\n");

            // ── Ctrl+C 中断 ───────────────────────────────────────────────
            boolean[] interrupted = {false};
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                if (!interrupted[0]) {
                    interrupted[0] = true;
                    System.out.println("\n⚠️  中断会话...");
                    try { client.interruptAsync().get(5, TimeUnit.SECONDS); } catch (Exception ignored) {}
                }
            }));

            // ── 对话循环（对应 quickstart.mjs 的 Promise + state:update 模式）─
            CompletableFuture<Void> conversationFuture = new CompletableFuture<>();
            Semaphore idleSignal = new Semaphore(0);

            // 对应 quickstart.mjs: core.once('session:error', reject)
            client.once("session:error", data -> {
                String msg = data != null && data.has("message") ? data.get("message").asText() : "";
                conversationFuture.completeExceptionally(new RuntimeException(msg));
            });

            // 当 state:update 变为 idle 时释放信号
            client.on("state:update", data -> {
                if (data != null && data.has("state")
                        && "idle".equals(data.get("state").asText())
                        && idleSignal.availablePermits() == 0) {
                    idleSignal.release();
                }
            });

            // 对话辅助方法
            ExecutorService executor = Executors.newSingleThreadExecutor();
            executor.submit(() -> {
                try {
                    System.out.print(blue("👤 消息 (exit退出): "));
                    String input = scanner.nextLine().trim();
                    if ("exit".equals(input) || "quit".equals(input)) {
                        conversationFuture.complete(null);
                        return null;
                    }
                    if (!input.isEmpty()) {
                        System.out.print(green("\n🤖 AI: "));
                        client.sendUserInputAsync(input).get();
                        idleSignal.acquire();
                        Thread.sleep(100);
                    }

                    // 后续轮次由 state:update idle 驱动
                    while (!conversationFuture.isDone()) {
                        System.out.print(blue("\n👤 消息 (exit退出): "));
                        input = scanner.nextLine().trim();
                        if ("exit".equals(input) || "quit".equals(input)) {
                            conversationFuture.complete(null);
                            return null;
                        }
                        if (!input.isEmpty()) {
                            System.out.print(green("\n🤖 AI: "));
                            client.sendUserInputAsync(input).get();
                            idleSignal.acquire();
                            Thread.sleep(100);
                        }
                    }
                } catch (Exception ex) {
                    conversationFuture.completeExceptionally(ex);
                }
                return null;
            });

            try {
                conversationFuture.get();
            } catch (ExecutionException ex) {
                System.err.println("[Error] " + ex.getCause().getMessage());
            }

            executor.shutdown();
        }

        System.out.println("\n=== 会话结束 ===");
    }
}

package com.semademo;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Scanner;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import com.fasterxml.jackson.databind.JsonNode;

public class Main {

    static String gray(String s)  { return "\u001b[90m" + s + "\u001b[0m"; }
    static String blue(String s)  { return "\u001b[34m" + s + "\u001b[0m"; }
    static String green(String s) { return "\u001b[32m" + s + "\u001b[0m"; }

    static final String MAIN_AGENT_ID = "main";

    /** 主代理判定：agentId 为 "main" 或空/缺失（message:text:chunk 等事件不带 agentId）时视为主代理 */
    static boolean isMain(String agentId) {
        return agentId == null || agentId.isEmpty() || MAIN_AGENT_ID.equals(agentId);
    }

    static String agentId(JsonNode data) {
        return data != null && data.has("agentId") ? data.get("agentId").asText() : "";
    }

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

            // 交互应答需要读控制台（阻塞），绝不能在 OkHttp 消息分发线程里做，
            // 否则会阻塞整个事件分发导致死锁。统一丢到单线程 executor 里执行。
            ExecutorService interactionExecutor = Executors.newSingleThreadExecutor();

            // ── 子代理深度跟踪 ────────────────────────────────────────────
            // message:text:chunk 不带 agentId，靠 task:agent:start/end 包裹判断是否在子代理内，
            // 仅 depth==0（主代理）时打印流式文本，避免子代理文本混入主输出。
            AtomicInteger subAgentDepth = new AtomicInteger(0);
            client.on("task:agent:start", data -> subAgentDepth.incrementAndGet());
            client.on("task:agent:end", data -> {
                if (subAgentDepth.get() > 0) subAgentDepth.decrementAndGet();
            });

            // ── 流式输出（仅主代理）──────────────────────────────────────
            client.on("message:text:chunk", data -> {
                if (subAgentDepth.get() > 0) return;
                if (data != null && data.has("delta"))
                    System.out.print(data.get("delta").asText());
            });

            // 仅主代理 message:complete 时换行（结束信号见下方 state:update=idle）
            client.on("message:complete", data -> {
                if (isMain(agentId(data))) System.out.println();
            });

            // ── 权限交互（覆盖日志处理器，追加用户确认逻辑）─────────────────
            client.on("tool:permission:request", data -> {
                String toolId = data != null && data.has("toolId") ? data.get("toolId").asText() : "";
                String toolName = data != null && data.has("toolName") ? data.get("toolName").asText() : "";
                interactionExecutor.submit(() -> {
                    System.out.print(blue("👤 权限响应 (y=agree / a=allow / n=refuse): "));
                    String answer = scanner.nextLine().trim();
                    String selected = switch (answer) {
                        case "a" -> "allow";
                        case "n" -> "refuse";
                        default  -> "agree";
                    };
                    client.respondToPermissionAsync(toolId, toolName, selected);
                });
            });

            // ── 选项请求（pick_option，交互式工具）────────────────────────
            // 注意：下方 config.init 已配置 disabledTools 禁用 ask_form/plan_to_agent，
            // 正常不会触发；保留处理器以演示如何应答。
            client.on("pick:option:request", data -> {
                String agentId = agentId(data);
                System.out.println("[Question] " + (data != null ? data.get("questions") : ""));
                String firstQuestion = "";
                if (data != null && data.has("questions") && data.get("questions").isArray() && data.get("questions").size() > 0) {
                    firstQuestion = data.get("questions").get(0).has("question") ? data.get("questions").get(0).get("question").asText() : "";
                }
                final String question = firstQuestion;
                interactionExecutor.submit(() -> {
                    System.out.print("Your answer: ");
                    String input = scanner.nextLine();
                    client.respondToQuestionAsync(agentId, Map.of(question, input));
                });
            });

            // ── Plan 退出请求 ─────────────────────────────────────────────
            client.on("plan:exit:request", data -> {
                System.out.println("[Plan] Exit plan mode — approving");
                String agentId = agentId(data);
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
                    .disabledTools("ask_form", "plan_to_agent") // 交互场景禁用无法应答的工具
                    .build()
            ).get(15, TimeUnit.SECONDS);

            // ── 配置模型（以 deepseek 为例，更多LLM服务商请见"新增模型"文档）──────
            // 只需要加一次，后面可以注释掉添加模型相关代码
            Map<String, Object> modelConfig = new LinkedHashMap<>();
            modelConfig.put("modelName",     "deepseek-v4-flash");
            modelConfig.put("provider",      "deepseek");
            modelConfig.put("baseURL",       "https://api.deepseek.com/anthropic");
            modelConfig.put("apiKey",        "sk-your-api-key");
            modelConfig.put("maxTokens",     32000);
            modelConfig.put("contextLength", 256000);
            modelConfig.put("adapt",         "anthropic");

            client.addModelAsync(modelConfig, false).get(15, TimeUnit.SECONDS);
            String modelId = "deepseek-v4-flash[deepseek]";
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

            // ── 对话循环：以主代理回到 idle 作为一轮结束信号 ──────────────
            CompletableFuture<Void> conversationFuture = new CompletableFuture<>();

            // 对应 quickstart.mjs: core.once('session:error', reject)
            client.once("session:error", data -> {
                String msg = data != null && data.has("message") ? data.get("message").asText() : "";
                conversationFuture.completeExceptionally(new RuntimeException(msg));
            });

            // 弹出下一条输入并发送。读控制台会阻塞，因此丢到独立线程，绝不在 dispatch 线程里执行。
            // awaitingInput 防止多个结束信号（idle / interrupted）重复弹出输入。
            java.util.concurrent.atomic.AtomicBoolean awaitingInput = new java.util.concurrent.atomic.AtomicBoolean(false);
            Runnable[] askAndSendHolder = new Runnable[1];
            askAndSendHolder[0] = () -> {
                if (!awaitingInput.compareAndSet(false, true)) return;
                interactionExecutor.submit(() -> {
                    try {
                        System.out.print(blue("\n👤 消息 (exit退出): "));
                        String input = scanner.nextLine().trim();
                        awaitingInput.set(false);
                        if ("exit".equals(input) || "quit".equals(input)) {
                            conversationFuture.complete(null);
                            return;
                        }
                        if (input.isEmpty()) { // 空输入：重新询问
                            askAndSendHolder[0].run();
                            return;
                        }
                        System.out.print(green("\n🤖 AI: "));
                        client.sendUserInputAsync(input).get();
                    } catch (Exception ex) {
                        conversationFuture.completeExceptionally(ex);
                    }
                });
            };

            // 本轮结束信号：主代理回到 idle（整轮含工具调用循环结束后仅触发一次）
            client.on("state:update", data -> {
                if (data != null && data.has("state") && "idle".equals(data.get("state").asText())) {
                    askAndSendHolder[0].run();
                }
            });
            // 被中断后重新弹输入
            client.on("session:interrupted", data -> askAndSendHolder[0].run());
            // 会话初始即 idle 不触发 state:update，首条输入靠 session:ready 后直接弹
            askAndSendHolder[0].run();

            try {
                conversationFuture.get();
            } catch (ExecutionException ex) {
                System.err.println("[Error] " + ex.getCause().getMessage());
            }

            // 退出前销毁会话，释放服务端资源
            try { client.disposeSessionAsync().get(5, TimeUnit.SECONDS); } catch (Exception ignored) {}

            interactionExecutor.shutdownNow();
        }

        System.out.println("\n=== 会话结束 ===");
    }
}

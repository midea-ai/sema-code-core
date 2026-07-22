package semacore.runtime;

import java.io.File;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** {@link NodeProvider} 的内置实现。 */
public final class NodeProviders {

    private static final System.Logger LOG = System.getLogger(NodeProviders.class.getName());

    /** sema-core 要求的最低 node 主版本。 */
    public static final int MIN_MAJOR = 18;

    /** 按需下载的 node 版本（LTS，与 Python / C# SDK 写死同值，升级时三处同步）。 */
    public static final String NODE_VERSION = "20.18.0";

    private static final String DEFAULT_BASE = "https://nodejs.org/dist";
    private static final String NODE_EXE = Provisioner.IS_WINDOWS ? "node.exe" : "node";

    private NodeProviders() {
    }

    /** 固定路径（不做版本校验，由宿主保证可用）。 */
    public static NodeProvider fixed(Path node) {
        String path = node.toAbsolutePath().toString();
        return () -> {
            File f = new File(path);
            if (!f.canExecute()) throw new IOException("node 不可执行: " + path);
            return path;
        };
    }

    /**
     * 统一分发范式（与 Python / C# SDK 行为对齐）：本地优先 → 缓存命中 → 按需下载。
     * SEMA_NODE_PATH 环境变量 / sema.node.path 系统属性 → 登录 shell PATH 里 ≥18 的 node →
     * 常见绝对路径 → {@code ~/.sema/node} 缓存 → 从 nodejs.org 官方 Release 下载到缓存
     * （内网用 SEMA_NODE_BASE_URL 指镜像）。探测与下载均失败时抛 IOException 引导用户安装。
     */
    public static NodeProvider system() {
        return NodeProviders::resolveSystemNode;
    }

    private static String resolveSystemNode() throws IOException {
        // 1) 显式指定
        String explicit = System.getenv("SEMA_NODE_PATH");
        if (explicit == null) explicit = System.getProperty("sema.node.path");
        if (explicit != null && !explicit.isBlank()) {
            File f = new File(explicit);
            if (f.canExecute()) return f.getAbsolutePath();
            throw new IOException("SEMA_NODE_PATH 指定但不可执行: " + explicit);
        }

        // 2) 登录 shell PATH 探测（GUI 场景下进程 PATH 不全）
        List<String> candidates = new ArrayList<>();
        String pathEnv = Provisioner.loginShellPath();
        if (pathEnv == null || pathEnv.isBlank()) pathEnv = System.getenv("PATH");
        if (pathEnv != null) {
            for (String dir : pathEnv.split(File.pathSeparator)) {
                if (!dir.isBlank()) candidates.add(new File(dir, NODE_EXE).getPath());
            }
        }
        // 3) 常见绝对路径兜底（宿主 PATH 精简时）
        if (!Provisioner.IS_WINDOWS) {
            candidates.add("/opt/homebrew/bin/node");
            candidates.add("/usr/local/bin/node");
            candidates.add("/usr/bin/node");
        }
        // 4) ~/.sema/node 缓存（缓存布局：<ver>/<triple>/bin/node，首次自动下载后落此处）
        File semaHome = Provisioner.semaHome();
        if (semaHome != null) {
            collectFilesNamed(new File(semaHome, "node"), NODE_EXE, candidates);
        }

        for (String candidate : candidates) {
            File f = new File(candidate);
            if (f.canExecute() && majorVersionOf(f.getAbsolutePath()) >= MIN_MAJOR) {
                return f.getAbsolutePath();
            }
        }

        // 5) 按需下载（一次性，落 ~/.sema/node 缓存后上面第 4 步即可命中）
        try {
            return downloadNode().getAbsolutePath();
        } catch (Exception e) {
            throw new IOException(
                    "未找到可用的 node（需 ≥" + MIN_MAJOR + "）且自动下载失败：" + e.getMessage()
                            + "。请安装 Node.js " + MIN_MAJOR + "+，设置环境变量 SEMA_NODE_PATH 指向 node"
                            + " 可执行文件，或用 SEMA_NODE_BASE_URL 指定可达的下载镜像。", e);
        }
    }

    /** nodejs.org 资产名片段；win 用 .zip，其余 .tar.gz。不支持的平台返回 null。 */
    private static String tripleFor() {
        if (Provisioner.IS_MAC) {
            if (Provisioner.IS_ARM) return "darwin-arm64";
            if (Provisioner.IS_X64) return "darwin-x64";
        } else if (Provisioner.IS_WINDOWS) {
            if (Provisioner.IS_X64) return "win-x64";
            if (Provisioner.IS_ARM) return "win-arm64";
        } else if (Provisioner.IS_LINUX) {
            if (Provisioner.IS_ARM) return "linux-arm64";
            if (Provisioner.IS_X64) return "linux-x64";
        }
        return null;
    }

    /** 下载 node 到 {@code ~/.sema/node/<ver>/<triple>/}，返回其中的可执行文件。 */
    private static File downloadNode() throws IOException {
        String triple = tripleFor();
        if (triple == null) {
            throw new IOException("不支持的平台: " + Provisioner.OS_NAME + "/" + System.getProperty("os.arch"));
        }
        File semaHome = Provisioner.semaHome();
        if (semaHome == null) throw new IOException("无法定位用户主目录");
        File cacheDir = new File(semaHome, "node/" + NODE_VERSION + "/" + triple);

        String base = System.getenv("SEMA_NODE_BASE_URL");
        if (base == null) base = System.getProperty("sema.node.baseUrl");
        if (base == null) base = DEFAULT_BASE;
        base = base.replaceAll("/+$", "");
        boolean zip = Provisioner.IS_WINDOWS;
        String fileName = "node-v" + NODE_VERSION + "-" + triple + (zip ? ".zip" : ".tar.gz");
        String url = base + "/v" + NODE_VERSION + "/" + fileName;
        LOG.log(System.Logger.Level.INFO, "[sema] 首启下载 node: " + url);

        File tmp = java.nio.file.Files.createTempDirectory("sema-node").toFile();
        try {
            File archive = new File(tmp, fileName);
            Provisioner.httpDownload(url, archive, 6);
            cacheDir.mkdirs();
            if (zip) {
                // win：解到 cacheDir，node.exe 在 cacheDir/<stem>/ 下（缓存探测按递归查找命中）
                Provisioner.unzip(archive, cacheDir);
            } else {
                // unix：--strip-components=1 把 bin/ lib/ 直接落到 cacheDir，node 固定在 bin/node
                Provisioner.untarGz(archive, cacheDir, 1);
            }
            List<String> found = new ArrayList<>();
            collectFilesNamed(cacheDir, NODE_EXE, found);
            if (found.isEmpty()) throw new IOException("解压后未找到 " + NODE_EXE);
            File exec = new File(found.get(0));
            if (!Provisioner.IS_WINDOWS) {
                exec.setExecutable(true, false);
                Provisioner.dequarantine(exec);
            }
            LOG.log(System.Logger.Level.INFO, "[sema] node 就绪: " + exec.getAbsolutePath());
            return exec;
        } catch (IOException | RuntimeException e) {
            Provisioner.deleteRecursively(cacheDir); // 半成品清掉，避免下次误命中
            throw e;
        } finally {
            Provisioner.deleteRecursively(tmp);
        }
    }

    /** 递归收集 root 下名为 name 的文件路径。 */
    private static void collectFilesNamed(File root, String name, List<String> into) {
        File[] files = root.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (f.isFile() && f.getName().equals(name)) into.add(f.getPath());
            else if (f.isDirectory()) collectFilesNamed(f, name, into);
        }
    }

    /** 运行 `node --version`（形如 "v20.18.0"）解析主版本号，失败返回 -1。 */
    private static int majorVersionOf(String nodeExec) {
        String out = Provisioner.runCapture(nodeExec, "--version");
        if (out == null) return -1;
        String v = out.trim();
        if (v.startsWith("v")) v = v.substring(1);
        int dot = v.indexOf('.');
        try {
            return Integer.parseInt(dot > 0 ? v.substring(0, dot) : v);
        } catch (NumberFormatException e) {
            return -1;
        }
    }
}

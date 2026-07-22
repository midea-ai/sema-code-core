package semacore.runtime;

import java.io.File;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipInputStream;

/**
 * node 等外部依赖供应的公共设施：平台探测、登录 shell 真实 PATH、版本探测、
 * 下载 / 解压 / 去隔离。统一分发范式：本地优先 -> {@code ~/.sema} 私有缓存命中 -> 按需下载。
 * 全程只写 {@code ~/.sema} 缓存、只影响 sidecar 子进程环境，不修改系统环境。
 */
public final class Provisioner {

    public static final String OS_NAME = System.getProperty("os.name", "").toLowerCase();
    public static final boolean IS_WINDOWS = OS_NAME.contains("win");
    public static final boolean IS_MAC = OS_NAME.contains("mac") || OS_NAME.contains("darwin");
    public static final boolean IS_LINUX = OS_NAME.contains("nux");

    private static final String ARCH = System.getProperty("os.arch", "").toLowerCase();
    public static final boolean IS_ARM = ARCH.contains("aarch64") || ARCH.contains("arm64");
    public static final boolean IS_X64 =
            ARCH.contains("amd64") || ARCH.contains("x86_64") || ARCH.equals("x64");

    private static volatile boolean loginPathResolved;
    private static volatile String loginPathCached;

    private Provisioner() {
    }

    /** {@code ~/.sema} 私有缓存根。 */
    public static File semaHome() {
        String home = System.getProperty("user.home");
        return home == null ? null : new File(home, ".sema");
    }

    /**
     * 通过登录 shell 取得真实 PATH，绕开桌面启动进程继承的精简 PATH。
     * Windows 返回 null。结果在进程内缓存一次。
     */
    public static synchronized String loginShellPath() {
        if (loginPathResolved) return loginPathCached;
        loginPathResolved = true;
        if (IS_WINDOWS) return null;
        try {
            String shell = System.getenv("SHELL");
            if (shell == null || shell.isBlank()) shell = "/bin/zsh";
            Process p = new ProcessBuilder(shell, "-ilc", "printf '__SEMA_PATH__:%s\\n' \"$PATH\"")
                    .redirectErrorStream(false)
                    .start();
            String out = new String(p.getInputStream().readAllBytes());
            if (!p.waitFor(5, TimeUnit.SECONDS)) p.destroyForcibly();
            for (String line : out.split("\\R")) {
                if (line.startsWith("__SEMA_PATH__:")) {
                    String path = line.substring("__SEMA_PATH__:".length()).trim();
                    loginPathCached = path.isEmpty() ? null : path;
                    return loginPathCached;
                }
            }
        } catch (Exception ignored) {
            loginPathCached = null;
        }
        return null;
    }

    /** 在给定 PATH 串里查找可执行文件。 */
    public static File whichIn(String path, String exe) {
        if (path == null) return null;
        for (String dir : path.split(File.pathSeparator)) {
            if (!dir.isBlank()) {
                File f = new File(dir, exe);
                if (f.canExecute()) return f;
            }
        }
        return null;
    }

    /** 跑 {@code exe args...} 取 stdout，非 0 退出或超时返回 null。 */
    public static String runCapture(String exe, String... args) {
        return runCapture(5, exe, args);
    }

    /** 跑 {@code exe args...} 取 stdout，非 0 退出或超时返回 null。 */
    public static String runCapture(long timeoutSec, String exe, String... args) {
        try {
            String[] cmd = new String[args.length + 1];
            cmd[0] = exe;
            System.arraycopy(args, 0, cmd, 1, args.length);
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            String out = new String(p.getInputStream().readAllBytes()).trim();
            if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                return null;
            }
            return p.exitValue() == 0 ? out : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** 手动跟随重定向（nodejs.org → CDN 302，HttpURLConnection 默认不跨主机跟随）下载到 dest。 */
    public static void httpDownload(String urlStr, File dest, int redirects) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setInstanceFollowRedirects(false);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(180000);
        conn.setRequestProperty("User-Agent", "sema-sdk");
        try {
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = conn.getHeaderField("Location");
                if (loc == null) throw new IOException("重定向缺 Location");
                if (redirects <= 0) throw new IOException("重定向过多");
                conn.disconnect();
                httpDownload(loc, dest, redirects - 1);
                return;
            }
            if (code != 200) throw new IOException("HTTP " + code + ": " + urlStr);
            try (var in = conn.getInputStream(); var out = new java.io.FileOutputStream(dest)) {
                in.transferTo(out);
            }
        } finally {
            conn.disconnect();
        }
    }

    /** 用系统 tar 解压 .tar.gz（mac/linux 自带），保留可执行位与符号链接。strip=剥离的顶层目录层数。 */
    public static void untarGz(File archive, File destDir, int strip) throws IOException {
        destDir.mkdirs();
        var cmd = new java.util.ArrayList<String>(
                java.util.List.of("tar", "xzf", archive.getAbsolutePath(), "-C", destDir.getAbsolutePath()));
        if (strip > 0) cmd.add("--strip-components=" + strip);
        try {
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            if (!p.waitFor(180, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                throw new IOException("tar 解压超时");
            }
            if (p.exitValue() != 0) throw new IOException("tar 解压失败（exit " + p.exitValue() + "）");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("tar 解压被中断", e);
        }
    }

    /** 纯 JVM 解压 zip（Windows 无 tar 兜底）。 */
    public static void unzip(File archive, File destDir) throws IOException {
        try (var zis = new ZipInputStream(new java.io.BufferedInputStream(new java.io.FileInputStream(archive)))) {
            java.util.zip.ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                File out = new File(destDir, entry.getName());
                if (!out.getCanonicalPath().startsWith(destDir.getCanonicalPath() + File.separator)) {
                    throw new IOException("zip 条目越界: " + entry.getName());
                }
                if (entry.isDirectory()) {
                    out.mkdirs();
                } else {
                    File parent = out.getParentFile();
                    if (parent != null) parent.mkdirs();
                    try (var fos = new java.io.FileOutputStream(out)) {
                        zis.transferTo(fos);
                    }
                }
            }
        }
    }

    /** macOS 去隔离，避免 Gatekeeper 拦下载来的二进制（只对我们下载的那份做，绝不碰系统二进制）。 */
    public static void dequarantine(File file) {
        if (!IS_MAC) return;
        try {
            new ProcessBuilder("xattr", "-dr", "com.apple.quarantine", file.getAbsolutePath())
                    .start().waitFor(10, TimeUnit.SECONDS);
        } catch (Exception ignored) {
        }
    }

    /** 递归删除目录（下载失败时清理半成品缓存）。 */
    public static void deleteRecursively(File root) {
        File[] files = root.listFiles();
        if (files != null) {
            for (File f : files) deleteRecursively(f);
        }
        root.delete();
    }
}

# PWHook Java 改造可行性评估

> 本文用于决策：是否值得把 PWHook 用 Java 重写。
> 当前实现：Python（注入器） + Node.js（劫持脚本 + HTTP/SSE 服务）。

---

## ❗ 关键前提：使用者完全不会 JS / Node

这是决策最重要的输入。在这个前提下，可以**直接砍掉一半的方案**，结论非常明确：

### 最终推荐：**维持现状 + 用 Java 写一个 HTTP 客户端 SDK**（0.5 - 1 天）

**理由**：

1. **Hook 脚本（`hook_source/*.js`）是"装好就别动"的基础设施**
   - 这套 JS 已经把所有劫持点封装好，对外只暴露 `127.0.0.1:28888` 的 REST + SSE 接口
   - 它内部用了多少 JS 闭包、`EventEmitter`、`Promise` 你都**完全不需要看懂**
   - 把它当成一个"黑盒微服务"即可——就像你不需要懂 Redis 是 C 写的也能用 Redis

2. **方案 A 看似只重写注入器，但实际仍然要碰 JS**
   - 注入器的核心动作是 `Runtime.evaluate('require("xxx.js")')`，**注入的内容本身就是 JS 字符串**
   - 平台升级 / IPC 通道变化时，要排查问题必须能读懂 `pw_hook_index.js`
   - 对完全不会 JS 的人来说，方案 A 的"省心"是个伪命题

3. **方案 B 更不可行**
   - 必须维护一段 70 行的 JS 桥接层，这部分**任何人都替不掉你**
   - 调试时要同时看 Java 日志 + JS 日志 + Electron IPC 流，对纯 Java 背景的人是地狱级难度
   - 等于花 1-2 周把"难懂的 Node 服务"换成"同样难懂的 JS 桥接 + 复杂的 Java 路由框架"

4. **实际的 Java 化收益，0.5 天就能拿到**
   - Java 端写 6 个方法包装现有 6 条 REST 接口（`get_user_match_history` 等）
   - 业务团队从此只用 Java，**完全感知不到底层是 Node**
   - 平台升级、新增路由这种"必须懂 JS"的活，让懂的人改一次（甚至直接让 AI 改），用例工 < 1 天

### 决策路径图

```
你完全不会 JS
   │
   ├─ 只想用 Java 业务代码调用 PWHook 能力？
   │     → ✅ 维持现状 + Java HTTP SDK（0.5-1 天）   ← 强烈推荐
   │
   ├─ 觉得 Python 注入器碍眼，想换成 Java 启动？
   │     → ⚠️ 方案 A，但仍然要面对 JS 注入字符串和 hook_source 目录
   │       建议直接写个 Java 包装：用 ProcessBuilder 调 `python main.py` 启动即可
   │       （5 分钟搞定，不用学 CDP）
   │
   ├─ 想让 Java 团队完全接管整套工具？
   │     → ❌ 不推荐。方案 B 必须有人懂 JS，强行上会变维护噩梦
   │
   └─ 老板要求"必须用 Java 重写"？
         → 如实汇报：Electron IPC 劫持的物理限制决定了至少 70 行 JS 必须保留
           不存在"纯 Java 实现"的技术路径
```

### 一份现成的"维持现状"工作流

```java
// 你只需要这样的 Java 代码，就能用上 PWHook 全部能力
@Service
public class PWHookClient {
    private final HttpClient http = HttpClient.newHttpClient();
    private final ObjectMapper json = new ObjectMapper();
    private static final String BASE = "http://127.0.0.1:28888";

    public JsonNode getMatchDetail(String matchId) throws Exception {
        return call("/api/call/get_match_detail", Map.of("match_id", matchId));
    }

    public JsonNode getUserMatchHistory(String uid, int page) throws Exception {
        return call("/api/call/get_user_match_history",
            Map.of("uid", uid, "page", String.valueOf(page), "page_size", "15"));
    }

    public JsonNode getCurrentSeason() throws Exception {
        return call("/api/call/get_current_season_info", Map.of());
    }

    private JsonNode call(String path, Map<String, ?> body) throws Exception {
        HttpResponse<String> resp = http.send(
            HttpRequest.newBuilder(URI.create(BASE + path))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
                .build(),
            HttpResponse.BodyHandlers.ofString());
        return json.readTree(resp.body()).path("data");
    }
}
```

**就这样，你的 Java 业务系统已经接入 PWHook 的全部能力。从此你不需要打开 `hook_source/` 任何一个 .js 文件。**

启动平台时，Python 那个 `main.py` 也不用学，每次手动跑一次 `python main.py` 即可（或者用 Java `ProcessBuilder` 起个子进程拉它）。

---

> 下面的章节是更全面的技术分析，**如果你已经决定走"维持现状 + Java SDK"，可以不用再看下去了**。下面的内容主要针对懂一些 JS / 需要技术评审的场景。

## 一、TL;DR 决策结论

| 你的诉求 | 推荐方案 | 工作量 | 是否需要保留 JS |
| --- | --- | --- | --- |
| 只想用 Java 调用 PWHook 的 API | **不重写**，Java 端写个 HTTP 客户端即可 | 0.5 天 | 全保留 |
| 想用 Java 替代 Python 注入器 | **方案 A：轻量改造** | 1-2 天 | 全保留 |
| 想让 Java 团队接管整套 Hook 维护 | **方案 B：深度改造** | 1-2 周 | 必须保留约 70 行 JS 桥接 |
| 完全消灭所有 JS 代码 | **不可行** | — | — |

**核心物理限制**：Electron 主进程的 `ipcMain.handle / on` 与 `webContents.send` 是 V8 堆里的 JS 对象引用，**只有运行在同一个 V8 上下文里的 JS 代码能改写它们**，Java 进程无论如何都拿不到调用现场。

## 二、各模块迁移可行性矩阵

| 当前模块 | 现有实现 | Java 替代 | 可行性 | 备注 |
| --- | --- | --- | --- | --- |
| 启动 .exe | `subprocess.Popen` | `ProcessBuilder` | ✅ 简单 | — |
| Windows UAC 提权 | `ctypes ShellExecuteW runas` | JNA 调 `Shell32.ShellExecuteW` | ✅ 简单 | 需引入 JNA |
| CDP HTTP 探活 | `urllib.request` → `/json/list` | JDK11+ `HttpClient` | ✅ 简单 | 零依赖 |
| CDP WebSocket | `websockets` lib | `Java-WebSocket` 或 JDK11+ `HttpClient.newWebSocketBuilder()` | ✅ 简单 | — |
| `Runtime.evaluate` 注入 | 拼 JSON + 发 frame | 同样拼 JSON + 发 frame | ✅ 简单 | 注入的 expression 仍然必须是 JS |
| HTTP 服务（28888） | Node `http` | Javalin / Spring Boot WebFlux / Undertow | ✅ 简单 | 推荐 Javalin（极轻量）|
| SSE 推送 | 手写 `text/event-stream` | Javalin `SseClient` / Spring `SseEmitter` | ✅ 简单 | — |
| ROUTE_MAPPING | JS 对象 + 闭包 | `Map<String, Route>` + 函数式接口 / 注解扫描 | ✅ 中等 | 可用 Spring 注解风格做得更优雅 |
| EventBus | Node `EventEmitter` | Guava `EventBus` / Reactor Sinks | ✅ 中等 | — |
| `waitFor` 排队 + 超时 | `setTimeout` + Promise | `CompletableFuture.orTimeout` + `ScheduledExecutorService` | ✅ 中等 | — |
| 拦截决策超时回退 | `setTimeout` + 兜底 | 同上 | ✅ 中等 | — |
| **`ipcMain.handle/on` 劫持** | **运行时改写 V8 对象** | **❌ 无法用 Java 实现** | ⚠️ 必须保留 JS | **核心限制** |
| **`webContents.send` 劫持** | 同上 | 同上 | ⚠️ 必须保留 JS | 同上 |
| `console.*` 日志桥接 | 重定义 console | 必须保留 JS | ⚠️ 同上 | — |

## 三、为什么 IPC 劫持必须留在 JS 层

Electron 的 IPC 体系：

```
前端 (Renderer)  ─── ipcRenderer.invoke/send ───→  C++ 序列化  ───→  主进程 (Main)
                                                                       │
                                                                       ▼
                                                                  V8 解码
                                                                       │
                                                                       ▼
                                                            ipcMain.handle/on 闭包
```

PWHook 现在做的是：**在主进程 V8 堆里把 `ipcMain.handle` 这个函数引用替换成自己的 wrapper**，wrapper 里调用 `processExternalInterception` 决策后再转发给原 listener。

这件事有两个不可替代点：
1. `ipcMain` 是 Electron 提供的 JS 单例对象，**只暴露给 V8**，C++ 层和外部进程都拿不到
2. `webContents.send` 同理，每个 `BrowserWindow` 持有独立的 `webContents` 实例，劫持时机必须在 `web-contents-created` 回调里——这是个纯 JS 事件

**理论上的替代方案**（成本远高于保留 JS）：
- frida 二进制 Hook libnode.dll 的 V8 入口 → 拿到的是序列化后的 buffer，需要自己反序列化 Electron 内部协议
- DLL 注入 + Detours Hook IPC C++ 函数 → 同上，且每次 Electron 升版都要重新逆向
- 改 Electron 源码自己编一份 → 需要替换平台自己的 .exe，违背"动态注入"初衷

结论：**留 70 行 JS 桥接**是工程上唯一合理的选择。

## 四、方案 A：轻量改造（仅替换 main.py）

**改动范围**：只把 Python 注入器换成 Java，`hook_source/*.js` 100% 保留，HTTP/SSE 服务也仍跑在 Node 侧。

### 架构

```
┌─────────────────────────┐
│ Java: PWHookLauncher    │
│  • ProcessBuilder 启 exe│
│  • HttpClient 探 9230   │
│  • WebSocket 注入       │
│  • Runtime.evaluate     │
└──────────┬──────────────┘
           │ CDP
           ▼
┌─────────────────────────┐         ┌─────────────────────┐
│ 完美平台主进程            │  HTTP   │ 任意消费方            │
│  └ pw_hook_*.js（不动）  │ ←─────→ │ (Java/Python/curl)  │
│     • 28888 服务         │         └─────────────────────┘
└─────────────────────────┘
```

### Java 端依赖（最小化）

```xml
<!-- 仅需 2 个三方依赖 -->
<dependency>
  <groupId>org.java-websocket</groupId>
  <artifactId>Java-WebSocket</artifactId>
  <version>1.5.7</version>
</dependency>
<dependency>
  <groupId>com.fasterxml.jackson.core</groupId>
  <artifactId>jackson-databind</artifactId>
</dependency>
<!-- HTTP 客户端用 JDK11+ 内置的 java.net.http.HttpClient，零依赖 -->
<!-- UAC 提权（可选）用 JNA -->
<dependency>
  <groupId>net.java.dev.jna</groupId>
  <artifactId>jna-platform</artifactId>
  <version>5.14.0</version>
</dependency>
```

### 核心代码骨架（约 100 行）

```java
public class PWHookLauncher {
    private static final String APP_EXE = "D:\\Applications\\PerfectWorld\\完美世界竞技平台.exe";
    private static final String HOOK_SCRIPT = "D:\\path\\to\\hook_source\\pw_hook_index.js";
    private static final int DEBUG_PORT = 9230;

    public static void main(String[] args) throws Exception {
        // 1. 启 .exe
        new ProcessBuilder(APP_EXE, "--inspect=" + DEBUG_PORT)
            .redirectErrorStream(true)
            .start();

        // 2. HTTP 探 /json/list
        HttpClient http = HttpClient.newHttpClient();
        HttpResponse<String> resp = http.send(
            HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + DEBUG_PORT + "/json/list")).build(),
            HttpResponse.BodyHandlers.ofString()
        );
        JsonNode list = new ObjectMapper().readTree(resp.body());
        String wsUrl = StreamSupport.stream(list.spliterator(), false)
            .filter(n -> "node".equals(n.path("type").asText()))
            .findFirst().orElse(list.get(0))
            .path("webSocketDebuggerUrl").asText();

        // 3. WebSocket 注入
        String jsPath = HOOK_SCRIPT.replace("\\", "/");
        String expression = "(async () => { try { require('" + jsPath + "'); return 'OK'; } catch(e) { return 'ERR:' + e.stack; } })()";
        String payload = """
            {"id":1,"method":"Runtime.evaluate","params":{
              "expression": %s, "returnByValue": true, "awaitPromise": true
            }}""".formatted(new ObjectMapper().writeValueAsString(expression));

        WebSocketClient client = new WebSocketClient(URI.create(wsUrl)) {
            @Override public void onOpen(ServerHandshake h) { send(payload); }
            @Override public void onMessage(String msg) { System.out.println("[CDP] " + msg); close(); }
            @Override public void onClose(int c, String r, boolean b) {}
            @Override public void onError(Exception e) { e.printStackTrace(); }
        };
        client.connectBlocking();
    }
}
```

### 优劣
- ✅ 工作量极小（1-2 天，含调试）
- ✅ 风险最低，JS 侧 0 改动
- ✅ 能集成进 Java 项目（Spring Boot 启动时自动拉起平台 + 注入）
- ❌ 业务路由仍写在 JS 里，Java 团队改业务还得碰 JS
- ❌ 28888 端口仍属 Node 进程，Java 端只能当客户端

**适用场景**：你只想用 Java 替代 Python 当"启动器"，业务能力维护仍由懂 JS 的人负责。

## 五、方案 B：深度改造（HTTP 服务+路由+拦截搬到 Java）

**改动范围**：JS 只保留极薄的"事件捕获 + 桥接转发"层，HTTP/SSE 服务、ROUTE_MAPPING、拦截决策、`waitFor` 排队全部用 Java 实现。

### 架构

```
┌────────────────────────────────────────────────────┐
│ Java 进程（Spring Boot / Javalin）                  │
│ ┌────────────────┐  ┌─────────────────────────┐   │
│ │ PWHookLauncher │  │ 28888 HTTP + SSE Server │   │
│ └────────────────┘  └────────────┬────────────┘   │
│                                  │                 │
│ ┌──────────────────────────────────────────────┐  │
│ │ RouteRegistry (Map<String, RouteDefinition>) │  │
│ │  • search_friend  → COMMON_IM_MT_SEARCH_...  │  │
│ │  • get_match_detail → CSGO_GET_REPORT_...    │  │
│ └──────────────────────────────────────────────┘  │
│                                                    │
│ ┌──────────────────────────────────────────────┐  │
│ │ InterceptManager                              │  │
│ │  ConcurrentHashMap<eventId, CompletableFuture>│  │
│ │  + ScheduledExecutorService 超时              │  │
│ └──────────────────────────────────────────────┘  │
│                                                    │
│ ┌──────────────────────────────────────────────┐  │
│ │ WaitForQueue (FIFO per channel)               │  │
│ └──────────────────────────────────────────────┘  │
└─────┬──────────────────────────────────────┬──────┘
      │                                      │
      │ 本地 WebSocket (双向)                 │
      ▼                                      ▼
┌──────────────────────────────────────────────────┐
│ 完美平台主进程                                     │
│  └ pw_hook_bridge.js（精简版，约 70 行）           │
│     • 劫持 ipcMain.handle/on                      │
│     • 劫持 webContents.send                       │
│     • 通过 WS 推 IPC 事件给 Java                  │
│     • 等 Java 回 allow/block/modify 决策          │
└──────────────────────────────────────────────────┘
```

### JS 桥接层职责（不可削减的最小集）

```js
// pw_hook_bridge.js  （示意）
const ws = new WebSocket("ws://127.0.0.1:28889/bridge");
const pendings = new Map();  // localId → resolve

const ask = (event) => new Promise((resolve) => {
    const localId = ++seq;
    pendings.set(localId, resolve);
    ws.send(JSON.stringify({ type: "intercept", localId, ...event }));
    setTimeout(() => { if (pendings.has(localId)) { pendings.delete(localId); resolve({action:"allow"}); } }, 1500);
});

ws.onmessage = (msg) => {
    const m = JSON.parse(msg.data);
    if (m.type === "decision") pendings.get(m.localId)?.(m);
    if (m.type === "call") electron.ipcMain.emit(m.channel, fakeEvent, m.payload); // Java 主动调用
};

// 劫持点（同现有实现，但 wrapper 里把决策委托给 Java）
electron.ipcMain.handle = function(channel, listener) {
    return originalHandle.call(this, channel, async (event, ...args) => {
        const decision = await ask({ direction: "upstream", channel, payload: args[0] });
        if (decision.action === "block") return undefined;
        if (decision.action === "modify") args[0] = decision.payload;
        return listener(event, ...args);
    });
};
// webContents.send 同理
```

约 70-100 行，**无业务逻辑**，仅做"捕获 → 问 Java → 执行决策"。

### Java 端关键设计点

1. **双向通信用 WebSocket，不用 HTTP**：拦截决策对延迟敏感（默认 1.5s 超时），HTTP 同步阻塞会拖慢平台 UI
2. **决策超时必须 < JS 侧兜底超时**：Java 端 `CompletableFuture.orTimeout(1200, MS)`，JS 端兜底 1500ms
3. **`waitFor` 排队**：用 `ConcurrentHashMap<String, ConcurrentLinkedQueue<CompletableFuture<JsonNode>>>`，下行事件到达时 `poll()` 出最旧的 future 完成
4. **信封剥壳**：在 Java 的 `RouteDefinition.parseResponse` 里实现 `$$data$$` 自动解包
5. **API 旁路标记**：Java 主动调用走 `type: "call"` 消息，桥接层不再走 `ask()`，等价于现有 `__pw_hook_api_bypass__`
6. **业务路由用 Spring 注解**（可选）：

```java
@PWRoute(name = "get_match_detail", channel = "CSGO_GET_REPORT_DETAIL_REQ")
public class GetMatchDetailRoute implements Route {
    @Param(desc = "比赛对局ID") String matchId;

    @Override public Object[] buildArgs() {
        return new Object[] { Map.of(
            "$$key$$", Math.random(),
            "$$data$$", Map.of("match_id", matchId),
            "$$name$$", "hs"
        )};
    }
}
```

### 优劣
- ✅ 业务路由全部 Java，符合 Java 团队工作流
- ✅ 可接 Java 监控/日志/配置中心（Nacos / Apollo / SLS）
- ✅ Spring Boot 生态加持（`@Scheduled` 定时任务、`@ConditionalOnProperty` 灰度等）
- ❌ 工作量大（1-2 周），需要重新设计 + 调试桥接协议
- ❌ 多了一层进程间通信，**拦截链路延迟增加 5-20ms**（本地 WS 往返）
- ❌ 仍然需要维护 70 行 JS（且这部分团队必须有人会 JS 调试）
- ⚠️ 调试链路变长：问题排查要同时看 Java 日志 + JS 日志 + 平台 IPC 流

**适用场景**：长期由 Java 团队维护，且业务路由会持续大量新增（>50 条）。

## 六、决策辅助清单

按以下问题逐项打分，决定走哪条路：

| 问题 | 是 | 否 |
| --- | --- | --- |
| 团队中是否完全没人会 JS / Node 调试？ | A 不够（仍要碰 JS）/ B 也省不掉 | 维持现状或方案 A 即可 |
| 业务路由是否预计 6 个月内会新增 30+ 条？ | 倾向 B | 倾向 A 或维持现状 |
| 是否需要把 PWHook 接入现有 Java 系统（如 Spring Boot 微服务）？ | A 即可 | 维持现状 |
| 拦截决策延迟是否敏感（< 100ms）？ | 警惕 B（会增加 5-20ms） | 任意方案均可 |
| 是否需要复用 Java 生态（监控、配置中心、注解、IoC）？ | 倾向 B | 倾向 A |
| Python 是否在团队里属于"少数语言"？ | A 即可解决 | 维持现状 |
| 平台版本升级时，谁来跟进 IPC 通道变化？ | 不影响选型（业务在哪边都要跟） | — |

**经验建议**：
- 如果只是"Python 这门语言团队不熟"，**选方案 A**，性价比最高
- 如果是"想用 Java 重写整个工具"，先想清楚为什么——通常 **方案 A + 用 Java 客户端调 28888 接口** 已经能满足 90% 的诉求
- 真正适合方案 B 的场景很少（除非要做一个团队级的 IPC 中间人平台，PWHook 只是其中一个采集器）

## 七、不推荐的反模式

- ❌ **用 Java 直接通过 CDP 操作 IPC**：CDP 没有 ipcMain 操作能力，只能 evaluate JS，等价于绕一圈还是写 JS
- ❌ **用 frida-java 替换 JS 桥接**：Electron 内部 IPC 序列化协议不公开，逆向成本极高且每次 Electron 升级都可能破
- ❌ **把劫持逻辑写在前端 Renderer**：抓不到主进程内部直接 emit 的事件，且只能改自己窗口的 IPC
- ❌ **改 Electron 源码自编**：违背"动态注入不修改平台二进制"的初衷，也无法应对平台自动更新

## 八、最终建议

> **如果你的核心动机是"团队不熟悉 Python/Node"** → 走 **方案 A**，1-2 天搞定，零业务风险。
>
> **如果是"想要 Java 全家桶维护"** → 走 **方案 B**，但要接受 1-2 周投入 + 必须保留 JS 桥接 + 链路延迟略增。
>
> **如果只是"用 Java 调 PWHook"** → **完全不用重写**，Java 直接当 28888 的 HTTP 客户端即可，0.5 天写个 SDK 就完事。

---

## 九、针对"完全不会 JS"的最终决策（重申）

回到文档开头的关键前提：**使用者完全不会 JS，是 Java 背景**。

那么上面所有"方案 A vs 方案 B"的纠结都不存在，结论只有一个：

| 项 | 推荐做法 |
| --- | --- |
| **业务接入** | Java 写 HTTP 客户端调 `127.0.0.1:28888`，把 6 条战绩接口包成 Service 方法 |
| **平台启动** | 沿用 `python main.py`，或用 Java `ProcessBuilder` 包一层（5 分钟工作量）|
| **Hook 脚本** | **不要碰**。当成黑盒微服务 |
| **平台升版导致 Hook 失效时** | 找懂 JS 的人改 / 让 AI 改 / 提 issue，不要自己硬啃 |
| **想加新业务路由** | 同上，让别人在 `pw_hook_router.js` 的 `ROUTE_MAPPING` 加一项即可 |

### 为什么不推荐你折腾方案 A/B

- **方案 A**：替换 Python 注入器，但注入器本质是"在远程 V8 里执行一段 JS"，你绕不开 JS
- **方案 B**：1-2 周时间 + 必须维护 70 行 JS 桥接 + 调试要看三种语言日志，对纯 Java 背景是负收益

### 你真正应该投入时间的地方

1. **Java SDK 封装**：把 6 条 REST 接口封装成强类型方法 + DTO（半天）
2. **业务上层逻辑**：基于 SDK 实现你真正想做的功能，比如战绩查询服务、定时拉取、数据持久化（这才是 Java 团队的主场）
3. **可选：Spring Boot 健康检查**：检测 28888 端口是否存活，断了就 `ProcessBuilder` 重启 `python main.py`

把"PWHook 是怎么劫持 Electron 的"这个问题完全交给现有 JS 代码去解决，**你只需要相信它在 28888 端口提供了一组 REST 接口**，剩下的全是 Java 主场。

需要我直接帮你把这个 Java SDK 写出来吗？

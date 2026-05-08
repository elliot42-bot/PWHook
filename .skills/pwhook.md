# PWHook Skill

## 一句话定位

PWHook 是一个针对 **完美世界竞技平台 Electron 客户端** 的 IPC 劫持/Mock 工具：通过 Node `--inspect` + CDP 把 Hook 脚本热注入到目标主进程，在 `127.0.0.1:28888` 暴露一套 HTTP + SSE API，对外提供 **主动调用 / 被动监听 / 拦截改包 / 伪造下行通知** 四大能力。

## 工程结构

```
PWHook-1/
├── main.py                       # 注入器：启动 .exe + CDP 注入 hook
├── test_external_client.py       # 外部消费端示例（订阅 + 拦截 + 主动调用）
├── pyproject.toml                # 依赖：python>=3.13, websockets>=16
└── hook_source/
    ├── pw_hook_index.js          # 劫持入口：劫持 console / ipcMain.handle / on / webContents.send
    ├── pw_hook_router.js         # HTTP 路由 + 业务路由表 ROUTE_MAPPING
    ├── pw_hook_server.js         # HTTP(28888) + SSE 服务（/api/events/stream、/api/log/stream）
    ├── pw_hook_store.js          # 状态中枢：函数表 / 订阅 / 拦截队列 / EventBus
    └── frontend/                 # 注入后弹出的 PW Hook Console 窗口
        ├── index.html
        ├── main.js
        └── style.css
```

## 注入原理（main.py）

1. `subprocess.Popen(完美世界竞技平台.exe --inspect=9230)` 拉起目标进程
2. 轮询 `http://127.0.0.1:9230/json/list`，找 `type==node` 的 `webSocketDebuggerUrl`
3. 通过 CDP `Runtime.evaluate` 在主进程里 `require('hook_source/pw_hook_index.js')`，完成热挂载
4. **注意**：原本对 `WinError 740`（需要管理员）会自动 `ShellExecuteW runas` 提权，现已注释掉，需要管理员请手动以管理员身份运行 Python 脚本
5. **注意**：`main.py` 文件首行带 BOM (U+FEFF)，Windows 下能跑，mac/Linux 下用 `python3` 直接跑会报语法错

## 劫持点（pw_hook_index.js）

- `electron.ipcMain.handle / on` → 包装 listener，捕获**上行**（前端→主进程），走 `processExternalInterception`
- 每个 `webContents.send` → 包装，捕获**下行**（主进程→前端），同步通过内部 `EventBus` 广播（供 `waitFor` 路由匹配响应）
- `console.*` → 同步原生输出 + SSE 日志流广播
- 兼容**注入前已挂载**：先扫描 `ipcMain.eventNames()` + `_invokeHandlers`，再覆盖 `handle/on` 方法
- **API 旁路标记 `__pw_hook_api_bypass__`**：API 主动发起的请求/通知会带这个隐藏字段，劫持层识别后跳过外部拦截链，避免自循环

## HTTP API（基址 `http://127.0.0.1:28888`）

| 接口 | 方法 | 用途 |
| --- | --- | --- |
| `/api/list` | GET | 列出所有可调用路由名 |
| `/api/docs` | GET | 完整路由文档（自动从 ROUTE_MAPPING 生成）|
| `/api/subscriptions` | GET/POST | 查询/设置上下行 forward + intercept 通道 |
| `/api/subscriptions/clear` | POST | 清空订阅 |
| `/api/intercepts/respond` | POST | 对拦截事件返回 `allow`/`block`/`modify` 决策 |
| `/api/notify/send` | POST | 主动给前端发伪造下行通知（不进自己的拦截链）|
| `/api/call/<route>` | POST | 调用 ROUTE_MAPPING 里已封装的业务路由 |
| `/api/events/stream` | GET (SSE) | 单连接事件流：system/notify/intercept_request/intercept_result |
| `/api/log/stream` | GET (SSE) | 多连接日志流 |

### 统一响应格式

```json
{ "ok": true|false, "timestamp": "ISO", "data": {...}|null, "error": null|{code,message} }
```

### 三种调用模式（在 ROUTE_MAPPING 中通过字段控制）

- `request_response`（默认）：`await targetFunc(...)` 直接拿返回
- `wait_event`（设 `waitFor: "XXX_RES"`）：发完上行后挂起，等指定下行通道（FIFO 排队，2s 超时）
- `fire_and_forget`（设 `nowait: true`）：发完即返回 `{fired: true}`

## 当前已保留的业务路由（精简后 6 条）

> 已按需求把其他无用路由用 `/* ... */` 注释，仅保留战绩查询相关 + 必要前置。

- `login` — 伪触发 `check-loginFromSteam`，写入 `global.user.{id,token,login_method}`（fire-and-forget）
- `get_current_user_info` — 内部直接返回 `global.user`
- `get_current_season_info` — 通道 `COMMON_GET_SEASON_DESC_REQ`
- `get_user_match_history` — 通道 `CSGO_OVERVIEW_GET_MATCH_LIST_REQ`，比赛历史列表
- `get_user_match_calendar` — 通道 `CSGO_OVERVIEW_GET_DAILY_STATS_REQ`，每日统计
- `get_match_detail` — 通道 `CSGO_GET_REPORT_DETAIL_REQ`，赛后详情（用 `$$key$$/$$data$$/$$name$$` 信封封装）

> 已注释（仍在文件中，需要时取消注释即可恢复）：`search_friend / add_friend / get_friend_list / send_friend_msg / create_ladder_team / leave_ladder_team / send_team_msg / get_match_zone / get_user_comment_list / save_reaction_result / get_user_season_stats`

## SSE 事件结构

```json
{
  "eventId": "evt_<ts>_<seq>",
  "type": "system|notify|intercept_request|intercept_result",
  "channel": "<内部通道名>",
  "direction": "upstream|downstream|internal",
  "timestamp": "ISO",
  "payload": {},
  "rawArgs": [],
  "meta": {}
}
```

## 典型使用流程

### 1. 仅观测某通道
```
POST /api/subscriptions  { upstream:{forwardChannels:["X"]}, downstream:{forwardChannels:["Y"]} }
GET  /api/events/stream  → 收 type=notify
```

### 2. 拦截改包
```
POST /api/subscriptions  { upstream:{interceptChannels:["X"]}, timeoutMs:1500, onTimeout:"allow" }
GET  /api/events/stream  → 收 type=intercept_request, eventId=evt_xxx
POST /api/intercepts/respond { eventId, action:"modify", payload:{...} }
                              # action ∈ allow/block/modify
                              # upstream modify 替换 args[0]，downstream modify 替换 send 的第一个 payload
```

### 3. 主动伪造下行
```
POST /api/notify/send  { channel:"STEAM_STEAM_UPDATE_NOTIFY", payload:{...} }
                       # 不会触发自己的订阅/拦截
```

### 4. 战绩查询完整链（精简后场景）
```
1) main.py 注入 → 平台正常登录后
2) GET  /api/call/get_current_user_info        → 拿到 uid
3) POST /api/call/get_current_season_info {}    → 拿到当前赛季
4) POST /api/call/get_user_match_history { uid, page:"1", page_size:"15", game_types:"10,12,14,..." }
5) POST /api/call/get_match_detail { match_id }
6) POST /api/call/get_user_match_calendar { uid, start_time, end_time }
```

## 关键设计要点（修改/扩展时务必注意）

- **新增路由**：在 `pw_hook_router.js` 的 `ROUTE_MAPPING` 加一项即可，必须包含 `description / channel / params / buildArgs`，按需加 `waitFor / nowait / parseResponse`；`/api/list` 与 `/api/docs` 自动同步
- **`buildArgs` 必须返回数组**：等同于 IPC 调用的 `args`，第一个元素若是对象会被自动注入 `__pw_hook_api_bypass__` 防自循环
- **信封路由**：部分通道（如 `CSGO_EMIT_GET_NETWORK_SPEED`、`CSGO_OVERVIEW_GET_SEASON_STATS_REQ`、`CSGO_GET_REPORT_DETAIL_REQ` 等）需用 `$$key$$/$$data$$/$$name$$:"hs"` 信封封装；返回值若含 `$$data$$` 会被 router 自动剥壳
- **`waitFor` 排队机制**：同一响应通道的多并发请求走 FIFO 队列 + 单次 `bus.on` 注册，避免重复监听泄漏；超时返回 `{ error: "等待事件 X 超时（2秒）" }`
- **拦截超时兜底**：`createPendingIntercept` 内置 `timeoutMs` 定时器，外部不响应按 `onTimeout`(`allow|block|modify`) 走，不会卡死平台
- **单事件流客户端**：`/api/events/stream` 只允许一个活跃连接（新顶旧），`/api/log/stream` 允许多连接
- **请求体 2MB 上限**：超出会 `req.destroy()`
- **依赖**：Python 3.13+、`websockets>=16`；Node 侧仅用 Electron 内置模块

## 排查清单

- 注入失败 → 检查 `9230` 端口是否被占用、平台是否真的带 `--inspect` 启动、是否需要管理员权限
- `/api/call/xxx` 返回 `TARGET_NOT_REGISTERED` → 平台尚未注册该 channel（先在前端触发一次让 `ipcMain.handle/on` 跑过）或通道名拼错
- `waitFor` 超时 → 平台未推送对应响应通道，或前端连接断开导致 `webContents.send` 没触发
- 主动调用又被自己拦截 → 检查 `buildArgs` 第一个参数是否为对象（否则注入不上 `__pw_hook_api_bypass__`）

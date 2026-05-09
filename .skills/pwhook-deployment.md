# PWHook 战绩系统部署架构

## 业务目标

提供一个公网可访问的网页（或机器人），展示完美世界竞技平台天梯/自定义比赛数据汇总（平均 KD、Rating、胜率等）。

## 核心矛盾

- **PWHook** 必须和完美平台客户端跑在同一台 Windows 本地机器上（寄生式注入）
- **网页** 需要部署在公网服务器上供他人访问

## 解法：本地采集 + 云端展示（推拉分离）

```
┌─ 本地（Windows）─────────────┐     HTTPS      ┌─ 云服务器 ──────────────────────┐
│                              │               │                                  │
│  完美平台.exe (登录中)        │               │  Web 服务端                       │
│       ↑ CDP 注入             │               │  ├── /api/internal/sync  ← 收数据│
│  python main.py              │               │  ├── /api/players       → 给前端 │
│       ↓                      │               │  ├── /api/matches       → 给前端 │
│  PWHook 28888 (127.0.0.1)    │               │  ├── /api/leaderboard   → 给前端 │
│       ↓                      │               │  └── DB (MySQL/SQLite)           │
│  采集脚本（Python）          ──── POST ──────→│                                  │
│  • 定时拉 15~20 人比赛数据    │               │  前端页面                         │
│  • 解析 + 打包               │               │  • 所有人可访问                    │
│  • 推到云端                  │               │                                  │
└──────────────────────────────┘               └──────────────────────────────────┘
```

## 各层职责

### 本地层（Windows 机器）

| 组件 | 职责 | 运行方式 |
| --- | --- | --- |
| 完美平台 .exe | 提供 IPC 通道（数据来源） | 正常登录，保持运行 |
| python main.py | CDP 注入 hook 脚本 | 启动一次即可 |
| PWHook (28888) | 劫持 IPC，暴露 REST API | 注入后自动常驻，随平台生死 |
| 采集脚本（Python） | 循环拉 15~20 人比赛数据，POST 到云端 | 常驻后台 |

### 云端层（服务器）

| 组件 | 职责 |
| --- | --- |
| Web 服务端 | 接收采集数据、存库、提供查询 API |
| 数据库 | 持久化比赛记录 + 玩家统计 |
| 前端页面 | 展示排行榜、比赛详情、玩家数据 |
| 机器人接入（可选） | webhook 推送查询结果 |

## 数据流

```
1. 采集程序 → PWHook: POST /api/call/get_user_match_history → 拿比赛列表
2. 采集程序 → PWHook: POST /api/call/get_match_detail       → 拿每场详情
3. 采集程序 → 云端:   POST /api/internal/sync-matches       → 推送原始数据
4. 云端服务 → 解析 kills/deaths/assists/rating → 存 DB
5. 云端服务 → 聚合计算 avg_kd / win_rate 等 → 更新玩家统计表
6. 前端页面 → 云端 API: GET /api/leaderboard 等 → 展示
```

## 数据模型（5 张表）

> 注：match_player 中的具体战绩字段（如 kills/deaths/rating 等）需等 `get_match_detail` 真实返回后最终确认，
> 下方列出的是基于完美平台 CS2 通用数据模型的合理预期字段，标注 `(*)` 的字段待真实数据验证。

```
player (玩家表)
├── uid               VARCHAR PK    -- Steam ID，全局唯一
├── nickname          VARCHAR       -- 昵称（取最近一次比赛中的值）
├── is_tracked        BOOLEAN       -- 是否为团队跟踪的玩家（15~20 人标记为 true）
├── first_seen        DATETIME      -- 首次出现时间
├── last_seen         DATETIME      -- 最后活跃时间
└── created_at        DATETIME

match (比赛表)
├── match_id          VARCHAR PK    -- 平台返回的比赛 ID（类型待真实数据确认）
├── game_type         INT           -- 比赛类型码（已知码表见下方 game_type 说明）
├── map_name          VARCHAR       -- 地图名
├── played_at         DATETIME      -- 比赛时间
├── duration_seconds  INT (*)       -- 比赛时长
├── team1_score       INT
├── team2_score       INT
├── season            VARCHAR       -- 所属赛季（如 S23）
├── raw_json          JSON/TEXT     -- 原始 get_match_detail 响应完整备份（兜底回溯用）
├── synced_at         DATETIME      -- 采集入库时间
└── created_at        DATETIME

match_player (比赛玩家明细)
├── id                BIGINT PK AUTO
├── match_id          VARCHAR FK → match
├── uid               VARCHAR FK → player  -- 账号 uid（登录的号）
├── actual_player_uid VARCHAR FK → player  -- 实际操作者 uid（默认 = uid，借号时填真实玩家）
├── is_verified       BOOLEAN DEFAULT false -- 是否已人工确认过操作者身份
├── nickname          VARCHAR       -- 本场使用的昵称
├── team              INT           -- 1 or 2
├── kills             INT (*)
├── deaths            INT (*)
├── assists           INT (*)
├── mvp               TINYINT (*)   -- MVP 次数
├── headshot_count    INT (*)       -- 爆头数
├── headshot_rate     DECIMAL(5,2) (*)
├── rating            DECIMAL(5,2) (*)
├── adr               DECIMAL(6,2) (*)  -- 场均伤害
├── score             INT (*)       -- 得分
├── first_kill        INT (*)       -- 首杀数
├── is_win            BOOLEAN
├── created_at        DATETIME
└── UNIQUE(match_id, uid)

player_season_stats (玩家赛季+类型维度统计 - 按 actual_player_uid 聚合)
├── id                BIGINT PK AUTO
├── uid               VARCHAR FK → player  -- 这里存的是 actual_player_uid，即真实操作者
├── season            VARCHAR       -- S23, S24 等
├── game_type_group   VARCHAR       -- 'ladder' / 'custom'（按 game_type 归类）
├── total_matches     INT
├── total_wins        INT
├── total_kills       INT
├── total_deaths      INT
├── total_assists     INT
├── avg_kd            DECIMAL(5,2)  -- total_kills / total_deaths
├── avg_rating        DECIMAL(5,2)
├── avg_adr           DECIMAL(6,2)
├── win_rate          DECIMAL(5,2)  -- total_wins / total_matches
├── best_rating       DECIMAL(5,2)  -- 单场最高 rating
├── last_updated      DATETIME
└── UNIQUE(uid, season, game_type_group)

sync_log (采集日志)
├── id                BIGINT PK AUTO
├── sync_type         VARCHAR       -- full / incremental
├── target_uid        VARCHAR       -- 本次采集的目标玩家 uid
├── matches_found     INT           -- 平台返回的比赛数
├── matches_new       INT           -- 实际新增入库的比赛数（去重后）
├── status            VARCHAR       -- success / partial / failed
├── error_message     TEXT          -- 失败时的错误信息
├── started_at        DATETIME
└── finished_at       DATETIME
```

### game_type 已知信息

代码中 `get_user_match_history` 接口的 `game_types` 默认值为 `"10,12,14,16,27,20,33,40,41,44,51"`，共 11 个类型码。

**各码的含义目前未知**，需要实际调用接口后，根据返回数据中的比赛类型名称来确认每个码对应什么（天梯 5v5、自定义 5v5、巅峰赛等），届时需要：

1. 建立 game_type → game_type_group 的映射（如：码 10 → ladder，码 XX → custom）
2. 该映射可以硬编码在采集脚本或云端服务中，无需单独建字典表（类型码数量固定且少）

## 前端页面规划（4 个页面）

```
/                   → Dashboard（总比赛数、最近比赛、活跃玩家）
/leaderboard        → 排行榜（KD / Rating / 胜率排序切换）
/players/:uid       → 玩家详情（KD 趋势图、最近比赛、擅长地图）
/matches/:matchId   → 比赛详情（双方阵容、每人 KDA、MVP）
```

## 云端 API 设计

```
# 内部接口（采集程序调用，需鉴权）
POST /api/internal/sync-matches          ← 批量推送比赛数据

# 管理接口（标记借号等，需鉴权）
PUT  /api/admin/matches/{matchId}/players/{uid}/actual-player  ← 修改某场比赛某账号的实际操作者
POST /api/admin/stats/recalculate        ← 触发重新聚合统计（修改 actual_player_uid 后）

# 对外接口（前端/机器人调用）
GET  /api/players                        → 玩家列表 + 汇总统计（按真实操作者聚合）
GET  /api/players/{uid}/matches          → 某玩家的比赛记录（按 actual_player_uid 查询）
GET  /api/matches/{matchId}              → 某场比赛详情
GET  /api/leaderboard?sort=avg_kd&type=ladder  → 排行榜（支持按天梯/自定义筛选）
GET  /api/stats/overview                 → 全局概览
```

## 开发路径

| 阶段 | 做什么 | 预估 |
| --- | --- | --- |
| P0 | 服务端 + DB 建表 + PWHook 客户端封装 + 定时采集 | 2-3 天 |
| P1 | REST API + 简单页面（能看到数据） | 1-2 天 |
| P2 | KD/Rating/胜率聚合 + 排行榜 | 1 天 |
| P3 | 前端美化（图表、趋势图） | 2-3 天 |
| P4 | 机器人接入（可选） | 1-2 天 |

## 技术选型

### 已确定

| 工程 | 部署位置 | 语言 | 定位 |
| --- | --- | --- | --- |
| **PWHook** | 本地 Windows | Python + JS | 已有，不动。劫持完美平台，暴露 28888 |
| **采集脚本** | 本地 Windows | **Python** | 一个文件，复用本地 Python 环境，定时调 28888 → POST 推到云端 |
| **云端展示系统** | 云服务器 | **待定** | 主战场：接收数据、存库、展示网页/排行榜 |

### 云端展示系统选型对比（待定）

| 方案 | 后端 | 前端 | 优势 | 劣势 |
| --- | --- | --- | --- | --- |
| Spring Boot + Thymeleaf | Java | 模板引擎 | Java 主场，零前端构建 | UI 不够现代 |
| Spring Boot + Vue3 | Java | Vue + Element Plus | Java 主场 + 好看 UI | 需要前端构建 |
| Next.js (TypeScript) | TS | React (内置) | 全栈统一语言，开发最快 | 需要学 TS/React |
| Python FastAPI + Jinja2 | Python | 模板引擎 | 轻量快速 | 非 Java |
| Go Gin + Vue | Go | Vue | 性能好 | 需要学 Go |

## 关键约束

- PWHook (28888) 永远不暴露公网，只在 127.0.0.1
- 本地关机 = 暂停采集，但云端网页和历史数据不受影响
- 云端 /api/internal/sync 接口必须加鉴权（API Key / Token），防止伪造数据
- get_match_detail 的返回结构需要实际调一次确认字段（影响 match_player 表设计）
- 拉取策略：拉指定 15~20 人的比赛数据，采集脚本维护一份 uid 列表，循环调用 get_user_match_history

## 业务场景补充

### 使用模式

- **用户群体**：本人 + 朋友，小团队使用
- **比赛类型**：天梯 + 自定义，需分别记录、分别统计
- **数据归属**：需要跟踪多个玩家的数据（不只是自己）

### 天梯 vs 自定义的区分要求

| 维度 | 天梯 | 自定义 |
|------|------|--------|
| 对手 | 随机匹配 | 可能是朋友（内战） |
| 分析意义 | KD/Rating/胜率反映真实水平 | 偏娱乐，内战数据有参考价值 |
| game_type | 已知码表中的部分码（具体哪些码对应天梯需真实数据确认） | 已知码表中的另一部分码（需真实数据确认） |
| 排行榜 | 适合做正式排行 | 内战趣味榜 |

### 借号/代打场景

团队成员之间存在互相借号的情况（如玩家 B 用 A 的账号打了几场），导致账号维度的战绩不等于真人维度的战绩。

**核心原则**：统计和排行必须按"真实操作者"聚合，而不是按"账号"聚合。

**解决方案：手动标记实际操作者**

- `match_player` 表中 `actual_player_uid` 默认等于 `uid`（即默认自己在打）
- 发现借号场次时，通过管理页面将 `actual_player_uid` 改为真实操作者的 uid，并标记 `is_verified = true`
- `player_season_stats` 的聚合全部按 `actual_player_uid` 而非 `uid` 计算
- 前端可展示"未确认"的比赛条目，提醒管理员去核实

### 对表设计和功能的影响

1. `player_season_stats` 需要按 game_type 分组统计（天梯胜率 vs 自定义胜率分开）
2. player 表的 `is_tracked` 标记"我们圈子里的人"（15~20 人）
3. 前端排行榜需支持按天梯/自定义切换筛选
4. `match_player` 增加 `actual_player_uid` + `is_verified` 字段支持借号标记
5. 云端需提供管理接口修改 `actual_player_uid`（需鉴权）
6. 聚合统计重算时需以 `actual_player_uid` 为准

### 数据量预估

- **团队人数**：15~20 人
- 团队成员之间经常组队或内战，同一场比赛会出现在多个成员的 match_history 中
- 采集时按 match_id 去重，同一场比赛只入库一次
- **match 表**：实际独立比赛数远少于"人数 × 场数"，预估每天 10~30 场独立比赛，约 **4,000~11,000 场/年**
- **match_player 表**：每场 10 人明细，约 **40,000~110,000 条/年**
- **player_season_stats 表**：20 人 × 2 类型(ladder/custom) × 赛季数，极少量
- 这个量级 SQLite 完全扛得住，MySQL 更不在话下

### 待确认

- 自定义赛只记自己人还是对面也记
- 排行榜是混合排还是分开排
- `get_match_detail` / `get_user_match_history` 的真实返回 JSON（影响最终表结构）
- 借号标记的操作权限：所有团队成员都能标记，还是只有管理员能标记

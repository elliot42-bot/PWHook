const server = require("./pw_hook_server.js");
const store = require("./pw_hook_store.js");
const electron = require("electron");
const path = require("path");

const API_BYPASS_SYMBOL = "__pw_hook_api_bypass__";
const ACCOUNT_GUARD_ENABLED = process.env.PWHOOK_ACCOUNT_GUARD_ENABLED !== "0";
const ALLOWED_STEAM_IDS = new Set(
    String(process.env.PWHOOK_ALLOWED_STEAM_IDS || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
);
let accountGuardTriggered = false;
let pwHookDisabled = false;
let accountGuardPollTimer = null;
let consoleWindow = null;

const getWebContentsMeta = (wc) => {
    let windowTitle = "";
    let url = "";
    try {
        windowTitle = typeof wc.getTitle === "function" ? wc.getTitle() : "";
    } catch (_) {}
    try {
        url = typeof wc.getURL === "function" ? wc.getURL() : "";
    } catch (_) {}

    return {
        source: "webContents.send",
        webContentsId: wc.id,
        url,
        windowTitle,
    };
};

const logPayload = (prefix, payload) => {
    try {
        console.log(prefix, JSON.stringify(payload, null, 2));
    } catch (_) {
        console.log(prefix, payload);
    }
};

const normalizeSteamId = (value) => {
    if (value === undefined || value === null) {
        return "";
    }
    const normalized = String(value).trim();
    return /^\d{5,20}$/.test(normalized) ? normalized : "";
};

const isLoginAccountSource = (payload, source) => {
    if (String(source || "").startsWith("global.user")) {
        return true;
    }
    if (payload && typeof payload === "object" && payload.type === "logined") {
        return true;
    }
    return /check-loginFromSteam|login/i.test(String(source || ""));
};

const extractSteamIdFromPayload = (payload, source) => {
    if (!payload || typeof payload !== "object") {
        return "";
    }
    if (payload.type === "logout") {
        return "";
    }
    if (!isLoginAccountSource(payload, source)) {
        return "";
    }

    return normalizeSteamId(
        payload.uid ??
        payload.steamId ??
        payload.steamID ??
        payload.steam_id ??
        payload.id
    );
};

const shutdownForUnexpectedSteamId = (steamId, source) => {
    if (accountGuardTriggered) {
        return;
    }
    accountGuardTriggered = true;
    pwHookDisabled = true;

    console.error("============================================================");
    console.error(`[PW_HOOK][ACCOUNT_GUARD] 检测到非测试 SteamID 登录: ${steamId}`);
    console.error(`[PW_HOOK][ACCOUNT_GUARD] 来源: ${source}`);
    console.error(`[PW_HOOK][ACCOUNT_GUARD] 允许的 SteamID: ${Array.from(ALLOWED_STEAM_IDS).join(", ") || "(未配置)"}`);
    console.error("[PW_HOOK][ACCOUNT_GUARD] 即将停用 PWHook，完美客户端会继续运行。");
    console.error("============================================================");

    setTimeout(() => {
        try {
            if (accountGuardPollTimer) {
                clearInterval(accountGuardPollTimer);
                accountGuardPollTimer = null;
            }
        } catch (_) {}

        try {
            store.clearSubscriptions();
        } catch (_) {}

        try {
            server.stopServer();
        } catch (_) {}

        try {
            if (consoleWindow && !consoleWindow.isDestroyed()) {
                consoleWindow.close();
            }
        } catch (_) {}

        console.error("[PW_HOOK][ACCOUNT_GUARD] PWHook 已停用。本地 API 端口和控制台窗口已关闭。");
    }, 500);
};

const verifySteamIdAllowed = (steamId, source) => {
    if (!ACCOUNT_GUARD_ENABLED || !steamId) {
        return;
    }
    if (!ALLOWED_STEAM_IDS.has(steamId)) {
        shutdownForUnexpectedSteamId(steamId, source);
    }
};

const verifyPayloadAccount = (payload, source) => {
    verifySteamIdAllowed(extractSteamIdFromPayload(payload, source), source);
};

const verifyGlobalUserAccount = (source) => {
    try {
        verifyPayloadAccount(global.user, source);
    } catch (_) {}
};

const isApiBypassPayload = (payload) => {
    return !!(payload && typeof payload === "object" && payload[API_BYPASS_SYMBOL] === true);
};

const sanitizeApiBypassPayload = (payload) => {
    if (!isApiBypassPayload(payload)) {
        return payload;
    }
    const nextPayload = { ...payload };
    delete nextPayload[API_BYPASS_SYMBOL];
    return nextPayload;
};

const emitHookEvent = ({ type, channel, direction, payload, rawArgs, meta, eventId }) => {
    server.broadcastEventObject(store.createHookEvent({
        type,
        channel,
        direction,
        payload,
        rawArgs,
        meta,
        eventId,
    }));
};

const processExternalInterception = async ({ channel, direction, payload, rawArgs, meta }) => {
    const shouldForward = store.shouldForwardChannel(direction, channel);
    const shouldIntercept = store.shouldInterceptChannel(direction, channel);

    if (!shouldForward && !shouldIntercept) {
        return {
            matched: false,
            action: "allow",
            payload,
            rawArgs,
        };
    }

    if (!shouldIntercept) {
        emitHookEvent({
            type: "notify",
            channel,
            direction,
            payload,
            rawArgs,
            meta: {
                ...meta,
                interceptible: false,
            },
        });
        return {
            matched: true,
            action: "allow",
            payload,
            rawArgs,
        };
    }

    const pending = store.createPendingIntercept({
        channel,
        direction,
        payload,
        rawArgs,
        meta,
    });

    emitHookEvent({
        eventId: pending.eventId,
        type: "intercept_request",
        channel,
        direction,
        payload,
        rawArgs,
        meta: {
            ...meta,
            timeoutMs: pending.timeoutMs,
            defaultAction: pending.defaultAction,
            interceptible: true,
        },
    });

    const decision = await pending.decisionPromise;

    emitHookEvent({
        eventId: pending.eventId,
        type: "intercept_result",
        channel,
        direction,
        payload: {
            action: decision.action,
            reason: decision.reason || "",
        },
        meta: {
            ...meta,
            resultSource: decision.resultSource,
        },
    });

    return {
        matched: true,
        action: decision.action,
        payload: decision.payload,
        rawArgs,
    };
};

const init = () => {
    // ─────────────────────────────────────────────────────────────
    // 劫持原生 console
    // ─────────────────────────────────────────────────────────────
    const nativeConsole = {
        log: Function.prototype.bind.call(console.log, console),
        info: Function.prototype.bind.call(console.info, console),
        warn: Function.prototype.bind.call(console.warn, console),
        error: Function.prototype.bind.call(console.error, console),
        debug: Function.prototype.bind.call(console.debug, console),
    };
    global.__pw_console__ = nativeConsole;

    // 将输出同时发往 SSE 和原生控制台
    const levels = ["log", "info", "warn", "error", "debug"];
    levels.forEach((level) => {
        const hooked = (...args) => {
            nativeConsole[level](...args);
            if (!pwHookDisabled) {
                server.broadcastLog(level, args);
            }
        };
        try {
            Object.defineProperty(console, level, {
                get: () => hooked,
                set: () => { },
                configurable: false,
                enumerable: true,
            });
        } catch (_) {
            console[level] = hooked;
        }
    });

    // ─────────────────────────────────────────────────────────────
    // 启动基于 HTTP 的 RPC 通信服务器（含 SSE 日志端点）
    // ─────────────────────────────────────────────────────────────
    server.startServer();

    if (ACCOUNT_GUARD_ENABLED) {
        console.warn(`[PW_HOOK][ACCOUNT_GUARD] SteamID 白名单保护已启用: ${Array.from(ALLOWED_STEAM_IDS).join(", ") || "(未配置)"}`);
        accountGuardPollTimer = setInterval(() => {
            verifyGlobalUserAccount("global.user poll");
        }, 1000);
    }

    console.log("[PW_HOOK] 正在初始化 God Mode Hook 系统...");

    // ─────────────────────────────────────────────────────────────
    // 打开前端控制台窗口
    // ─────────────────────────────────────────────────────────────
    const openConsoleWindow = () => {
        const win = new electron.BrowserWindow({
            width: 1000,
            height: 680,
            title: "PW Hook Console",
            backgroundColor: "#0d1117",
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
            },
        });

        const frontendPath = path.join(__dirname, "frontend", "index.html");
        win.loadFile(frontendPath);

        win.setMenuBarVisibility(false);
        consoleWindow = win;
        win.on("closed", () => {
            if (consoleWindow === win) {
                consoleWindow = null;
            }
        });
    };

    if (electron.app.isReady()) {
        openConsoleWindow();
    } else {
        electron.app.once("ready", openConsoleWindow);
    }

    // ─────────────────────────────────────────────────────────────
    // 获取注入前已经被程序挂载的原生事件处理函数
    // ─────────────────────────────────────────────────────────────
    const existingOnChannels = electron.ipcMain.eventNames();
    existingOnChannels.forEach((channel) => {
        if (typeof channel !== "string") return;
        const listeners = electron.ipcMain.listeners(channel);
        if (listeners.length > 0) {
            console.log(`[PW_HOOK] 发现已挂载的原生 IPC On 通道: ${channel}`);
            store.registerFunction(channel, (...args) => {
                return new Promise((resolve, reject) => {
                    const fakeEvent = {
                        reply: (resType, data) => resolve(data),
                        sender: { send: (resType, data) => resolve(data) },
                    };
                    try {
                        listeners[0](fakeEvent, ...args);
                    } catch (err) {
                        reject(err);
                    }
                });
            });
        }
    });

    if (electron.ipcMain._invokeHandlers) {
        electron.ipcMain._invokeHandlers.forEach((listener, channel) => {
            console.log(`[PW_HOOK] 发现已挂载的原生 IPC Handle 通道: ${channel}`);
            store.registerFunction(channel, async (...args) => {
                const fakeEvent = { sender: { send: () => {} } };
                return await listener(fakeEvent, ...args);
            });
        });
    }

    // ─────────────────────────────────────────────────────────────
    // 劫持 Electron 主进程的 IPC 通信
    // ─────────────────────────────────────────────────────────────
    const originalIpcHandle = electron.ipcMain.handle;
    electron.ipcMain.handle = function (channel, listener) {
        console.log(`[PW_HOOK] 捕获到平台注册 IPC Handle 通道: ${channel}`);

        store.registerFunction(channel, async (...args) => {
            const fakeEvent = { sender: { send: () => { } } };
            return await listener(fakeEvent, ...args);
        });

        const wrappedListener = async function (event, ...args) {
            if (pwHookDisabled) {
                return await listener.apply(this, [event, ...args]);
            }

            let modifiedArgs = args;
            const shouldBypassInterception = isApiBypassPayload(modifiedArgs[0]);

            if (shouldBypassInterception) {
                modifiedArgs = Array.isArray(modifiedArgs) ? [...modifiedArgs] : [];
                modifiedArgs[0] = sanitizeApiBypassPayload(modifiedArgs[0]);
            }

            console.log(`[PW_HOOK] 捕获前端请求 ↑ [${channel}]`);
            if (modifiedArgs.length > 0) {
                logPayload(`[PW_HOOK] 请求传参 Payload:`, modifiedArgs[0]);
                verifyPayloadAccount(modifiedArgs[0], `ipcMain.handle:${channel}`);
            }

            if (!shouldBypassInterception) {
                try {
                    const interception = await processExternalInterception({
                        channel,
                        direction: "upstream",
                        payload: modifiedArgs[0],
                        rawArgs: modifiedArgs,
                        meta: {
                            source: "ipcMain.handle",
                        },
                    });

                    if (interception.action === "block") {
                        console.log(`[PW_HOOK] 外部程序阻断上行消息 [${channel}]`);
                        return undefined;
                    }

                    if (interception.action === "modify") {
                        modifiedArgs = Array.isArray(modifiedArgs) ? [...modifiedArgs] : [];
                        modifiedArgs[0] = interception.payload;
                        console.log(`[PW_HOOK] 外部程序修改上行消息 [${channel}]`);
                    }
                } catch (e) {
                    console.error(`[PW_HOOK] 上行外部拦截执行失败:`, e);
                }
            }

            return await listener.apply(this, [event, ...modifiedArgs]);
        };

        const newArgs = [channel, wrappedListener];
        return originalIpcHandle.apply(this, newArgs);
    };

    // 拦截 ipcMain.on
    const originalIpcOn = electron.ipcMain.on;
    electron.ipcMain.on = function (channel, listener) {
        console.log(`[PW_HOOK] 捕获到平台注册 IPC On 通道: ${channel}`);

        store.registerFunction(channel, (...args) => {
            return new Promise((resolve, reject) => {
                const fakeEvent = {
                    reply: (resType, data) => {
                        console.log(`[PW_HOOK] 拦截到返回值，通道: ${resType}`);
                        resolve(data);
                    },
                    sender: {
                        send: (resType, data) => {
                            resolve(data);
                        },
                    },
                };
                try {
                    listener(fakeEvent, ...args);
                } catch (err) {
                    reject(err);
                }
            });
        });

        const wrappedListener = function (event, ...args) {
            if (pwHookDisabled) {
                return listener.apply(this, [event, ...args]);
            }

            return (async () => {
            let modifiedArgs = args;
            const shouldBypassInterception = isApiBypassPayload(modifiedArgs[0]);

            if (shouldBypassInterception) {
                modifiedArgs = Array.isArray(modifiedArgs) ? [...modifiedArgs] : [];
                modifiedArgs[0] = sanitizeApiBypassPayload(modifiedArgs[0]);
            }

            // 当玩家在平台界面点击按钮触发 IPC 通信时，拦截并打印它的上行报文
            console.log(`[PW_HOOK] 捕获前端请求 ↑ [${channel}]`);
            if (modifiedArgs.length > 0) {
                logPayload(`[PW_HOOK] 请求传参 Payload:`, modifiedArgs[0]);
                verifyPayloadAccount(modifiedArgs[0], `ipcMain.on:${channel}`);
            }

            if (!shouldBypassInterception) {
                try {
                    const interception = await processExternalInterception({
                        channel,
                        direction: "upstream",
                        payload: modifiedArgs[0],
                        rawArgs: modifiedArgs,
                        meta: {
                            source: "ipcMain.on",
                        },
                    });

                    if (interception.action === "block") {
                        console.log(`[PW_HOOK] 外部程序阻断上行消息 [${channel}]`);
                        return undefined;
                    }

                    if (interception.action === "modify") {
                        modifiedArgs = Array.isArray(modifiedArgs) ? [...modifiedArgs] : [];
                        modifiedArgs[0] = interception.payload;
                        console.log(`[PW_HOOK] 外部程序修改上行消息 [${channel}]`);
                    }
                } catch (e) {
                    console.error(`[PW_HOOK] 上行外部拦截执行失败:`, e);
                }
            }

            return listener.apply(this, [event, ...modifiedArgs]);
            })();
        };

        const newArgs = [channel, wrappedListener];
        return originalIpcOn.apply(this, newArgs);
    };

    // ─────────────────────────────────────────────────────────────
    // 拦截WebSocket推送
    // ─────────────────────────────────────────────────────────────
    const hookWebContents = (wc) => {
        if (wc.__pw_hook_injected__) return;
        wc.__pw_hook_injected__ = true;

        const originalSend = wc.send;
        wc.send = async function (channel, ...args) {
            if (pwHookDisabled) {
                return originalSend.apply(this, [channel, ...args]);
            }

            let targetChannel = channel;
            let modifiedArgs = args;
            const shouldBypassInterception = isApiBypassPayload(modifiedArgs[0]);

            if (shouldBypassInterception) {
                modifiedArgs = Array.isArray(modifiedArgs) ? [...modifiedArgs] : [];
                modifiedArgs[0] = sanitizeApiBypassPayload(modifiedArgs[0]);
            }

            console.log(`[PW_HOOK] 捕获服务端推送 ↓ [${targetChannel}]`);
            if (modifiedArgs.length > 0) {
                logPayload(`[PW_HOOK] 推送数据 Payload:`, modifiedArgs[0]);
                verifyPayloadAccount(modifiedArgs[0], `webContents.send:${targetChannel}`);
            }

            // 将服务端推给前端的事件通过 EventBus 广播出来，供 Router 等机制挂起等待
            try {
                store.getEventBus().emit(targetChannel, modifiedArgs[0]);
            } catch (err) { }

            if (!shouldBypassInterception) {
                try {
                    const baseMeta = getWebContentsMeta(wc);
                    const interception = await processExternalInterception({
                        channel: targetChannel,
                        direction: "downstream",
                        payload: modifiedArgs[0],
                        rawArgs: modifiedArgs,
                        meta: baseMeta,
                    });

                    if (interception.action === "block") {
                        console.log(`[PW_HOOK] 外部程序阻断消息 [${targetChannel}]`);
                        return;
                    }

                    if (interception.action === "modify") {
                        modifiedArgs = Array.isArray(modifiedArgs) ? [...modifiedArgs] : [];
                        modifiedArgs[0] = interception.payload;
                        console.log(`[PW_HOOK] 外部程序修改消息 [${targetChannel}]`);
                    }
                } catch (err) { }
            }

            return originalSend.apply(this, [targetChannel, ...modifiedArgs]);
        };
    };

    // 监听webContents
    electron.app.on("web-contents-created", (event, wc) => {
        hookWebContents(wc);
    });

    // 处理已经创建好的webContents
    if (electron.webContents && typeof electron.webContents.getAllWebContents === "function") {
        electron.webContents.getAllWebContents().forEach(wc => hookWebContents(wc));
    }
};

init();

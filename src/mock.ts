// 浏览器调试用的 mygo 运行时替身：页面不在 mygo 窗口里运行时
// （例如直接用浏览器打开 Vite dev server），安装一个 window.mygo，
// 用 localStorage 模拟后端，让整个 UI 可以独立开发与测试。

import type { Channel, Runtime } from "mygo-runtime";
import { newProxyTemplate, toInt, type ProfileData, type ProxyEntry } from "./types";
import type { SettingsData, Status } from "./mygo";

interface MockStore {
  settings: SettingsData;
  profiles: Record<string, ProfileData>;
}

const LS_KEY = "frpcclient-mock-v1";

function defaultStore(): MockStore {
  const profile: ProfileData = {
    serverAddr: "127.0.0.1",
    serverPort: 7000,
    loginFailExit: false,
    auth: { method: "token", token: "" },
    transport: { protocol: "tcp", tls: { enable: true }, heartbeatInterval: 30, heartbeatTimeout: 90 },
    log: { level: "info", maxDays: 3 },
    proxies: [],
  };
  const p1 = newProxyTemplate("tcp");
  p1.name = "proxy_1";
  p1.localPort = 8080;
  p1.remotePort = 6080;
  profile.proxies = [p1];
  return {
    settings: {
      frpcExe: "C:\\tools\\frp\\frpc.exe",
      currentProfile: "default",
      minimizeToTray: true,
      autostart: false,
      autoReconnect: true,
      stopOnExit: true,
      frpcAutostart: false,
      frpcAutostartProfile: "",
    },
    profiles: { default: profile },
  };
}

let store: MockStore;
let running = false;
let runPid = 0;
let runProfile = "";
let externalPids: number[] = [];

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

function emit(event: string, payload: unknown) {
  listeners.get(event)?.forEach((fn) => fn(payload));
}

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    /* 无痕模式等场景忽略 */
  }
}

function load(): MockStore {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as MockStore;
  } catch {
    /* 损坏则重置 */
  }
  return defaultStore();
}

function validateProfile(data: ProfileData): string[] {
  const errs: string[] = [];
  if (!String(data.serverAddr ?? "").trim()) errs.push("服务器地址（serverAddr）不能为空");
  const port = toInt(data.serverPort, 0);
  if (port <= 0 || port >= 65536) errs.push("服务器端口（serverPort）必须是 1-65535 的整数");
  const seen: Record<string, boolean> = {};
  const seenRemote: Record<number, string> = {};
  (data.proxies ?? []).forEach((p: ProxyEntry, i: number) => {
    const name = String(p.name ?? "").trim();
    const tag = `代理#${i + 1}(${name || "未命名"})`;
    if (!name) errs.push(`${tag}：名称（name）不能为空`);
    else if (seen[name]) errs.push(`${tag}：名称与其它代理重复`);
    else seen[name] = true;
    if (p.localPort !== undefined && !p.plugin) {
      const lp = toInt(p.localPort, 0);
      if (lp <= 0 || lp >= 65536) errs.push(`${tag}：本地端口（localPort）无效`);
    }
    if (p.type === "tcp" || p.type === "udp") {
      const rp = toInt(p.remotePort, 0);
      if (rp <= 0 || rp >= 65536) errs.push(`${tag}：tcp/udp 代理必须填写有效的远程端口（remotePort）`);
      else if (seenRemote[rp]) errs.push(`${tag}：远程端口 ${rp} 与代理[${seenRemote[rp]}] 重复`);
      else seenRemote[rp] = name || `#${i + 1}`;
    }
  });
  return errs;
}

function status(): Status {
  if (running) {
    return { running: true, external: false, pid: runPid, externalPids: [], profile: runProfile };
  }
  return { running: false, external: externalPids.length > 0, pid: 0, externalPids, profile: "" };
}

function pushLog(line: string) {
  emit("logLines", [line]);
}

let logTimer: ReturnType<typeof setInterval> | null = null;
function startFakeLogs(profile: string) {
  let n = 0;
  const lines = [
    `${new Date().toISOString()} [I] [root.go] start service`,
    `${new Date().toISOString()} [I] [sub/proxy_1] proxy success: use 127.0.0.1:6080`,
    `${new Date().toISOString()} [I] [sub/proxy_1] [proxy_1] tcp proxy listen on port 6080`,
  ];
  logTimer = setInterval(() => {
    if (!running) return;
    const line = lines[n % lines.length]!;
    pushLog(line.replace("proxy_1", String(100 + (n % 3))));
    n++;
  }, 2000);
  pushLog(`[系统] 已启动 frpc，profile = ${profile}`);
  pushLog(lines[0]!);
}

function stopFakeLogs(code: number) {
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
  pushLog(`[系统] frpc 进程退出，code = ${code}`);
}

function setRunning(v: boolean, profile: string) {
  running = v;
  runProfile = v ? profile : "";
  runPid = v ? 4000 + Math.floor(Math.random() * 1000) : 0;
  emit("statusChanged", status());
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function call(method: string, ...args: unknown[]): Promise<unknown> {
  const [a, b] = args as [string, unknown];
  switch (method) {
    case "Profiles.List": {
      // 保证 default 存在
      if (!store.profiles["default"]) store.profiles["default"] = defaultStore().profiles["default"]!;
      return Object.keys(store.profiles)
        .sort()
        .map((name) => {
          const d = store.profiles[name]!;
          return { name, serverAddr: String(d.serverAddr ?? ""), serverPort: toInt(d.serverPort, 0) };
        });
    }
    case "Profiles.Get":
      return structuredClone(store.profiles[a as string] ?? defaultStore().profiles["default"]);
    case "Profiles.Save":
      store.profiles[a as string] = structuredClone(b as ProfileData);
      persist();
      return null;
    case "Profiles.Create": {
      const name = a as string;
      const copyFrom = (args[1] as string) || "";
      if (store.profiles[name]) throw new Error(`名称 [${name}] 已存在，请换一个`);
      store.profiles[name] = copyFrom
        ? structuredClone(store.profiles[copyFrom] ?? {})
        : structuredClone(defaultStore().profiles["default"] ?? {});
      persist();
      return null;
    }
    case "Profiles.Rename": {
      const oldName = a as string;
      const newName = args[1] as string;
      if (oldName === newName) return null;
      if (store.profiles[newName]) throw new Error(`名称 [${newName}] 已存在，请换一个`);
      store.profiles[newName] = store.profiles[oldName]!;
      delete store.profiles[oldName];
      if (store.settings.frpcAutostartProfile === oldName) store.settings.frpcAutostartProfile = newName;
      persist();
      return null;
    }
    case "Profiles.Delete": {
      if (a === "default") throw new Error("default 配置不允许删除");
      delete store.profiles[a as string];
      if (store.settings.frpcAutostartProfile === a) {
        store.settings.frpcAutostart = false;
        store.settings.frpcAutostartProfile = "";
      }
      persist();
      return null;
    }
    case "Profiles.PickToml":
      return ""; // 浏览器 mock：视为取消
    case "Profiles.ImportToml":
      return null;
    case "Profiles.ExportToml":
      return "";
    case "Profiles.SafeName":
      return String(a).replace(/[\\/:*?"<>|]/g, "_").trim() || "default";
    case "Settings.Get":
      return { ...store.settings };
    case "Settings.Save":
      store.settings = { ...store.settings, ...(b as object) } as SettingsData;
      persist();
      return { autostartError: "", frpcAutostartError: "", suggestStartDetached: false };
    case "Settings.SetCurrentProfile":
      store.settings.currentProfile = a as string;
      persist();
      return null;
    case "Settings.BrowseFrpcExe":
      return "C:\\tools\\frp\\frpc.exe";
    case "Settings.OpenDir":
      return null;
    case "Frpc.Status":
      return status();
    case "Frpc.Start": {
      const profile = a as string;
      if (running) throw new Error("frpc 已在运行，请先停止再启动。");
      if (externalPids.length > 0)
        throw new Error("frpc 已作为独立进程运行（开机自启）。\n点「重启」可由本软件接管，或先「停止」再启动。");
      const data = store.profiles[profile];
      const errs = data ? validateProfile(data) : [];
      if (errs.length) throw new Error("配置有误，无法启动：\n" + errs.join("\n"));
      await sleep(300);
      setRunning(true, profile);
      startFakeLogs(profile);
      return null;
    }
    case "Frpc.Stop":
      if (running) {
        setRunning(false, "");
        stopFakeLogs(0);
      } else if (externalPids.length > 0) {
        pushLog(`[系统] 已结束独立运行的 frpc (pid=${externalPids.join(",")})`);
        externalPids = [];
        emit("statusChanged", status());
      }
      return null;
    case "Frpc.Restart": {
      const profile = a as string;
      if (running) {
        stopFakeLogs(0);
        setRunning(false, "");
        await sleep(300);
      } else if (externalPids.length > 0) {
        pushLog(`[系统] 已结束独立运行的 frpc (pid=${externalPids.join(",")})`);
        externalPids = [];
      }
      return call("Frpc.Start", profile);
    }
    case "Frpc.StartDetached": {
      if (running) throw new Error("frpc 正由本软件管理，请先「停止」后再以独立方式启动。");
      if (externalPids.length > 0) throw new Error("frpc 已在独立运行，无需重复启动。");
      externalPids = [5200];
      pushLog("[系统] frpc 已作为独立进程启动 (pid=5200)，关闭本软件后仍会继续运行");
      emit("statusChanged", status());
      return null;
    }
    default:
      throw new Error(`mock: unknown method ${method}`);
  }
}

/** 在非 mygo 环境安装替身。必须在页面代码发起调用之前执行。 */
export function installMock() {
  store = load();
  const rt: Runtime = {
    call: <T,>(method: string, ...args: unknown[]) => call(method, ...args) as Promise<T>,
    channel: <T,>(): Channel<T> => {
      throw new Error("mock: channel unsupported");
    },
    on: <T,>(event: string, listener: (payload: T) => void): (() => void) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const fn = listener as (payload: unknown) => void;
      set.add(fn);
      return () => {
        set!.delete(fn);
      };
    },
    once: <T,>(event: string, listener: (payload: T) => void): (() => void) => {
      const off = rt.on<T>(event, (p) => {
        off();
        listener(p);
      });
      return off;
    },
    platform: "win32",
    windowId: 1,
    version: "mock",
    window: {
      minimize: async () => {},
      maximize: async () => {},
      unmaximize: async () => {},
      toggleMaximize: async () => {},
      isMaximized: async () => false,
      toggleFullScreen: async () => {},
      close: async () => {},
      setTitle: async () => {},
    },
  };
  (window as { mygo?: Runtime }).mygo = rt;
  console.info("[frpcclient] 浏览器调试模式：已安装 mygo mock（localStorage 存档）");
}

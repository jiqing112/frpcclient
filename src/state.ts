// 集中状态：设置、profile 列表、当前 profile 数据、运行状态、日志。
// 组件通过 onStoreChange 注册刷新回调；所有变更走这里的动作函数。

import { Frpc, Profiles, Settings, events, type ProfileSummary, type SettingsData, type Status } from "./mygo";
import type { ProfileData } from "./types";

export interface AppState {
  settings: SettingsData;
  profiles: ProfileSummary[];
  currentProfile: string;
  profileData: ProfileData;
  status: Status;
  saveNote: string; // "已保存 HH:MM:SS" 等提示
}

export const state: AppState = {
  settings: {
    frpcExe: "",
    currentProfile: "default",
    minimizeToTray: true,
    autostart: false,
    autoReconnect: true,
    stopOnExit: true,
    frpcAutostart: false,
    frpcAutostartProfile: "",
  },
  profiles: [],
  currentProfile: "default",
  profileData: {},
  status: { running: false, external: false, pid: 0, externalPids: [], profile: "" },
  saveNote: "",
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function onStoreChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  listeners.forEach((fn) => fn());
}

export function nowHMS(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

export async function boot() {
  events.logLines.on((lines) => appendLogLines(lines));
  events.statusChanged.on((st) => {
    state.status = st;
    notify();
  });

  state.settings = await Settings.get();
  state.profiles = await Profiles.list();
  state.currentProfile = state.settings.currentProfile;
  if (!state.profiles.some((p) => p.name === state.currentProfile)) {
    state.currentProfile = state.profiles[0]?.name ?? "default";
  }
  state.profileData = (await Profiles.get(state.currentProfile)) as ProfileData;
  state.status = await Frpc.status();
  notify();
}

// ---------------------------------------------------------------------------
// 保存（每次修改立即落盘）
// ---------------------------------------------------------------------------

export async function saveCurrent(opts: { silent?: boolean } = {}): Promise<void> {
  await Profiles.save(state.currentProfile, state.profileData);
  state.saveNote = `已保存 ${nowHMS()}`;
  notify();
  if (!opts.silent) refreshProfiles(); // 侧栏地址等可能变化
}

export async function refreshProfiles() {
  state.profiles = await Profiles.list();
  notify();
}

export async function reloadSettings() {
  state.settings = await Settings.get();
  notify();
}

// ---------------------------------------------------------------------------
// profile 切换与管理
// ---------------------------------------------------------------------------

export async function switchProfile(name: string) {
  if (name === state.currentProfile) return;
  state.currentProfile = name;
  await Settings.setCurrentProfile(name);
  state.profileData = (await Profiles.get(name)) as ProfileData;
  state.saveNote = "";
  notify();
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

export interface LogLine {
  text: string;
  system: boolean;
}

export const logLines: LogLine[] = [];
export const LOG_MAX_LINES = 5000;

export function appendLogLines(lines: string[]) {
  for (const line of lines) {
    logLines.push({ text: line, system: line.startsWith("[系统]") });
  }
  if (logLines.length > LOG_MAX_LINES) {
    logLines.splice(0, logLines.length - LOG_MAX_LINES);
  }
  notify();
}

export function clearLogs() {
  logLines.length = 0;
  notify();
}

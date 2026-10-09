// 与 Go 端 map[string]any 约定的 profile 数据形状。
// 未知字段（plugin、healthCheck、tcpMux 等）保存在索引签名里，
// 读写已知字段时不要重建整个对象，避免丢键。

export interface ProxyTransport {
  useEncryption?: boolean;
  useCompression?: boolean;
  [k: string]: unknown;
}

export interface ProxyEntry {
  name: string;
  type: string;
  localIP?: string;
  localPort?: number;
  remotePort?: number;
  customDomains?: string[];
  subdomain?: string;
  httpUser?: string;
  httpPassword?: string;
  hostHeaderRewrite?: string;
  secretKey?: string;
  group?: string;
  groupKey?: string;
  transport?: ProxyTransport;
  [k: string]: unknown;
}

export interface ProfileData {
  serverAddr?: string;
  serverPort?: number;
  user?: string;
  loginFailExit?: boolean;
  auth?: { method?: string; token?: string; user?: string } & Record<string, unknown>;
  transport?: {
    protocol?: string;
    tls?: { enable?: boolean } & Record<string, unknown>;
    heartbeatInterval?: number;
    heartbeatTimeout?: number;
    poolCount?: number;
  } & Record<string, unknown>;
  log?: { level?: string; maxDays?: number; to?: string } & Record<string, unknown>;
  webServer?: { addr?: string; port?: number; user?: string; password?: string } & Record<string, unknown>;
  proxies?: ProxyEntry[];
  [k: string]: unknown;
}

// 代理类型分组（与 Python 版 PROXY_TYPES / 对话框逻辑一致）
export const WEB_TYPES = ["http", "https"];
export const SECRET_TYPES = ["stcp", "sudp", "xtcp"];
export const GROUP_TYPES = ["tcp", "udp", "stcp", "sudp", "xtcp"];
export const PROXY_TYPES = ["tcp", "udp", "http", "https", "stcp", "sudp", "xtcp"];

/** 新代理模板（对应 Go 的 newProxyTemplate）。 */
export function newProxyTemplate(type: string): ProxyEntry {
  const base: ProxyEntry = {
    name: "new_proxy",
    type,
    localIP: "127.0.0.1",
    localPort: 80,
    transport: { useEncryption: false, useCompression: false },
  };
  if (type === "tcp" || type === "udp") base.remotePort = 6000;
  else if (type === "http" || type === "https") base.customDomains = [];
  else if (SECRET_TYPES.includes(type)) base.secretKey = "";
  return base;
}

/** profile 名清洗为安全文件名（与 Go sanitizeName 一致）。 */
export function sanitizeName(name: string): string {
  const s = (name || "").replace(/[\\/:*?"<>|]/g, "_").trim();
  return s || "default";
}

export function toInt(v: unknown, def = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = parseInt(v.trim(), 10);
    if (Number.isFinite(n)) return n;
  }
  return def;
}

export function toBool(v: unknown, def = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
  return def;
}

/** toml 值 → 输入框显示字符串（数组逗号连接）。 */
export function entryValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (typeof v === "object") return "";
  return String(v);
}

/** 逗号分隔输入 → 去空白列表。 */
export function splitList(s: string): string[] {
  return (s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

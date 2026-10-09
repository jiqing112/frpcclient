// 「服务器配置」对话框：frps 连接 / 认证 / 传输 / 日志 / 本地管理界面。
// 保存即写入当前 profile；frpc 运行中会询问是否立即重启生效。

import { Frpc } from "./mygo";
import { state, saveCurrent } from "./state";
import { confirmDialog, errorDialog, h, FormSection, modal, modalFooter, button, toast } from "./ui";
import { entryValue, toBool, toInt } from "./types";

export function openServerDialog(): void {
  const data = state.profileData;
  const m = modal({
    title: "服务器配置",
    subtitle: `保存到配置 [${state.currentProfile}]，frpc 运行中修改后需重启生效`,
    width: 800,
  });

  const get = <T,>(key: string, def: T): T => {
    const v = data[key];
    return (v === undefined || v === null ? def : v) as T;
  };
  const auth = (data.auth ?? {}) as Record<string, unknown>;
  const tr = (data.transport ?? {}) as Record<string, unknown>;
  const tls = (tr.tls ?? {}) as Record<string, unknown>;
  const log = (data.log ?? {}) as Record<string, unknown>;
  const wsRaw = data.webServer;
  const ws = (typeof wsRaw === "object" && wsRaw !== null ? wsRaw : {}) as Record<string, unknown>;
  const webEnabled = typeof wsRaw === "object" && wsRaw !== null;

  // ---- ① 服务器连接 ----
  const s1 = new FormSection("① 服务器连接");
  const addrInput = s1.field("服务器地址", entryValue(get("serverAddr", "127.0.0.1")), { hint: "serverAddr" });
  const portInput = s1.field("服务器端口", entryValue(get("serverPort", 7000)), { hint: "serverPort，默认 7000", width: 10 });
  const userInput = s1.field("用户名", entryValue(get("user", "")), { hint: "user，可选" });
  const failExitCheck = s1.check(
    "登录失败立即退出程序",
    toBool(get("loginFailExit", false)),
    "loginFailExit，勾选后连不上会退出 frpc",
  );

  // ---- ② 认证 ----
  const s2 = new FormSection("② 认证");
  const methodSel = s2.select("认证方式", String(auth.method ?? "token") || "token", ["token", "oidc"], "auth.method");
  const tokenInput = s2.field("Token", entryValue(auth.token), { hint: "auth.token，与 frps 一致", width: 36 });
  const authUserInput = s2.field("用户名", entryValue(auth.user), { hint: "auth.user（oidc 时使用）" });
  const syncAuthUser = () => {
    authUserInput.disabled = methodSel.value !== "oidc";
  };
  methodSel.addEventListener("change", syncAuthUser);

  // ---- ③ 传输 ----
  const s3 = new FormSection("③ 传输设置");
  const protoSel = s3.select(
    "协议",
    String(tr.protocol ?? "tcp") || "tcp",
    ["tcp", "kcp", "quic", "websocket", "wss"],
    "transport.protocol",
  );
  const hbInterval = s3.field("心跳间隔", entryValue(tr.heartbeatInterval ?? 30), { hint: "transport.heartbeatInterval（秒）", width: 10 });
  const hbTimeout = s3.field("心跳超时", entryValue(tr.heartbeatTimeout ?? 90), { hint: "transport.heartbeatTimeout（秒）", width: 10 });
  const poolCount = s3.field("连接池大小", entryValue(tr.poolCount ?? 0), { hint: "transport.poolCount，0=不启用", width: 10 });
  const tlsCheck = s3.check("启用 TLS 加密", toBool(tls.enable, true), "transport.tls.enable，新版 frp 默认开启");

  // ---- ④ 日志 ----
  const s4 = new FormSection("④ 日志");
  const logLevel = s4.select("日志级别", String(log.level ?? "info") || "info", ["trace", "debug", "info", "warn", "error"], "log.level");
  const logDays = s4.field("日志保留天数", entryValue(log.maxDays ?? 3), { hint: "log.maxDays", width: 10 });
  s4.appendRow(
    "",
    h("div", { class: "form-hint wide" },
      "frpc 运行日志会自动写入程序 logs 目录，可在「日志」页查看或打开目录。"),
  );

  // ---- ⑤ 本地管理界面（可选） ----
  const s5 = new FormSection("⑤ 本地管理界面（可选）");
  const webCheck = s5.check("启用 webServer 管理界面", webEnabled, "不启用时配置里不会出现 webServer 段");
  const webAddr = s5.field("监听地址", entryValue(ws.addr ?? "127.0.0.1"), { hint: "webServer.addr" });
  const webPort = s5.field("监听端口", entryValue(ws.port ?? 7400), { hint: "webServer.port", width: 10 });
  const webUser = s5.field("账号", entryValue(ws.user), { hint: "webServer.user" });
  const webPass = s5.field("密码", entryValue(ws.password), { hint: "webServer.password", width: 28 });
  const webFields = [webAddr, webPort, webUser, webPass];
  const syncWeb = () => {
    webFields.forEach((f) => {
      f.disabled = !webCheck.checked;
    });
  };
  webCheck.addEventListener("change", syncWeb);

  syncAuthUser();
  syncWeb();
  m.body.append(s1.card, s2.card, s3.card, s4.card, s5.card);

  const { error, actions } = modalFooter(m.body);

  const collect = () => {
    // 合并语义：只写 UI 覆盖的键，保留 log.to、tcpMux 等未覆盖字段
    data.serverAddr = addrInput.value.trim();
    data.serverPort = toInt(portInput.value, 7000);
    data.user = userInput.value.trim();
    data.loginFailExit = failExitCheck.checked;

    const a = (data.auth ??= {}) as Record<string, unknown>;
    a.method = methodSel.value.trim() || "token";
    a.token = tokenInput.value.trim();
    a.user = authUserInput.value.trim();

    const t = (data.transport ??= {}) as Record<string, unknown>;
    t.protocol = protoSel.value.trim() || "tcp";
    const tlsObj = (t.tls ??= {}) as Record<string, unknown>;
    tlsObj.enable = tlsCheck.checked;
    // frpc 严格解析：客户端级 transport 不存在 useEncryption/useCompression
    // （仅代理级有效），旧版本曾错误写入，这里清除
    delete t.useEncryption;
    delete t.useCompression;
    t.heartbeatInterval = toInt(hbInterval.value, 30);
    t.heartbeatTimeout = toInt(hbTimeout.value, 90);
    const pool = toInt(poolCount.value, 0);
    if (pool > 0) t.poolCount = pool;
    else delete t.poolCount;

    const lg = (data.log ??= {}) as Record<string, unknown>;
    lg.level = logLevel.value.trim() || "info";
    lg.maxDays = toInt(logDays.value, 3);

    if (webCheck.checked) {
      const w = (data.webServer ??= {}) as Record<string, unknown>;
      w.addr = webAddr.value.trim() || "127.0.0.1";
      w.port = toInt(webPort.value, 7400);
      w.user = webUser.value.trim();
      w.password = webPass.value.trim();
    } else {
      delete data.webServer;
    }
  };

  const save = async () => {
    collect();
    m.close();
    try {
      await saveCurrent();
    } catch (e) {
      void errorDialog("保存失败", String((e as Error).message ?? e));
      return;
    }
    toast(`已保存 ${new Date().toLocaleTimeString()}`);
    if (state.status.running) {
      const restart = await confirmDialog({
        title: "已保存",
        message: "frpc 正在运行，立即重启以使新配置生效？",
        okText: "重启",
      });
      if (restart) {
        try {
          await Frpc.restart(state.currentProfile);
        } catch (e) {
          void errorDialog("重启失败", String((e as Error).message ?? e));
        }
      }
    }
  };

  actions.append(button("取消", "outline", () => m.close()), button("保存", "primary", () => void save()));
  error.textContent = "";
}

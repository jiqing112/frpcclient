// 设置页：frpc.exe 路径 + 行为选项 + frpc 独立自启。

import { Frpc, Settings, type SaveSettingsResult, type SettingsData } from "./mygo";
import { reloadSettings, state } from "./state";
import { button, errorDialog, FormSection, h, toast } from "./ui";
import { confirmDialog } from "./ui";

export function settingsTab(): HTMLElement {
  const root = h("div", { class: "tab-pane settings-pane" });

  // ---- frpc.exe 路径 ----
  const s1 = new FormSection("frpc.exe 路径");
  const exeInput = s1.field("可执行文件", state.settings.frpcExe, {
    hint: "frp 客户端程序路径；留空会自动探测程序目录下的 frpc.exe",
  });
  const browseRow = s1.appendRow("", button("浏览", "outline", () => void browse()));
  browseRow.classList.add("compact");
  root.append(s1.card);

  // ---- 行为选项 ----
  const s2 = new FormSection("行为选项");
  const minimizeCheck = s2.check("关闭窗口时最小化到系统托盘", state.settings.minimizeToTray, "关闭按钮缩到托盘，不退出程序");
  const autostartCheck = s2.check("开机自启", state.settings.autostart, "Windows 登录后自动启动本程序");
  const reconnectCheck = s2.check("开机自启时自动连接当前 profile", state.settings.autoReconnect, "仅在「开机自启」勾选时生效");
  const stopExitCheck = s2.check("退出程序时自动停止 frpc", state.settings.stopOnExit, "关闭即停，避免残留进程（不影响独立运行的 frpc）");
  root.append(s2.card);

  // ---- frpc 独立自启 ----
  const s3 = new FormSection("frpc 独立运行");
  const bootState = h("div", { class: "form-hint boot-state" });
  s3.appendRow("", bootState);
  const frpcBootCheck = s3.check("frpc 开机自启（独立运行）", state.settings.frpcAutostart, "登录后由系统直接运行 frpc，无需打开本软件");
  s3.appendRow(
    "",
    h("div", { class: "form-hint wide" },
      "启用后使用当时的当前配置生成启动文件并写入系统启动项；",
      h("br"),
      "修改该配置后，本软件会自动更新启动文件，重启 frpc 后生效。",
      h("br"),
      "与本软件同时打开时互不冲突：本软件会识别并接管管理。"),
  );
  root.append(s3.card);

  // ---- 操作栏 ----
  const bar = h("div", { class: "settings-actions" });
  const saveBtn = button("保存设置", "primary", () => void save());
  const openDirBtn = button("打开配置目录", "outline", () => void Settings.openDir("data"));
  bar.append(saveBtn, openDirBtn, h("span", { class: "form-hint" }, "设置保存在 settings.json"));
  root.append(bar);

  const tip = h(
    "div",
    { class: "settings-tip" },
    "使用提示：",
    h("br"),
    "· 在此指定 frpc.exe 路径后，点击顶部「启动」即可连接 frps。",
    h("br"),
    "· 多套 frps 配置用左侧「配置文件」切换，每个配置对应一个 toml 文件。",
    h("br"),
    "· 配置与日志存放在 配置目录 下的 profiles\\ 与 logs\\ 子目录。",
    h("br"),
    "· 顶部「保存配置」随时可存；修改会自动保存。",
  );
  root.append(tip);

  async function browse() {
    const path = await Settings.browseFrpcExe();
    if (path) exeInput.value = path;
  }

  function renderBootState() {
    const on = state.settings.frpcAutostart;
    const profile = state.settings.frpcAutostartProfile;
    bootState.textContent =
      on && profile ? `● 已注册：开机自动运行配置 [${profile}]` : "○ 未注册系统自启";
    bootState.classList.toggle("on", Boolean(on && profile));
  }

  async function save() {
    const v: SettingsData = {
      ...state.settings,
      frpcExe: exeInput.value.trim(),
      minimizeToTray: minimizeCheck.checked,
      autostart: autostartCheck.checked,
      autoReconnect: reconnectCheck.checked,
      stopOnExit: stopExitCheck.checked,
      frpcAutostart: frpcBootCheck.checked,
    };
    let res: SaveSettingsResult;
    try {
      res = await Settings.save(v);
    } catch (e) {
      void errorDialog("保存失败", String((e as Error).message ?? e));
      return;
    }
    await reloadSettings();
    renderBootState();
    if (res.autostartError) toast(`自启设置：${res.autostartError}`, "error");
    if (res.frpcAutostartError) {
      toast(`frpc 独立自启：${res.frpcAutostartError}`, "error");
      frpcBootCheck.checked = false;
      renderBootState();
    } else if (res.suggestStartDetached) {
      const now = await confirmDialog({
        title: "frpc 独立自启",
        message: "已写入系统启动项，登录后 frpc 将自动运行。\n是否现在就以独立进程启动 frpc？",
        okText: "启动",
      });
      if (now) {
        try {
          await Frpc.startDetached(state.currentProfile);
        } catch (e) {
          void errorDialog("启动失败", String((e as Error).message ?? e));
        }
      }
    }
    toast("设置已保存");
  }

  renderBootState();
  return root;
}

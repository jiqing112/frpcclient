// frpc 控制台主入口：布局（顶栏 / 侧栏 / hero / 标签页）与全局动作。

import { Frpc, Profiles } from "./mygo";
import { boot, onStoreChange, saveCurrent, state, switchProfile, notify } from "./state";
import { badge, button, clear, confirmDialog, errorDialog, h, setEnabled, toast, updateBadge } from "./ui";
import { proxiesTab, refreshProxiesTab } from "./proxies";
import { logTab } from "./logtab";
import { settingsTab } from "./settingsTab";
import { profileNameDialog } from "./dialogs";
import { isMyGo } from "mygo-runtime";

async function main() {
  if (!isMyGo()) {
    const { installMock } = await import("./mock");
    installMock();
  }
  await boot();
  buildLayout();
}

// ---------------------------------------------------------------------------
// 布局
// ---------------------------------------------------------------------------

function buildLayout() {
  const app = document.getElementById("app")!;

  // ---- 顶栏 ----
  const header = h("header", { class: "app-header" });
  const brand = h("div", { class: "brand" });
  brand.append(h("div", { class: "logo" }, "F"));
  const brandText = h("div", { class: "brand-text" });
  brandText.append(
    h("div", { class: "brand-title" }, "frpc 控制台"),
    h("div", { class: "brand-sub" }, "FRP 内网穿透管理"),
  );
  brand.append(brandText);
  const statusBadge = badge("已停止", "muted");
  const saveNote = h("span", { class: "save-note" });

  const actions = h("div", { class: "header-actions" });
  const btnSave = button("保存", "ghost", () => void doSave());
  const btnRestart = button("重启", "outline", () => void doRestart());
  const btnStop = button("停止", "outline", () => void doStop());
  const btnStart = button("启动", "primary", () => void doStart());
  actions.append(btnSave, btnRestart, btnStop, btnStart);

  header.append(brand, statusBadge, saveNote, actions);
  app.append(header);

  // ---- 主体 ----
  const body = h("div", { class: "app-body" });
  app.append(body);

  // 侧栏
  const sidebar = h("aside", { class: "sidebar" });
  const sideHead = h("div", { class: "side-head" });
  sideHead.append(h("div", { class: "side-title" }, "配置文件"));
  const btnNew = button("＋ 新建配置", "outline", () => void newProfile());
  btnNew.classList.add("block");
  sideHead.append(btnNew);
  const profileList = h("div", { class: "profile-list" });

  const sideActions = h("div", { class: "side-actions" });
  const btnRename = button("重命名", "outline", () => void renameProfile());
  const btnDelete = button("删除", "danger-outline", () => void deleteProfile());
  const btnImport = button("导入", "outline", () => void importToml());
  const btnExport = button("导出", "outline", () => void exportToml());
  [btnRename, btnDelete, btnImport, btnExport].forEach((b) => b.classList.add("small"));
  sideActions.append(btnRename, btnDelete, btnImport, btnExport);

  sidebar.append(sideHead, profileList, sideActions);
  body.append(sidebar);

  // 主区
  const content = h("main", { class: "content" });
  body.append(content);

  // hero
  const hero = h("div", { class: "hero" });
  const heroTop = h("div", { class: "hero-top" });
  const heroDot = h("span", { class: "hero-dot" });
  const heroStatus = h("span", { class: "hero-status" }, "已停止");
  const heroProfile = h("span", { class: "hero-profile" });
  const heroTag = h("span", { class: "hero-tag" });
  heroTop.append(heroDot, heroStatus, heroProfile, heroTag);
  hero.append(heroTop);
  content.append(hero);

  // 标签页
  const tabs = h("div", { class: "tabs" });
  const panes: Record<string, HTMLElement> = {};
  const tabDefs: Array<[string, string]> = [
    ["proxies", "代理"],
    ["log", "日志"],
    ["settings", "设置"],
  ];
  const tabButtons: Record<string, HTMLElement> = {};
  for (const [id, label] of tabDefs) {
    const b = h("button", { class: "tab-btn", type: "button" }, label);
    b.addEventListener("click", () => showTab(id));
    tabButtons[id] = b;
    tabs.append(b);
  }
  panes["proxies"] = proxiesTab();
  panes["log"] = logTab();
  panes["settings"] = settingsTab();
  const paneWrap = h("div", { class: "tab-panes" });
  Object.values(panes).forEach((p) => paneWrap.append(p));
  content.append(tabs, paneWrap);

  function showTab(id: string) {
    for (const [tid, b] of Object.entries(tabButtons)) {
      b.classList.toggle("active", tid === id);
    }
    for (const [tid, p] of Object.entries(panes)) {
      p.style.display = tid === id ? "" : "none";
    }
  }
  showTab("proxies");

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  const renderProfiles = () => {
    clear(profileList);
    for (const p of state.profiles) {
      const active = p.name === state.currentProfile;
      const item = h("div", { class: `profile-item${active ? " active" : ""}` });
      const addr = p.serverAddr ? `${p.serverAddr}:${p.serverPort}` : "配置读取失败";
      item.append(
        h("div", { class: "profile-name" }, p.name),
        h("div", { class: "profile-addr" }, addr),
      );
      item.addEventListener("click", () => void switchProfile(p.name));
      profileList.append(item);
    }
  };

  const renderStatus = () => {
    const { running, external, pid, externalPids } = state.status;
    if (running) {
      updateBadge(statusBadge, "运行中", "success");
      heroDot.className = "hero-dot on";
      heroStatus.textContent = "运行中";
      heroTag.textContent = `本软件管理 · PID ${pid}`;
      heroTag.style.display = "";
      setEnabled(btnStart, false);
      setEnabled(btnStop, true);
    } else if (external) {
      updateBadge(statusBadge, "frpc 独立运行中", "success");
      heroDot.className = "hero-dot on";
      heroStatus.textContent = "frpc 独立运行中";
      heroTag.textContent = `系统自启 · PID ${externalPids.join(",")}`;
      heroTag.style.display = "";
      setEnabled(btnStart, false);
      setEnabled(btnStop, true);
    } else {
      updateBadge(statusBadge, "已停止", "muted");
      heroDot.className = "hero-dot";
      heroStatus.textContent = "已停止";
      heroTag.style.display = "none";
      setEnabled(btnStart, true);
      setEnabled(btnStop, false);
    }

    const n = (state.profileData.proxies ?? []).length;
    heroProfile.textContent = `配置 ${state.currentProfile} · ${n} 条代理规则`;
  };

  const renderNote = () => {
    saveNote.textContent = state.saveNote;
  };

  onStoreChange(() => {
    renderProfiles();
    renderStatus();
    renderNote();
  });
  renderProfiles();
  renderStatus();

  // ---------------------------------------------------------------------------
  // 动作
  // ---------------------------------------------------------------------------

  async function doSave() {
    try {
      await saveCurrent();
    } catch (e) {
      void errorDialog("保存失败", String((e as Error).message ?? e));
    }
  }

  async function doStart() {
    try {
      await saveCurrent({ silent: true });
      await Frpc.start(state.currentProfile);
    } catch (e) {
      void errorDialog("无法启动", String((e as Error).message ?? e));
    }
  }

  async function doStop() {
    try {
      await Frpc.stop();
    } catch (e) {
      void errorDialog("停止失败", String((e as Error).message ?? e));
    }
  }

  async function doRestart() {
    try {
      await saveCurrent({ silent: true });
      await Frpc.restart(state.currentProfile);
    } catch (e) {
      void errorDialog("重启失败", String((e as Error).message ?? e));
    }
  }

  async function newProfile() {
    profileNameDialog({
      title: "新建配置",
      subtitle: "每个配置对应一个 toml 文件，用于连接不同的 frps",
      confirmText: "创建",
      existing: state.profiles.map((p) => p.name),
      allowCopy: true,
      copySource: state.currentProfile,
      onConfirm: async (name, copyFrom) => {
        try {
          await Profiles.create(name, copyFrom ?? "");
          await switchProfile(name);
          await refreshProfilesList();
        } catch (e) {
          void errorDialog("创建失败", String((e as Error).message ?? e));
        }
      },
    });
  }

  async function renameProfile() {
    const old = state.currentProfile;
    profileNameDialog({
      title: "重命名配置",
      subtitle: `把「${old}」重命名为`,
      confirmText: "重命名",
      initial: old,
      existing: state.profiles.map((p) => p.name).filter((n) => n !== old),
      onConfirm: async (name) => {
        try {
          await Profiles.rename(old, name);
          if (old === state.currentProfile) await switchProfile(name);
          await refreshProfilesList();
          // frpc 独立自启可能被 Go 端同步改名，刷新设置页显示
          state.saveNote = "";
          notify();
        } catch (e) {
          void errorDialog("重命名失败", String((e as Error).message ?? e));
        }
      },
    });
  }

  async function deleteProfile() {
    const name = state.currentProfile;
    if (name === "default") {
      void errorDialog("提示", "default 配置不允许删除");
      return;
    }
    if (!(await confirmDialog({
      title: "确认",
      message: `确定删除配置 [${name}] 吗？`,
      okText: "删除",
      danger: true,
    }))) {
      return;
    }
    try {
      await Profiles.delete(name);
      await switchProfile("default");
      await refreshProfilesList();
      notify();
    } catch (e) {
      void errorDialog("删除失败", String((e as Error).message ?? e));
    }
  }

  async function importToml() {
    let srcPath: string;
    try {
      srcPath = await Profiles.pickToml();
    } catch (e) {
      void errorDialog("导入失败", String((e as Error).message ?? e));
      return;
    }
    if (!srcPath) return;
    const suggested = (srcPath.split(/[\\/]/).pop() ?? "").replace(/\.toml$/i, "");
    profileNameDialog({
      title: "导入配置",
      subtitle: `从 ${srcPath.split(/[\\/]/).pop()} 导入为一个新的配置文件`,
      confirmText: "导入",
      initial: suggested,
      existing: state.profiles.map((p) => p.name),
      onConfirm: async (name) => {
        try {
          await Profiles.importToml(srcPath, name);
          await switchProfile(name);
          await refreshProfilesList();
        } catch (e) {
          void errorDialog("导入失败", String((e as Error).message ?? e));
        }
      },
    });
  }

  async function exportToml() {
    try {
      const path = await Profiles.exportToml(state.currentProfile);
      if (path) toast(`已导出到 ${path}`);
    } catch (e) {
      void errorDialog("导出失败", String((e as Error).message ?? e));
    }
  }

  async function refreshProfilesList() {
    state.profiles = await Profiles.list();
    notify();
  }

  // 切换 profile 后刷新代理表格
  onStoreChange(() => refreshProxiesTab());
}

void main();

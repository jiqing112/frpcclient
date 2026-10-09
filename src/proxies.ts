// 代理页：[[proxies]] 列表总览 + 新增/编辑/复制/删除。
// 编辑通过「代理对话框」完成，按代理类型只显示相关分区；
// 保存时校验并写回，取消不产生任何改动。

import { newProxyTemplate, entryValue, splitList, toInt, toBool,
  GROUP_TYPES, SECRET_TYPES, WEB_TYPES, type ProxyEntry } from "./types";
import { state, saveCurrent } from "./state";
import { openServerDialog } from "./server";
import { button, clear, confirmDialog, formatExpose, h, FormSection, modal, modalFooter } from "./ui";

export function proxiesTab(): HTMLElement {
  const root = h("div", { class: "tab-pane" });
  root.dataset.tab = "proxies";

  // ---- 服务器信息常驻卡 ----
  const serverAddr = h("span", { class: "server-addr" });
  const serverMeta = h("div", { class: "server-meta" });
  const serverCard = h(
    "div",
    { class: "server-card" },
    h(
      "div",
      { class: "server-info" },
      serverAddr,
      serverMeta,
    ),
    button("服务器配置", "outline", () => openServerDialog()),
  );

  const bar = h("div", { class: "toolbar" });
  const btnAdd = button("新增代理", "primary", () => void addProxy());
  const btnEdit = button("编辑", "outline", () => void editProxy());
  const btnDup = button("复制", "outline", () => void dupProxy());
  const btnDel = button("删除", "danger", () => void delProxy());
  bar.append(btnAdd, btnEdit, btnDup, btnDel);
  bar.append(h("div", { class: "toolbar-hint" }, "双击条目可直接编辑"));

  const tableCard = h("div", { class: "table-card" });
  const table = h("table", { class: "table" });
  const thead = h("thead", {}, h(
    "tr",
    {},
    h("th", { class: "col-type" }, "类型"),
    h("th", {}, "名称"),
    h("th", {}, "本地"),
    h("th", {}, "对外"),
  ));
  const tbody = h("tbody");
  table.append(thead, tbody);
  tableCard.append(table);
  const empty = h("div", { class: "table-empty" }, "还没有代理规则，点左上角「新增代理」添加");
  tableCard.append(empty);

  root.append(serverCard, bar, tableCard);

  let selected = -1;

  const proxies = (): ProxyEntry[] => (state.profileData.proxies ??= []);

  const render = () => {
    // 服务器信息卡（随当前 profile 刷新）
    const d = state.profileData;
    const auth = (d.auth ?? {}) as Record<string, unknown>;
    const tr = (d.transport ?? {}) as Record<string, unknown>;
    const tlsObj = (tr.tls ?? {}) as Record<string, unknown>;
    serverAddr.textContent = `${d.serverAddr ?? ""}:${d.serverPort ?? ""}`;
    const method = String(auth.method ?? "token") || "token";
    const hasToken = typeof auth.token === "string" && auth.token.trim() !== "";
    clear(serverMeta);
    serverMeta.append(
      h("span", { class: method === "token" && !hasToken ? "warn" : "" },
        method === "token" && !hasToken ? "token 认证（未设 Token）" : `${method} 认证`),
      h("span", {}, `${String(tr.protocol ?? "tcp") || "tcp"}${tlsObj.enable === true ? " · TLS" : ""}`),
    );

    clear(tbody);
    const list = proxies();
    empty.style.display = list.length ? "none" : "";
    list.forEach((p, i) => {
      const tr = h(
        "tr",
        { class: i === selected ? "selected" : "" },
        h("td", { class: "col-type" }, h("span", { class: "proxy-type" }, p.type ?? "tcp")),
        h("td", {}, p.name ?? ""),
        h("td", {}, `${p.localIP ?? ""}:${p.localPort ?? ""}`),
        h("td", {}, formatExpose(p)),
      );
      tr.addEventListener("click", () => {
        selected = i;
        render();
      });
      tr.addEventListener("dblclick", () => {
        selected = i;
        void editProxy();
      });
      tbody.append(tr);
    });
    const has = selected >= 0 && selected < list.length;
    btnEdit.disabled = !has;
    btnDup.disabled = !has;
    btnDel.disabled = !has;
  };

  const uniqueName = (base: string): string => {
    const names = new Set(proxies().map((p) => p.name));
    let name = base;
    let n = 1;
    while (names.has(name)) {
      n += 1;
      name = `${base}_${n}`;
    }
    return name;
  };

  const openDialog = async (proxy: ProxyEntry, title: string, apply: () => void) => {
    const others = new Set(proxies().filter((p) => p !== proxy).map((p) => p.name));
    const ok = await proxyDialog(proxy, title, others);
    if (ok) {
      apply();
      await saveCurrent();
    }
    render();
  };

  async function addProxy() {
    const p = newProxyTemplate("tcp");
    p.name = uniqueName(`proxy_${proxies().length + 1}`);
    await openDialog(p, "新增代理", () => {
      proxies().push(p);
      selected = proxies().length - 1;
    });
  }

  async function editProxy() {
    if (selected < 0) return;
    const proxy = proxies()[selected]!;
    await openDialog(proxy, `编辑代理 — ${proxy.name ?? ""}`, () => {});
  }

  async function dupProxy() {
    if (selected < 0) return;
    const src = proxies()[selected]!;
    const p = structuredClone(src) as ProxyEntry;
    p.name = uniqueName(`${p.name ?? "proxy"}_copy`);
    await openDialog(p, `复制代理 — ${src.name ?? ""}`, () => {
      proxies().push(p);
      selected = proxies().length - 1;
    });
  }

  async function delProxy() {
    if (selected < 0) return;
    const list = proxies();
    const name = list[selected]?.name || `#${selected + 1}`;
    if (!(await confirmDialog({ title: "确认", message: `删除代理 [${name}]？`, okText: "删除", danger: true }))) return;
    list.splice(selected, 1);
    selected = -1;
    await saveCurrent();
    render();
  }

  onTableRefresh(root, render);
  render();
  return root;
}

// 渲染联动：代理列表随 profileData 刷新（切配置后重建）
function onTableRefresh(root: HTMLElement, render: () => void) {
  root.dataset.refresh = "proxies";
  refreshers.add(render);
}

const refreshers = new Set<() => void>();

export function refreshProxiesTab() {
  refreshers.forEach((fn) => fn());
}

// ---------------------------------------------------------------------------
// 代理对话框
// ---------------------------------------------------------------------------

async function proxyDialog(proxy: ProxyEntry, title: string, others: Set<string>): Promise<boolean> {
  return new Promise((resolve) => {
    let saved = false;
    const m = modal({
      title,
      subtitle: "按代理类型显示对应的配置分区",
      width: 760,
      onClose: () => resolve(saved),
    });

    // ---- ① 基本信息 ----
    const s1 = new FormSection("① 基本信息");
    const nameInput = s1.field("名称", proxy.name ?? "", { hint: "必填，全局唯一" });
    const typeSel = s1.select(
      "类型",
      proxy.type ?? "tcp",
      ["tcp", "udp", "http", "https", "stcp", "sudp", "xtcp"],
      "决定显示哪些配置分区",
    );

    // ---- ② 网络映射 ----
    const s2 = new FormSection("② 网络映射");
    const ipInput = s2.field("本地 IP", proxy.localIP ?? "", { hint: "localIP，一般 127.0.0.1" });
    const localPort = s2.field("本地端口", entryValue(proxy.localPort), { hint: "localPort", width: 10 });
    const remoteInput = s2.field("远程端口", entryValue(proxy.remotePort), { hint: "remotePort，在 frps 上监听的端口", width: 10 });
    const remoteRow = remoteInput.closest(".form-row") as HTMLElement;
    s2.setRowVisible(remoteRow, proxy.type === "tcp" || proxy.type === "udp");

    // ---- ③ Web 域名与访问控制 ----
    const s3 = new FormSection("③ Web 域名与访问控制");
    const domainsInput = s3.field("自定义域名", entryValue(proxy.customDomains), { hint: "customDomains，多个用逗号分隔" });
    const subdomainInput = s3.field("Subdomain", proxy.subdomain ?? "", { hint: "subdomain，配合 frps 的 subdomainHost 使用" });
    const httpUserInput = s3.field("HTTP 账号", proxy.httpUser ?? "", { hint: "httpUser，可留空" });
    const httpPassInput = s3.field("HTTP 密码", proxy.httpPassword ?? "", { hint: "httpPassword，可留空" });
    const rewriteInput = s3.field("Host 改写", proxy.hostHeaderRewrite ?? "", { hint: "hostHeaderRewrite，发送给后端的 Host，可留空" });

    // ---- ④ 安全通道 ----
    const s4 = new FormSection("④ 安全通道");
    const secretInput = s4.field("密钥", proxy.secretKey ?? "", { hint: "secretKey，访问端需要相同密钥", width: 26 });

    // ---- ⑤ 分组 ----
    const s5 = new FormSection("⑤ 分组（可选）");
    const groupInput = s5.field("分组名", proxy.group ?? "", { hint: "group，同组代理在 frps 上负载均衡" });
    const groupKeyInput = s5.field("分组密钥", proxy.groupKey ?? "", { hint: "groupKey", width: 26 });

    // ---- ⑥ 传输选项 ----
    const s6 = new FormSection("⑥ 传输选项");
    const tr = proxy.transport ?? {};
    const encInput = s6.check("传输加密", toBool(tr.useEncryption), "transport.useEncryption");
    const compInput = s6.check("传输压缩", toBool(tr.useCompression), "transport.useCompression");

    const sections: Array<{ el: HTMLElement; types: string[] | null }> = [
      { el: s1.card, types: null },
      { el: s2.card, types: null },
      { el: s3.card, types: WEB_TYPES },
      { el: s4.card, types: SECRET_TYPES },
      { el: s5.card, types: GROUP_TYPES },
      { el: s6.card, types: null },
    ];
    const applyType = () => {
      const t = typeSel.value || "tcp";
      for (const s of sections) {
        s.el.style.display = s.types === null || s.types.includes(t) ? "" : "none";
      }
      s2.setRowVisible(remoteRow, t === "tcp" || t === "udp");
    };
    typeSel.addEventListener("change", applyType);
    applyType();

    m.body.append(...sections.map((s) => s.el));

    const { error, actions } = modalFooter(m.body);

    const save = () => {
      const name = nameInput.value.trim();
      if (!name) {
        error.textContent = "代理名称不能为空";
        return;
      }
      if (others.has(name)) {
        error.textContent = `代理名 [${name}] 已被其它代理使用`;
        return;
      }
      const ptype = typeSel.value || "tcp";
      const localPortN = toInt(localPort.value, 0);
      if (localPortN <= 0 || localPortN >= 65536) {
        error.textContent = "本地端口必须是 1-65535 的整数";
        return;
      }
      const remotePortN = toInt(remoteInput.value, 0);
      if ((ptype === "tcp" || ptype === "udp") && (remotePortN <= 0 || remotePortN >= 65536)) {
        error.textContent = "tcp/udp 代理必须填写远程端口（1-65535）";
        return;
      }
      writeBack(proxy, ptype, {
        name,
        localIP: ipInput.value.trim(),
        localPort: localPortN,
        remotePort: remotePortN,
        customDomains: splitList(domainsInput.value),
        subdomain: subdomainInput.value.trim(),
        httpUser: httpUserInput.value.trim(),
        httpPassword: httpPassInput.value.trim(),
        hostHeaderRewrite: rewriteInput.value.trim(),
        secretKey: secretInput.value.trim(),
        group: groupInput.value.trim(),
        groupKey: groupKeyInput.value.trim(),
        useEncryption: encInput.checked,
        useCompression: compInput.checked,
      });
      saved = true;
      m.close();
    };

    actions.append(button("取消", "outline", () => m.close()), button("保存", "primary", save));
  });
}

// 把表单值写回代理对象；与类型无关的键会被清除，保持配置干净。
function writeBack(
  p: ProxyEntry,
  ptype: string,
  v: {
    name: string; localIP: string; localPort: number; remotePort: number;
    customDomains: string[]; subdomain: string; httpUser: string; httpPassword: string;
    hostHeaderRewrite: string; secretKey: string; group: string; groupKey: string;
    useEncryption: boolean; useCompression: boolean;
  },
) {
  p.name = v.name;
  p.type = ptype;
  p.localIP = v.localIP;
  p.localPort = v.localPort;

  if (ptype === "tcp" || ptype === "udp") p.remotePort = v.remotePort;
  else delete p.remotePort;

  if (WEB_TYPES.includes(ptype)) {
    p.customDomains = v.customDomains;
    p.subdomain = v.subdomain;
    p.httpUser = v.httpUser;
    p.httpPassword = v.httpPassword;
    if (v.hostHeaderRewrite) p.hostHeaderRewrite = v.hostHeaderRewrite;
    else delete p.hostHeaderRewrite;
  } else {
    for (const k of ["customDomains", "subdomain", "httpUser", "httpPassword", "hostHeaderRewrite"] as const) {
      delete p[k];
    }
  }

  if (SECRET_TYPES.includes(ptype)) p.secretKey = v.secretKey;
  else delete p.secretKey;

  if (GROUP_TYPES.includes(ptype)) {
    p.group = v.group;
    p.groupKey = v.groupKey;
  } else {
    delete p.group;
    delete p.groupKey;
  }

  p.transport = { ...(p.transport ?? {}), useEncryption: v.useEncryption, useCompression: v.useCompression };
}

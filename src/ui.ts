// DOM 构建小工具与共享控件（按钮 / 徽章 / 表单分区 / 弹窗 / 提示）。

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") {
      el.addEventListener(k.replace(/^on/, "").toLowerCase(), v as (e: Event) => void);
    } else if (v === true) {
      el.setAttribute(k, "");
    } else if (v !== false && v !== null && v !== undefined) {
      el.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ---------------------------------------------------------------------------
// 按钮
// ---------------------------------------------------------------------------

export type ButtonKind = "primary" | "outline" | "ghost" | "danger" | "danger-outline";

export function button(
  text: string,
  kind: ButtonKind,
  onClick?: () => void,
): HTMLButtonElement {
  const b = h(
    "button",
    { class: `btn btn-${kind}`, type: "button", onclick: onClick ?? (() => {}) },
    text,
  );
  return b;
}

export function setEnabled(b: HTMLButtonElement, enabled: boolean) {
  b.disabled = !enabled;
}

// ---------------------------------------------------------------------------
// 徽章
// ---------------------------------------------------------------------------

export type BadgeTone = "muted" | "success" | "warn";

export function badge(text: string, tone: BadgeTone): HTMLElement {
  return h("span", { class: `badge badge-${tone}` }, text);
}

export function updateBadge(el: HTMLElement, text: string, tone: BadgeTone) {
  el.textContent = text;
  el.className = `badge badge-${tone}`;
}

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------

/** 一个表单分区：标题 + 若干行控件。 */
export class FormSection {
  readonly card: HTMLElement;
  private readonly body: HTMLElement;

  constructor(title: string) {
    this.card = h("div", { class: "form-card" });
    this.card.append(h("div", { class: "form-card-title" }, title));
    this.body = h("div", { class: "form-card-body" });
    this.card.append(this.body);
  }

  /** 文本输入行。返回 input。 */
  field(label: string, value: string, opts: { hint?: string; width?: number; type?: string } = {}): HTMLInputElement {
    const input = h("input", { class: "input", type: opts.type ?? "text" }) as HTMLInputElement;
    input.value = value;
    if (opts.width) input.style.width = `${opts.width}ch`;
    this.appendRow(label, input, opts.hint);
    return input;
  }

  /** 下拉行。返回 select。 */
  select(label: string, value: string, options: readonly string[], hint?: string): HTMLSelectElement {
    const sel = h("select", { class: "input select" }) as HTMLSelectElement;
    for (const opt of options) {
      sel.append(h("option", { value: opt }, opt));
    }
    sel.value = value;
    this.appendRow(label, sel, hint);
    return sel;
  }

  /** 复选框行。返回 checkbox（含 label 的容器）。 */
  check(label: string, checked: boolean, hint?: string, onChange?: (v: boolean) => void): HTMLInputElement {
    const input = h("input", { type: "checkbox", class: "checkbox" }) as HTMLInputElement;
    input.checked = checked;
    input.addEventListener("change", () => onChange?.(input.checked));
    const row = this.appendRow("", h("label", { class: "check-label" }, input, h("span", {}, label)), hint);
    row.classList.add("check-row");
    return input;
  }

  /** 追加一行自定义控件。 */
  appendRow(label: string, control: HTMLElement, hint?: string): HTMLElement {
    const row = h("div", { class: "form-row" });
    if (label) {
      row.append(h("label", { class: "form-label" }, label));
    }
    const right = h("div", { class: "form-control" }, control);
    if (hint) {
      right.append(h("div", { class: "form-hint" }, hint));
    }
    row.append(right);
    this.body.append(row);
    return row;
  }

  setRowVisible(row: HTMLElement, visible: boolean) {
    row.style.display = visible ? "" : "none";
  }
}

// ---------------------------------------------------------------------------
// 弹窗
// ---------------------------------------------------------------------------

export interface ModalHandle {
  close(): void;
  body: HTMLElement;
}

export function modal(opts: {
  title: string;
  subtitle?: string;
  width?: number;
  onClose?: () => void;
}): ModalHandle {
  const overlay = h("div", { class: "modal-overlay" });
  const card = h("div", { class: "modal-card" });
  if (opts.width) card.style.width = `${opts.width}px`;

  const head = h("div", { class: "modal-head" });
  head.append(h("div", { class: "modal-title" }, opts.title));
  if (opts.subtitle) head.append(h("div", { class: "modal-subtitle" }, opts.subtitle));
  card.append(head);

  const body = h("div", { class: "modal-body" });
  card.append(body);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  overlay.append(card);
  document.body.append(overlay);

  return { close, body };
}

/** 弹窗底部操作栏：左错误区 + 右按钮组。 */
export function modalFooter(parent: HTMLElement): { error: HTMLElement; actions: HTMLElement } {
  const footer = h("div", { class: "modal-footer" });
  const error = h("div", { class: "modal-error" });
  const actions = h("div", { class: "modal-actions" });
  footer.append(error, actions);
  parent.append(footer);
  return { error, actions };
}

/** Promise 化的确认对话框（替代 messagebox.askyesno）。 */
export function confirmDialog(opts: {
  title: string;
  message: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const m = modal({
      title: opts.title,
      width: 420,
      onClose: () => resolve(result),
    });
    const body = h("div", { class: "confirm-message" }, opts.message);
    m.body.append(body);
    const { actions } = modalFooter(m.body);
    actions.append(
      button(opts.cancelText ?? "取消", "outline", () => m.close()),
      button(opts.okText ?? "确定", opts.danger ? "danger" : "primary", () => {
        result = true;
        m.close();
      }),
    );
    m.body.querySelector<HTMLElement>(".modal-error")?.remove();
  });
}

/** 错误信息弹窗（替代 messagebox.showerror）。 */
export function errorDialog(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    const m = modal({ title, width: 480, onClose: resolve });
    m.body.append(h("div", { class: "confirm-message error-text" }, message));
    const { error, actions } = modalFooter(m.body);
    error.remove();
    actions.append(button("知道了", "primary", () => m.close()));
  });
}

// ---------------------------------------------------------------------------
// 提示（toast）
// ---------------------------------------------------------------------------

export function toast(message: string, kind: "info" | "error" = "info") {
  let host = document.querySelector<HTMLElement>(".toast-host");
  if (!host) {
    host = h("div", { class: "toast-host" });
    document.body.append(host);
  }
  const t = h("div", { class: `toast toast-${kind}` }, message);
  host.append(t);
  setTimeout(() => {
    t.classList.add("toast-out");
    setTimeout(() => t.remove(), 300);
  }, 3600);
}

// ---------------------------------------------------------------------------
// 其它
// ---------------------------------------------------------------------------

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function formatExpose(p: { type?: string; remotePort?: unknown; customDomains?: unknown; subdomain?: string }): string {
  const type = p.type ?? "";
  if (type === "tcp" || type === "udp") return `远程端口 ${p.remotePort ?? ""}`;
  if (type === "http" || type === "https") {
    const domains = Array.isArray(p.customDomains) ? p.customDomains.join(", ") : "";
    const sub = p.subdomain || "";
    return `域名 ${domains}` + (sub ? ` / sub ${sub}` : "");
  }
  if (["stcp", "sudp", "xtcp"].includes(type)) return "需密钥建立通道";
  return "";
}

// 配置命名对话框（新建 / 重命名 / 导入共用）。
// 校验内联提示；名称实时清洗并显示落盘路径。

import { sanitizeName } from "./types";
import { h, modal, modalFooter, button, FormSection } from "./ui";

export function profileNameDialog(opts: {
  title: string;
  subtitle: string;
  confirmText: string;
  initial?: string;
  existing: string[];
  allowCopy?: boolean;
  copySource?: string;
  onConfirm: (name: string, copyFrom: string | null) => void | Promise<void>;
}): void {
  const m = modal({ title: opts.title, subtitle: opts.subtitle, width: 460 });
  const existing = new Set(opts.existing);

  const nameInput = h("input", { class: "input", type: "text", spellcheck: "false" }) as HTMLInputElement;
  nameInput.value = opts.initial ?? "";
  const pathHint = h("div", { class: "form-hint" });
  const err = h("div", { class: "modal-error" });

  const section = new FormSection("配置名称");
  section.appendRow("", nameInput);
  section.appendRow("", pathHint);
  m.body.append(section.card, err);

  let copyMode = "blank";
  if (opts.allowCopy) {
    const sec = new FormSection("创建方式");
    const mkRadio = (value: string, label: string) => {
      const input = h("input", { type: "radio", name: "copy-mode", value }) as HTMLInputElement;
      input.checked = value === copyMode;
      input.addEventListener("change", () => {
        if (input.checked) copyMode = value;
      });
      const row = sec.appendRow("", h("label", { class: "check-label" }, input, h("span", {}, label)));
      row.classList.add("check-row");
    };
    mkRadio("blank", "空白配置（默认模板）");
    mkRadio("copy", `复制「${opts.copySource}」的完整配置（服务器 + 代理）`);
    m.body.append(sec.card);
  }

  const { error, actions } = modalFooter(m.body);
  error.replaceWith(err);

  const updateHint = () => {
    const raw = nameInput.value.trim();
    pathHint.textContent = raw
      ? `将保存为 profiles\\${sanitizeName(raw)}.toml`
      : "将保存为 profiles\\<名称>.toml";
  };
  nameInput.addEventListener("input", updateHint);
  updateHint();

  const confirm = async () => {
    const raw = nameInput.value.trim();
    if (!raw) {
      err.textContent = "请输入配置名称";
      return;
    }
    const name = sanitizeName(raw);
    if (existing.has(name)) {
      err.textContent = `名称 [${name}] 已存在，请换一个`;
      return;
    }
    const copyFrom = opts.allowCopy && copyMode === "copy" ? (opts.copySource ?? null) : null;
    m.close();
    await opts.onConfirm(name, copyFrom);
  };
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void confirm();
  });
  setTimeout(() => nameInput.focus(), 50);

  actions.append(button("取消", "outline", () => m.close()), button(opts.confirmText, "primary", () => void confirm()));
}

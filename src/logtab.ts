// 日志页：frpc 实时输出 + 自动滚动 / 清空 / 打开日志目录。

import { Settings } from "./mygo";
import { clearLogs, logLines, onStoreChange } from "./state";
import { button, h } from "./ui";

export function logTab(): HTMLElement {
  const root = h("div", { class: "tab-pane log-pane" });
  root.dataset.tab = "log";

  const bar = h("div", { class: "toolbar" });
  const autoScroll = h("input", { type: "checkbox", class: "checkbox", id: "autoscroll" }) as HTMLInputElement;
  autoScroll.checked = true;
  bar.append(
    h("label", { class: "check-label", for: "autoscroll" }, autoScroll, h("span", {}, "自动滚动到底部")),
    button("清空", "ghost", () => clearLogs()),
    button("打开日志目录", "outline", () => void Settings.openDir("logs")),
  );

  const console_ = h("div", { class: "log-console" });
  root.append(bar, console_);

  let follow = true;
  autoScroll.addEventListener("change", () => {
    follow = autoScroll.checked;
  });

  const render = () => {
    // 全量重建在 5000 行时会卡；仅当行数变化时追加/裁剪
    const count = console_.childElementCount;
    if (logLines.length > count) {
      const frag = document.createDocumentFragment();
      for (let i = count; i < logLines.length; i++) {
        const line = logLines[i]!;
        frag.append(h("div", { class: `log-line${line.system ? " log-system" : ""}` }, line.text || " "));
      }
      console_.append(frag);
    } else if (logLines.length < count) {
      while (console_.childElementCount > logLines.length) {
        console_.firstChild?.remove();
      }
    }
    if (follow) console_.scrollTop = console_.scrollHeight;
  };

  onStoreChange(render);
  render();
  return root;
}

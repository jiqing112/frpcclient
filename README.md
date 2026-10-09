# frpc 客户端（Go + mygo 桌面版）

一个运行在 Windows 10/11 上的 **frp 客户端图形管理工具**。
通过可视化编辑 toml 配置、管理 `frpc.exe` 进程的启停，实现 frps 内网穿透的可视化管理。

本版本使用 [mygo](https://github.com/egoist/mygo)（egoist 的 Go 桌面框架）重构：
Go 后端 + 系统 WebView2 渲染的 Web 前端，**无 cgo、单文件 ~9MB 的原生 exe**，
通过 mygo 生成的类型化 TypeScript 客户端调用 Go（编译期两侧类型校验）。
旧 Python/tkinter 版本的配置文件（settings.json、profiles/*.toml、logs/）**完全兼容，可直接沿用**。

## 功能特性

- **shadcn/ui 风格界面**：zinc 中性色扁平设计，微软雅黑 UI 字体，高 DPI 原生渲染
- **多 Profile（多服务器）切换**：每个 profile 对应一个 toml 文件、一台 frps
  （frpc 的 toml 只支持单服务器，多台服务器就建多个配置），左侧列表快速切换
- **服务器信息常驻卡**：代理页顶部显示当前配置的 frps 地址、认证与传输方式，
  一键打开服务器配置对话框（连接 / 认证 / 传输 / 日志 / webServer 表单化填写）；
  frpc 运行中保存会询问是否立即重启生效
- **代理（`[[proxies]]`）管理**：tcp / udp / http / https / stcp / sudp / xtcp，
  列表 + 弹窗编辑；按代理类型自动显隐相关配置分区，校验错误内联提示
- **修改即保存**：代理增删改、服务器配置保存立即落盘，顶栏显示「已保存 HH:MM:SS」
- **启动前校验**：地址/端口/代理名称唯一性/远程端口缺失或重复等，问题在启动前集中提示
- **实时日志**：frpc 输出经 IPC 事件推送前端，自动滚动 + 清空 + 打开日志目录
  （前端最多保留 5000 行；frpc 自身日志同时写入 logs/<profile>.log）
- **系统托盘**：左键点击显示主窗口，右键菜单可启停 frpc / 显示窗口 / 退出；
  关闭窗口缩到托盘，图标颜色随运行状态变化（绿=运行中，灰=已停止）
- **退出自动停止**：退出程序时自动停止 frpc（可在设置里关闭）
- **开机自启（两种）**：
  - 本 GUI 开机自启：mygo 内建 `SetOpenAtLogin`（注册表 `HKCU\...\Run`），
    登录后可自动连接当前 profile；
  - frpc 独立自启：由系统直接运行 frpc，与本软件互不依赖；本软件会自动识别
    独立进程并显示状态，「停止」可结束它，「重启」则接管为由 GUI 管理；
    修改该配置后启动文件自动同步，frpc 重启后生效
- **导入/导出 toml**：原生文件对话框；兼容已有 `frpc.toml`；UI 未覆盖的字段
  （plugin、healthCheck、tcpMux 等）在导入-导出回环中原样保留
- **单实例**：重复启动会把已有实例唤起到前台

## 目录结构

```
frpcclient/
├── main.go             # 入口：绑定服务、窗口、生命周期、单实例
├── service.go          # 绑定给前端的三个服务：Profiles / Settings / Frpc
│                       #   + core 编排（启停、外部进程扫描、状态/日志事件广播）
├── settings.go         # settings.json 读写（沿用旧版下划线键名）、frpc.exe 探测
├── profile.go          # profile(toml) 模型：读写/清理/校验/导入导出/启动文件
├── runner.go           # frpc.exe 进程封装（启停/日志/退出回调）
├── external_win.go     # 独立运行的 frpc 进程识别与结束（wmic/PowerShell/taskkill）
├── autostart_win.go    # frpc 独立开机自启（注册表 HKCU\...\Run）
├── tray.go             # 系统托盘（两态图标 + 右键菜单）
├── backend_test.go     # 后端测试（profile 回环/清理/校验 + frpc 真实启停冒烟）
├── resources/          # 应用图标 + 托盘两态图标
├── mygo.config.ts      # mygo 配置（devUrl、构建命令等）
├── index.html
├── src/                # 前端（TypeScript + Vite，无框架）
│   ├── main.ts         #   布局：顶栏/侧栏/hero/标签页 + 全局动作
│   ├── mygo.ts         #   mygo generate 生成的类型化客户端（勿手改）
│   ├── state.ts        #   集中状态 + 日志缓冲 + 保存动作
│   ├── proxies.ts      #   代理页（服务器信息卡 + 列表 + 弹窗编辑）
│   ├── server.ts       #   服务器配置对话框
│   ├── settingsTab.ts  #   设置页
│   ├── logtab.ts       #   日志页
│   ├── dialogs.ts      #   配置命名对话框（新建/重命名/导入）
│   ├── ui.ts           #   DOM 工具 + 按钮/徽章/表单/弹窗/toast
│   ├── mock.ts         #   浏览器调试替身（localStorage 模拟后端）
│   └── style.css       #   shadcn zinc 主题
└── frpc.exe、frpc.toml  # frp 客户端与你手头的 toml（程序会自动探测/兼容）
```

应用数据存放位置（与旧版一致，可用环境变量 `FRPCCLIENT_DATA_DIR` 覆盖）：

```
%APPDATA%\frpcclient\
├── settings.json              # 程序设置（键名与旧版相同）
├── profiles\*.toml            # 各个 profile 的 toml
└── logs\
    ├── <profile>.log          # frpc 实际日志
    └── <profile>.runtime.toml # 启动时实际喂给 frpc.exe 的 toml
```

## 运行环境

- **操作系统**：Windows 10 / 11（WebView2 Runtime，Win11 自带，
  Win10 缺失时从 [这里](https://developer.microsoft.com/microsoft-edge/webview2/) 安装）
- **Go**：1.27+（[go.dev/dl](https://go.dev/dl/)）
- **Node.js**：22.6+（npm 驱动前端工具链；装了 Bun 的话用 Bun 也可以）
- **frpc.exe**：[frp releases](https://github.com/fatedier/frp/releases) 下载；
  放在程序同目录会被自动探测，或在「设置」里手动指定

## 开发

```powershell
cd C:\Users\Administrator\Desktop\frpcclient
npm install
npm run dev
```

`mygo dev` 会：生成 `src/mygo.ts` 类型客户端 → 启动 Vite（127.0.0.1:5273）→
编译并启动桌面应用。修改 Go 文件自动重建重启，修改前端文件即时热更新。
右键页面可打开 WebView2 DevTools。

**纯浏览器调试**（无 Go 后端，mock 模式，数据存 localStorage）：

```powershell
npx vite        # 打开 http://127.0.0.1:5273
```

**后端测试**（含用真实 frpc.exe 的启停冒烟测试，未找到 frpc.exe 时自动跳过）：

```powershell
go test ./...
```

## 构建与分发

```powershell
npm run build
```

产出在 `build\windows-amd64\`：

- `frpcclient.exe`（~9MB，前端已嵌入，单文件即可运行）
- `frpcclient Setup 1.0.0.exe`（NSIS 安装器）

## 使用说明

首次使用：

1. 若 frpc.exe 不在程序目录，切到 **设置** 页点「浏览」选择路径
2. 点顶栏 **服务器配置**，填写 frps 地址、端口、token 后保存
3. 在 **代理** 页「新增代理」并填写本地服务映射
4. 点顶栏 **启动**；在 **日志** 页查看连接情况

从旧 Python 版升级：直接运行新版即可，配置文件位置与格式不变；
旧版本生成的配置会得到自动修正（客户端级 `transport` 下的
`useEncryption` / `useCompression` 会在保存时清除，避免新版 frpc 报 unknown field）。

## 常见问题

**Q：启动后报错「找不到 frpc.exe」？**
A：把 frpc.exe 放到本程序目录（会自动探测），或在「设置」页指定完整路径。

**Q：frpc 报 `unknown field "xxx"`？**
A：说明配置里有当前 frp 版本不支持的字段。本程序生成的配置已按 frp v0.52+ 的
TOML 结构生成；若是导入的旧 toml，请检查该字段是否属于你的 frp 版本。

**Q：GUI 开机自启指向的是哪个程序？**
A：注册表里记录的是当前可执行文件的路径。以 `go run`/`mygo dev` 方式运行时
注册的是开发版路径，正式使用请用 `npm run build` 的产物并以安装器安装，
随后在设置里关一次再开一次「开机自启」即可重写为新路径。

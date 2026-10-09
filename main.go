// frpcclient — frp 客户端图形管理工具（mygo 桌面版）。
//
// 结构：
//
//	main.go            入口：绑定服务、窗口、托盘、生命周期
//	settings.go        settings.json 与数据目录、frpc.exe 自动探测
//	profile.go         profile(toml) 模型：读写/清理/校验/导入导出
//	runner.go          frpc.exe 进程封装（启停/日志/退出回调）
//	external_win.go    独立运行的 frpc 进程识别与结束（Windows）
//	autostart_win.go   frpc 独立开机自启（注册表，Windows）
//	service.go         绑定给前端的 Profiles / Settings / Frpc 服务
//	tray.go            系统托盘
package main

import (
	"log"
	"os"

	"github.com/egoist/mygo"
)

func main() {
	app := mygo.App
	// 与 Python 版一致的数据目录（%AppData%\frpcclient），配置可直接沿用
	app.SetName("frpcclient")
	if dir := os.Getenv("FRPCCLIENT_DATA_DIR"); dir != "" {
		app.SetPath(mygo.PathUserData, dir)
	}

	core, err := newCore()
	if err != nil {
		log.Fatal(err)
	}

	mygo.Bind(&Profiles{core})
	mygo.Bind(&Settings{core})
	mygo.Bind(&Frpc{core})

	// 二次启动唤起已有实例
	if !app.RequestSingleInstanceLock() {
		return
	}
	app.OnSecondInstance(func(_ []string, _ string) { core.showWindow() })

	// 关闭窗口时若托盘在运行则保持后台；否则退出
	app.OnWindowAllClosed(func() {
		if !core.trayAlive() {
			app.Quit()
		}
	})
	// 退出前按设置停止本 GUI 管理的 frpc
	app.OnBeforeQuit(func(*mygo.QuitEvent) { core.beforeQuit() })

	app.WhenReady(func() { core.start() })

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

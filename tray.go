package main

import (
	_ "embed"
	"sync"

	"github.com/egoist/mygo"
)

//go:embed resources/tray-off.png
var trayIconOff []byte

//go:embed resources/tray-on.png
var trayIconOn []byte

// trayController 管理系统托盘图标：
// 左键显示主窗口，右键弹出菜单（启停 frpc / 退出）。
type trayController struct {
	mu      sync.Mutex
	tray    *mygo.Tray
	running bool

	onShow   func()
	onToggle func()
	onQuit   func()
}

func newTrayController(onShow, onToggle, onQuit func()) *trayController {
	return &trayController{onShow: onShow, onToggle: onToggle, onQuit: onQuit}
}

func (t *trayController) started() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.tray != nil
}

// start 创建托盘图标（已存在时是 no-op）。
func (t *trayController) start() error {
	t.mu.Lock()
	if t.tray != nil {
		t.mu.Unlock()
		return nil
	}
	t.mu.Unlock()

	tr, err := mygo.NewTray(mygo.TrayOptions{
		Icon:    trayIconOff,
		ToolTip: "frpc 客户端",
	})
	if err != nil {
		return err
	}
	tr.OnClick(func() {
		if t.onShow != nil {
			t.onShow()
		}
	})
	// 右键弹出菜单；平时不设菜单，左键留给「显示主窗口」
	tr.OnRightClick(func() {
		tr.SetMenu(t.buildMenu())
		tr.PopUpMenu()
		tr.SetMenu(nil)
	})

	t.mu.Lock()
	t.tray = tr
	t.mu.Unlock()
	return nil
}

func (t *trayController) buildMenu() *mygo.Menu {
	t.mu.Lock()
	running := t.running
	t.mu.Unlock()

	toggleLabel := "○ frpc 已停止（点击启动）"
	if running {
		toggleLabel = "● frpc 运行中（点击停止）"
	}
	return mygo.NewMenu([]*mygo.MenuItem{
		{Label: "显示主窗口", Click: func(*mygo.MenuItem, *mygo.Window) {
			if t.onShow != nil {
				t.onShow()
			}
		}},
		{Label: toggleLabel, Click: func(*mygo.MenuItem, *mygo.Window) {
			if t.onToggle != nil {
				t.onToggle()
			}
		}},
		mygo.Separator(),
		{Label: "退出", Click: func(*mygo.MenuItem, *mygo.Window) {
			if t.onQuit != nil {
				t.onQuit()
			}
		}},
	})
}

// stop 移除托盘图标。
func (t *trayController) stop() {
	t.mu.Lock()
	tr := t.tray
	t.tray = nil
	t.mu.Unlock()
	if tr != nil {
		tr.Destroy()
	}
}

// setRunning 更新托盘图标颜色（绿=运行中，灰=已停止）。
func (t *trayController) setRunning(running bool) {
	t.mu.Lock()
	tr := t.tray
	t.running = running
	t.mu.Unlock()
	if tr == nil {
		return
	}
	icon := trayIconOff
	tip := "frpc 客户端（已停止）"
	if running {
		icon = trayIconOn
		tip = "frpc 客户端（运行中）"
	}
	_ = tr.SetIcon(icon, false)
	tr.SetToolTip(tip)
}

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
)

// ---------------------------------------------------------------------------
// 事件（Go → 页面）
// ---------------------------------------------------------------------------

// LogLinesEvent 实时日志行（frpc 输出与系统提示）。
var LogLinesEvent = mygo.NewEvent[[]string]("logLines")

// StatusEvent 运行状态快照（启动/停止/外部进程变化时广播）。
var StatusEvent = mygo.NewEvent[Status]("statusChanged")

// Status 是 frpc 的运行状态快照。
type Status struct {
	Running      bool   `json:"running"` // 本 GUI 管理的进程在运行
	External     bool   `json:"external"`
	PID          int    `json:"pid"`
	ExternalPIDs []int  `json:"externalPids"`
	Profile      string `json:"profile"`
}

// ---------------------------------------------------------------------------
// core：应用状态与编排
// ---------------------------------------------------------------------------

type core struct {
	settings *settingsStore
	profiles *profileStore
	runner   *frpcRunner
	tray     *trayController

	win      atomic.Pointer[mygo.Window]
	quitting atomic.Bool

	mu     sync.Mutex // 保护 extPIDs 与代际
	extPIDs []int
	gen    atomic.Int64
	busy   atomic.Bool // 后台扫描进行中
}

func newCore() (*core, error) {
	st, err := loadSettings()
	if err != nil {
		return nil, err
	}
	c := &core{
		settings: st,
		profiles: &profileStore{},
		runner:   &frpcRunner{},
	}
	// 启动时自动探测 frpc.exe（程序目录、当前目录）
	c.autodetectFrpcExe()
	c.tray = newTrayController(c.showWindow, c.trayToggle, func() { mygo.App.Quit() })
	return c, nil
}

// start 在应用就绪后创建窗口、托盘并启动后台任务。
func (c *core) start() {
	win := mygo.NewWindow(mygo.WindowOptions{
		Title:           "frpc 控制台",
		Width:           1120,
		Height:          740,
		MinWidth:        980,
		MinHeight:       640,
		BackgroundColor: "#FAFAFA",
		StateKey:        "main",
		URL:             "/",
	})
	c.win.Store(win)

	win.OnClose(func(e *mygo.CloseEvent) {
		// 关闭按钮缩到托盘；退出流程中的关闭不拦截
		if !c.quitting.Load() && c.settings.Get().MinimizeToTray && c.tray.started() {
			e.PreventDefault()
			win.Hide()
		}
	})

	if c.settings.Get().MinimizeToTray {
		if err := c.tray.start(); err != nil {
			c.systemLog("[系统] 托盘创建失败：" + err.Error())
		}
	}

	c.runner.setCallbacks(c.onRunnerLog, c.onRunnerExit)

	// 周期扫描独立运行的 frpc（开机自启等）
	go func() {
		c.scanExternalAsync()
		for {
			time.Sleep(3 * time.Second)
			if c.quitting.Load() {
				return
			}
			c.scanExternalAsync()
		}
	}()

	// 开机自启（GUI）：静默连接当前 profile；
	// 若 frpc 已被系统独立启动，startFrpc 内部会拒绝并记录日志
	if mygo.App.WasOpenedAtLogin() && c.settings.Get().AutoReconnect {
		go func() {
			if err := c.startFrpc(c.currentProfile(), true); err != nil {
				c.systemLog("[系统] 自动启动取消：" + err.Error())
			}
		}()
	}
}

func (c *core) showWindow() {
	if win := c.win.Load(); win != nil {
		win.Show()
		win.Focus()
	}
}

func (c *core) beforeQuit() {
	c.quitting.Store(true)
	if c.runner.IsRunning() && c.settings.Get().StopOnExit {
		c.runner.stop(3 * time.Second)
		c.systemLog("[系统] 应用退出，frpc 已自动停止")
	}
}

func (c *core) trayAlive() bool {
	return c.settings.Get().MinimizeToTray && c.tray.started()
}

// ---------------------------------------------------------------------------
// 日志与状态广播
// ---------------------------------------------------------------------------

func (c *core) systemLog(line string) {
	_ = LogLinesEvent.Broadcast([]string{line})
}

func (c *core) onRunnerLog(line string) {
	_ = LogLinesEvent.Broadcast([]string{line})
}

func (c *core) onRunnerExit(code int) {
	c.broadcastStatus()
	c.tray.setRunning(c.runner.IsRunning())
	if !c.runner.IsRunning() && code != 0 {
		c.systemLog(fmt.Sprintf("[系统] frpc 异常退出 (code=%d)，请检查日志", code))
	}
}

func (c *core) statusSnapshot() Status {
	st := Status{ExternalPIDs: []int{}}
	if c.runner.IsRunning() {
		st.Running = true
		st.PID = c.runner.PID()
		st.Profile = c.runner.Profile()
	} else {
		c.mu.Lock()
		st.ExternalPIDs = slices.Clone(c.extPIDs)
		c.mu.Unlock()
		st.External = len(st.ExternalPIDs) > 0
	}
	return st
}

func (c *core) broadcastStatus() {
	_ = StatusEvent.Broadcast(c.statusSnapshot())
}

func (c *core) traySetRunning(running bool) {
	c.tray.setRunning(running)
}

// ---------------------------------------------------------------------------
// profile 辅助
// ---------------------------------------------------------------------------

func (c *core) currentProfile() string {
	name := c.settings.Get().CurrentProfile
	if name == "" {
		name = "default"
	}
	names, _ := c.profiles.list()
	if slices.Contains(names, name) {
		return name
	}
	if len(names) > 0 {
		return names[0]
	}
	return "default"
}

func (c *core) autodetectFrpcExe() {
	st := c.settings.Get()
	if st.FrpcExe != "" && fileExists(st.FrpcExe) {
		return
	}
	if found := findFrpcExe(); found != "" && found != st.FrpcExe {
		_ = c.settings.SetFrpcExe(found)
	}
}

func (c *core) resolveFrpcExe() (string, error) {
	st := c.settings.Get()
	if st.FrpcExe != "" && fileExists(st.FrpcExe) {
		return st.FrpcExe, nil
	}
	if found := findFrpcExe(); found != "" {
		if found != st.FrpcExe {
			_ = c.settings.SetFrpcExe(found)
		}
		return found, nil
	}
	return "", errors.New("找不到 frpc.exe，请到「设置」页指定路径")
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// ---------------------------------------------------------------------------
// frpc 进程控制（供 Frpc 服务与托盘共用）
// ---------------------------------------------------------------------------

// startFrpc 校验并启动当前配置的 frpc；silent 时错误只写日志（自动启动场景）。
func (c *core) startFrpc(profile string, silent bool) error {
	err := c.doStart(profile)
	if err != nil && silent {
		c.systemLog("[系统] " + err.Error())
		return nil
	}
	return err
}

func (c *core) doStart(profile string) error {
	if c.runner.IsRunning() {
		return errors.New("frpc 已在运行，请先停止再启动。")
	}
	if c.externalRunning() {
		return errors.New("frpc 已作为独立进程运行（开机自启）。\n点「重启」可由本软件接管，或先「停止」再启动。")
	}
	exe, err := c.resolveFrpcExe()
	if err != nil {
		return err
	}
	data, err := c.profiles.load(profile)
	if err != nil {
		return err
	}
	if errs := validateProfile(data); len(errs) > 0 {
		return errors.New("配置有误，无法启动：\n" + strings.Join(errs, "\n"))
	}
	tomlPath, err := c.profiles.materializeRuntime(profile)
	if err != nil {
		return err
	}
	if err := c.runner.start(exe, tomlPath, profile); err != nil {
		return err
	}
	c.broadcastStatus()
	c.traySetRunning(true)
	return nil
}

func (c *core) externalRunning() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.extPIDs) > 0
}

// stopFrpc 停止本 GUI 管理的进程，或结束独立运行的 frpc。
func (c *core) stopFrpc() {
	if c.runner.IsRunning() {
		c.runner.stop(5 * time.Second)
	} else if c.externalRunning() {
		// 重新扫描再结束，避免旧 PID 已被系统复用而误杀无关进程
		fresh := findFrpcProcesses(c.logsMarker(), c.runner.PID())
		if len(fresh) > 0 {
			pids := extPIDs(fresh)
			terminatePIDs(pids)
			c.systemLog(fmt.Sprintf("[系统] 已结束独立运行的 frpc (pid=%s)", joinInts(pids)))
		}
		// 作废在途扫描结果；若 kill 未生效，周期扫描会自动纠正状态
		c.gen.Add(1)
		c.mu.Lock()
		c.extPIDs = nil
		c.mu.Unlock()
	}
	c.broadcastStatus()
	c.traySetRunning(false)
}

// restartFrpc 重启：未在管理运行时先接管（结束独立进程）再启动。
func (c *core) restartFrpc(profile string) error {
	if !c.runner.IsRunning() {
		if c.externalRunning() {
			c.mu.Lock()
			pids := slices.Clone(c.extPIDs)
			c.mu.Unlock()
			terminatePIDs(pids)
			c.gen.Add(1)
			c.mu.Lock()
			c.extPIDs = nil
			c.mu.Unlock()
			c.broadcastStatus()
		}
		return c.doStart(profile)
	}
	exe, err := c.resolveFrpcExe()
	if err != nil {
		return err
	}
	tomlPath, err := c.profiles.materializeRuntime(profile)
	if err != nil {
		return err
	}
	if err := c.runner.restart(exe, tomlPath, profile); err != nil {
		return err
	}
	c.broadcastStatus()
	c.traySetRunning(c.runner.IsRunning())
	return nil
}

func (c *core) trayToggle() {
	if c.runner.IsRunning() {
		c.stopFrpc()
		return
	}
	if err := c.startFrpc(c.currentProfile(), true); err != nil {
		c.systemLog("[系统] " + err.Error())
	}
}

// ---------------------------------------------------------------------------
// 外部 frpc 扫描
// ---------------------------------------------------------------------------

func (c *core) logsMarker() string {
	dir, err := c.profiles.logsDir()
	if err != nil {
		return ""
	}
	return dir
}

func (c *core) scanExternalAsync() {
	if c.runner.IsRunning() {
		return
	}
	if !c.busy.CompareAndSwap(false, true) {
		return
	}
	gen := c.gen.Add(1)
	marker := c.logsMarker()
	runnerPID := c.runner.PID()

	go func() {
		defer c.busy.Store(false)
		found := findFrpcProcesses(marker, runnerPID)
		pids := extPIDs(found)

		c.mu.Lock()
		if gen != c.gen.Load() {
			c.mu.Unlock() // 扫描期间发生过停止/接管，结果作废
			return
		}
		changed := !slices.Equal(pids, c.extPIDs)
		var logs []string
		if changed {
			if len(pids) > 0 && len(c.extPIDs) == 0 {
				logs = append(logs, fmt.Sprintf("[系统] 检测到独立运行的 frpc (pid=%s)", joinInts(pids)))
			} else if len(c.extPIDs) > 0 && len(pids) == 0 {
				logs = append(logs, "[系统] 独立运行的 frpc 已退出")
			}
			c.extPIDs = pids
		}
		c.mu.Unlock()

		for _, l := range logs {
			c.systemLog(l)
		}
		if changed {
			c.broadcastStatus()
		}
	}()
}

func extPIDs(procs []extProcess) []int {
	out := make([]int, 0, len(procs))
	for _, p := range procs {
		out = append(out, p.PID)
	}
	return out
}

func joinInts(xs []int) string {
	parts := make([]string, len(xs))
	for i, x := range xs {
		parts[i] = fmt.Sprint(x)
	}
	return strings.Join(parts, ",")
}

// ---------------------------------------------------------------------------
// Profiles 服务
// ---------------------------------------------------------------------------

// ProfileSummary 是侧栏里的 profile 概要。
type ProfileSummary struct {
	Name       string `json:"name"`
	ServerAddr string `json:"serverAddr"`
	ServerPort int    `json:"serverPort"`
}

// Profiles 是配置文件管理服务，前端通过 Profiles.* 调用。
type Profiles struct{ c *core }

// List 列出全部 profile（保证 default 存在）。
func (p *Profiles) List() ([]ProfileSummary, error) {
	names, err := p.c.profiles.list()
	if err != nil {
		return nil, err
	}
	out := make([]ProfileSummary, 0, len(names))
	for _, n := range names {
		addr, port := p.c.profiles.profileAddr(n)
		out = append(out, ProfileSummary{Name: n, ServerAddr: addr, ServerPort: port})
	}
	return out, nil
}

// Get 读取一个 profile 的完整数据（toml 内容，未知字段原样保留）。
func (p *Profiles) Get(name string) (map[string]any, error) {
	return p.c.profiles.load(name)
}

// Save 保存 profile；frpc 独立自启指向它时同步刷新启动文件。
func (p *Profiles) Save(name string, data map[string]any) error {
	if strings.TrimSpace(name) == "" {
		return errors.New("配置名称不能为空")
	}
	if err := p.c.profiles.save(name, data); err != nil {
		return err
	}
	st := p.c.settings.Get()
	if st.FrpcAutostart && st.FrpcAutostartProfile == name {
		_, _ = p.c.profiles.materializeRuntime(name)
	}
	return nil
}

// Create 新建 profile；copyFrom 非空时复制其完整配置。
func (p *Profiles) Create(name, copyFrom string) error {
	path, err := p.c.profiles.profilePath(name)
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("名称 [%s] 已存在，请换一个", name)
	}
	if copyFrom != "" {
		data, err := p.c.profiles.load(copyFrom)
		if err != nil {
			return err
		}
		return p.c.profiles.save(name, data)
	}
	return p.c.profiles.save(name, newEmptyProfile())
}

// Rename 重命名 profile；frpc 独立自启指向旧名时同步更新记录与启动项。
func (p *Profiles) Rename(oldName, newName string) error {
	if newName == oldName {
		return nil
	}
	newPath, err := p.c.profiles.profilePath(newName)
	if err != nil {
		return err
	}
	if _, err := os.Stat(newPath); err == nil {
		return fmt.Errorf("名称 [%s] 已存在，请换一个", newName)
	}
	if err := p.c.profiles.rename(oldName, newName); err != nil {
		return err
	}
	st := p.c.settings.Get()
	if st.FrpcAutostartProfile == oldName {
		st.FrpcAutostartProfile = newName
		if err := p.c.settings.Save(st); err != nil {
			return err
		}
		if st.FrpcAutostart {
			if exe, err := p.c.resolveFrpcExe(); err == nil {
				if tomlPath, err := p.c.profiles.materializeRuntime(newName); err == nil {
					_ = setFrpcAutostart(exe, tomlPath)
				}
			}
		}
	}
	return nil
}

// Delete 删除 profile；default 不允许删除。frpc 独立自启指向它时一并注销。
func (p *Profiles) Delete(name string) error {
	if name == "default" {
		return errors.New("default 配置不允许删除")
	}
	if err := p.c.profiles.remove(name); err != nil {
		return err
	}
	st := p.c.settings.Get()
	if st.FrpcAutostartProfile == name {
		_ = clearFrpcAutostart()
		st.FrpcAutostart = false
		st.FrpcAutostartProfile = ""
		if err := p.c.settings.Save(st); err != nil {
			return err
		}
	}
	return nil
}

// PickToml 打开原生文件选择框，返回选中的 toml 路径（取消返回空串）。
func (p *Profiles) PickToml(ctx context.Context) (string, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:      mygo.CallerWindow(ctx),
		Title:       "选择要导入的 frpc.toml",
		Filters:     []mygo.FileFilter{{Name: "TOML", Extensions: []string{"toml"}}},
	})
	if err != nil {
		return "", err
	}
	if len(paths) == 0 {
		return "", nil
	}
	return paths[0], nil
}

// ImportToml 把一个 toml 文件导入为新 profile。
func (p *Profiles) ImportToml(srcPath, name string) error {
	return p.c.profiles.importToml(srcPath, name)
}

// ExportToml 弹出保存框并导出 profile，返回目标路径（取消返回空串）。
func (p *Profiles) ExportToml(ctx context.Context, name string) (string, error) {
	path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
		Parent:      mygo.CallerWindow(ctx),
		Title:       "导出到 toml 文件",
		DefaultPath: name + ".toml",
		Filters:     []mygo.FileFilter{{Name: "TOML", Extensions: []string{"toml"}}},
	})
	if err != nil || path == "" {
		return "", err
	}
	if err := p.c.profiles.exportToml(name, path); err != nil {
		return "", err
	}
	return path, nil
}

// SafeName 把 profile 名清洗成可安全做文件名的形式（对话框提示用）。
func (p *Profiles) SafeName(name string) string {
	return sanitizeName(name)
}

// ---------------------------------------------------------------------------
// Settings 服务
// ---------------------------------------------------------------------------

// SaveSettingsResult 是保存设置后的反馈。
type SaveSettingsResult struct {
	AutostartError       string `json:"autostartError"`
	FrpcAutostartError   string `json:"frpcAutostartError"`
	SuggestStartDetached bool   `json:"suggestStartDetached"`
}

// Settings 是程序设置服务。
type Settings struct{ c *core }

// Get 读取全部设置。
func (s *Settings) Get() SettingsData {
	return s.c.settings.Get()
}

// Save 覆盖全部设置，并处理开机自启与 frpc 独立自启的注册。
func (s *Settings) Save(v SettingsData) (SaveSettingsResult, error) {
	res := SaveSettingsResult{}
	old := s.c.settings.Get()

	// GUI 开机自启（mygo 内建：注册表 Run 项）
	if v.Autostart != old.Autostart || mygo.App.OpenAtLogin() != v.Autostart {
		if err := mygo.App.SetOpenAtLogin(v.Autostart); err != nil {
			res.AutostartError = err.Error()
		}
	}

	// frpc 独立开机自启
	if !v.FrpcAutostart {
		if err := clearFrpcAutostart(); err != nil {
			res.FrpcAutostartError = err.Error()
		}
		v.FrpcAutostartProfile = ""
	} else {
		exe := v.FrpcExe
		if exe == "" || !fileExists(exe) {
			exe = findFrpcExe()
		}
		if exe == "" || !fileExists(exe) {
			res.FrpcAutostartError = "找不到 frpc.exe，请先在上方指定 frpc 路径"
			v.FrpcAutostart = false
			v.FrpcAutostartProfile = ""
		} else {
			v.FrpcExe = exe
			v.FrpcAutostartProfile = s.c.currentProfile()
			tomlPath, err := s.c.profiles.materializeRuntime(v.FrpcAutostartProfile)
			if err != nil {
				res.FrpcAutostartError = err.Error()
				v.FrpcAutostart = false
				v.FrpcAutostartProfile = ""
			} else if err := setFrpcAutostart(exe, tomlPath); err != nil {
				res.FrpcAutostartError = err.Error()
				v.FrpcAutostart = false
				v.FrpcAutostartProfile = ""
			} else {
				res.SuggestStartDetached = true
			}
		}
	}

	if err := s.c.settings.Save(v); err != nil {
		return res, err
	}

	// 托盘跟随设置
	if v.MinimizeToTray && !s.c.tray.started() {
		if err := s.c.tray.start(); err != nil {
			res.AutostartError = errors.New("托盘创建失败：" + err.Error()).Error()
		}
	} else if !v.MinimizeToTray && s.c.tray.started() {
		s.c.tray.stop()
	}
	return res, nil
}

// SetCurrentProfile 记住当前 profile。
func (s *Settings) SetCurrentProfile(name string) error {
	return s.c.settings.SetCurrentProfile(name)
}

// BrowseFrpcExe 打开文件选择框选择 frpc.exe（取消返回空串）。
func (s *Settings) BrowseFrpcExe(ctx context.Context) (string, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:      mygo.CallerWindow(ctx),
		Title:       "选择 frpc.exe",
		Filters:     []mygo.FileFilter{{Name: "frpc.exe", Extensions: []string{"exe"}}},
	})
	if err != nil {
		return "", err
	}
	if len(paths) == 0 {
		return "", nil
	}
	return paths[0], nil
}

// OpenDir 打开数据目录（"data"）或日志目录（"logs"）。
func (s *Settings) OpenDir(which string) error {
	var dir string
	var err error
	if which == "logs" {
		dir, err = s.c.profiles.logsDir()
	} else {
		dir, err = mygo.App.Path(mygo.PathUserData)
	}
	if err != nil {
		return err
	}
	return mygo.Shell.OpenPath(dir)
}

// ---------------------------------------------------------------------------
// Frpc 服务
// ---------------------------------------------------------------------------

// Frpc 是 frpc 进程控制服务。
type Frpc struct{ c *core }

// Status 返回当前运行状态。
func (f *Frpc) Status() Status {
	return f.c.statusSnapshot()
}

// Start 校验并启动一个 profile。
func (f *Frpc) Start(profile string) error {
	return f.c.startFrpc(profile, false)
}

// Stop 停止 frpc（含结束独立进程）。
func (f *Frpc) Stop() error {
	f.c.stopFrpc()
	return nil
}

// Restart 重启 frpc；独立运行时先接管。
func (f *Frpc) Restart(profile string) error {
	return f.c.restartFrpc(profile)
}

// StartDetached 以独立进程启动当前配置的 frpc（不随本 GUI 退出而结束）。
func (f *Frpc) StartDetached(profile string) error {
	c := f.c
	if c.runner.IsRunning() {
		return errors.New("frpc 正由本软件管理，请先「停止」后再以独立方式启动。")
	}
	if c.externalRunning() {
		return errors.New("frpc 已在独立运行，无需重复启动。")
	}
	exe, err := c.resolveFrpcExe()
	if err != nil {
		return err
	}
	data, err := c.profiles.load(profile)
	if err != nil {
		return err
	}
	if errs := validateProfile(data); len(errs) > 0 {
		return errors.New("配置有误，无法启动：\n" + strings.Join(errs, "\n"))
	}
	tomlPath, err := c.profiles.materializeRuntime(profile)
	if err != nil {
		return err
	}
	pid, err := startDetached(exe, tomlPath, "")
	if err != nil {
		return fmt.Errorf("启动失败：%w", err)
	}
	c.systemLog(fmt.Sprintf("[系统] frpc 已作为独立进程启动 (pid=%d)，关闭本软件后仍会继续运行", pid))
	c.mu.Lock()
	c.extPIDs = []int{pid}
	c.mu.Unlock()
	c.broadcastStatus()
	return nil
}

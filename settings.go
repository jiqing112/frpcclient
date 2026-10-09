package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/egoist/mygo"
)

// SettingsData 是前端可见的设置（IPC 上用 camelCase）。
type SettingsData struct {
	FrpcExe              string `json:"frpcExe"`
	CurrentProfile       string `json:"currentProfile"`
	MinimizeToTray       bool   `json:"minimizeToTray"`
	Autostart            bool   `json:"autostart"`
	AutoReconnect        bool   `json:"autoReconnect"`
	StopOnExit           bool   `json:"stopOnExit"`
	FrpcAutostart        bool   `json:"frpcAutostart"`
	FrpcAutostartProfile string `json:"frpcAutostartProfile"`
}

// defaultSettings 与 Python 版的 DEFAULT_SETTINGS 一致。
var defaultSettings = SettingsData{
	CurrentProfile: "default",
	MinimizeToTray: true,
	AutoReconnect:  true,
	StopOnExit:     true,
}

// settingsStore 读写 settings.json。文件沿用 Python 版的下划线键名，
// 新旧版本可以互相读取同一份配置。
type settingsStore struct {
	mu   sync.Mutex
	path string
	data SettingsData
}

func loadSettings() (*settingsStore, error) {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return nil, err
	}
	s := &settingsStore{path: filepath.Join(dir, "settings.json"), data: defaultSettings}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return s, nil // 首次运行没有配置文件
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return s, nil
	}
	getStr := func(key string) string { v, _ := m[key].(string); return v }
	getBool := func(key string) bool { v, _ := m[key].(bool); return v }
	d := defaultSettings
	if v := getStr("frpc_exe"); v != "" || m["frpc_exe"] != nil {
		d.FrpcExe = v
	}
	d.CurrentProfile = getStr("current_profile")
	d.MinimizeToTray = getBool("minimize_to_tray")
	d.Autostart = getBool("autostart")
	d.AutoReconnect = getBool("auto_reconnect")
	d.StopOnExit = getBool("stop_on_exit")
	d.FrpcAutostart = getBool("frpc_autostart")
	d.FrpcAutostartProfile = getStr("frpc_autostart_profile")
	s.data = d
	return s, nil
}

// Get 返回设置的副本。
func (s *settingsStore) Get() SettingsData {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data
}

// Save 覆盖全部设置并落盘。
func (s *settingsStore) Save(d SettingsData) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = d
	return s.writeLocked()
}

// SetCurrentProfile 只更新当前 profile（切换时的高频轻量操作）。
func (s *settingsStore) SetCurrentProfile(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.CurrentProfile = name
	return s.writeLocked()
}

// SetFrpcExe 只更新 frpc.exe 路径（自动探测后的持久化）。
func (s *settingsStore) SetFrpcExe(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.FrpcExe = path
	return s.writeLocked()
}

func (s *settingsStore) writeLocked() error {
	m := map[string]any{
		"frpc_exe":               s.data.FrpcExe,
		"current_profile":        s.data.CurrentProfile,
		"minimize_to_tray":       s.data.MinimizeToTray,
		"autostart":              s.data.Autostart,
		"auto_reconnect":         s.data.AutoReconnect,
		"stop_on_exit":           s.data.StopOnExit,
		"frpc_autostart":         s.data.FrpcAutostart,
		"frpc_autostart_profile": s.data.FrpcAutostartProfile,
	}
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, raw, 0o644)
}

// findFrpcExe 在常见位置自动探测 frpc.exe（程序目录、当前目录）。
func findFrpcExe() string {
	roots := []string{}
	if exe, err := os.Executable(); err == nil {
		roots = append(roots, filepath.Dir(exe))
	}
	if cwd, err := os.Getwd(); err == nil {
		roots = append(roots, cwd)
	}
	for _, dir := range roots {
		candidate := filepath.Join(dir, "frpc.exe")
		if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
			return candidate
		}
	}
	return ""
}

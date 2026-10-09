package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
)

// useTempDataDir 把数据目录指到本测试专属的临时目录，不碰真实 %AppData%。
func useTempDataDir(t *testing.T) {
	t.Helper()
	mygo.App.SetPath(mygo.PathUserData, t.TempDir())
}

func newTestStore(t *testing.T) *profileStore {
	t.Helper()
	useTempDataDir(t)
	return &profileStore{}
}

func TestProfileRoundTripKeepsUnknownFields(t *testing.T) {
	s := newTestStore(t)

	src := map[string]any{
		"serverAddr": "10.0.0.1",
		"serverPort": 7500,
		"customTop":  "kept",
		"transport": map[string]any{
			"protocol": "kcp",
			"tcpMux":   true, // UI 未覆盖的字段应保留
		},
		"proxies": []any{
			map[string]any{
				"name": "web", "type": "http", "localPort": int64(80),
				"customDomains": []any{"a.com"},
				"healthCheck":   map[string]any{"enable": true},
			},
		},
	}
	if err := s.save("roundtrip", src); err != nil {
		t.Fatal(err)
	}
	got, err := s.load("roundtrip")
	if err != nil {
		t.Fatal(err)
	}
	if got["customTop"] != "kept" {
		t.Errorf("顶层未知字段丢失: %v", got["customTop"])
	}
	tr := asMap(got["transport"])
	if tr == nil || tr["tcpMux"] != true {
		t.Errorf("transport.tcpMux 丢失: %v", tr)
	}
	proxies := asSlice(got["proxies"])
	if len(proxies) != 1 {
		t.Fatalf("proxies 数量错误: %d", len(proxies))
	}
	p0 := asMap(proxies[0])
	if asMap(p0["healthCheck"]) == nil {
		t.Errorf("代理的 healthCheck 丢失")
	}
	if got["serverAddr"] != "10.0.0.1" {
		t.Errorf("serverAddr 错误: %v", got["serverAddr"])
	}
}

func TestCleanRemovesEmptyButKeepsZero(t *testing.T) {
	s := newTestStore(t)
	data := map[string]any{
		"serverAddr": "", // 空串应被剔除
		"serverPort": 0,  // 0 应保留
		"user":       "",
		"transport":  map[string]any{},
		"proxies":    []any{},
	}
	if err := s.save("clean", data); err != nil {
		t.Fatal(err)
	}
	dir, err := s.profilesDir()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "clean.toml"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if strings.Contains(text, "serverAddr") || strings.Contains(text, "user") || strings.Contains(text, "[transport]") {
		t.Errorf("空值未被剔除:\n%s", text)
	}
	if !strings.Contains(text, "serverPort = 0") {
		t.Errorf("0 值不应被剔除:\n%s", text)
	}
}

func TestValidateProfile(t *testing.T) {
	data := newEmptyProfile()
	if errs := validateProfile(data); len(errs) != 0 {
		t.Errorf("默认模板应通过校验: %v", errs)
	}
	data["proxies"] = []any{
		map[string]any{"name": "a", "type": "tcp", "localPort": int64(80), "remotePort": int64(7000)},
		map[string]any{"name": "a", "type": "tcp", "localPort": int64(81), "remotePort": int64(7000)},
		map[string]any{"name": "", "type": "udp", "localPort": int64(82), "remotePort": int64(0)},
	}
	errs := validateProfile(data)
	if len(errs) != 4 {
		t.Errorf("应报 4 个错误（重名/远程端口重复/空名/udp 缺远程端口），得到 %d: %v", len(errs), errs)
	}
}

func TestListEnsuresDefault(t *testing.T) {
	s := newTestStore(t)
	names, err := s.list()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, n := range names {
		if n == "default" {
			found = true
		}
	}
	if !found {
		t.Errorf("list 应保证 default 存在: %v", names)
	}
}

// TestRunnerStartStop 用真实 frpc.exe（若可找到）做启停冒烟测试。
func TestRunnerStartStop(t *testing.T) {
	useTempDataDir(t)
	exe := findFrpcExe()
	if exe == "" {
		t.Skip("未找到 frpc.exe，跳过")
	}
	s := newTestStore(t)
	if err := s.save("smoke", newEmptyProfile()); err != nil {
		t.Fatal(err)
	}
	tomlPath, err := s.materializeRuntime("smoke")
	if err != nil {
		t.Fatal(err)
	}

	r := &frpcRunner{}
	lines := make(chan string, 64)
	exited := make(chan struct{})
	r.setCallbacks(func(line string) {
		select {
		case lines <- line:
		default:
		}
	}, func(int) { close(exited) })

	if err := r.start(exe, tomlPath, "smoke"); err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	if !r.IsRunning() {
		t.Fatal("启动后应处于运行状态")
	}
	// 读到至少一行日志或进程退出（frpc 连不上 frps 也会先打日志）
	deadline := time.After(10 * time.Second)
	got := false
	for !got {
		select {
		case <-lines:
			got = true
		case <-exited:
			got = true
		case <-deadline:
			t.Fatal("10 秒内未收到任何日志")
		}
	}
	if r.stop(5 * time.Second) == false {
		t.Fatal("stop 后进程应已退出")
	}
	if r.IsRunning() {
		t.Fatal("stop 后 IsRunning 应为 false")
	}
}

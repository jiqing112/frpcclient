package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/BurntSushi/toml"
	"github.com/egoist/mygo"
)

// profileStore 管理 profiles/ 目录下的 toml 文件。
//
// 与 Python 版一致：
//   - 每个 profile 对应一个 toml 文件；
//   - 保存时递归剔除空字符串/空表/空列表；
//   - UI 未覆盖的字段（plugin、healthCheck、tcpMux 等）原样保留。
type profileStore struct {
	mu sync.Mutex
}

var nameSanitizer = regexp.MustCompile(`[\\/:*?"<>|]`)

// sanitizeName 把 profile 名清洗成可安全用于 Windows 文件名的形式。
func sanitizeName(name string) string {
	s := strings.TrimSpace(nameSanitizer.ReplaceAllString(name, "_"))
	if s == "" {
		return "default"
	}
	return s
}

func (p *profileStore) profilesDir() (string, error) {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "profiles")
	if err := os.MkdirAll(path, 0o755); err != nil {
		return "", err
	}
	return path, nil
}

func (p *profileStore) logsDir() (string, error) {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "logs")
	if err := os.MkdirAll(path, 0o755); err != nil {
		return "", err
	}
	return path, nil
}

func (p *profileStore) profilePath(name string) (string, error) {
	dir, err := p.profilesDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, sanitizeName(name)+".toml"), nil
}

func (p *profileStore) frpcLogPath(name string) (string, error) {
	dir, err := p.logsDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, sanitizeName(name)+".log"), nil
}

// ---------------------------------------------------------------------------
// 默认模板
// ---------------------------------------------------------------------------

// newEmptyProfile 新建 profile 的默认模板（未启用 webServer；TLS 默认开启）。
func newEmptyProfile() map[string]any {
	return map[string]any{
		"serverAddr":    "127.0.0.1",
		"serverPort":    7000,
		"loginFailExit": false,
		"auth":          map[string]any{"method": "token", "token": ""},
		"transport": map[string]any{
			"protocol":          "tcp",
			"tls":               map[string]any{"enable": true},
			"heartbeatInterval": 30,
			"heartbeatTimeout":  90,
		},
		"log":     map[string]any{"level": "info", "maxDays": 3},
		"proxies": []any{},
	}
}

// newProxyTemplate 生成一个新代理的默认字段集合。
func newProxyTemplate(proxyType string) map[string]any {
	base := map[string]any{
		"name":     "new_proxy",
		"type":     proxyType,
		"localIP":  "127.0.0.1",
		"localPort": 80,
		"transport": map[string]any{"useEncryption": false, "useCompression": false},
	}
	switch proxyType {
	case "tcp", "udp":
		base["remotePort"] = 6000
	case "http", "https":
		base["customDomains"] = []any{}
	case "stcp", "sudp", "xtcp":
		base["secretKey"] = ""
	}
	return base
}

// ---------------------------------------------------------------------------
// 值清理与转换
// ---------------------------------------------------------------------------

// normalizeToml 把 BurntSushi 解码出的类型归一成 map[string]any / []any：
// 表数组（[[proxies]]）会解码成 []map[string]any，若不归一，
// asSlice 会把代理列表当成 nil 丢掉。
func normalizeToml(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, x := range t {
			t[k] = normalizeToml(x)
		}
		return t
	case []map[string]any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = normalizeToml(x)
		}
		return out
	case []any:
		for i, x := range t {
			t[i] = normalizeToml(x)
		}
		return t
	default:
		return v
	}
}

// cleanValue 递归剔除空字符串/空表/空列表（保留 false、0 等有意义的值）。
func cleanValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			c := cleanValue(x)
			if !isEmptyVal(c) {
				out[k] = c
			}
		}
		return out
	case []any:
		out := make([]any, 0, len(t))
		for _, x := range t {
			c := cleanValue(x)
			if !isEmptyVal(c) {
				out = append(out, c)
			}
		}
		return out
	default:
		return v
	}
}

func isEmptyVal(v any) bool {
	switch t := v.(type) {
	case string:
		return t == ""
	case map[string]any:
		return len(t) == 0
	case []any:
		return len(t) == 0
	}
	return false
}

// toInt 把 toml/JSON 里的数值宽容地转成 int。
func toInt(v any, def int) int {
	switch t := v.(type) {
	case int:
		return t
	case int64:
		return int(t)
	case uint64:
		return int(t)
	case float64:
		return int(t)
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil {
			return n
		}
	}
	return def
}

func toStr(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return ""
	default:
		return fmt.Sprint(t)
	}
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

// load 读取一个 profile；文件不存在则返回带示例代理的默认模板。
// 与 Python 版相同，以默认模板打底合并，补齐缺键并保留模板之外的顶层字段。
func (p *profileStore) load(name string) (map[string]any, error) {
	path, err := p.profilePath(name)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		data := newEmptyProfile()
		proxy := newProxyTemplate("tcp")
		proxy["name"] = "proxy_1"
		data["proxies"] = []any{proxy}
		return data, nil
	}
	var data map[string]any
	if _, err := toml.DecodeFile(path, &data); err != nil {
		return nil, fmt.Errorf("无法解析 toml 文件 %s：%w", path, err)
	}
	if data == nil {
		return nil, fmt.Errorf("toml 文件内容不是有效的配置结构：%s", path)
	}
	normalizeToml(data)

	merged := newEmptyProfile()
	for k, dv := range merged {
		if k == "proxies" {
			continue
		}
		if dm, ok := dv.(map[string]any); ok {
			if src := asMap(data[k]); src != nil {
				for sk, sv := range src {
					dm[sk] = sv
				}
			}
		} else if src, ok := data[k]; ok {
			merged[k] = src
		}
	}
	for k, v := range data {
		if k == "proxies" {
			continue
		}
		if _, ok := merged[k]; !ok {
			merged[k] = v
		}
	}

	proxies := asSlice(data["proxies"])
	clean := make([]any, 0, len(proxies))
	for _, x := range proxies {
		if asMap(x) != nil {
			clean = append(clean, x)
		}
	}
	merged["proxies"] = clean
	return merged, nil
}

// save 写入 profile（先清理空值）。
func (p *profileStore) save(name string, data map[string]any) error {
	path, err := p.profilePath(name)
	if err != nil {
		return err
	}
	cleaned, _ := cleanValue(data).(map[string]any)
	if cleaned == nil {
		cleaned = map[string]any{}
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return toml.NewEncoder(f).Encode(cleaned)
}

// list 列出全部 profile 名（保证 default 存在）。
func (p *profileStore) list() ([]string, error) {
	dir, err := p.profilesDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		fn := e.Name()
		if strings.EqualFold(filepath.Ext(fn), ".toml") {
			files = append(files, strings.TrimSuffix(fn, filepath.Ext(fn)))
		}
	}
	hasDefault := false
	for _, f := range files {
		if f == "default" {
			hasDefault = true
			break
		}
	}
	if !hasDefault {
		if err := p.save("default", newEmptyProfile()); err != nil {
			return nil, err
		}
		files = append(files, "default")
	}
	sort.Strings(files)
	return files, nil
}

func (p *profileStore) remove(name string) error {
	path, err := p.profilePath(name)
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); err == nil {
		return os.Remove(path)
	}
	return nil
}

func (p *profileStore) rename(oldName, newName string) error {
	data, err := p.load(oldName)
	if err != nil {
		return err
	}
	if err := p.save(newName, data); err != nil {
		return err
	}
	return p.remove(oldName)
}

func (p *profileStore) importToml(srcPath, name string) error {
	var data map[string]any
	if _, err := toml.DecodeFile(srcPath, &data); err != nil {
		return fmt.Errorf("toml 解析失败：%w", err)
	}
	if data == nil {
		return errors.New("toml 内容不是有效的配置结构")
	}
	normalizeToml(data)
	return p.save(name, data)
}

func (p *profileStore) exportToml(name, dstPath string) error {
	data, err := p.load(name)
	if err != nil {
		return err
	}
	cleaned, _ := cleanValue(data).(map[string]any)
	f, err := os.Create(dstPath)
	if err != nil {
		return err
	}
	defer f.Close()
	return toml.NewEncoder(f).Encode(cleaned)
}

// materializeRuntime 把 profile 落成实际喂给 frpc.exe 的 toml（logs 目录下），
// 并强制把 frpc 日志重定向到 logs 目录，便于统一收集。
func (p *profileStore) materializeRuntime(name string) (string, error) {
	data, err := p.load(name)
	if err != nil {
		return "", err
	}
	logPath, err := p.frpcLogPath(name)
	if err != nil {
		return "", err
	}
	logSec := asMap(data["log"])
	if logSec == nil {
		logSec = map[string]any{}
		data["log"] = logSec
	}
	logSec["to"] = logPath
	out, err := p.logsDir()
	if err != nil {
		return "", err
	}
	outPath := filepath.Join(out, sanitizeName(name)+".runtime.toml")
	f, err := os.Create(outPath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if err := toml.NewEncoder(f).Encode(cleanValue(data)); err != nil {
		return "", err
	}
	return outPath, nil
}

// profileAddr 读取配置里的 frps 地址（侧栏副标题用，失败返回占位）。
func (p *profileStore) profileAddr(name string) (string, int) {
	data, err := p.load(name)
	if err != nil {
		return "", 0
	}
	return toStr(data["serverAddr"]), toInt(data["serverPort"], 0)
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

// validate 启动前校验，返回中文错误信息列表（空表示通过）。
func validateProfile(data map[string]any) []string {
	var errs []string

	if strings.TrimSpace(toStr(data["serverAddr"])) == "" {
		errs = append(errs, "服务器地址（serverAddr）不能为空")
	}
	if port := toInt(data["serverPort"], 0); port <= 0 || port >= 65536 {
		errs = append(errs, "服务器端口（serverPort）必须是 1-65535 的整数")
	}

	proxies := asSlice(data["proxies"])
	seenNames := map[string]bool{}
	seenRemote := map[int]string{}
	for i, raw := range proxies {
		proxy := asMap(raw)
		if proxy == nil {
			continue
		}
		ptype := toStr(proxy["type"])
		if ptype == "" {
			ptype = "tcp"
		}
		name := strings.TrimSpace(toStr(proxy["name"]))
		tag := fmt.Sprintf("代理#%d(%s)", i+1, orDefault(name, "未命名"))
		if name == "" {
			errs = append(errs, tag+"：名称（name）不能为空")
		} else if seenNames[name] {
			errs = append(errs, tag+"：名称与其它代理重复")
		} else {
			seenNames[name] = true
		}

		if _, has := proxy["localPort"]; has && asMap(proxy["plugin"]) == nil {
			if lp := toInt(proxy["localPort"], 0); lp <= 0 || lp >= 65536 {
				errs = append(errs, tag+"：本地端口（localPort）无效")
			}
		}

		if ptype == "tcp" || ptype == "udp" {
			rp := toInt(proxy["remotePort"], 0)
			switch {
			case rp <= 0 || rp >= 65536:
				errs = append(errs, tag+"：tcp/udp 代理必须填写有效的远程端口（remotePort）")
			case seenRemote[rp] != "":
				errs = append(errs, fmt.Sprintf("%s：远程端口 %d 与代理[%s] 重复", tag, rp, seenRemote[rp]))
			default:
				seenRemote[rp] = orDefault(name, fmt.Sprintf("#%d", i+1))
			}
		}
	}
	return errs
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

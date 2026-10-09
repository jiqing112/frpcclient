//go:build windows

package main

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

const (
	createNoWindow     = 0x08000000
	createNewProcessGr = 0x00000200
)

// hideConsole 让子进程不弹出控制台黑窗。
func hideConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// hideConsoleDetached 启动脱离本 GUI 生命周期的子进程（独立 frpc）。
func hideConsoleDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow | createNewProcessGr,
	}
}

// extProcess 是一个正在运行的 frpc 进程。
type extProcess struct {
	PID     int    `json:"pid"`
	Cmdline string `json:"cmdline"`
}

// findFrpcProcesses 查找命令行里包含 marker（我们的 logs 目录）的 frpc 进程。
func findFrpcProcesses(marker string, excludePID int) []extProcess {
	out := queryProcessList()
	var found []extProcess
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(strings.ToLower(line), "node,") {
			continue
		}
		idx := strings.LastIndex(line, ",")
		if idx < 0 {
			continue
		}
		cmdline := strings.Trim(line[:idx], `"`)
		pid, err := strconv.Atoi(strings.TrimSpace(line[idx+1:]))
		if err != nil || (excludePID != 0 && pid == excludePID) {
			continue
		}
		if marker != "" && strings.Contains(cmdline, marker) {
			found = append(found, extProcess{PID: pid, Cmdline: cmdline})
		}
	}
	return found
}

// queryProcessList 查询 frpc 进程的命令行文本。
// 优先 wmic（Win10 自带）；新版 Win11 已移除 wmic 时回退 PowerShell。
func queryProcessList() string {
	if out, err := runHidden(15*time.Second, "wmic", "process", "where", "name='frpc.exe'",
		"get", "ProcessId,CommandLine", "/format:csv"); err == nil && out != "" {
		return out
	}
	out, _ := runHidden(20*time.Second, "powershell", "-NoProfile", "-Command",
		`Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" | `+
			`ForEach-Object { '"{0}",{1}' -f $_.CommandLine, $_.ProcessId }`)
	return out
}

func runHidden(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return decodeConsoleOutput(out), nil
}

// decodeConsoleOutput 中文版 Windows 的控制台输出为 GBK。
func decodeConsoleOutput(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	if s, err := simplifiedchinese.GBK.NewDecoder().Bytes(b); err == nil {
		return string(s)
	}
	return string(b)
}

// terminatePIDs 强制结束外部 frpc 进程。
func terminatePIDs(pids []int) {
	for _, pid := range pids {
		cmd := exec.Command("taskkill", "/F", "/PID", strconv.Itoa(pid))
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		_ = cmd.Run()
	}
}

// startDetached 启动一个不随本 GUI 退出而结束的 frpc 进程，返回 pid。
func startDetached(exe, tomlPath, workDir string) (int, error) {
	cmd := exec.Command(exe, "-c", tomlPath)
	hideConsoleDetached(cmd)
	cmd.Dir = workDir
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release() // 不 Wait，交给系统
	return pid, nil
}

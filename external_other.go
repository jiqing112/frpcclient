//go:build !windows

package main

import (
	"errors"
	"os/exec"
)

// 非 Windows 平台的占位实现：本工具面向 Windows（frpc.exe），这里保证可编译。

func hideConsole(cmd *exec.Cmd)       {}
func hideConsoleDetached(*exec.Cmd)   {}

type extProcess struct {
	PID     int    `json:"pid"`
	Cmdline string `json:"cmdline"`
}

func findFrpcProcesses(marker string, excludePID int) []extProcess { return nil }

func terminatePIDs(pids []int) {}

func startDetached(exe, tomlPath, workDir string) (int, error) {
	cmd := exec.Command(exe, "-c", tomlPath)
	cmd.Dir = workDir
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	return pid, nil
}

var errWindowsOnly = errors.New("此功能仅支持 Windows")

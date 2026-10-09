package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// frpcRunner 封装一个由本 GUI 管理的 frpc.exe 进程：
// 启停、实时日志（经 onLog 回调投递）、退出回调。
//
// 退出只由读日志 goroutine（唯一调用 Wait 的地方）触发一次；
// Stop 只是结束进程并等待它退出。
type frpcRunner struct {
	mu      sync.Mutex
	cmd     *exec.Cmd
	profile string
	done    chan struct{} // 进程退出后关闭

	onLog  func(line string)
	onExit func(code int)
}

func (r *frpcRunner) setCallbacks(onLog func(string), onExit func(int)) {
	r.onLog = onLog
	r.onExit = onExit
}

func (r *frpcRunner) IsRunning() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.isRunningLocked()
}

func (r *frpcRunner) isRunningLocked() bool {
	return r.cmd != nil && r.cmd.Process != nil && r.cmd.ProcessState == nil
}

// PID 返回运行中进程的 pid，未运行返回 0。
func (r *frpcRunner) PID() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.isRunningLocked() {
		return r.cmd.Process.Pid
	}
	return 0
}

// Profile 返回正在运行的 profile 名。
func (r *frpcRunner) Profile() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.isRunningLocked() {
		return r.profile
	}
	return ""
}

// start 启动 frpc.exe -c <toml>。日志行经 onLog 投递，退出时 onExit 触发一次。
func (r *frpcRunner) start(exe, tomlPath, profile string) error {
	r.mu.Lock()
	if r.isRunningLocked() {
		r.mu.Unlock()
		return errors.New("frpc 已在运行，请先停止再启动。")
	}
	if exe == "" {
		r.mu.Unlock()
		return errors.New("找不到 frpc.exe，请到「设置」页指定路径")
	}
	if st, err := os.Stat(exe); err != nil || st.IsDir() {
		r.mu.Unlock()
		return fmt.Errorf("找不到 frpc.exe：%s", exe)
	}
	if st, err := os.Stat(tomlPath); err != nil || st.IsDir() {
		r.mu.Unlock()
		return fmt.Errorf("找不到配置文件：%s", tomlPath)
	}

	cmd := exec.Command(exe, "-c", tomlPath)
	hideConsole(cmd)
	cmd.Dir = filepath.Dir(exe)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		r.mu.Unlock()
		return fmt.Errorf("启动 frpc 失败：%w", err)
	}
	if err := cmd.Start(); err != nil {
		r.mu.Unlock()
		return fmt.Errorf("启动 frpc 失败：%w", err)
	}
	r.cmd = cmd
	r.profile = profile
	r.done = make(chan struct{})
	done := r.done
	proc := cmd.Process
	r.mu.Unlock()

	r.emitLog(fmt.Sprintf("[系统] 已启动 frpc，profile = %s (pid=%d)", profile, proc.Pid))

	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if line != "" {
				r.emitLog(line)
			}
		}
		code := -1
		if err := cmd.Wait(); err == nil {
			code = cmd.ProcessState.ExitCode()
		} else if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		r.mu.Lock()
		r.cmd = nil
		r.profile = ""
		r.mu.Unlock()
		close(done)
		r.emitLog(fmt.Sprintf("[系统] frpc 进程退出，code = %d", code))
		if r.onExit != nil {
			r.onExit(code)
		}
	}()
	return nil
}

// stop 结束进程并等待退出，最多等 timeout。
func (r *frpcRunner) stop(timeout time.Duration) bool {
	r.mu.Lock()
	cmd := r.cmd
	done := r.done
	running := r.isRunningLocked()
	r.mu.Unlock()

	if cmd == nil || cmd.Process == nil {
		return true
	}
	if running {
		_ = cmd.Process.Kill()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(timeout):
		}
	}
	return !r.IsRunning()
}

// restart 停止旧进程后以新配置启动。
func (r *frpcRunner) restart(exe, tomlPath, profile string) error {
	r.stop(5 * time.Second)
	for i := 0; i < 10 && r.IsRunning(); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	return r.start(exe, tomlPath, profile)
}

func (r *frpcRunner) emitLog(line string) {
	if r.onLog != nil {
		r.onLog(line)
	}
}

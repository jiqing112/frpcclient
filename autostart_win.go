//go:build windows

package main

import (
	"errors"

	"golang.org/x/sys/windows/registry"
)

const (
	runKeyPath = `Software\Microsoft\Windows\CurrentVersion\Run`
	// frpcAutostartEntry 是 frpc 独立自启在注册表 Run 里的值名（与 Python 版一致）。
	frpcAutostartEntry = "frpcclient-frpc"
)

// frpcAutostartValue 读取 frpc 独立自启项内容，未设置返回空串。
func frpcAutostartValue() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, err := k.GetStringValue(frpcAutostartEntry)
	if err != nil {
		return ""
	}
	return v
}

// setFrpcAutostart 写入 frpc 的自启项：frpc.exe -c <runtime toml>。
func setFrpcAutostart(exe, tomlPath string) error {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(frpcAutostartEntry, `"`+exe+`" -c "`+tomlPath+`"`)
}

// clearFrpcAutostart 注销 frpc 独立自启项。
func clearFrpcAutostart() error {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if err := k.DeleteValue(frpcAutostartEntry); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

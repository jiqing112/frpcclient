//go:build !windows

package main

// 非 Windows 平台的占位实现。

func frpcAutostartValue() string { return "" }

func setFrpcAutostart(exe, tomlPath string) error { return nil }

func clearFrpcAutostart() error { return nil }

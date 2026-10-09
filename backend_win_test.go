//go:build windows

package main

import (
	"testing"
)

func TestSanitizeName(t *testing.T) {
	cases := map[string]string{
		"abc":         "abc",
		`a\b/c:d*e?f`: "a_b_c_d_e_f",
		"  ":          "default",
		"":            "default",
		"中文名":          "中文名",
	}
	for in, want := range cases {
		if got := sanitizeName(in); got != want {
			t.Errorf("sanitizeName(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestFrpcAutostartRegistry 往真实 HKCU Run 写入再清除（结束时无残留）。
func TestFrpcAutostartRegistry(t *testing.T) {
	toml := t.TempDir() + `\smoke.runtime.toml`
	if err := setFrpcAutostart(`C:\fake\frpc.exe`, toml); err != nil {
		t.Fatal(err)
	}
	if got := frpcAutostartValue(); got == "" {
		t.Fatal("写入后应能读到自启项")
	}
	if err := clearFrpcAutostart(); err != nil {
		t.Fatal(err)
	}
	if got := frpcAutostartValue(); got != "" {
		t.Errorf("清除后应读不到自启项，得到 %q", got)
	}
}

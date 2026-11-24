package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func candidate(t *testing.T, dir string) string {
	t.Helper()
	f, err := os.CreateTemp(dir, ".candidate-*")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return f.Name()
}

func TestNormalize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "coverage.out")
	original := "mode: atomic\na.go:1.1,2.1 2 0\nb.go:3.1,4.2 1 0\na.go:1.1,2.1 2 5\na.go:1.1,2.1 2 7\n"
	if err := os.WriteFile(path, []byte(original), 0640); err != nil {
		t.Fatal(err)
	}
	temp := candidate(t, filepath.Dir(path))
	if err := normalize(path, temp, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(temp); !os.IsNotExist(err) {
		t.Fatalf("candidate remains: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "mode: atomic\na.go:1.1,2.1 2 12\nb.go:3.1,4.2 1 0\n"
	if string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0640 {
		t.Fatalf("mode: %v, %v", info, err)
	}
}

func TestFailurePreservesProfile(t *testing.T) {
	maxInt := int(^uint(0) >> 1)
	for name, original := range map[string]string{
		"header":        "mode: count\na.go:1.1,2.1 2 1\n",
		"empty":         "mode: atomic\n",
		"broken":        "mode: atomic\na.go:1.1,2.1 2 1\nbad\n",
		"range":         "mode: atomic\na.go:2.1,1.1 2 1\n",
		"statements":    "mode: atomic\na.go:1.1,2.1 2 1\na.go:1.1,2.1 3 2\n",
		"overflow":      fmt.Sprintf("mode: atomic\na.go:1.1,2.1 2 %d\na.go:1.1,2.1 2 1\n", maxInt),
		"line too long": "mode: atomic\n" + strings.Repeat("a", 1024*1024) + "\n",
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "profile")
			if err := os.WriteFile(path, []byte(original), 0600); err != nil {
				t.Fatal(err)
			}
			temp := candidate(t, dir)
			if err := normalize(path, temp, nil); err == nil {
				t.Fatal("expected failure")
			}
			got, err := os.ReadFile(path)
			if err != nil || string(got) != original {
				t.Fatalf("profile changed: %v", err)
			}
			files, err := os.ReadDir(dir)
			if err != nil || len(files) != 1 {
				t.Fatalf("temporary file leaked: %v %v", files, err)
			}
		})
	}
}

func TestInterruptedPreservesProfile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "profile")
	original := "mode: atomic\na.go:1.1,2.1 2 1\n"
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	interrupt := make(chan os.Signal, 1)
	interrupt <- os.Interrupt
	temp := candidate(t, dir)
	if err := normalize(path, temp, interrupt); err == nil {
		t.Fatal("expected interruption")
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != original {
		t.Fatalf("profile changed: %v", err)
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 1 {
		t.Fatalf("temporary file leaked: %v %v", files, err)
	}
}

func TestRejectInvalidCandidate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "profile")
	original := "mode: atomic\na.go:1.1,2.1 2 1\n"
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	outside := candidate(t, t.TempDir())
	alias := filepath.Join(dir, "alias")
	if err := os.Link(path, alias); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	for _, temp := range []string{path, outside, alias, link, filepath.Join(dir, "missing")} {
		if err := normalize(path, temp, nil); err == nil {
			t.Fatalf("accepted invalid candidate %q", temp)
		}
		got, err := os.ReadFile(path)
		if err != nil || string(got) != original {
			t.Fatalf("profile changed: %v", err)
		}
	}
}

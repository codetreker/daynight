package local

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSiblingNamespaceIsolationAndPruning(t *testing.T) {
	storage, root := newStorage(t)
	const bucket = "task-attachments"
	const project = "10000000-0000-4000-8000-000000000001"
	const otherProject = "10000000-0000-4000-8000-000000000002"
	owners := []struct{ project, shard, task string }{
		{project, "ab", "ab000000-0000-4000-8000-000000000001"},
		{project, "ab", "ab000000-0000-4000-8000-000000000002"},
		{project, "cd", "cd000000-0000-4000-8000-000000000003"},
		{otherProject, "ab", "ab000000-0000-4000-8000-000000000004"},
	}
	const name = "文档 space/same%_?#.bin"
	contents := [][]byte{{0, 255, 1}, {0, 255, 2}, {0, 255, 3}, {0, 255, 4}}
	namespace := func(index int) string {
		owner := owners[index]
		return owner.project + "/" + owner.shard + "/" + owner.task
	}
	assertContent := func(index int) {
		t.Helper()
		path := namespace(index) + "/" + name
		if got := read(t, storage, bucket, path); !bytes.Equal(got, contents[index]) {
			t.Fatalf("stored content for %s: %v", path, got)
		}
		physical, err := os.ReadFile(filepath.Join(root, bucket, filepath.FromSlash(path)))
		if err != nil || !bytes.Equal(physical, contents[index]) {
			t.Fatalf("physical content for %s: %v, %v", path, physical, err)
		}
	}
	assertDirectory := func(relative string, exists bool) {
		t.Helper()
		info, err := os.Stat(filepath.Join(root, bucket, filepath.FromSlash(relative)))
		if exists {
			if err != nil || !info.IsDir() {
				t.Fatalf("directory %s should remain: %v", relative, err)
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("empty directory %s should be removed: %v", relative, err)
		}
	}
	for index := range owners {
		put(t, storage, bucket, namespace(index)+"/"+name, contents[index])
		assertContent(index)
	}
	contents[0] = []byte("replacement")
	put(t, storage, bucket, namespace(0)+"/"+name, contents[0])
	for index := range owners {
		assertContent(index)
	}
	put(t, storage, bucket, namespace(0)+"/sibling.txt", []byte("keep task"))
	for index := range owners {
		if err := storage.Delete(t.Context(), bucket, namespace(index)+"/"+name); err != nil {
			t.Fatal(err)
		}
		if index == 0 {
			assertDirectory(namespace(index), true)
			if err := storage.Delete(t.Context(), bucket, namespace(index)+"/sibling.txt"); err != nil {
				t.Fatal(err)
			}
		}
		assertDirectory(namespace(index), false)
		for sibling := index + 1; sibling < len(owners); sibling++ {
			assertContent(sibling)
		}
		switch index {
		case 0:
			assertDirectory(project+"/ab", true)
		case 1:
			assertDirectory(project+"/ab", false)
			assertDirectory(project, true)
		case 2:
			assertDirectory(project, false)
			assertDirectory(otherProject, true)
		case 3:
			assertDirectory(otherProject, false)
			assertDirectory("", true)
		}
	}
	assertNoTemporary(t, root)
}

func TestLongUnicodePathsRemainAccessible(t *testing.T) {
	storage, _ := newStorage(t)
	const bucket = "task-attachments"
	const namespace = "10000000-0000-4000-8000-000000000001/ab/ab000000-0000-4000-8000-000000000001/"
	path := strings.Repeat(strings.Repeat("界", 50)+"/", 20) + "界界界界"
	put(t, storage, bucket, namespace+path, []byte("within"))
	put(t, storage, bucket, namespace+path, []byte("replacement"))
	extendedPath := namespace + path + "x"
	put(t, storage, bucket, extendedPath, []byte("legacy"))
	if got := string(read(t, storage, bucket, extendedPath)); got != "legacy" {
		t.Fatalf("long path content: %q", got)
	}
	if err := storage.Delete(t.Context(), bucket, extendedPath); err != nil {
		t.Fatal(err)
	}
}

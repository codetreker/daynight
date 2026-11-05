package webui

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"regexp"
	"testing"
	"testing/fstest"
)

func TestBundledPageAndReferencedAssets(t *testing.T) {
	resources := New()
	index, err := resources.Read("dist/index.html")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(index, []byte(`<div id="root"></div>`)) || bytes.Contains(index, []byte("/src/main.tsx")) {
		t.Fatal("embedded page is not the production frontend")
	}
	assets := regexp.MustCompile(`(?:src|href)="(/assets/[^"?#]+)"`).FindAllStringSubmatch(string(index), -1)
	if len(assets) < 2 {
		t.Fatal("production index does not reference emitted script and stylesheet")
	}
	for _, asset := range assets {
		data, err := resources.Read("dist" + asset[1])
		if err != nil || len(data) == 0 {
			t.Fatalf("embedded asset %s: %v", asset[1], err)
		}
	}
}

func TestReadMissingAndDirectory(t *testing.T) {
	resources := NewFromFS(fstest.MapFS{"dist/assets/folder/file.txt": &fstest.MapFile{Data: []byte("content")}})
	for _, name := range []string{"dist/assets/missing.js", "dist/assets/folder"} {
		data, err := resources.Read(name)
		if !errors.Is(err, ErrNotFound) || data != nil {
			t.Fatalf("%s: expected not found without data, got %q, %v", name, data, err)
		}
		if name == "dist/assets/missing.js" && !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("missing file lost its underlying cause: %v", err)
		}
	}
}

type resourceFailureFS struct {
	openErr, statErr, readErr, closeErr error
}

func (f resourceFailureFS) Open(string) (fs.File, error) {
	if f.openErr != nil {
		return nil, f.openErr
	}
	file, err := (fstest.MapFS{"file": &fstest.MapFile{Data: []byte("resource")}}).Open("file")
	return &resourceFailureFile{File: file, failure: f}, err
}

type resourceFailureFile struct {
	fs.File
	failure resourceFailureFS
}

func (f *resourceFailureFile) Stat() (fs.FileInfo, error) {
	if f.failure.statErr != nil {
		return nil, f.failure.statErr
	}
	return f.File.Stat()
}

func (f *resourceFailureFile) Read(data []byte) (int, error) {
	if f.failure.readErr != nil {
		return 0, f.failure.readErr
	}
	return f.File.Read(data)
}

func (f *resourceFailureFile) Close() error {
	return errors.Join(f.File.Close(), f.failure.closeErr)
}

func TestResourceIOErrorsPreserveCauses(t *testing.T) {
	cause := errors.New("private-resource-path")
	for _, files := range []resourceFailureFS{{openErr: cause}, {statErr: cause}, {readErr: cause}, {closeErr: cause}, {statErr: cause, closeErr: io.ErrClosedPipe}} {
		data, err := NewFromFS(files).Read("dist/index.html")
		if !errors.Is(err, cause) || data != nil {
			t.Fatalf("resource IO failure lost its cause or returned data: %q, %v", data, err)
		}
		if files.closeErr != nil && !errors.Is(err, files.closeErr) {
			t.Fatalf("resource close failure lost its cause: %v", err)
		}
	}
}

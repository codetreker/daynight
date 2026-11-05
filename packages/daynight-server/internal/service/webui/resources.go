package webui

import (
	"embed"
	"errors"
	"fmt"
	"io"
	"io/fs"
)

// Both patterns must match real build output before this package can compile.
//
//go:embed dist/index.html dist/assets/*
var bundled embed.FS

var ErrNotFound = errors.New("web resource not found")

type Resources struct {
	files fs.FS
}

func New() *Resources { return NewFromFS(bundled) }

func NewFromFS(files fs.FS) *Resources { return &Resources{files: files} }

func (r *Resources) Read(name string) ([]byte, error) {
	file, err := r.files.Open(name)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("%w: %w", ErrNotFound, err)
		}
		return nil, err
	}
	info, statErr := file.Stat()
	var data []byte
	var readErr error
	if statErr == nil && !info.IsDir() {
		data, readErr = io.ReadAll(file)
	}
	if err := errors.Join(statErr, readErr, file.Close()); err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, ErrNotFound
	}
	return data, nil
}

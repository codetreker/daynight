//go:build unix

package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"syscall"
)

// The fingerprint detects ordinary root replacement; an operator must still
// establish that the same storage instance remains mounted during the window.
func storageRootFingerprint(path string, info os.FileInfo) (string, error) {
	if !info.IsDir() {
		return "", fmt.Errorf("storage root is not a directory")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("storage root identity unavailable")
	}
	value := fmt.Sprintf("%s\x00%d\x00%d", path, stat.Dev, stat.Ino)
	return fmt.Sprintf("%x", sha256.Sum256([]byte(value))), nil
}

func openInspectionReport(path string) (*os.File, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err != nil {
		return nil, errors.Join(err, file.Close())
	}
	if !info.Mode().IsRegular() {
		return nil, errors.Join(errors.New("report is not a regular file"), file.Close())
	}
	return file, nil
}

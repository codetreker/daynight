//go:build !unix

package main

import (
	"errors"
	"os"
)

func storageRootFingerprint(string, os.FileInfo) (string, error) {
	return "", errors.New("storage root identity unavailable on this platform")
}

func openInspectionReport(string) (*os.File, error) {
	return nil, errors.New("report inspection unavailable on this platform")
}

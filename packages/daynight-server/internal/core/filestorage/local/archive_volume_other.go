//go:build !linux

package local

import (
	"context"
	"errors"
	"os"
)

var ErrArchiveVolumeUnverified = errors.New("archive staging volume is not verified")

func (*Storage) EnableArchiveStaging(context.Context, bool) error { return ErrArchiveVolumeUnverified }
func (*Storage) archiveStagingEnabled() error                     { return ErrArchiveVolumeUnverified }
func (*Storage) checkArchiveMount(*os.Root) error                 { return ErrArchiveVolumeUnverified }
func (*Storage) checkArchiveFileMount(*os.File) error             { return ErrArchiveVolumeUnverified }
func archiveReadRootMount(*os.Root) (uint64, error)               { return 0, ErrArchiveVolumeUnverified }
func archiveReadDirectoryMount(uint64, *os.Root) error            { return ErrArchiveVolumeUnverified }
func archiveReadFileMount(uint64, *os.File) error                 { return ErrArchiveVolumeUnverified }
func verifyArchiveStagingFile(*os.File) error                     { return ErrArchiveVolumeUnverified }

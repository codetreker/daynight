package local

import "golang.org/x/sys/unix"

func transferBlockSize(stat *unix.Statfs_t) uint64 { return uint64(stat.Bsize) }

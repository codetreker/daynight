package local

import (
	"testing"

	"golang.org/x/sys/unix"
)

func TestTransferBlockSizeFallback(t *testing.T) {
	for _, test := range []struct {
		stat unix.Statfs_t
		want uint64
	}{
		{unix.Statfs_t{Frsize: 1024, Bsize: 4096}, 1024},
		{unix.Statfs_t{Frsize: 0, Bsize: 4096}, 4096},
		{unix.Statfs_t{Frsize: -1, Bsize: 4096}, 4096},
		{unix.Statfs_t{Frsize: 0, Bsize: 0}, 0},
		{unix.Statfs_t{Frsize: -1, Bsize: -1}, 0},
	} {
		if got := transferBlockSize(&test.stat); got != test.want {
			t.Errorf("block size = %d, want %d", got, test.want)
		}
	}
}

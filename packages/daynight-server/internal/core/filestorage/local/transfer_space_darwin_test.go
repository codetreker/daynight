package local

import (
	"testing"

	"golang.org/x/sys/unix"
)

func TestTransferBlockSize(t *testing.T) {
	for _, test := range []struct {
		stat unix.Statfs_t
		want uint64
	}{
		{unix.Statfs_t{Bsize: 4096}, 4096},
		{unix.Statfs_t{Bsize: 0}, 0},
	} {
		if got := transferBlockSize(&test.stat); got != test.want {
			t.Errorf("block size = %d, want %d", got, test.want)
		}
	}
}

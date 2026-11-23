//go:build linux || darwin

package local

import (
	"errors"
	"os"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"golang.org/x/sys/unix"
)

func lockArchiveDirectory(file *os.File) error {
	err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
		return filestorage.ErrGateBusy
	}
	return err
}
func unlockArchiveDirectory(file *os.File) error { return unix.Flock(int(file.Fd()), unix.LOCK_UN) }

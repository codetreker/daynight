package local

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"golang.org/x/sys/unix"
)

var ErrArchiveVolumeUnverified = errors.New("archive staging volume is not verified")

// EnableArchiveStaging requires the operator to have verified lock, visibility
// and sync semantics between every actual participating instance on this volume.
// A local process probe supplements but cannot replace that topology proof.
// Permission is bound to the current opened root identity and is not persistent.
func (s *Storage) EnableArchiveStaging(ctx context.Context, topologyVerified bool) (result error) {
	if !topologyVerified {
		return ErrArchiveVolumeUnverified
	}
	s.archiveMu.Lock()
	defer s.archiveMu.Unlock()
	s.archiveVolume = nil
	s.archiveMount = 0
	defer func() {
		if result != nil {
			s.archiveVolume = nil
		}
	}()
	root, err := s.root.Open(".")
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, root.Close()) }()
	var stat unix.Statfs_t
	if err = unix.Fstatfs(int(root.Fd()), &stat); err != nil {
		return err
	}
	// Never infer cross-instance guarantees from this local type check. It
	// excludes known shared and unknown filesystems even after attestation.
	switch uint64(stat.Type) {
	case unix.EXT4_SUPER_MAGIC, unix.XFS_SUPER_MAGIC, unix.BTRFS_SUPER_MAGIC:
	default:
		return fmt.Errorf("%w: unsupported filesystem type %#x", ErrArchiveVolumeUnverified, stat.Type)
	}
	info, err := root.Stat()
	if err != nil {
		return err
	}
	mount, err := archiveMountID(root)
	if err != nil {
		return err
	}
	current, err := os.Stat(s.root.Name())
	if err != nil || !os.SameFile(info, current) {
		return errors.Join(ErrArchiveVolumeUnverified, err)
	}
	if err = lockArchiveDirectory(root); err != nil {
		return err
	}
	locked := true
	defer func() {
		if locked {
			result = errors.Join(result, unlockArchiveDirectory(root))
		}
	}()
	probe := ".daynight-archive-probe-" + rand.Text()
	f, err := s.root.OpenFile(probe, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, f.Close(), s.root.Remove(probe), s.fileSync(root)) }()
	data := []byte("daynight archive volume probe")
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = s.fileSync(f); err != nil {
		return err
	}
	if err = s.fileSync(root); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "flock", "-n", "/proc/self/fd/3", "true")
	cmd.ExtraFiles = []*os.File{root}
	if err = cmd.Run(); err == nil {
		return fmt.Errorf("%w: cross-process lock did not exclude", ErrArchiveVolumeUnverified)
	}
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 || ctx.Err() != nil {
		return errors.Join(ErrArchiveVolumeUnverified, err, ctx.Err())
	}
	cmd = exec.CommandContext(ctx, "cat", "/proc/self/fd/3/"+probe)
	cmd.ExtraFiles = []*os.File{root}
	got, err := cmd.Output()
	if err != nil || !bytes.Equal(got, data) {
		return errors.Join(ErrArchiveVolumeUnverified, err)
	}
	childData := []byte("daynight child synchronized probe")
	cmd = exec.CommandContext(ctx, "dd", "of=/proc/self/fd/3/"+probe, "conv=fsync", "status=none")
	cmd.ExtraFiles = []*os.File{root}
	cmd.Stdin = bytes.NewReader(childData)
	if err = cmd.Run(); err != nil {
		return errors.Join(ErrArchiveVolumeUnverified, err)
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	got = make([]byte, len(childData))
	if _, err = io.ReadFull(f, got); err != nil || !bytes.Equal(got, childData) {
		return errors.Join(ErrArchiveVolumeUnverified, err)
	}
	if err = unlockArchiveDirectory(root); err != nil {
		return err
	}
	locked = false
	cmd = exec.CommandContext(ctx, "flock", "-n", "/proc/self/fd/3", "true")
	cmd.ExtraFiles = []*os.File{root}
	if err = cmd.Run(); err != nil {
		return errors.Join(ErrArchiveVolumeUnverified, err)
	}
	s.archiveVolume = info
	s.archiveMount = mount
	return nil
}

func archiveMountID(f *os.File) (uint64, error) {
	var stat unix.Statx_t
	if err := unix.Statx(int(f.Fd()), "", unix.AT_EMPTY_PATH, unix.STATX_MNT_ID, &stat); err != nil {
		return 0, errors.Join(ErrArchiveVolumeUnverified, err)
	}
	if stat.Mask&unix.STATX_MNT_ID == 0 {
		return 0, ErrArchiveVolumeUnverified
	}
	return stat.Mnt_id, nil
}

func archiveReadRootMount(root *os.Root) (uint64, error) {
	f, err := root.Open(".")
	if err != nil {
		return 0, err
	}
	id, err := archiveMountID(f)
	return id, errors.Join(err, f.Close())
}

func archiveReadDirectoryMount(expected uint64, dir *os.Root) error {
	f, err := dir.Open(".")
	if err != nil {
		return err
	}
	return errors.Join(archiveReadFileMount(expected, f), f.Close())
}

func archiveReadFileMount(expected uint64, file *os.File) error {
	id, err := archiveMountID(file)
	if err != nil {
		return err
	}
	if id != expected {
		return ErrArchiveVolumeUnverified
	}
	return nil
}

// A hard-linked staging file can be changed through another namespace even
// while the Session directory is locked. No such alias is admissible.
func verifyArchiveStagingFile(file *os.File) error {
	var stat unix.Stat_t
	if err := unix.Fstat(int(file.Fd()), &stat); err != nil {
		return err
	}
	if stat.Nlink != 1 {
		return filestorage.ErrPathConflict
	}
	return nil
}

func (s *Storage) checkArchiveMount(dir *os.Root) error {
	f, err := dir.Open(".")
	if err != nil {
		return err
	}
	id, err := archiveMountID(f)
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	s.archiveMu.Lock()
	defer s.archiveMu.Unlock()
	if s.archiveVolume == nil || id != s.archiveMount {
		return ErrArchiveVolumeUnverified
	}
	return nil
}

func (s *Storage) checkArchiveFileMount(file *os.File) error {
	id, err := archiveMountID(file)
	if err != nil {
		return err
	}
	s.archiveMu.Lock()
	defer s.archiveMu.Unlock()
	if s.archiveVolume == nil || id != s.archiveMount {
		return ErrArchiveVolumeUnverified
	}
	return nil
}

func (s *Storage) archiveStagingEnabled() error {
	s.archiveMu.Lock()
	defer s.archiveMu.Unlock()
	if s.archiveVolume == nil {
		return ErrArchiveVolumeUnverified
	}
	current, err := os.Stat(s.root.Name())
	if err != nil || !os.SameFile(s.archiveVolume, current) {
		return errors.Join(ErrArchiveVolumeUnverified, err)
	}
	f, err := os.Open(s.root.Name())
	if err != nil {
		return errors.Join(ErrArchiveVolumeUnverified, err)
	}
	id, err := archiveMountID(f)
	err = errors.Join(err, f.Close())
	if err != nil || id != s.archiveMount {
		return errors.Join(ErrArchiveVolumeUnverified, err)
	}
	return nil
}

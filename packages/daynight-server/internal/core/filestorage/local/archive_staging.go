package local

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"sync"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
)

// ArchiveStaging owns the Session directory lock until Close. Callers must
// recheck business admission after acquiring it and hold it through publication.
type ArchiveStaging struct {
	storage   *Storage
	root      *os.Root
	lock      *os.File
	namespace sessionarchive.Namespace
	mu        sync.Mutex
	readers   int
	closed    bool
	frozen    bool
}

// A cleanup failure makes an absence observation inconclusive: do not let an
// errors.Join expose the missing sentinel alongside the cleanup failure.
func stagingCloseResult(result, cleanup error) error {
	if cleanup != nil && errors.Is(result, filestorage.ErrArchiveStagingMissing) {
		return fmt.Errorf("archive staging observation cleanup: %w", cleanup)
	}
	return errors.Join(result, cleanup)
}

// AcquireArchiveStaging locks the actual Session directory. Creation is only
// for a newly admitted writer; observation must never create a missing namespace.
func (s *Storage) AcquireArchiveStaging(ctx context.Context, namespace sessionarchive.Namespace, create bool) (handle filestorage.ArchiveStaging, result error) {
	if err := s.archiveStagingEnabled(); err != nil {
		return nil, err
	}
	if err := namespace.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %w", filestorage.ErrInvalidAddress, err)
	}
	if err := filestorage.GateError(ctx); err != nil {
		return nil, err
	}
	rootLock, err := s.root.Open(".")
	if err != nil {
		return nil, err
	}
	if err = lockArchiveDirectory(rootLock); err != nil {
		return nil, errors.Join(err, rootLock.Close())
	}
	defer func() {
		if e := errors.Join(unlockArchiveDirectory(rootLock), rootLock.Close()); e != nil {
			if handle != nil {
				e = errors.Join(e, handle.Close())
				handle = nil
			}
			result = stagingCloseResult(result, e)
		}
	}()

	components := append([]string{sessionarchive.Bucket}, strings.Split(namespace.Directory(), "/")...)
	parent := s.root
	var opened []*os.Root
	defer func() {
		for i := len(opened) - 1; i >= 0; i-- {
			result = stagingCloseResult(result, opened[i].Close())
		}
		if result != nil && handle != nil {
			result = errors.Join(result, handle.Close())
			handle = nil
		}
	}()
	var sessionParent *os.Root
	var sessionInfo fs.FileInfo
	for _, name := range components {
		if err = filestorage.GateError(ctx); err != nil {
			return nil, err
		}
		if err = s.checkArchiveMount(parent); err != nil {
			return nil, err
		}
		// Distinguish an observed absent entry from a failed open after Lstat:
		// the latter can mean that the path changed while it was inspected.
		_, statErr := parent.Lstat(name)
		if errors.Is(statErr, fs.ErrNotExist) && !create {
			if err = filestorage.GateError(ctx); err != nil {
				return nil, err
			}
			return nil, filestorage.ErrArchiveStagingMissing
		}
		if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
			return nil, statErr
		}
		dir, info, e := openArchiveDirectory(parent, name)
		if errors.Is(statErr, fs.ErrNotExist) && create {
			if e = verifyMutation(ctx); e != nil {
				return nil, e
			}
			if e = parent.Mkdir(name, 0o700); e != nil && !errors.Is(e, fs.ErrExist) {
				return nil, e
			}
			dir, info, e = openArchiveDirectory(parent, name)
		}
		if e != nil {
			return nil, e
		}
		// Even an existing namespace can follow an interrupted initializer.
		// Its handle permits later mutations, so adopt it only after every
		// ancestor entry and directory has passed its durability barrier.
		if e = s.checkArchiveMount(dir); e == nil {
			e = errors.Join(s.syncArchiveDirectory(parent), s.syncArchiveDirectory(dir))
		}
		if e != nil {
			return nil, errors.Join(e, dir.Close())
		}
		sessionParent, sessionInfo = parent, info
		opened = append(opened, dir)
		parent = dir
	}
	fd, err := parent.Open(".")
	if err != nil {
		return nil, err
	}
	if err = lockArchiveDirectory(fd); err != nil {
		return nil, errors.Join(err, fd.Close())
	}
	current, err := sessionParent.Lstat(components[len(components)-1])
	if err == nil && !os.SameFile(sessionInfo, current) {
		err = filestorage.ErrPathConflict
	}
	if err != nil {
		return nil, errors.Join(err, unlockArchiveDirectory(fd), fd.Close())
	}
	if err = filestorage.GateError(ctx); err != nil {
		return nil, errors.Join(err, unlockArchiveDirectory(fd), fd.Close())
	}
	opened = opened[:len(opened)-1]
	return &ArchiveStaging{storage: s, root: parent, lock: fd, namespace: namespace}, nil
}

func (s *ArchiveStaging) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	if s.readers != 0 {
		return filestorage.ErrGateBusy
	}
	s.closed = true
	return errors.Join(s.root.Close(), unlockArchiveDirectory(s.lock), s.lock.Close())
}

func (s *ArchiveStaging) filename(fileID string) (string, error) {
	// The path helper performs the same canonical ID check as the stored address.
	n, _ := sessionarchive.NewNamespace(sessionarchive.Users, "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000001")
	path, err := filestorage.ArchiveStagingPath(n, fileID)
	if err != nil {
		return "", err
	}
	return path[len(n.Directory())+1:], nil
}

func (s *ArchiveStaging) ready(ctx context.Context) error {
	if s.closed {
		return os.ErrClosed
	}
	return filestorage.GateError(ctx)
}

func (s *ArchiveStaging) Create(ctx context.Context, fileID string) (result error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(ctx); err != nil {
		return err
	}
	if s.frozen {
		return filestorage.ErrGateBusy
	}
	name, err := s.filename(fileID)
	if err != nil {
		return err
	}
	if err = verifyMutation(ctx); err != nil {
		return err
	}
	if err = s.root.Mkdir(".staging", 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	dir, _, err := openArchiveDirectory(s.root, ".staging")
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, dir.Close()) }()
	if err = s.storage.checkArchiveMount(dir); err != nil {
		return err
	}
	if err = s.storage.syncArchiveDirectory(s.root); err != nil {
		return err
	}
	file, err := dir.OpenFile(strings.TrimPrefix(name, ".staging/"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if err = verifyArchiveStagingFile(file); err != nil {
		return errors.Join(err, file.Close())
	}
	if err = errors.Join(s.storage.fileSync(file), file.Close()); err != nil {
		return err
	}
	return errors.Join(s.storage.syncArchiveDirectory(dir), filestorage.GateError(ctx))
}

// AdoptEmpty supplies the missing durability barriers after a conditional
// create's outcome was uncertain. Business registration and terminal-state
// checks remain the caller's responsibility under the same Session lock.
func (s *ArchiveStaging) AdoptEmpty(ctx context.Context, fileID string) (result error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(ctx); err != nil {
		return err
	}
	if s.frozen {
		return filestorage.ErrGateBusy
	}
	name, err := s.filename(fileID)
	if err != nil {
		return err
	}
	if err = verifyMutation(ctx); err != nil {
		return err
	}
	f, err := s.openFile(ctx, fileID, os.O_RDWR)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, f.Close()) }()
	dir, _, err := openArchiveDirectory(s.root, ".staging")
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, dir.Close()) }()
	if err = s.storage.checkArchiveMount(dir); err != nil {
		return err
	}
	entry, err := dir.Lstat(strings.TrimPrefix(name, ".staging/"))
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !entry.Mode().IsRegular() || !os.SameFile(entry, info) {
		return filestorage.ErrPathConflict
	}
	if info.Size() != 0 {
		return filestorage.ErrArchiveStagingOffset
	}
	if err = s.storage.fileSync(f); err != nil {
		return err
	}
	if err = verifyArchiveStagingFile(f); err != nil {
		return err
	}
	info, err = f.Stat()
	if err != nil {
		return err
	}
	if info.Size() != 0 {
		return filestorage.ErrArchiveStagingOffset
	}
	return errors.Join(s.storage.syncArchiveDirectory(s.root), s.storage.syncArchiveDirectory(dir), filestorage.GateError(ctx))
}

func recoveredOffset(size, total int64) (int64, error) {
	if total < 0 || size < 0 || size > total {
		return 0, filestorage.ErrArchiveStagingCorrupt
	}
	if size == total {
		return total, nil
	}
	return size / sessionarchive.BlockSize * sessionarchive.BlockSize, nil
}

func (s *ArchiveStaging) openFile(ctx context.Context, fileID string, flag int) (file *os.File, result error) {
	name, err := s.filename(fileID)
	if err != nil {
		return nil, err
	}
	if err = s.storage.checkArchiveMount(s.root); err != nil {
		return nil, err
	}
	_, err = s.root.Lstat(".staging")
	if errors.Is(err, fs.ErrNotExist) {
		if err = filestorage.GateError(ctx); err != nil {
			return nil, err
		}
		return nil, filestorage.ErrArchiveStagingMissing
	}
	if err != nil {
		return nil, err
	}
	dir, _, err := openArchiveDirectory(s.root, ".staging")
	if err != nil {
		return nil, err
	}
	defer func() {
		if err := dir.Close(); err != nil {
			if file != nil {
				err = errors.Join(err, file.Close())
				file = nil
			}
			result = stagingCloseResult(result, err)
		}
	}()
	if err = s.storage.checkArchiveMount(dir); err != nil {
		return nil, err
	}
	name = strings.TrimPrefix(name, ".staging/")
	info, err := dir.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		if err = filestorage.GateError(ctx); err != nil {
			return nil, err
		}
		return nil, filestorage.ErrArchiveStagingMissing
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, filestorage.ErrNotRegular
	}
	f, err := dir.OpenFile(name, flag, 0)
	if err != nil {
		return nil, err
	}
	if err = s.storage.checkArchiveFileMount(f); err != nil {
		return nil, errors.Join(err, f.Close())
	}
	if err = verifyArchiveStagingFile(f); err != nil {
		return nil, errors.Join(err, f.Close())
	}
	got, err := f.Stat()
	if err == nil && (!got.Mode().IsRegular() || !os.SameFile(info, got)) {
		err = filestorage.ErrPathConflict
	}
	if err == nil {
		err = filestorage.GateError(ctx)
	}
	if err != nil {
		return nil, errors.Join(err, f.Close())
	}
	return f, nil
}

func (s *ArchiveStaging) observe(ctx context.Context, f *os.File, total int64) (int64, error) {
	if err := s.storage.fileSync(f); err != nil {
		return 0, err
	}
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	offset, err := recoveredOffset(info.Size(), total)
	return offset, errors.Join(err, filestorage.GateError(ctx))
}

// Observe synchronizes the file before returning its recoverable offset.
func (s *ArchiveStaging) Observe(ctx context.Context, fileID string, total int64) (offset int64, result error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(ctx); err != nil {
		return 0, err
	}
	f, err := s.openFile(ctx, fileID, os.O_RDONLY)
	if err != nil {
		return 0, err
	}
	defer func() { result = errors.Join(result, f.Close()) }()
	return s.observe(ctx, f, total)
}

// Append accepts exactly one complete block, or the final shorter block. A
// crash tail is truncated only after the caller's expected offset is checked.
func (s *ArchiveStaging) Append(ctx context.Context, fileID string, total, expected int64, data []byte) (offset int64, result error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(ctx); err != nil {
		return 0, err
	}
	if s.frozen {
		return 0, filestorage.ErrGateBusy
	}
	if total < 0 || expected < 0 || expected > total || int64(len(data)) != min(sessionarchive.BlockSize, total-expected) || len(data) == 0 {
		return 0, filestorage.ErrArchiveStagingOffset
	}
	f, err := s.openFile(ctx, fileID, os.O_RDWR)
	if err != nil {
		return 0, err
	}
	defer func() { result = errors.Join(result, f.Close()) }()
	offset, err = s.observe(ctx, f, total)
	if err != nil {
		return 0, err
	}
	if offset != expected {
		return offset, filestorage.ErrArchiveStagingOffset
	}
	if err = verifyMutation(ctx); err != nil {
		return offset, err
	}
	if err = f.Truncate(offset); err != nil {
		return offset, err
	}
	if _, err = f.Seek(offset, io.SeekStart); err != nil {
		return offset, err
	}
	n, err := f.Write(data)
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	if err != nil {
		return offset, err
	}
	if err = s.storage.fileSync(f); err != nil {
		return offset, err
	}
	return offset + int64(n), filestorage.GateError(ctx)
}

// Open returns a bounded view of the recoverable bytes. Close the returned body
// before closing the staging handle; a live reader keeps the physical lock held.
func (s *ArchiveStaging) Open(ctx context.Context, fileID string, total int64) (filestorage.Object, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(ctx); err != nil {
		return filestorage.Object{}, err
	}
	f, err := s.openFile(ctx, fileID, os.O_RDONLY)
	if err != nil {
		return filestorage.Object{}, err
	}
	n, err := s.observe(ctx, f, total)
	if err != nil {
		return filestorage.Object{}, errors.Join(err, f.Close())
	}
	s.readers++
	s.frozen = true
	return filestorage.Object{Body: &archiveStagingReader{owner: s, file: f, reader: io.LimitReader(contextReader{ctx: ctx, reader: f}, n)}, Info: filestorage.FileInfo{Size: n}}, nil
}

type archiveStagingReader struct {
	owner  *ArchiveStaging
	file   *os.File
	reader io.Reader
	once   sync.Once
	err    error
}

func (r *archiveStagingReader) Read(b []byte) (int, error) { return r.reader.Read(b) }
func (r *archiveStagingReader) Close() error {
	r.once.Do(func() { r.err = r.file.Close(); r.owner.mu.Lock(); r.owner.readers--; r.owner.mu.Unlock() })
	return r.err
}

func (s *ArchiveStaging) Delete(ctx context.Context, fileID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(ctx); err != nil {
		return err
	}
	if s.readers != 0 || s.frozen {
		return filestorage.ErrGateBusy
	}
	name, err := s.filename(fileID)
	if err != nil {
		return err
	}
	dir, _, err := openArchiveDirectory(s.root, ".staging")
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer dir.Close()
	if err = s.storage.checkArchiveMount(dir); err != nil {
		return err
	}
	name = strings.TrimPrefix(name, ".staging/")
	info, err := dir.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return s.storage.syncArchiveDirectory(dir)
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return filestorage.ErrNotRegular
	}
	f, err := dir.Open(name)
	if err != nil {
		return err
	}
	checked, checkErr := f.Stat()
	if checkErr == nil && !os.SameFile(info, checked) {
		checkErr = filestorage.ErrPathConflict
	}
	if checkErr == nil {
		checkErr = verifyArchiveStagingFile(f)
	}
	if checkErr == nil {
		checkErr = s.storage.checkArchiveFileMount(f)
	}
	if checkErr = errors.Join(checkErr, f.Close()); checkErr != nil {
		return checkErr
	}
	if err = removeArchiveEntry(ctx, dir, name, info); err != nil {
		return err
	}
	return errors.Join(s.storage.syncArchiveDirectory(dir), filestorage.GateError(ctx))
}

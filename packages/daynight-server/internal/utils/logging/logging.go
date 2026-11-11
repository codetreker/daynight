// Package logging owns the server's synchronous, exclusively held log output.
package logging

import (
	"context"
	"errors"
	"io"
	"os"
	"strconv"
	"sync"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
	"golang.org/x/sys/unix"
)

const (
	logName  = "daynight-server.log"
	lockName = ".writer.lock"
)

// Error exposes only fixed diagnostic values while retaining the original error chain.
type Error struct {
	Phase, Sink, Resource, Cause string
	err                          error
}

func (e *Error) Error() string { return "logging " + e.Phase + " failed" }
func (e *Error) Unwrap() error { return e.err }

func failure(phase, sink, resource string, err error) error {
	cause := "other"
	switch {
	case errors.Is(err, io.ErrShortWrite):
		cause = "short_write"
	case errors.Is(err, unix.EWOULDBLOCK), errors.Is(err, unix.EAGAIN):
		cause = "busy"
	case errors.Is(err, os.ErrPermission):
		cause = "permission"
	case errors.Is(err, os.ErrNotExist):
		cause = "not_found"
	case errors.Is(err, unix.ENOSPC):
		cause = "no_space"
	case errors.Is(err, unix.EIO):
		cause = "io"
	}
	return &Error{Phase: phase, Sink: sink, Resource: resource, Cause: cause, err: err}
}

type file interface {
	io.Writer
	Stat() (os.FileInfo, error)
	Close() error
}

type operations struct {
	open   func(string, int, os.FileMode) (file, error)
	remove func(string) error
	rename func(string, string) error
}

var systemOperations = operations{
	open:   func(name string, flag int, mode os.FileMode) (file, error) { return os.OpenFile(name, flag, mode) },
	remove: os.Remove,
	rename: os.Rename,
}

// Output serializes both sinks and holds the lock until Close. Call Close only
// after all producers have stopped.
type Output struct {
	mu       sync.Mutex
	stderr   io.Writer
	cancel   context.CancelCauseFunc
	config   Config
	path     string
	lock     *os.File
	active   file
	ops      operations
	fileErr  error
	firstErr error
	closed   bool
}

// Open obtains the lock before opening the active file. On failure it releases
// any acquired resources; the caller reports the safe Error through bootstrap stderr.
func Open(root string, stderr io.Writer, cancel context.CancelCauseFunc) (*Output, error) {
	return open(root, stderr, cancel, DefaultConfig(), systemOperations)
}

func open(root string, stderr io.Writer, cancel context.CancelCauseFunc, config Config, ops operations) (*Output, error) {
	if err := config.Validate(); err != nil {
		return nil, failure("open", "file", logName, err)
	}
	if stderr == nil {
		return nil, failure("open", "stderr", "stderr", errors.New("missing stderr"))
	}
	dir := configvalue.ResolvePath(root, "logs")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, failure("open", "file", logName, err)
	}
	lock, err := os.OpenFile(configvalue.ResolvePath(dir, lockName), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, failure("lock", "lock", lockName, err)
	}
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return nil, errors.Join(failure("lock", "lock", lockName, err), closeLockFile(lock))
	}
	path := configvalue.ResolvePath(dir, logName)
	active, err := ops.open(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, errors.Join(failure("open", "file", logName, err), releaseLock(lock, unix.Flock))
	}
	return &Output{stderr: stderr, cancel: cancel, config: config, path: path, lock: lock, active: active, ops: ops}, nil
}

func closeLockFile(lock io.Closer) error {
	if err := lock.Close(); err != nil {
		return failure("close", "lock", lockName, err)
	}
	return nil
}

type lockFile interface {
	io.Closer
	Fd() uintptr
}

func releaseLock(lock lockFile, flock func(int, int) error) error {
	var unlockErr error
	if err := flock(int(lock.Fd()), unix.LOCK_UN); err != nil {
		unlockErr = failure("close", "lock", lockName, err)
	}
	return errors.Join(unlockErr, closeLockFile(lock))
}

func (o *Output) latch(err error) {
	if err != nil && o.firstErr == nil {
		o.firstErr = err
		if o.cancel != nil {
			o.cancel(err)
		}
	}
}

// Err returns the first failure, including when a prior signal cancelled the context.
func (o *Output) Err() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.firstErr
}

func writeFull(w io.Writer, p []byte) error {
	n, err := w.Write(p)
	if n != len(p) {
		err = errors.Join(err, io.ErrShortWrite)
	}
	return err
}

// Write always attempts stderr and the file when the file is still usable.
func (o *Output) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	stderrErr := writeFull(o.stderr, p)
	if stderrErr != nil {
		stderrErr = failure("write", "stderr", "stderr", stderrErr)
	}
	fileErr := o.fileErr
	if o.closed {
		fileErr = failure("write", "file", logName, os.ErrClosed)
	} else if fileErr == nil {
		fileErr = o.writeFile(p)
		if fileErr != nil {
			o.fileErr = fileErr
		}
	}
	err := errors.Join(stderrErr, fileErr)
	o.latch(err)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

func (o *Output) writeFile(p []byte) error {
	info, err := o.active.Stat()
	if err != nil {
		return failure("write", "file", logName, err)
	}
	size := info.Size()
	if size > 0 && (size > o.config.MaxBytes || int64(len(p)) > o.config.MaxBytes-size) {
		if err = o.rotate(); err != nil {
			return err
		}
	}
	if err = writeFull(o.active, p); err != nil {
		return failure("write", "file", logName, err)
	}
	return nil
}

func (o *Output) rotate() error {
	active := o.active
	o.active = nil
	if err := active.Close(); err != nil {
		return failure("rotate", "file", logName, err)
	}
	last := o.path + "." + strconv.Itoa(o.config.Archives)
	if err := o.ops.remove(last); err != nil && !errors.Is(err, os.ErrNotExist) {
		return failure("rotate", "file", logName, err)
	}
	for i := o.config.Archives - 1; i >= 1; i-- {
		from := o.path + "." + strconv.Itoa(i)
		to := o.path + "." + strconv.Itoa(i+1)
		if err := o.ops.rename(from, to); err != nil && !errors.Is(err, os.ErrNotExist) {
			return failure("rotate", "file", logName, err)
		}
	}
	if err := o.ops.rename(o.path, o.path+".1"); err != nil {
		return failure("rotate", "file", logName, err)
	}
	active, err := o.ops.open(o.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return failure("rotate", "file", logName, err)
	}
	o.active = active
	return nil
}

// Close closes the active file before releasing the process lock, even on failure.
func (o *Output) Close() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return nil
	}
	o.closed = true
	var fileErr error
	if o.active != nil {
		if err := o.active.Close(); err != nil {
			fileErr = failure("close", "file", logName, err)
		}
		o.active = nil
	}
	lockErr := releaseLock(o.lock, unix.Flock)
	err := errors.Join(fileErr, lockErr)
	o.latch(err)
	return err
}

var _ io.WriteCloser = (*Output)(nil)

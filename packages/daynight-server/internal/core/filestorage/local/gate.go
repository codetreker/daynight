package local

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"sync"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"golang.org/x/sys/unix"
)

// These files are persistent control objects, never attachment or transfer data.
const gateDirectory = ".daynight-gates"

type gatePermit struct {
	file  *os.File
	local chan struct{}
	once  sync.Once
	err   error
}

func (p *gatePermit) Close() error {
	p.once.Do(func() {
		p.err = p.file.Close() // Closing the descriptor releases the advisory lock.
		<-p.local
	})
	return p.err
}

func (s *Storage) AcquireGate(ctx context.Context, domain filestorage.GateDomain, key string) (io.Closer, error) {
	var index int
	switch domain {
	case filestorage.TargetGate:
		index = 0
	case filestorage.PrivateGate:
		index = 1
	default:
		return nil, fmt.Errorf("invalid storage gate domain %q", domain)
	}
	if key == "" {
		return nil, errors.New("empty storage gate key")
	}
	stripe := sha256.Sum256([]byte(key))[0]
	local := s.gates[index][stripe]
	select {
	case local <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	acquired := false
	defer func() {
		if !acquired {
			<-local
		}
	}()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := s.root.Mkdir(gateDirectory, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return nil, fmt.Errorf("create gate directory: %w", err)
	}
	info, err := s.root.Lstat(gateDirectory)
	if err != nil {
		return nil, fmt.Errorf("inspect gate directory: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%w: gate directory", filestorage.ErrNotRegular)
	}
	name := fmt.Sprintf("%s/%s-%03d", gateDirectory, domain, stripe)
	file, err := s.root.OpenFile(name, os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open storage gate: %w", err)
	}
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		if err == nil {
			err = filestorage.ErrNotRegular
		}
		return nil, errors.Join(err, file.Close())
	}
	for {
		err = unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			if err = ctx.Err(); err != nil {
				return nil, errors.Join(err, file.Close())
			}
			acquired = true
			return &gatePermit{file: file, local: local}, nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) && !errors.Is(err, unix.EINTR) {
			return nil, errors.Join(fmt.Errorf("lock storage gate: %w", err), file.Close())
		}
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return nil, errors.Join(ctx.Err(), file.Close())
		}
	}
}

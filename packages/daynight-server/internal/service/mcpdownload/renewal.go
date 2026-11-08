package mcpdownload

import (
	"context"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

// renewal owns the snapshot's activity heartbeat and stops the copy if a
// current-credential check or the bounded renewal transaction fails.
type renewal struct {
	cancel context.CancelFunc
	done   chan error
	once   sync.Once
	err    error
}

func (s *Service) startRenewal(ctx context.Context, stopCopy context.CancelFunc, a mcptransfer.Actor, id string) *renewal {
	rctx, cancel := context.WithCancel(ctx)
	r := &renewal{cancel: cancel, done: make(chan error, 1)}
	go func() {
		ticker := time.NewTicker(s.renewInterval)
		defer ticker.Stop()
		for {
			select {
			case <-rctx.Done():
				r.done <- nil
				return
			case <-ticker.C:
				c, end := context.WithTimeout(rctx, 10*time.Second)
				record, err := s.lifecycle.Touch(c, a, id)
				end()
				if err == nil && record.State != "preparing" {
					err = mcptransfer.ErrState
				}
				if err != nil {
					if rctx.Err() != nil {
						r.done <- nil
						return
					}
					stopCopy()
					r.done <- err
					return
				}
			}
		}
	}()
	return r
}
func (r *renewal) stop() error {
	r.once.Do(func() { r.cancel(); r.err = <-r.done })
	return r.err
}

// utf8Stream carries only the incomplete suffix between writes, so whole-file
// classification is independent of I/O chunk boundaries and file length.
type utf8Stream struct {
	pending [utf8.UTFMax]byte
	n       int
	invalid bool
}

func (v *utf8Stream) Write(p []byte) (int, error) {
	length := len(p)
	for len(p) > 0 && !v.invalid {
		if v.n > 0 {
			v.pending[v.n] = p[0]
			v.n++
			p = p[1:]
			if !utf8.FullRune(v.pending[:v.n]) {
				continue
			}
			r, n := utf8.DecodeRune(v.pending[:v.n])
			if r == utf8.RuneError && n == 1 {
				v.invalid = true
				break
			}
			v.n = 0
			continue
		}
		if !utf8.FullRune(p) {
			v.n = copy(v.pending[:], p)
			break
		}
		r, n := utf8.DecodeRune(p)
		if r == utf8.RuneError && n == 1 {
			v.invalid = true
			break
		}
		p = p[n:]
	}
	return length, nil
}
func (v *utf8Stream) Valid() bool { return !v.invalid && v.n == 0 }

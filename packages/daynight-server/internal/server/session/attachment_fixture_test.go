package session_test

import (
	"context"
	"io"
)

type attachmentFailingBody struct {
	data     []byte
	readErr  error
	closeErr error
	closed   bool
	cancel   context.CancelFunc
}

func (r *attachmentFailingBody) Read(buffer []byte) (int, error) {
	if r.cancel != nil {
		r.cancel()
	}
	count := copy(buffer, r.data)
	r.data = r.data[count:]
	if len(r.data) == 0 {
		if r.readErr != nil {
			return count, r.readErr
		}
		return count, io.EOF
	}
	return count, nil
}

func (r *attachmentFailingBody) Close() error {
	r.closed = true
	return r.closeErr
}

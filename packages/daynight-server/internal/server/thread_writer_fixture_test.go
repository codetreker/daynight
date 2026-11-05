package server

import (
	"errors"
	"net/http/httptest"
)

type threadFailingWriter struct {
	*httptest.ResponseRecorder
	short bool
	calls int
}

func (w *threadFailingWriter) Write(data []byte) (int, error) {
	w.calls++
	if w.short {
		return 0, nil
	}
	return 0, errors.New("private response failure")
}

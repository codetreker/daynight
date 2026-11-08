package session

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type responseLease struct {
	calls int
	err   error
}

func (l *responseLease) Close() error {
	l.calls++
	return l.err
}

type archiveResponseWriter struct {
	*httptest.ResponseRecorder
	mu            sync.Mutex
	deadlines     []time.Time
	setErr        error
	clearErr      error
	writeErr      error
	shortWrite    bool
	flushErr      error
	cancelOnWrite context.CancelFunc
}

func (w *archiveResponseWriter) SetWriteDeadline(deadline time.Time) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.deadlines = append(w.deadlines, deadline)
	if deadline.IsZero() {
		return w.clearErr
	}
	return w.setErr
}

func (w *archiveResponseWriter) Write(data []byte) (int, error) {
	if w.cancelOnWrite != nil {
		w.cancelOnWrite()
	}
	if w.writeErr != nil {
		return 0, w.writeErr
	}
	if w.shortWrite {
		return w.ResponseRecorder.Write(data[:len(data)-1])
	}
	return w.ResponseRecorder.Write(data)
}

func (w *archiveResponseWriter) FlushError() error {
	if w.flushErr != nil {
		return w.flushErr
	}
	w.ResponseRecorder.Flush()
	return nil
}

func TestArchiveResultRetainsLeaseAndPreservesFailures(t *testing.T) {
	for _, tc := range []struct {
		name       string
		value      any
		canceled   bool
		closeErr   error
		wantStatus int
		wantBody   string
		wantLog    bool
	}{
		{name: "sent", value: map[string]string{"value": "ok"}, wantStatus: http.StatusOK, wantBody: `{"value":"ok"}`},
		{name: "encoding failure", value: make(chan int), wantStatus: http.StatusInternalServerError, wantBody: `"internal_error"`},
		{name: "encoding and cleanup failure", value: make(chan int), closeErr: errors.New("private cleanup details"), wantStatus: http.StatusServiceUnavailable, wantBody: `"cleanup_unknown"`},
		{name: "cancel before encoding", value: make(chan int), canceled: true, wantStatus: http.StatusOK},
		{name: "cancel and cleanup failure", value: make(chan int), canceled: true, closeErr: errors.New("private cleanup details"), wantStatus: http.StatusOK, wantLog: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			routes := &Routes{logger: slog.New(slog.NewJSONHandler(&logs, nil))}
			r := httptest.NewRequest(http.MethodGet, "/archive/content", nil)
			ctx, cancel := context.WithCancel(r.Context())
			defer cancel()
			if tc.canceled {
				cancel()
			}
			lease := &responseLease{err: tc.closeErr}
			w := &archiveResponseWriter{ResponseRecorder: httptest.NewRecorder()}
			routes.archiveResult(w, r.WithContext(ctx), tc.value, lease)
			if lease.calls != 1 {
				t.Fatalf("lease closed %d times", lease.calls)
			}
			if w.Code != tc.wantStatus || !strings.Contains(w.Body.String(), tc.wantBody) {
				t.Fatalf("status=%d body=%q", w.Code, w.Body.String())
			}
			if tc.canceled && (w.Body.Len() != 0 || len(w.Header()) != 0) {
				t.Fatalf("canceled response was written: %v %q", w.Header(), w.Body.String())
			}
			if tc.wantLog && !strings.Contains(logs.String(), `"phase":"archive_close"`) {
				t.Fatalf("cleanup failure missing from logs: %s", logs.String())
			}
			if strings.Contains(logs.String(), "private cleanup details") {
				t.Fatal("private cleanup cause leaked into logs")
			}
		})
	}
}

func TestArchiveSendFailureAbortsAndReleases(t *testing.T) {
	for _, tc := range []struct {
		name       string
		configure  func(*archiveResponseWriter, context.CancelFunc)
		closeErr   error
		wantAbort  bool
		wantStatus int
		wantBody   string
		wantLogged bool
	}{
		{name: "deadline setup", configure: func(w *archiveResponseWriter, _ context.CancelFunc) { w.setErr = errors.New("deadline unavailable") }, wantStatus: 500, wantBody: `"internal_error"`},
		{name: "deadline setup and cleanup", configure: func(w *archiveResponseWriter, _ context.CancelFunc) { w.setErr = errors.New("deadline unavailable") }, closeErr: errors.New("private cleanup details"), wantStatus: 503, wantBody: `"cleanup_unknown"`},
		{name: "write failure", configure: func(w *archiveResponseWriter, _ context.CancelFunc) { w.writeErr = errors.New("private write details") }, closeErr: errors.New("private cleanup details"), wantAbort: true, wantStatus: 200, wantLogged: true},
		{name: "short write", configure: func(w *archiveResponseWriter, _ context.CancelFunc) { w.shortWrite = true }, wantAbort: true, wantStatus: 200, wantLogged: true},
		{name: "flush failure", configure: func(w *archiveResponseWriter, _ context.CancelFunc) { w.flushErr = io.ErrClosedPipe }, wantAbort: true, wantStatus: 200, wantLogged: true},
		{name: "deadline clear failure", configure: func(w *archiveResponseWriter, _ context.CancelFunc) { w.clearErr = errors.New("deadline clear failed") }, wantAbort: true, wantStatus: 200, wantLogged: true},
		{name: "canceled during write", configure: func(w *archiveResponseWriter, cancel context.CancelFunc) { w.cancelOnWrite = cancel }, wantAbort: true, wantStatus: 200, wantLogged: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			routes := &Routes{logger: slog.New(slog.NewJSONHandler(&logs, nil))}
			r := httptest.NewRequest(http.MethodGet, "/archive/content", nil)
			ctx, cancel := context.WithCancel(r.Context())
			defer cancel()
			w := &archiveResponseWriter{ResponseRecorder: httptest.NewRecorder()}
			tc.configure(w, cancel)
			lease := &responseLease{err: tc.closeErr}
			var recovered any
			func() {
				defer func() { recovered = recover() }()
				routes.sendArchive(w, r.WithContext(ctx), []byte(`{"archive":{}}`), time.Second, lease)
			}()
			if tc.wantAbort && recovered != http.ErrAbortHandler || !tc.wantAbort && recovered != nil {
				t.Fatalf("unexpected abort: %v", recovered)
			}
			if lease.calls != 1 {
				t.Fatalf("lease closed %d times", lease.calls)
			}
			if w.Code != tc.wantStatus || !strings.Contains(w.Body.String(), tc.wantBody) {
				t.Fatalf("status=%d body=%q", w.Code, w.Body.String())
			}
			if tc.wantLogged && !strings.Contains(logs.String(), `"phase":"response"`) {
				t.Fatalf("send failure missing from logs: %s", logs.String())
			}
			if strings.Contains(logs.String(), "private write details") || strings.Contains(logs.String(), "private cleanup details") {
				t.Fatal("private failure cause leaked into logs")
			}
		})
	}
}

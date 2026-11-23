package httpx

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type deadlineRecorder struct {
	*httptest.ResponseRecorder
	reads []time.Time
}

type cancellationDeadlineWriter struct {
	*httptest.ResponseRecorder
	refreshEntered chan struct{}
	releaseRefresh chan struct{}
	cancelDeadline chan struct{}
	cancelOnce     sync.Once
}

func (w *cancellationDeadlineWriter) SetReadDeadline(deadline time.Time) error {
	if deadline.After(time.Now().Add(time.Second)) {
		close(w.refreshEntered)
		<-w.releaseRefresh
	} else if !deadline.IsZero() {
		w.cancelOnce.Do(func() { close(w.cancelDeadline) })
	}
	return nil
}

type cancelBlockedBody struct{ canceled <-chan struct{} }

func (b cancelBlockedBody) Read([]byte) (int, error) { <-b.canceled; return 0, context.Canceled }
func (b cancelBlockedBody) Close() error             { return nil }

func TestStreamingCancellationDuringDeadlineRefresh(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := &cancellationDeadlineWriter{ResponseRecorder: httptest.NewRecorder(), refreshEntered: make(chan struct{}), releaseRefresh: make(chan struct{}), cancelDeadline: make(chan struct{})}
	r := httptest.NewRequest(http.MethodPut, "/", nil).WithContext(ctx)
	r.Body = cancelBlockedBody{canceled: w.cancelDeadline}
	b := NewStreamingDeadlineBody(w, r, 30*time.Second, time.Minute)
	result := make(chan error, 1)
	go func() { _, err := b.Read(make([]byte, 1)); result <- err }()
	<-w.refreshEntered
	cancel()
	close(w.releaseRefresh)
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation lost: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled read remained blocked")
	}
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
}

func (w *deadlineRecorder) SetReadDeadline(deadline time.Time) error {
	w.reads = append(w.reads, deadline)
	return nil
}

type failedBody struct{ err error }

func (b failedBody) Read([]byte) (int, error) { return 0, b.err }
func (b failedBody) Close() error             { return nil }

func TestDeadlineBodyStartsOnReadAndClearsAtEOF(t *testing.T) {
	w := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	r := httptest.NewRequest(http.MethodPut, "/", strings.NewReader("content"))
	b := NewDeadlineBody(w, r, 60*time.Second)
	if len(w.reads) != 0 {
		t.Fatal("deadline started before read")
	}
	before := time.Now()
	data, err := io.ReadAll(b)
	if err != nil || string(data) != "content" {
		t.Fatalf("%q %v", data, err)
	}
	if len(w.reads) != 2 || w.reads[0].Before(before.Add(60*time.Second)) || !w.reads[1].IsZero() || r.Body != http.NoBody {
		t.Fatalf("deadlines %v", w.reads)
	}
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestDeadlineBodyPreservesReadCauseAndClosesUnread(t *testing.T) {
	sentinel := errors.New("read failure")
	w := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	r := httptest.NewRequest(http.MethodPut, "/", nil)
	r.Body = failedBody{sentinel}
	_, err := io.ReadAll(NewDeadlineBody(w, r, 120*time.Second))
	var failure *BodyReadError
	if !errors.As(err, &failure) || !errors.Is(err, sentinel) || failure.Status != 400 || !r.Close {
		t.Fatalf("%v close=%v", err, r.Close)
	}
}

func TestStreamingDeadlineRefreshesIdleWithinTotal(t *testing.T) {
	w := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	r := httptest.NewRequest(http.MethodPut, "/", strings.NewReader("abcd"))
	b := NewStreamingDeadlineBody(w, r, 2*time.Second, 5*time.Second)
	start := time.Now()
	data := make([]byte, 2)
	if _, err := b.Read(data); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Read(data); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Read(data); err != io.EOF {
		t.Fatal(err)
	}
	if len(w.reads) != 4 || w.reads[0].Before(start.Add(2*time.Second)) || w.reads[1].Before(w.reads[0]) || w.reads[2].After(start.Add(5*time.Second+time.Second)) || !w.reads[3].IsZero() {
		t.Fatalf("deadlines %v", w.reads)
	}
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
}

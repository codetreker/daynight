package httpx

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type deadlineRecorder struct {
	*httptest.ResponseRecorder
	reads []time.Time
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

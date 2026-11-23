package github

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestReviewAssignmentHTTP(t *testing.T) {
	now := time.Date(2026, 1, 2, 0, 0, 0, 0, time.FixedZone("x", 3600))
	enabled, online := true, false
	s := &readerStub{reviewAssignment: coregithub.ReviewAssignmentResult{Status: "assigned", Assignment: &coregithub.ReviewAssignment{WorkerID: "worker", AssignedAt: now, Online: &online, ReviewEnabled: &enabled}}}
	m := newMux(s)
	base := "/api/v1/projects/" + strings.ToUpper(projectID) + "/pull-requests/42/review-assignment"
	w := call(m, http.MethodGet, base+"?repositoryId=9007199254740993")
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || w.Body.String() != "{\"status\":\"assigned\",\"assignment\":{\"workerId\":\"worker\",\"assignedAt\":\"2026-01-01T23:00:00Z\",\"online\":false,\"reviewEnabled\":true}}\n" {
		t.Fatalf("response %d %s", w.Code, w.Body)
	}
	if s.calls != 1 || s.id != projectID || s.number != 42 || s.repositoryID == nil || *s.repositoryID != 9007199254740993 || s.principal.UserID != userID || s.ctx == nil {
		t.Fatalf("arguments %+v", s)
	}
	s.reviewAssignment = coregithub.ReviewAssignmentResult{Status: "waiting"}
	w = call(m, http.MethodHead, base)
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("HEAD %d %s", w.Code, w.Body)
	}
	w = call(m, http.MethodGet, base)
	if w.Body.String() != "{\"status\":\"waiting\",\"assignment\":null}\n" {
		t.Fatal(w.Body.String())
	}
	s.reviewAssignment = coregithub.ReviewAssignmentResult{Status: "assigned", Assignment: &coregithub.ReviewAssignment{WorkerID: "worker", AssignedAt: now}}
	w = call(m, http.MethodGet, base)
	if !strings.Contains(w.Body.String(), `"online":null,"reviewEnabled":null`) {
		t.Fatal(w.Body.String())
	}
}

func TestReviewAssignmentHTTPRefusals(t *testing.T) {
	s := &readerStub{}
	m := newMux(s)
	base := "/api/v1/projects/" + projectID + "/pull-requests/"
	for _, path := range []string{"0/review-assignment", "01/review-assignment", "-1/review-assignment", "42/review-assignment?repositoryId=0", "42/review-assignment?repositoryId=1&repositoryId=2", "42/review-assignment?unexpected=x"} {
		w := call(m, http.MethodGet, base+path)
		if w.Code != http.StatusBadRequest || w.Header().Get("Cache-Control") != "no-store" || s.calls != 0 {
			t.Fatalf("%s: %d %s, calls %d", path, w.Code, w.Body, s.calls)
		}
	}
	w := call(m, http.MethodPost, base+"42/review-assignment")
	if w.Code != http.StatusMethodNotAllowed || s.calls != 0 {
		t.Fatalf("method %d calls %d", w.Code, s.calls)
	}
	s.err = &model.Fault{Code: "not_found", Message: "Pull request was not found."}
	w = call(m, http.MethodGet, base+"42/review-assignment")
	if w.Code != http.StatusNotFound || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("not found %d %s", w.Code, w.Body)
	}
	s.err = errors.New("private storage failure")
	w = call(m, http.MethodGet, base+"42/review-assignment")
	if w.Code != http.StatusInternalServerError || strings.Contains(w.Body.String(), "private") {
		t.Fatalf("failure %d %s", w.Code, w.Body)
	}
}

type blockingAssignmentReader struct {
	readerStub
	started, stopped chan struct{}
}

func (s *blockingAssignmentReader) ReviewAssignment(ctx context.Context, _ model.Principal, _ string, _ int64, _ *int64) (coregithub.ReviewAssignmentResult, error) {
	close(s.started)
	<-ctx.Done()
	close(s.stopped)
	return coregithub.ReviewAssignmentResult{}, ctx.Err()
}

func TestReviewAssignmentHTTPCancellation(t *testing.T) {
	s := &blockingAssignmentReader{started: make(chan struct{}), stopped: make(chan struct{})}
	m := http.NewServeMux()
	RegisterPullRequestRoutes(m, s, authStub{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		m.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+projectID+"/pull-requests/42/review-assignment", nil).WithContext(ctx))
		close(done)
	}()
	select {
	case <-s.started:
	case <-time.After(time.Second):
		t.Fatal("read did not start")
	}
	cancel()
	select {
	case <-s.stopped:
	case <-time.After(time.Second):
		t.Fatal("read did not stop")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler did not finish")
	}
	if w.Body.Len() != 0 {
		t.Fatalf("cancelled response: %s", w.Body)
	}
}

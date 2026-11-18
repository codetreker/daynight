package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

func statisticsURL(window string) string {
	return "/api/v1/projects/" + projectID + "/pull-request-statistics?endDate=2026-03-08&window=" + url.QueryEscape(window)
}

func statisticsWindow() string {
	first := time.Date(2026, 2, 7, 0, 0, 0, 0, time.UTC).UnixMilli()
	return fmt.Sprintf("0@%d,1@%d,0@%d,-@%d", first, first+86400000, first+90000000, first+172800000)
}

func TestStatisticsProtocolAndPrecision(t *testing.T) {
	c, _ := fixture()
	c.Revision = 9007199254740993
	authorID := int64(9007199254740995)
	authorDaily := &[30]int64{}
	authorDaily[1] = 9007199254740994
	result := coregithub.Statistics{Connection: c, ProjectTotal: 9007199254740996, Availability: "ready", HasAuthors: true, AuthorID: &authorID, Author: &githubpr.Author{ID: authorID, Login: "new-name"}, AuthorDaily: authorDaily}
	result.Daily[1] = 9007199254740995
	s := &readerStub{statisticsResult: result}
	w := call(newMux(s), "GET", statisticsURL(statisticsWindow())+"&authorId=9007199254740995")
	var got api.PullRequestStatistics
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
		t.Fatalf("response %d %s: %v", w.Code, w.Body, err)
	}
	if s.calls != 1 || s.id != projectID || s.principal.UserID != userID || s.statisticsInput.EndDate != "2026-03-08" || len(s.statisticsInput.Window) != 4 || s.statisticsInput.Window[2].DateIndex != 0 || s.statisticsInput.Window[3].DateIndex != -1 || *s.statisticsInput.AuthorID != authorID {
		t.Fatalf("request: %+v", s.statisticsInput)
	}
	if got.ProjectID != projectID || got.EndDate != "2026-03-08" || got.Revision != "9007199254740993" || got.ProjectTotal != "9007199254740996" || got.Daily[0] != "0" || got.Daily[1] != "9007199254740995" || got.Author == nil || got.Author.ID != "9007199254740995" || got.Author.Login != "new-name" || got.AuthorDaily == nil || got.AuthorDaily[1] != "9007199254740994" || w.Header().Get("Daynight-User-ID") != userID || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("response: %s headers %v", w.Body, w.Header())
	}
	s.statisticsResult.AuthorID, s.statisticsResult.Author, s.statisticsResult.AuthorDaily = nil, nil, nil
	w = call(newMux(s), "GET", statisticsURL(statisticsWindow()))
	if !strings.Contains(w.Body.String(), `"authorId":null`) || !strings.Contains(w.Body.String(), `"author":null`) || !strings.Contains(w.Body.String(), `"authorDaily":null`) {
		t.Fatalf("unselected author: %s", w.Body)
	}
	zero := &[30]int64{}
	s.statisticsResult.AuthorID, s.statisticsResult.AuthorDaily = &authorID, zero
	w = call(newMux(s), "GET", statisticsURL(statisticsWindow())+"&authorId=9007199254740995")
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || got.Author != nil || got.AuthorDaily == nil || got.AuthorDaily[29] != "0" {
		t.Fatalf("unknown author: %s %v", w.Body, err)
	}
}

func TestStatisticsRejectsInvalidQueriesBeforeReading(t *testing.T) {
	s := &readerStub{}
	m := newMux(s)
	base := "/api/v1/projects/" + projectID + "/pull-request-statistics"
	first := time.Date(2026, 2, 7, 0, 0, 0, 0, time.UTC).UnixMilli()
	window := statisticsWindow()
	for _, query := range []string{
		"", "?endDate=2026-03-08", "?window=" + url.QueryEscape(window),
		"?endDate=2026-02-29&window=" + url.QueryEscape(window),
		"?endDate=0001-01-29&window=" + url.QueryEscape(window),
		"?endDate=0000-03-08&window=" + url.QueryEscape(window),
		"?endDate=2026-3-08&window=" + url.QueryEscape(window),
		"?endDate=2026-03-08&endDate=2026-03-08&window=" + url.QueryEscape(window),
		"?endDate=2026-03-08&window=&authorId=1", "?endDate=2026-03-08&window=%GG",
		"?endDate=2026-03-08&window=" + url.QueryEscape(window) + "&other=x",
		"?endDate=2026-03-08&window=" + url.QueryEscape(window) + "&authorId=01",
		"?endDate=2026-03-08&window=" + url.QueryEscape(window) + "&authorId=1&authorId=1",
	} {
		w := call(m, "GET", base+query)
		if w.Code != http.StatusBadRequest || s.calls != 0 {
			t.Errorf("query %q: %d %s calls %d", query, w.Code, w.Body, s.calls)
		}
	}
	for _, invalid := range []string{
		"", fmt.Sprintf("0@%d", first), fmt.Sprintf("-@%d,-@%d", first, first+1),
		fmt.Sprintf("0@%d,0@%d,-@%d", first, first+1, first+2),
		fmt.Sprintf("0@%d,-@%d", first, first), fmt.Sprintf("0@%d,1@%d", first, first+1),
		fmt.Sprintf("30@%d,-@%d", first, first+1), fmt.Sprintf("00@%d,-@%d", first, first+1),
		fmt.Sprintf("0@+%d,-@%d", first, first+1), fmt.Sprintf("0@%d,-@%d", first-86400001, first+1),
		fmt.Sprintf("0@%d,-@%d", first, first+172800001), fmt.Sprintf("29@%d,-@%d", first, first+1),
		strings.Repeat(fmt.Sprintf("0@%d,", first), 64) + fmt.Sprintf("-@%d", first+1),
	} {
		w := call(m, "GET", statisticsURL(invalid))
		if w.Code != http.StatusBadRequest || s.calls != 0 {
			t.Errorf("window %q: %d %s calls %d", invalid, w.Code, w.Body, s.calls)
		}
	}
	w := call(m, "GET", base+"?"+strings.Repeat("a", 4097))
	if w.Code != http.StatusRequestURITooLong || s.calls != 0 {
		t.Fatalf("long query: %d %s", w.Code, w.Body)
	}
	w = call(m, "GET", base+"?"+strings.Repeat("a", 4096))
	if w.Code != http.StatusBadRequest || s.calls != 0 {
		t.Fatalf("limit query: %d %s", w.Code, w.Body)
	}
	w = call(m, "POST", base)
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD" || s.calls != 0 {
		t.Fatalf("method %d %v", w.Code, w.Header())
	}
}

func TestStatisticsWindowLimitsAndSignedTimes(t *testing.T) {
	first := time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	// Inclusive bounds accommodate the widest permitted local offset.
	w := fmt.Sprintf("0@%d,-@%d", first-86400000, first+172800000)
	segments, err := parseStatisticsWindow("0001-01-30", w)
	if err != nil || len(segments) != 2 || segments[0].StartMillis != first-86400000 {
		t.Fatalf("signed and inclusive boundaries: %+v %v", segments, err)
	}
	parts := make([]string, 64)
	for i := 0; i < 63; i++ {
		parts[i] = fmt.Sprintf("%d@%d", i%2, first+int64(i))
	}
	parts[63] = fmt.Sprintf("-@%d", first+63)
	segments, err = parseStatisticsWindow("0001-01-30", strings.Join(parts, ","))
	if err != nil || len(segments) != 64 {
		t.Fatalf("maximum segments: %d %v", len(segments), err)
	}
}

type blockingStatisticsReader struct {
	readerStub
	started, stopped chan struct{}
}

func (s *blockingStatisticsReader) Statistics(ctx context.Context, _ model.Principal, _ string, _ coregithub.StatisticsRequest) (coregithub.Statistics, error) {
	close(s.started)
	<-ctx.Done()
	close(s.stopped)
	return coregithub.Statistics{}, ctx.Err()
}

func TestStatisticsCancellationAndSafeErrorLog(t *testing.T) {
	reader := &blockingStatisticsReader{started: make(chan struct{}), stopped: make(chan struct{})}
	mux := http.NewServeMux()
	var log bytes.Buffer
	RegisterPullRequestRoutes(mux, reader, authStub{}, slog.New(slog.NewJSONHandler(&log, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		mux.ServeHTTP(w, httptest.NewRequest("GET", statisticsURL(statisticsWindow()), nil).WithContext(ctx))
		close(done)
	}()
	select {
	case <-reader.started:
	case <-time.After(time.Second):
		t.Fatal("read did not start")
	}
	cancel()
	select {
	case <-reader.stopped:
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
	log.Reset()
	failure := &readerStub{err: errors.New("database failure")}
	mux = http.NewServeMux()
	RegisterPullRequestRoutes(mux, failure, authStub{}, slog.New(slog.NewJSONHandler(&log, nil)))
	w = call(mux, "GET", statisticsURL(statisticsWindow())+"&authorId=1234567")
	if w.Code != 500 || !strings.Contains(log.String(), `"phase":"statistics"`) || !strings.Contains(log.String(), `"project_id":"`+projectID+`"`) || strings.Contains(log.String(), "1234567") || strings.Contains(log.String(), "2026-03-08") || strings.Contains(log.String(), "database failure") || strings.Contains(w.Body.String(), "database failure") {
		t.Fatalf("response %d %s log %s", w.Code, w.Body, log.String())
	}
	log.Reset()
	failure.err = &model.Fault{Code: "not_found", Message: "private statistics data"}
	w = call(mux, "GET", statisticsURL(statisticsWindow()))
	if w.Code != http.StatusNotFound || strings.Contains(log.String(), "private statistics data") || !strings.Contains(log.String(), `"error_code":"not_found"`) {
		t.Fatalf("failure %d log %s", w.Code, log.String())
	}
}

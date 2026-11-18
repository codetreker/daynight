package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

const diagnosticPrivateContent = "private-token private-key webhook-secret Authorization: Bearer private-markdown-body"

func diagnosticRecords(t *testing.T, output *bytes.Buffer) []map[string]any {
	t.Helper()
	for _, sensitive := range strings.Fields(diagnosticPrivateContent) {
		if strings.Contains(output.String(), sensitive) {
			t.Fatalf("diagnostics exposed private content: %q", sensitive)
		}
	}
	var records []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(output.Bytes()), []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatalf("invalid JSON log: %v", err)
		}
		records = append(records, record)
		if record["phase"] == "discovery" || record["phase"] == "detail" {
			t.Log(string(line))
		}
	}
	return records
}

func requireDiagnostic(t *testing.T, records []map[string]any, want map[string]any) map[string]any {
	t.Helper()
	var matches []map[string]any
	for _, record := range records {
		match := true
		for key, value := range want {
			if record[key] != value {
				match = false
				break
			}
		}
		if match {
			matches = append(matches, record)
		}
	}
	if len(matches) != 1 {
		t.Fatalf("matching logs=%d, want one with %+v; records=%+v", len(matches), want, records)
	}
	return matches[0]
}

func discoveryDiagnosticRun(t *testing.T, f *pollFixture, remote Remote) (*run, *bytes.Buffer) {
	t.Helper()
	r := f.preparedRun(remote)
	output := &bytes.Buffer{}
	r.log = slog.New(slog.NewJSONHandler(output, nil))
	return r, output
}

func TestDiscoveryDiagnosticsNormalAndTruncated(t *testing.T) {
	for _, truncated := range []bool{false, true} {
		t.Run(fmt.Sprintf("truncated=%v", truncated), func(t *testing.T) {
			f := newPollFixture(t)
			f.facts = func(int64, *time.Time) store.GitHubPublicationFacts { return store.GitHubPublicationFacts{} }
			client := f.remote()
			pages := 1
			result := "natural_end"
			if truncated {
				pages, result = 10, "truncated"
			}
			client.listAll = func(ctx context.Context, _ int64, _, _ string, visit func([]remote.PullSummary) error) (bool, error) {
				for range pages {
					if err := visit([]remote.PullSummary{{Number: 5, RepositoryID: 30, State: "open", UpdatedAt: f.now}}); err != nil {
						return false, err
					}
				}
				return truncated, nil
			}
			client.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
				o := observation(n, "open", f.now)
				body := diagnosticPrivateContent
				o.Description = &body
				return o, nil
			}
			r, output := discoveryDiagnosticRun(t, f, client)
			if err := r.discover(context.Background(), "owner", "repo"); err != nil {
				t.Fatal(err)
			}
			records := diagnosticRecords(t, output)
			requireDiagnostic(t, records, map[string]any{"phase": "discovery", "result": result, "pages": float64(pages), "candidates": float64(1), "published": float64(1)})
			requireDiagnostic(t, records, map[string]any{"phase": "detail", "stage": "initial", "result": "success", "number": float64(5), "pages": float64(pages), "candidates": float64(1), "published": float64(0)})
			if len(f.publications) != 1 {
				t.Fatalf("duplicate discovery published %d batches", len(f.publications))
			}
		})
	}
}

func TestDiscoveryDiagnosticsListAndDetailFailures(t *testing.T) {
	for _, stage := range []string{"list", "initial", "recheck"} {
		t.Run(stage, func(t *testing.T) {
			f := newPollFixture(t)
			f.facts = func(int64, *time.Time) store.GitHubPublicationFacts {
				return store.GitHubPublicationFacts{Period: &store.GitHubCoveragePeriod{StartedAt: f.now.Add(-time.Hour)}}
			}
			cause := fmt.Errorf("%s: %w", diagnosticPrivateContent, &remote.Error{Code: "unavailable", Status: 500, RequestID: "request-500"})
			client := f.remote()
			client.listAll = func(ctx context.Context, _ int64, _, _ string, visit func([]remote.PullSummary) error) (bool, error) {
				if err := visit([]remote.PullSummary{{Number: 5, RepositoryID: 30, State: "open", UpdatedAt: f.now}, {Number: 6, RepositoryID: 30, State: "closed", UpdatedAt: f.now, ClosedAt: &f.now}}); err != nil {
					return false, err
				}
				if stage == "list" {
					return false, cause
				}
				return false, nil
			}
			reads := 0
			client.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
				if n == 5 {
					return observation(n, "open", f.now), nil
				}
				reads++
				if stage == "initial" || reads == 2 {
					return githubpr.Observation{}, cause
				}
				return observation(n, "open", f.now), nil
			}
			r, output := discoveryDiagnosticRun(t, f, client)
			if err := r.discover(context.Background(), "owner", "repo"); err != cause {
				t.Fatalf("error object changed: %v", err)
			}
			records := diagnosticRecords(t, output)
			phase, candidates, published := "detail", 2, 1
			if stage == "list" {
				phase, candidates, published = "discovery", 0, 0
			}
			want := map[string]any{"phase": phase, "stage": stage, "result": "failed", "pages": float64(1), "candidates": float64(candidates), "published": float64(published), "result_code": "github_unavailable", "remote_status": float64(500), "github_request_id": "request-500"}
			if phase == "detail" {
				want["number"] = float64(6)
			}
			requireDiagnostic(t, records, want)
			for _, record := range records {
				if phase == "detail" && record["phase"] == "discovery" {
					t.Fatalf("detail failure misreported by discovery: %+v", record)
				}
			}
		})
	}
}

func TestDiscoveryDiagnosticsInterleavedHintFailureRetainsSource(t *testing.T) {
	f := newPollFixture(t)
	f.hints = []store.GitHubPendingPR{hintFor(4, "hint-request")}
	cause := &remote.Error{Code: "rate_limited", Status: 429, RequestID: "hint-upstream"}
	client := f.remote()
	client.listAll = func(ctx context.Context, _ int64, _, _ string, visit func([]remote.PullSummary) error) (bool, error) {
		return false, visit(nil)
	}
	client.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		if n != 4 {
			t.Fatalf("wrong hint number %d", n)
		}
		return githubpr.Observation{}, cause
	}
	r, output := discoveryDiagnosticRun(t, f, client)
	if err := r.discover(context.Background(), "owner", "repo"); err != cause {
		t.Fatalf("hint cause changed: %v", err)
	}
	records := diagnosticRecords(t, output)
	requireDiagnostic(t, records, map[string]any{"phase": "detail", "stage": "initial", "source": "hint", "hint_id": "hint-request", "delivery_id": "delivery-hint-request", "number": float64(4), "result_code": "github_rate_limited", "pages": float64(1), "candidates": float64(0), "published": float64(0)})
	requireDiagnostic(t, records, map[string]any{"phase": "discovery", "stage": "hint", "result": "failed", "remote_status": float64(429), "pages": float64(1), "candidates": float64(0), "published": float64(0)})
	for _, record := range records {
		if record["stage"] == "list" {
			t.Fatalf("hint failure misreported as list: %+v", record)
		}
	}
	if len(f.rescheduled) != 1 || f.rescheduled[0] != "hint-request" {
		t.Fatalf("hint rescheduling changed: %v", f.rescheduled)
	}
}

func TestDiscoveryDiagnosticsCountsCommittedPublicationBeforeRenewalFailure(t *testing.T) {
	f := newPollFixture(t)
	f.unknownRenewAt = 1
	f.facts = func(int64, *time.Time) store.GitHubPublicationFacts { return store.GitHubPublicationFacts{} }
	client := f.remote()
	client.listAll = func(ctx context.Context, _ int64, _, _ string, visit func([]remote.PullSummary) error) (bool, error) {
		return false, visit([]remote.PullSummary{{Number: 5, RepositoryID: 30, State: "open", UpdatedAt: f.now}})
	}
	client.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		return observation(n, "open", f.now), nil
	}
	r, output := discoveryDiagnosticRun(t, f, client)
	if err := r.discover(context.Background(), "owner", "repo"); !errors.Is(err, errUnknown) {
		t.Fatalf("renewal failure changed: %v", err)
	}
	requireDiagnostic(t, diagnosticRecords(t, output), map[string]any{"phase": "discovery", "stage": "publish", "result": "failed", "pages": float64(1), "candidates": float64(1), "published": float64(1)})
	if len(f.publications) != 1 {
		t.Fatalf("committed publications=%d", len(f.publications))
	}
}

func TestDiscoveryDiagnosticsValidationAndSelectionFailures(t *testing.T) {
	for _, stage := range []string{"list", "selection", "initial"} {
		t.Run(stage, func(t *testing.T) {
			f := newPollFixture(t)
			client := f.remote()
			client.listAll = func(ctx context.Context, _ int64, _, _ string, visit func([]remote.PullSummary) error) (bool, error) {
				repository := int64(30)
				if stage == "list" {
					repository = 999
				}
				return false, visit([]remote.PullSummary{{Number: 5, RepositoryID: repository, State: "open", UpdatedAt: f.now}})
			}
			factsCalls := 0
			f.facts = func(int64, *time.Time) store.GitHubPublicationFacts {
				factsCalls++
				if stage == "selection" {
					f.lost = true
				}
				return store.GitHubPublicationFacts{}
			}
			client.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
				o := observation(n, "closed", f.now)
				o.ClosedAt = nil
				return o, nil
			}
			r, output := discoveryDiagnosticRun(t, f, client)
			if err := r.discover(context.Background(), "owner", "repo"); err == nil {
				t.Fatal("invalid discovery unexpectedly succeeded")
			}
			phase, pages, candidates := "discovery", 1, 0
			if stage == "list" {
				pages = 0
			}
			if stage == "initial" {
				phase, candidates = "detail", 1
			}
			requireDiagnostic(t, diagnosticRecords(t, output), map[string]any{"phase": phase, "stage": stage, "result": "failed", "pages": float64(pages), "candidates": float64(candidates), "published": float64(0)})
			if stage == "selection" && factsCalls != 1 {
				t.Fatalf("continued after selection failure: facts=%d", factsCalls)
			}
		})
	}
}

package github

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type receiptStub struct {
	t                 *testing.T
	ctx               context.Context
	facts             store.GitHubProjectWebhookReceiptFacts
	lockErr, writeErr error
	calls             []string
	write             store.GitHubProjectWebhookReceiptWrite
}

func (s *receiptStub) LockReceipt(ctx context.Context) (store.GitHubProjectWebhookReceiptFacts, error) {
	if ctx != s.ctx || len(s.calls) != 0 {
		s.t.Fatal("unexpected lock call or context")
	}
	s.calls = append(s.calls, "lock")
	return s.facts, s.lockErr
}
func (s *receiptStub) RecordReceipt(ctx context.Context, w store.GitHubProjectWebhookReceiptWrite) error {
	if ctx != s.ctx || !reflect.DeepEqual(s.calls, []string{"lock"}) {
		s.t.Fatal("unexpected write call or context")
	}
	s.calls = append(s.calls, "write")
	s.write = w
	return s.writeErr
}
func TestRecordProjectWebhook(t *testing.T) {
	version, repo, other := int64(4), int64(7), int64(8)
	base := store.GitHubProjectWebhookReceiptFacts{Exists: true, Version: &version, RepositoryID: &repo, CurrentRepositoryID: &repo, Enabled: true, SyncEnabled: true, BindingValid: true, AccessAvailable: true, Generation: 3}
	failure := errors.New("storage failed")
	for _, tc := range []struct {
		name    string
		modify  func(*receiptStub, *ProjectWebhookIdentity, *WebhookEvent)
		result  ProjectWebhookReceiptResult
		err     error
		calls   []string
		enqueue bool
	}{
		{"eligible PR", func(*receiptStub, *ProjectWebhookIdentity, *WebhookEvent) {}, ProjectWebhookEnqueued, nil, []string{"lock", "write"}, true},
		{"ping", func(_ *receiptStub, _ *ProjectWebhookIdentity, e *WebhookEvent) { e.Kind = "ping"; e.Number = 0 }, ProjectWebhookReceived, nil, []string{"lock", "write"}, false},
		{"sync off", func(s *receiptStub, _ *ProjectWebhookIdentity, _ *WebhookEvent) { s.facts.SyncEnabled = false }, ProjectWebhookReceived, nil, []string{"lock", "write"}, false},
		{"disconnected", func(s *receiptStub, _ *ProjectWebhookIdentity, _ *WebhookEvent) {
			s.facts.CurrentRepositoryID = nil
			s.facts.BindingValid = false
		}, ProjectWebhookReceived, nil, []string{"lock", "write"}, false},
		{"revoked", func(s *receiptStub, _ *ProjectWebhookIdentity, _ *WebhookEvent) { s.facts.BindingValid = false }, ProjectWebhookReceived, nil, []string{"lock", "write"}, false},
		{"unavailable", func(s *receiptStub, _ *ProjectWebhookIdentity, _ *WebhookEvent) { s.facts.AccessAvailable = false }, ProjectWebhookReceived, nil, []string{"lock", "write"}, false},
		{"wrong event repository", func(_ *receiptStub, _ *ProjectWebhookIdentity, e *WebhookEvent) { e.RepositoryID = other }, ProjectWebhookRejected, nil, []string{"lock"}, false},
		{"different active repository", func(s *receiptStub, _ *ProjectWebhookIdentity, _ *WebhookEvent) { s.facts.CurrentRepositoryID = &other }, ProjectWebhookRejected, nil, []string{"lock"}, false},
		{"rotated", func(_ *receiptStub, i *ProjectWebhookIdentity, _ *WebhookEvent) { i.Version-- }, "", ErrProjectWebhookSnapshotChanged, []string{"lock"}, false},
		{"rebound", func(_ *receiptStub, i *ProjectWebhookIdentity, _ *WebhookEvent) { i.RepositoryID = other }, "", ErrProjectWebhookSnapshotChanged, []string{"lock"}, false},
		{"disabled", func(s *receiptStub, _ *ProjectWebhookIdentity, _ *WebhookEvent) { s.facts.Enabled = false }, "", ErrProjectWebhookSnapshotChanged, []string{"lock"}, false},
		{"missing", func(s *receiptStub, _ *ProjectWebhookIdentity, _ *WebhookEvent) { s.facts.Exists = false }, "", ErrProjectWebhookSnapshotChanged, []string{"lock"}, false},
		{"unconfigured", func(s *receiptStub, _ *ProjectWebhookIdentity, _ *WebhookEvent) {
			s.facts.Version = nil
			s.facts.RepositoryID = nil
		}, "", ErrProjectWebhookSnapshotChanged, []string{"lock"}, false},
		{"lock error", func(s *receiptStub, _ *ProjectWebhookIdentity, _ *WebhookEvent) { s.lockErr = failure }, "", failure, []string{"lock"}, false},
		{"write error", func(s *receiptStub, _ *ProjectWebhookIdentity, _ *WebhookEvent) { s.writeErr = failure }, "", failure, []string{"lock", "write"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			s := &receiptStub{t: t, ctx: ctx, facts: base}
			i := ProjectWebhookIdentity{ProjectID: "project", Version: version, RepositoryID: repo}
			e := WebhookEvent{Kind: "pull_request", RepositoryID: repo, Number: 12, DeliveryID: "delivery"}
			tc.modify(s, &i, &e)
			got, err := RecordProjectWebhook(ctx, s, i, e, "request")
			if got != tc.result || !errors.Is(err, tc.err) {
				t.Fatalf("got %q, %v; want %q, %v", got, err, tc.result, tc.err)
			}
			if !reflect.DeepEqual(s.calls, tc.calls) {
				t.Fatalf("calls %v, want %v", s.calls, tc.calls)
			}
			if len(s.calls) == 2 {
				want := store.GitHubProjectWebhookReceiptWrite{Enqueue: tc.enqueue, Number: e.Number, RequestID: "request", DeliveryID: e.DeliveryID}
				if s.write != want {
					t.Fatalf("write %+v, want %+v", s.write, want)
				}
			}
		})
	}
}
func TestRecordProjectWebhookRejectsInvalidInputBeforeLock(t *testing.T) {
	for _, mutate := range []func(*ProjectWebhookIdentity, *WebhookEvent, *string){
		func(i *ProjectWebhookIdentity, _ *WebhookEvent, _ *string) { i.ProjectID = " " },
		func(i *ProjectWebhookIdentity, _ *WebhookEvent, _ *string) { i.Version = 0 },
		func(i *ProjectWebhookIdentity, _ *WebhookEvent, _ *string) { i.RepositoryID = 0 },
		func(_ *ProjectWebhookIdentity, e *WebhookEvent, _ *string) { e.RepositoryID = 0 },
		func(_ *ProjectWebhookIdentity, e *WebhookEvent, _ *string) { e.Number = 0 },
		func(_ *ProjectWebhookIdentity, e *WebhookEvent, _ *string) { e.Kind = "access" },
		func(_ *ProjectWebhookIdentity, e *WebhookEvent, _ *string) { e.DeliveryID = " " },
		func(_ *ProjectWebhookIdentity, _ *WebhookEvent, r *string) { *r = " " },
	} {
		ctx := t.Context()
		s := &receiptStub{t: t, ctx: ctx}
		i := ProjectWebhookIdentity{ProjectID: "project", Version: 1, RepositoryID: 2}
		e := WebhookEvent{Kind: "pull_request", RepositoryID: 2, Number: 3, DeliveryID: "delivery"}
		r := "request"
		mutate(&i, &e, &r)
		if _, err := RecordProjectWebhook(ctx, s, i, e, r); err == nil || len(s.calls) != 0 {
			t.Fatalf("invalid input: err %v, calls %v", err, s.calls)
		}
	}
	if _, err := RecordProjectWebhook(t.Context(), nil, ProjectWebhookIdentity{}, WebhookEvent{}, ""); err == nil {
		t.Fatal("nil DAO accepted")
	}
}

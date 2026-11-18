package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
	"github.com/google/uuid"
)

type receiptServiceDAO struct {
	t         *testing.T
	ctx       context.Context
	writes    int
	requestID string
}

func (d *receiptServiceDAO) LockReceipt(ctx context.Context) (store.GitHubProjectWebhookReceiptFacts, error) {
	if ctx != d.ctx {
		d.t.Fatal("wrong context")
	}
	version, repo := int64(3), int64(42)
	return store.GitHubProjectWebhookReceiptFacts{Exists: true, Enabled: true, SyncEnabled: true, BindingValid: true, AccessAvailable: true, Version: &version, RepositoryID: &repo, CurrentRepositoryID: &repo}, nil
}
func (d *receiptServiceDAO) RecordReceipt(ctx context.Context, write store.GitHubProjectWebhookReceiptWrite) error {
	if ctx != d.ctx || !write.Enqueue || write.Number != 7 || write.DeliveryID != "delivery" {
		d.t.Fatalf("unexpected write: %+v", write)
	}
	if id, err := uuid.Parse(write.RequestID); err != nil || id == uuid.Nil {
		d.t.Fatalf("invalid request ID: %q", write.RequestID)
	}
	d.writes++
	d.requestID = write.RequestID
	return nil
}

func TestProjectWebhookReceiverLogsQueueCorrelation(t *testing.T) {
	ctx := requestid.With(t.Context(), "http-request")
	dao := &receiptServiceDAO{t: t, ctx: ctx}
	writer := &receiptServiceWriter{t: t, dao: dao, outcome: store.TransactionCommitted}
	var output bytes.Buffer
	receiver, err := NewProjectWebhookReceiver(writer, slog.New(slog.NewJSONHandler(&output, nil)))
	if err != nil {
		t.Fatal(err)
	}
	_, err = receiver.Receive(ctx, mgmtProject, core.ProjectWebhookIdentity{ProjectID: mgmtProject, Version: 3, RepositoryID: 42}, core.WebhookEvent{Kind: "pull_request", RepositoryID: 42, Number: 7, DeliveryID: "delivery"})
	if err != nil {
		t.Fatal(err)
	}
	var entry map[string]any
	if err := json.Unmarshal(output.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if entry["request_id"] != "http-request" || entry["queue_request_id"] != dao.requestID || entry["delivery_id"] != "delivery" || entry["project_id"] != mgmtProject || entry["write_outcome"] != "committed" {
		t.Fatalf("correlation log: %+v", entry)
	}
}

type receiptServiceScope struct {
	store.ProjectWriteScope
	dao *receiptServiceDAO
}

func (s receiptServiceScope) GitHubProjectWebhookReceiptDAO() store.GitHubProjectWebhookReceiptDAO {
	return s.dao
}

type receiptServiceWriter struct {
	t       *testing.T
	dao     *receiptServiceDAO
	outcome store.TransactionOutcome
	cause   error
	calls   int
}

func (w *receiptServiceWriter) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	w.calls++
	if ctx != w.dao.ctx || id != mgmtProject {
		w.t.Fatalf("wrong project or context: %q", id)
	}
	if err := work(receiptServiceScope{dao: w.dao}); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: w.outcome}, w.cause
}
func TestProjectWebhookReceiverCompletion(t *testing.T) {
	lost := errors.New("commit response lost")
	for _, tc := range []struct {
		name             string
		outcome          store.TransactionOutcome
		cause            error
		success, unknown bool
	}{
		{"committed", store.TransactionCommitted, nil, true, false},
		{"rollback", store.TransactionNotCommitted, errors.New("rollback"), false, false},
		{"unknown", store.TransactionUnknown, lost, false, true},
		{"missing outcome", "", nil, false, false},
		{"cleanup error", store.TransactionCommitted, errors.New("cleanup"), false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			dao := &receiptServiceDAO{t: t, ctx: ctx}
			writer := &receiptServiceWriter{t: t, dao: dao, outcome: tc.outcome, cause: tc.cause}
			receiver, err := NewProjectWebhookReceiver(writer, nil)
			if err != nil {
				t.Fatal(err)
			}
			result, err := receiver.Receive(ctx, mgmtProject, core.ProjectWebhookIdentity{ProjectID: mgmtProject, Version: 3, RepositoryID: 42}, core.WebhookEvent{Kind: "pull_request", RepositoryID: 42, Number: 7, DeliveryID: "delivery"})
			if writer.calls != 1 || dao.writes != 1 {
				t.Fatalf("calls=%d writes=%d", writer.calls, dao.writes)
			}
			if tc.success {
				if err != nil || result != core.ProjectWebhookEnqueued {
					t.Fatalf("result=%q error=%v", result, err)
				}
			} else if err == nil || result != "" || (tc.cause != nil && !errors.Is(err, tc.cause)) || (tc.unknown && !errors.Is(err, errUnknown)) {
				t.Fatalf("result=%q error=%v", result, err)
			}
		})
	}
}
func TestProjectWebhookReceiverRejectsInvalidProjectBeforeWrite(t *testing.T) {
	receiver, err := NewProjectWebhookReceiver(&receiptServiceWriter{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = receiver.Receive(t.Context(), "bad", core.ProjectWebhookIdentity{}, core.WebhookEvent{}); err == nil {
		t.Fatal("invalid project accepted")
	}
	if _, err = NewProjectWebhookReceiver(nil, nil); err == nil {
		t.Fatal("nil store accepted")
	}
	if _, err = receiver.Receive(t.Context(), mgmtProject, core.ProjectWebhookIdentity{ProjectID: uuid.NewString(), Version: 3, RepositoryID: 42}, core.WebhookEvent{Kind: "pull_request", RepositoryID: 42, Number: 7, DeliveryID: "delivery"}); err == nil {
		t.Fatal("another project's snapshot accepted")
	}
}

func TestProjectWebhookReceiverSuppressesStaleSnapshot(t *testing.T) {
	ctx := t.Context()
	dao := &receiptServiceDAO{t: t, ctx: ctx}
	writer := &receiptServiceWriter{t: t, dao: dao, outcome: store.TransactionCommitted}
	receiver, err := NewProjectWebhookReceiver(writer, nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := receiver.Receive(ctx, mgmtProject, core.ProjectWebhookIdentity{ProjectID: mgmtProject, Version: 2, RepositoryID: 42}, core.WebhookEvent{Kind: "pull_request", RepositoryID: 42, Number: 7, DeliveryID: "delivery"})
	if result != "" || !errors.Is(err, core.ErrProjectWebhookSnapshotChanged) || dao.writes != 0 || writer.calls != 1 {
		t.Fatalf("result=%q error=%v writes=%d calls=%d", result, err, dao.writes, writer.calls)
	}
}

package webhook_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
)

var errRedeliveryInjected = errors.New("injected redelivery dependency failure")

func redeliveryErrorContains(err error, fragment string) bool {
	if err == nil {
		return false
	}
	if strings.Contains(err.Error(), fragment) {
		return true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, e := range joined.Unwrap() {
			if redeliveryErrorContains(e, fragment) {
				return true
			}
		}
		return false
	}
	return redeliveryErrorContains(errors.Unwrap(err), fragment)
}

type redeliveryFaultDB struct {
	store.WebhookTransactions
	phase string
	reads int
}

func (d *redeliveryFaultDB) ReadWebhookSnapshot(ctx context.Context, fn func(store.WebhookReadScope) error) error {
	d.reads++
	if (d.phase == "initial_snapshot" && d.reads == 1) || (d.phase == "postcommit_snapshot" && d.reads == 2) {
		return errRedeliveryInjected
	}
	return d.WebhookTransactions.ReadWebhookSnapshot(ctx, fn)
}
func (d *redeliveryFaultDB) WriteWebhook(ctx context.Context, o wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
	if d.phase == "unknown_with_error" {
		return store.Completion{Outcome: store.TransactionUnknown}, errRedeliveryInjected
	}
	if d.phase == "unknown_without_error" {
		return store.Completion{Outcome: store.TransactionUnknown}, nil
	}
	return d.WebhookTransactions.WriteWebhook(ctx, o, id, func(sc store.WebhookWriteScope) error {
		return fn(&redeliveryFaultScope{WebhookWriteScope: sc, phase: d.phase})
	})
}

type redeliveryFaultScope struct {
	store.WebhookWriteScope
	phase  string
	clocks int
}

func (s *redeliveryFaultScope) WebhookWriter() store.WebhookWriter {
	return redeliveryFaultWriter{WebhookWriter: s.WebhookWriteScope.WebhookWriter(), phase: s.phase}
}
func (s *redeliveryFaultScope) WebhookDAO() store.WebhookReader {
	if s.phase == "history_required" {
		return redeliveryBasicReader{WebhookReader: s.WebhookWriteScope.WebhookDAO()}
	}
	return s.WebhookWriteScope.WebhookDAO()
}
func (s *redeliveryFaultScope) RedeliveryWriter() store.WebhookRedeliveryScope {
	return redeliveryFaultDAO{WebhookRedeliveryScope: s.WebhookWriteScope.RedeliveryWriter(), phase: s.phase}
}
func (s *redeliveryFaultScope) EligibilityDAO() store.WebhookEligibilityDAO {
	return redeliveryFaultEligibility{WebhookEligibilityDAO: s.WebhookWriteScope.EligibilityDAO(), phase: s.phase}
}
func (s *redeliveryFaultScope) LockCredential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	if s.phase == "credential" {
		return store.ThreadCredential{}, errRedeliveryInjected
	}
	return s.WebhookWriteScope.LockCredential(ctx, p)
}
func (s *redeliveryFaultScope) ObservedAt(ctx context.Context) (time.Time, error) {
	s.clocks++
	if (s.phase == "initial_clock" && s.clocks == 1) || (s.phase == "locked_clock" && s.clocks == 2) || (s.phase == "final_clock" && s.clocks == 4) {
		return time.Time{}, errRedeliveryInjected
	}
	return s.WebhookWriteScope.ObservedAt(ctx)
}

type redeliveryBasicReader struct{ store.WebhookReader }
type redeliveryFaultWriter struct {
	store.WebhookWriter
	phase string
}

func (w redeliveryFaultWriter) Operation(ctx context.Context, o wm.Owner, id string) (wm.Operation, error) {
	if w.phase == "receipt_lookup" {
		return wm.Operation{}, errRedeliveryInjected
	}
	return w.WebhookWriter.Operation(ctx, o, id)
}
func (w redeliveryFaultWriter) Policy(ctx context.Context, version int64) (wm.Policy, error) {
	if w.phase == "policy" {
		return wm.Policy{}, errRedeliveryInjected
	}
	return w.WebhookWriter.Policy(ctx, version)
}
func (w redeliveryFaultWriter) PutOperation(ctx context.Context, o wm.Operation) error {
	if w.phase == "receipt_insert" {
		return errRedeliveryInjected
	}
	return w.WebhookWriter.PutOperation(ctx, o)
}

type redeliveryFaultDAO struct {
	store.WebhookRedeliveryScope
	phase string
}

func (d redeliveryFaultDAO) AdmissionSourcesForActor(ctx context.Context, id, endpoint string, o wm.Owner, actor string, now time.Time) (store.WebhookAdmissionSources, error) {
	if d.phase == "sources" {
		return store.WebhookAdmissionSources{}, errRedeliveryInjected
	}
	return d.WebhookRedeliveryScope.AdmissionSourcesForActor(ctx, id, endpoint, o, actor, now)
}
func (d redeliveryFaultDAO) LockDelivery(ctx context.Context, id string) (store.WebhookDelivery, error) {
	if d.phase == "delivery_lock" {
		return store.WebhookDelivery{}, errRedeliveryInjected
	}
	return d.WebhookRedeliveryScope.LockDelivery(ctx, id)
}
func (d redeliveryFaultDAO) LockAttempts(ctx context.Context, id string) ([]store.WebhookAttempt, error) {
	if d.phase == "attempt_locks" {
		return nil, errRedeliveryInjected
	}
	return d.WebhookRedeliveryScope.LockAttempts(ctx, id)
}
func (d redeliveryFaultDAO) NextQueueOrder(ctx context.Context) (int64, error) {
	if d.phase == "ticket" {
		return 0, errRedeliveryInjected
	}
	return d.WebhookRedeliveryScope.NextQueueOrder(ctx)
}
func (d redeliveryFaultDAO) UpdateDelivery(ctx context.Context, v store.WebhookDelivery) error {
	if d.phase == "delivery_update" {
		return errRedeliveryInjected
	}
	return d.WebhookRedeliveryScope.UpdateDelivery(ctx, v)
}

type redeliveryFaultEligibility struct {
	store.WebhookEligibilityDAO
	phase string
}

func (e redeliveryFaultEligibility) ReadEligibility(ctx context.Context, o wm.Owner, project, actor string) (store.WebhookEligibility, error) {
	if e.phase == "eligibility" {
		return store.WebhookEligibility{}, errRedeliveryInjected
	}
	return e.WebhookEligibilityDAO.ReadEligibility(ctx, o, project, actor)
}

type redeliveryObservedState struct {
	generation, ticket         int64
	manual, attempts, receipts int
}

func redeliveryState(t *testing.T, r *retentionHTTP) redeliveryObservedState {
	t.Helper()
	var x redeliveryObservedState
	err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT generation,queue_order,manual_operation_count,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=$1),(SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver') FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&x.generation, &x.ticket, &x.manual, &x.attempts, &x.receipts)
	if err != nil {
		t.Fatal(err)
	}
	return x
}
func TestRedeliveryDependencyFailuresDoNotPartiallyCommit(t *testing.T) {
	for _, phase := range []string{"initial_snapshot", "receipt_lookup", "policy", "initial_clock", "sources", "delivery_lock", "attempt_locks", "credential", "locked_clock", "history_required", "eligibility", "ticket", "final_clock", "delivery_update", "receipt_insert"} {
		t.Run(phase, func(t *testing.T) {
			r := newRetentionHTTP(t, false)
			before := redeliveryState(t, r)
			db := &redeliveryFaultDB{WebhookTransactions: r.f.db, phase: phase}
			svc := &webhook.Service{DB: db, Keys: r.f.capture.Keys, DispatchEnabled: true}
			intent := webhook.Redelivery{OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: r.f.principal.UserID, IfVersion: 1, IfGeneration: 1, RequestSHA256: strings.Repeat("a", 64)}
			_, err := svc.Redeliver(r.f.ctx, r.f.principal, webhook.Owner{Kind: "personal", ID: r.f.principal.UserID}, r.endpoint, r.delivery, intent)
			if phase == "history_required" {
				if !redeliveryErrorContains(err, "webhook history reader unavailable") {
					t.Fatalf("missing reader: %v", err)
				}
			} else if !errors.Is(err, errRedeliveryInjected) {
				t.Fatalf("%s failure not propagated: %v", phase, err)
			}
			if after := redeliveryState(t, r); after != before {
				t.Fatalf("%s partial effect before=%+v after=%+v", phase, before, after)
			}
		})
	}
}
func TestRedeliveryUnknownOutcomeAndCommittedResponseFailure(t *testing.T) {
	for _, phase := range []string{"unknown_with_error", "unknown_without_error", "postcommit_snapshot"} {
		t.Run(phase, func(t *testing.T) {
			r := newRetentionHTTP(t, false)
			before := redeliveryState(t, r)
			db := &redeliveryFaultDB{WebhookTransactions: r.f.db, phase: phase}
			svc := &webhook.Service{DB: db, Keys: r.f.capture.Keys, DispatchEnabled: true}
			intent := webhook.Redelivery{OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: r.f.principal.UserID, IfVersion: 1, IfGeneration: 1, RequestSHA256: strings.Repeat("a", 64)}
			_, err := svc.Redeliver(r.f.ctx, r.f.principal, webhook.Owner{Kind: "personal", ID: r.f.principal.UserID}, r.endpoint, r.delivery, intent)
			var failure *model.Fault
			if !errors.As(err, &failure) || failure.Code != "write_outcome_unknown" {
				t.Fatalf("%s expected unknown: %v", phase, err)
			}
			after := redeliveryState(t, r)
			if phase == "postcommit_snapshot" {
				if after.generation != before.generation+1 || after.manual != before.manual+1 || after.receipts != 1 || after.attempts != 0 || after.ticket <= before.ticket {
					t.Fatalf("committed effect not preserved: before=%+v after=%+v", before, after)
				}
			} else if after != before {
				t.Fatalf("%s stub changed state: %s", phase, fmt.Sprint(after))
			}
		})
	}
}

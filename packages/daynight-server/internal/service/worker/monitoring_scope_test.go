package worker

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
)

func TestScopedMonitoringProducerRequiresReportBeforeSaving(t *testing.T) {
	for _, direct := range []bool{false, true} {
		database := &scopeAdmissionStore{snapshot: &admissionSnapshot{}}
		calls := 0
		workers, err := NewScopedWorkers(database, workerAuthorization{read: func(ctx context.Context, scope store.SnapshotScope, principal model.Principal) (model.CredentialAuthorization, error) {
			calls++
			return workerPolicy(t, principal, "worker:read"), nil
		}})
		if err != nil {
			t.Fatal(err)
		}
		if direct {
			observation := monitoring.DirectObservation(serviceObservation(t))
			delete(observation, "runId")
			delete(observation, "sequence")
			_, _, err = workers.SaveDirectMonitoring(t.Context(), servicePrincipal(), serviceWorker, observation)
		} else {
			_, err = workers.PutMonitoring(t.Context(), servicePrincipal(), serviceWorker, nil, serviceObservation(t))
		}
		if !errors.Is(err, scopepolicy.ErrInsufficientScope) || calls != 1 {
			t.Fatalf("direct=%v calls=%d err=%v", direct, calls, err)
		}
	}
}

func TestScopedMonitoringRechecksReadAfterExternalObservation(t *testing.T) {
	for _, query := range []bool{false, true} {
		events := []string{}
		workers, _ := monitorFixture(t, &events)
		calls := 0
		workers.authorization = workerAuthorization{read: func(ctx context.Context, scope store.SnapshotScope, principal model.Principal) (model.CredentialAuthorization, error) {
			calls++
			if principal != servicePrincipal() {
				t.Fatal("monitoring authority principal changed")
			}
			if calls == 1 {
				return workerPolicy(t, principal, "worker:read"), nil
			}
			return workerPolicy(t, principal, "worker:report"), nil
		}}
		observation := serviceObservation(t)
		body, err := json.Marshal(observation)
		if err != nil {
			t.Fatal(err)
		}
		summary, err := monitoring.Summary(observation)
		if err != nil {
			t.Fatal(err)
		}
		stored := &store.MonitoringValue{Body: body, Summary: summary, Receipt: store.MonitoringReceipt{Revision: serviceRevision, RunID: serviceRun, Sequence: "1", ReceivedAt: serviceNow, ExpiresAt: serviceNow}}
		reads := 0
		workers.SetMonitoringStore(monitorStore{
			read: func(context.Context, store.MonitoringIdentity) (store.MonitoringReadResult, error) {
				reads++
				return store.MonitoringReadResult{ObservedAt: serviceNow, Value: stored}, nil
			},
			summaries: func(context.Context, []store.MonitoringIdentity) (store.MonitoringSummariesResult, error) {
				reads++
				return store.MonitoringSummariesResult{ObservedAt: serviceNow, Values: []*store.MonitoringValue{stored}}, nil
			},
		})
		if query {
			result, err := workers.QueryMonitoring(t.Context(), servicePrincipal(), []string{serviceWorker})
			if !errors.Is(err, scopepolicy.ErrInsufficientScope) || result.Items != nil || !result.ObservedAt.IsZero() {
				t.Fatalf("query result=%+v err=%v", result, err)
			}
		} else {
			result, err := workers.GetMonitoring(t.Context(), servicePrincipal(), serviceWorker)
			if !errors.Is(err, scopepolicy.ErrInsufficientScope) || result.Data != nil || result.Revision != nil || !result.ObservedAt.IsZero() {
				t.Fatalf("get result=%+v err=%v", result, err)
			}
		}
		if calls != 2 || reads != 1 {
			t.Fatalf("query=%v authority=%d external reads=%d", query, calls, reads)
		}
	}
}

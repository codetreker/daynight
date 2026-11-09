package webhook

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestHistoryBatchCallsEachCollectionOnceAndDoesNotUsePointReaders(t *testing.T) {
	f := newHistoryScenario(t)
	rows := historyPageRows(f, 101)
	f.reader.sources, f.reader.attempts, f.reader.deliveries = nil, nil, nil
	f.scope.eligibility = nil
	calls := []string{}
	var wantIDs []string
	f.reader.batch = func(_ context.Context, o Owner, endpoint, actor string, at time.Time, id string, limit int) (store.WebhookHistoryBatch, error) {
		calls = append(calls, "batch")
		if o != f.owner || endpoint != f.d.EndpointID || actor != f.principal.UserID || limit != 100 {
			t.Fatal("batch scope changed")
		}
		var selected []store.WebhookDelivery
		switch len(calls) {
		case 1:
			if !at.IsZero() || id != "" {
				t.Fatal("first batch has a position")
			}
			selected = rows[:100]
		case 4:
			if !at.Equal(rows[99].OccurredAt) || id != rows[99].ID {
				t.Fatal("second batch lost position")
			}
			selected = rows[100:]
		default:
			t.Fatalf("unexpected batch: %v", calls)
		}
		wantIDs = make([]string, len(selected))
		for i, d := range selected {
			wantIDs[i] = d.ID
		}
		return historyBatchRows(f, selected), nil
	}
	matches := f.reader.matches
	f.reader.matches = func(ctx context.Context, ids []string) ([]store.WebhookHistoryMatch, error) {
		calls = append(calls, "matches")
		if !reflect.DeepEqual(ids, wantIDs) {
			t.Fatalf("match IDs=%v want=%v", ids, wantIDs)
		}
		return matches(ctx, ids)
	}
	f.reader.batchAttempts = func(_ context.Context, ids []string) ([]store.WebhookAttempt, error) {
		calls = append(calls, "attempts")
		if !reflect.DeepEqual(ids, wantIDs) {
			t.Fatalf("attempt IDs=%v want=%v", ids, wantIDs)
		}
		return nil, nil
	}
	value, err := f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{EventType: "task.paused"})
	retentionFail(t, err)
	if len(value.(map[string]any)["items"].([]any)) != 0 || !reflect.DeepEqual(calls, []string{"batch", "matches", "attempts", "batch", "matches", "attempts"}) {
		t.Fatalf("result=%v calls=%v", value, calls)
	}
	f.reader.batch = func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error) {
		return store.WebhookHistoryBatch{}, nil
	}
	f.reader.matches, f.reader.batchAttempts = nil, nil
	_, err = f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{})
	retentionFail(t, err)
}

func TestHistoryBatchReadFailuresPropagateWithoutProjection(t *testing.T) {
	failure := errors.New("batch read failed")
	for _, phase := range []string{"batch", "matches", "attempts"} {
		t.Run(phase, func(t *testing.T) {
			f := newHistoryScenario(t)
			f.reader.batch = func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error) {
				return historyBatchRows(f, []store.WebhookDelivery{f.d}), nil
			}
			switch phase {
			case "batch":
				f.reader.batch = func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error) {
					return store.WebhookHistoryBatch{}, failure
				}
			case "matches":
				f.reader.matches = func(context.Context, []string) ([]store.WebhookHistoryMatch, error) { return nil, failure }
			case "attempts":
				f.reader.batchAttempts = func(context.Context, []string) ([]store.WebhookAttempt, error) { return nil, failure }
			}
			value, err := f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{})
			if !errors.Is(err, failure) || value != nil {
				t.Fatalf("phase=%s value=%v error=%v", phase, value, err)
			}
		})
	}
}

func TestHistoryBatchUsesReturnedDatabaseTimeAtPayloadBoundary(t *testing.T) {
	for _, offset := range []time.Duration{time.Nanosecond, 0, -time.Nanosecond} {
		t.Run(offset.String(), func(t *testing.T) {
			f := newHistoryScenario(t)
			f.d.PayloadExpiresAt = retentionTestNow.Add(offset)
			clockCalls := 0
			f.scope.now = func(context.Context) (time.Time, error) { clockCalls++; return retentionTestNow.Add(-time.Hour), nil }
			f.reader.batch = func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error) {
				return historyBatchRows(f, []store.WebhookDelivery{f.d}), nil
			}
			value, err := f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{})
			retentionFail(t, err)
			item := value.(map[string]any)["items"].([]any)[0].(map[string]any)
			if item["payloadAvailable"] != (offset > 0) || clockCalls != 1 {
				t.Fatalf("projection=%v clockCalls=%d", item, clockCalls)
			}
		})
	}
}

func TestHistoryBatchValidatesConsumedAndLookaheadCandidatesOnly(t *testing.T) {
	for _, badIndex := range []int{1, 2} {
		t.Run(string(rune('0'+badIndex)), func(t *testing.T) {
			f := newHistoryScenario(t)
			rows := historyPageRows(f, 3)
			rows[badIndex].BodySHA256 = []byte("corrupt")
			f.reader.batch = func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error) {
				return historyBatchRows(f, rows), nil
			}
			value, err := f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{Limit: 1})
			if badIndex == 1 {
				historyFaultCode(t, err, "internal_error")
				if value != nil {
					t.Fatal("bad lookahead returned page")
				}
				return
			}
			retentionFail(t, err)
			page := value.(map[string]any)
			if len(page["items"].([]any)) != 1 || page["nextCursor"] == nil {
				t.Fatalf("page=%v", page)
			}
		})
	}
}

func TestHistoryBatchMatchContinuityIsAnyAndKeepsCompleteProof(t *testing.T) {
	for _, active := range []bool{false, true} {
		t.Run(map[bool]string{false: "all revoked", true: "one active"}[active], func(t *testing.T) {
			f := newHistoryScenario(t)
			first := f.src.Matches[0]
			first.Continuous = false
			second := first
			second.SubscriptionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
			second.BindingID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
			second.Continuous = active
			f.src.Matches = []store.WebhookAdmissionMatch{first, second}
			f.d.OriginalMatchCount = 2
			var err error
			f.d.OriginalMatchSHA256, err = MatchDigest([]store.WebhookCapturedMatch{first.WebhookCapturedMatch, second.WebhookCapturedMatch})
			retentionFail(t, err)
			f.reader.batch = func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error) {
				return historyBatchRows(f, []store.WebhookDelivery{f.d}), nil
			}
			value, err := f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{})
			retentionFail(t, err)
			item := value.(map[string]any)["items"].([]any)[0].(map[string]any)
			want := "suppressed"
			if active {
				want = "pending"
			}
			if item["state"] != want || item["disclosure"] != "full" {
				t.Fatalf("projection=%v", item)
			}
		})
	}
}

func TestHistoryBatchGroupsAttemptsByDeliveryWithoutRevivingEarlierResult(t *testing.T) {
	f := newHistoryScenario(t)
	rows := historyPageRows(f, 2)
	one, two, three := retentionTestNow.Add(-3*time.Minute), retentionTestNow.Add(-2*time.Minute), retentionTestNow.Add(-time.Minute)
	ack, failed := "acknowledged", "http_error"
	f.reader.batch = func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error) {
		return historyBatchRows(f, rows), nil
	}
	f.reader.batchAttempts = func(context.Context, []string) ([]store.WebhookAttempt, error) {
		return []store.WebhookAttempt{
			{DeliveryID: rows[0].ID, Generation: 1, Sequence: 1, AdmittedAt: one, FinishedAt: &one, Outcome: &ack},
			{DeliveryID: rows[0].ID, Generation: 1, Sequence: 2, AdmittedAt: two},
			{DeliveryID: rows[1].ID, Generation: 1, Sequence: 1, AdmittedAt: one, FinishedAt: &two, Outcome: &failed, LateObservedAt: &three, LateOutcome: &ack},
		}, nil
	}
	value, err := f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{})
	retentionFail(t, err)
	items := value.(map[string]any)["items"].([]any)
	first, second := items[0].(map[string]any), items[1].(map[string]any)
	if first["lastResult"] != nil || !first["lastAttemptAt"].(*time.Time).Equal(two) || !first["lastAcknowledgedAt"].(*time.Time).Equal(one) {
		t.Fatalf("first=%v", first)
	}
	if !second["lastAcknowledgedAt"].(*time.Time).Equal(three) || second["lastResult"].(map[string]any)["category"] != &ack {
		t.Fatalf("second=%v", second)
	}
}

func TestHistoryBatchConsumedCorruptionIsNotHiddenByDisclosure(t *testing.T) {
	for _, kind := range []string{"missing Event", "proof", "fact", "ownership", "body"} {
		t.Run(kind, func(t *testing.T) {
			f := newHistoryScenario(t)
			batch := historyBatchRows(f, []store.WebhookDelivery{f.d})
			item := &batch.Items[0]
			item.Sources.ProjectReadable = false
			wantFault := true
			switch kind {
			case "missing Event":
				item.EventPresent = false
			case "proof":
				item.Delivery.OriginalMatchSHA256 = []byte("corrupt")
			case "fact":
				item.Sources.Event.FactSHA256 = []byte("corrupt")
			case "ownership":
				item.Eligibility.TeamPresent = false
				wantFault = false
			case "body":
				item.Delivery.BodySHA256 = []byte("corrupt")
			}
			f.reader.batch = func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error) {
				return batch, nil
			}
			value, err := f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{})
			if err == nil || value != nil {
				t.Fatalf("corruption hidden as metadata: value=%v error=%v", value, err)
			}
			if wantFault {
				historyFaultCode(t, err, "internal_error")
			}
		})
	}
}

func TestHistoryBatchAdvancesDatabaseObservationAcrossFilteredBatches(t *testing.T) {
	f := newHistoryScenario(t)
	f.d.PayloadExpiresAt = retentionTestNow.Add(time.Second)
	rows := historyPageRows(f, 101)
	calls := 0
	f.reader.batch = func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error) {
		calls++
		if calls == 1 {
			batch := historyBatchRows(f, rows[:100])
			for i := range batch.Items {
				batch.Items[i].Sources.ProjectReadable = false
			}
			return batch, nil
		}
		if calls != 2 {
			t.Fatal("unexpected third batch")
		}
		batch := historyBatchRows(f, rows[100:])
		batch.ObservedAt = retentionTestNow.Add(2 * time.Second)
		return batch, nil
	}
	value, err := f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{EventType: f.d.EventType})
	retentionFail(t, err)
	items := value.(map[string]any)["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["id"] != rows[100].ID || items[0].(map[string]any)["payloadAvailable"] != false {
		t.Fatalf("cross-batch time=%v", value)
	}
}

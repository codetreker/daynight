package session

import (
	"context"
	"errors"
	"reflect"
	"strconv"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestBotCheckpointReceiptSurvivesReclamationFailure(t *testing.T) {
	cause := errors.New("controlled failure")
	for _, point := range []string{"success", "commit rejected", "commit unknown", "cleanup failed", "reader active"} {
		t.Run(point, func(t *testing.T) {
			ctx := t.Context()
			input := sp.BotHistoryCheckpoint{BotHistoryWindowBoundary: sp.BotHistoryWindowBoundary{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: "original-session"}}, WindowRevision: "2"}, SourceThrough: "9"}
			receipt := sp.BotHistoryCheckpointReceipt{BotHistoryWindowBoundary: input.BotHistoryWindowBoundary, SourceThrough: input.SourceThrough}
			var calls []string
			var commitError error
			if point == "commit rejected" {
				commitError = cause
			}
			if point == "commit unknown" {
				commitError = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: cause}
			}
			got, err := commitBotHistoryCheckpoint(ctx, "credential", input, func(actual context.Context, credential string, in sp.BotHistoryCheckpoint) (sp.BotHistoryCheckpointReceipt, error) {
				if actual != ctx || credential != "credential" || !reflect.DeepEqual(in, input) {
					t.Fatal("original checkpoint changed")
				}
				calls = append(calls, "commit")
				return receipt, commitError
			}, func(actual context.Context, id string) error {
				if actual != ctx || id != input.SessionID || !reflect.DeepEqual(calls, []string{"commit"}) {
					t.Fatal("cleanup ran before confirmed original commit", calls)
				}
				calls = append(calls, "reclaim")
				if point == "cleanup failed" {
					return cause
				}
				if point == "reader active" {
					return &model.Fault{Code: "resource_busy", Message: "Reader remains active."}
				}
				return nil
			})
			if commitError != nil {
				if err != commitError || !reflect.ValueOf(got).IsZero() || len(calls) != 1 {
					t.Fatal("unconfirmed checkpoint proceeded to cleanup", got, err, calls)
				}
				return
			}
			receipt.CleanupPending = point != "success"
			if err != nil || !reflect.DeepEqual(got, receipt) || len(calls) != 2 {
				t.Fatal("confirmed receipt lost after cleanup", got, err, calls)
			}
		})
	}
}

type botWindowReclaimDAO struct {
	store.SessionDAO
	lock func(context.Context, string) (store.SessionRecord, error)
}

func (d botWindowReclaimDAO) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	return d.lock(ctx, id)
}

func TestBotWindowReclaimRunnerConfirmsEachSessionTransaction(t *testing.T) {
	for _, point := range []string{"success", "missing", "lock error", "work error", "unknown", "unconfirmed"} {
		t.Run(point, func(t *testing.T) {
			ctx := t.Context()
			cause := errors.New("controlled failure")
			record := store.SessionRecord{Owner: "original-owner"}
			var calls []string
			dao := &botWindowReclaimDAO{lock: func(actual context.Context, id string) (store.SessionRecord, error) {
				if actual != ctx || id != "original-session" {
					t.Fatal("maintenance lock identity changed")
				}
				calls = append(calls, "lock")
				if point == "missing" {
					return store.SessionRecord{}, model.ErrNotFound
				}
				if point == "lock error" {
					return store.SessionRecord{}, cause
				}
				return record, nil
			}}
			svc := &Service{writer: archiveCompletionOrderWriter(func(actual context.Context, work func(store.SessionScope) error) (store.Completion, error) {
				if actual != ctx {
					t.Fatal("transaction context changed")
				}
				calls = append(calls, "begin")
				err := work(mediaRecoveryScope{dao: dao})
				calls = append(calls, "completion")
				if point == "unknown" {
					return store.Completion{Outcome: store.TransactionUnknown}, cause
				}
				if point == "unconfirmed" {
					return store.Completion{Outcome: store.TransactionUnknown}, nil
				}
				if err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			})}
			err := svc.botHistoryReclaimRunner("original-session")(ctx, func(actual store.SessionDAO, got store.SessionRecord) error {
				if actual != dao || !reflect.DeepEqual(got, record) {
					t.Fatal("maintenance received another transaction or record")
				}
				calls = append(calls, "work")
				if point == "work error" {
					return cause
				}
				return nil
			})
			want := []string{"begin", "lock", "work", "completion"}
			if point == "missing" || point == "lock error" {
				want = []string{"begin", "lock", "completion"}
			}
			if !reflect.DeepEqual(calls, want) {
				t.Fatal("maintenance order changed", calls)
			}
			if point == "success" || point == "missing" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || point != "unconfirmed" && !errors.Is(err, cause) {
				t.Fatal("maintenance lost transaction failure", err)
			}
		})
	}
}

func TestBotWindowSweepContinuesBoundedPagesAfterIndividualFailures(t *testing.T) {
	ctx := t.Context()
	cause := errors.New("physical removal failed")
	ids := make([]string, 32)
	for i := range ids {
		ids[i] = strconv.Itoa(i + 1)
	}
	seen := []string{}
	next, err := sweepBotHistoryReclaims(ctx, "original", func(actual context.Context, after string, limit int) ([]string, error) {
		if actual != ctx || after != "original" || limit != 32 {
			t.Fatal("inventory query changed")
		}
		return ids, nil
	}, func(attempt context.Context, id string) error {
		if attempt == ctx || attempt.Err() != nil {
			t.Fatal("resource attempt context changed")
		}
		if _, ok := attempt.Deadline(); !ok {
			t.Fatal("resource attempt is unbounded")
		}
		seen = append(seen, id)
		if id == "1" {
			return &model.Fault{Code: "resource_busy", Message: "Reader active."}
		}
		if id == "2" {
			return cause
		}
		return nil
	})
	if next != "32" || !errors.Is(err, cause) || !reflect.DeepEqual(seen, ids) {
		t.Fatal("sweep stopped on one resource", next, err, seen)
	}
	next, err = sweepBotHistoryReclaims(ctx, next, func(context.Context, string, int) ([]string, error) { return []string{"33"}, nil }, func(context.Context, string) error { return nil })
	if next != "" || err != nil {
		t.Fatal("finished scan did not restart from beginning", next, err)
	}
	next, err = sweepBotHistoryReclaims(ctx, "original", func(context.Context, string, int) ([]string, error) { return nil, cause }, func(context.Context, string) error { t.Fatal("failed inventory attempted removal"); return nil })
	if next != "original" || err != cause {
		t.Fatal("inventory failure lost cursor", next, err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	next, err = sweepBotHistoryReclaims(cancelled, "original", func(context.Context, string, int) ([]string, error) { return ids, nil }, func(context.Context, string) error { t.Fatal("cancelled pass attempted removal"); return nil })
	if next != "original" || !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation lost progress", next, err)
	}
}

type botWindowInventoryDAO struct {
	store.SessionDAO
	list func(context.Context, string, int) ([]string, error)
}

func (d botWindowInventoryDAO) BotHistoryReclaimSessions(ctx context.Context, after string, limit int) ([]string, error) {
	return d.list(ctx, after, limit)
}

func TestBotWindowInventorySuppressesUnconfirmedReads(t *testing.T) {
	for _, point := range []string{"success", "query error", "unknown", "missing capability"} {
		t.Run(point, func(t *testing.T) {
			ctx := t.Context()
			cause := errors.New("inventory failure")
			calls := 0
			var dao store.SessionDAO = botWindowInventoryDAO{list: func(actual context.Context, after string, limit int) ([]string, error) {
				calls++
				if actual != ctx || after != "previous" || limit != 32 {
					t.Fatal("inventory identity changed")
				}
				if point == "query error" {
					return nil, cause
				}
				return []string{"queued-session"}, nil
			}}
			if point == "missing capability" {
				dao = mediaRecoveryMissingDAO{}
			}
			svc := &Service{writer: archiveCompletionOrderWriter(func(actual context.Context, work func(store.SessionScope) error) (store.Completion, error) {
				if actual != ctx {
					t.Fatal("inventory transaction context changed")
				}
				err := work(mediaRecoveryScope{dao: dao})
				if point == "unknown" {
					return store.Completion{Outcome: store.TransactionUnknown}, cause
				}
				if err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			})}
			ids, err := svc.botHistoryReclaimSessions(ctx, "previous", 32)
			if point == "success" {
				if err != nil || !reflect.DeepEqual(ids, []string{"queued-session"}) {
					t.Fatal(ids, err)
				}
			} else if err == nil || ids != nil || point != "missing capability" && !errors.Is(err, cause) {
				t.Fatal("unconfirmed inventory escaped", ids, err)
			}
			if point == "missing capability" && calls != 0 || point != "missing capability" && calls != 1 {
				t.Fatal("unexpected inventory calls", calls)
			}
		})
	}
}

func TestBotWindowBusyDeferralPreservesIndependentFailures(t *testing.T) {
	busy := &model.Fault{Code: "resource_busy", Message: "Reader active."}
	cleanup := errors.New("permit close failed")
	for _, err := range []error{busy, errors.Join(busy)} {
		if !botHistoryReaderBusy(err) {
			t.Fatal("ordinary reader deferral was lost", err)
		}
	}
	for _, err := range []error{nil, cleanup, errors.Join(busy, cleanup), &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: busy}} {
		if botHistoryReaderBusy(err) {
			t.Fatal("independent failure hidden as busy", err)
		}
	}
}

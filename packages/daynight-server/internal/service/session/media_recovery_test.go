package session

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type mediaRecoveryDAO struct {
	store.SessionDAO
	store.SessionResourceDAO
	list    func(context.Context) ([]store.SessionResourceLease, error)
	release func(context.Context, string, string) error
}

func (d mediaRecoveryDAO) ListSessionMediaLeases(ctx context.Context) ([]store.SessionResourceLease, error) {
	return d.list(ctx)
}
func (d mediaRecoveryDAO) ReleaseSessionResourceLease(ctx context.Context, id, lease string) error {
	return d.release(ctx, id, lease)
}

type mediaRecoveryMissingDAO struct{ store.SessionDAO }
type mediaRecoveryListOnlyDAO struct {
	store.SessionDAO
	list func(context.Context) ([]store.SessionResourceLease, error)
}

func (d mediaRecoveryListOnlyDAO) ListSessionMediaLeases(ctx context.Context) ([]store.SessionResourceLease, error) {
	return d.list(ctx)
}

type mediaRecoveryScope struct {
	store.SessionScope
	dao store.SessionDAO
}

func (s mediaRecoveryScope) SessionDAO() store.SessionDAO { return s.dao }

func TestMediaRecoveryCoordinatesConfirmedListingAndDeletionOutsideTheDatabaseScope(t *testing.T) {
	for _, point := range []string{"success", "list error", "list unknown", "list missing", "release error", "release unknown", "release cleanup", "release missing", "reaper error"} {
		t.Run(point, func(t *testing.T) {
			ctx := t.Context()
			cause := errors.New("controlled " + point)
			lease := store.SessionResourceLease{SessionID: "session", ID: "original", OwnerID: "owner", Kind: "read"}
			var calls []string
			list := func(actual context.Context) ([]store.SessionResourceLease, error) {
				if actual != ctx {
					t.Fatal("listing context changed")
				}
				calls = append(calls, "list")
				if point == "list error" {
					return nil, cause
				}
				return []store.SessionResourceLease{lease}, nil
			}
			var dao store.SessionDAO = mediaRecoveryDAO{list: list, release: func(actual context.Context, id, leaseID string) error {
				if actual != ctx || id != lease.SessionID || leaseID != lease.ID {
					t.Fatal("lease deletion binding changed")
				}
				calls = append(calls, "delete")
				if point == "release error" {
					return cause
				}
				return nil
			}}
			if point == "list missing" {
				dao = mediaRecoveryMissingDAO{}
			}
			if point == "release missing" {
				dao = mediaRecoveryListOnlyDAO{list: list}
			}
			active, writes := false, 0
			outcomes := []store.TransactionOutcome{store.TransactionCommitted, store.TransactionCommitted}
			failures := []error{nil, nil}
			switch point {
			case "list error":
				outcomes[0] = store.TransactionNotCommitted
			case "list unknown":
				outcomes[0] = store.TransactionUnknown
				failures[0] = cause
			case "list missing":
				outcomes[0] = store.TransactionNotCommitted
			case "release error", "release missing":
				outcomes[1] = store.TransactionNotCommitted
			case "release unknown":
				outcomes[1] = store.TransactionUnknown
				failures[1] = cause
			case "release cleanup":
				failures[1] = cause
			}
			service := &Service{writer: archiveCompletionOrderWriter(func(actual context.Context, run func(store.SessionScope) error) (store.Completion, error) {
				if actual != ctx || active || writes >= 2 {
					t.Fatal("unexpected recovery transaction")
				}
				i := writes
				writes++
				active = true
				calls = append(calls, "begin")
				callbackErr := run(mediaRecoveryScope{dao: dao})
				active = false
				calls = append(calls, "complete")
				return store.Completion{Outcome: outcomes[i]}, errors.Join(callbackErr, failures[i])
			})}
			err := service.recoverMediaLeasesUsing(ctx, func(actual context.Context, leases []store.SessionResourceLease, release func(context.Context, string, string) error) error {
				if actual != ctx || active || !reflect.DeepEqual(leases, []store.SessionResourceLease{lease}) {
					t.Fatal("reaper received unconfirmed listing or held scope")
				}
				calls = append(calls, "reap")
				if point == "reaper error" {
					return cause
				}
				return release(ctx, lease.SessionID, lease.ID)
			})
			if point == "success" {
				if err != nil {
					t.Fatal(err)
				}
			} else if strings.HasSuffix(point, "missing") {
				if err == nil || !strings.Contains(err.Error(), "requires") {
					t.Fatal("missing capability admitted recovery", err)
				}
			} else if !errors.Is(err, cause) {
				t.Fatal("recovery error chain lost", err)
			}
			want := []string{"begin", "list", "complete", "reap", "begin", "delete", "complete"}
			switch point {
			case "list error", "list unknown":
				want = want[:3]
			case "list missing":
				want = []string{"begin", "complete"}
			case "release missing":
				want = []string{"begin", "list", "complete", "reap", "begin", "complete"}
			case "reaper error":
				want = want[:4]
			}
			if !reflect.DeepEqual(calls, want) {
				t.Fatalf("recovery continued or reordered transaction facts: %v want %v", calls, want)
			}
		})
	}
}

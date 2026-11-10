package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func TestArchiveStatusMigrationKeepsActorSpecificPreflightRefusals(t *testing.T) {
	for _, actorKind := range []string{"owner PAT", "owner Session", "other PAT"} {
		t.Run(actorKind, func(t *testing.T) {
			op, d, r, _, _, _ := legacyArchiveReviewFixture(t)
			actor := op.principal
			mode := ArchiveV1Upload
			if actorKind == "owner Session" {
				actor.Kind, mode = model.SessionCredential, ArchiveV1Read
			} else if actorKind == "other PAT" {
				actor.UserID, mode = uuid.NewString(), ArchiveV1Read
			}
			previous := d.status
			refused := fault("forbidden", "Archive content access was revoked.")
			scopes, preflights := 0, 0
			op.execution.archiveRun = func(_ context.Context, principal model.Principal, project, taskID, id string, finalize bool, work func(*Access) error) error {
				scopes++
				if principal != actor || project != op.project || taskID != op.task || id != op.id || !finalize || scopes != 1 {
					t.Fatal("preflight refusal entered another scope or changed the status actor")
				}
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			op.execution.SetArchivePreflight(func(_ context.Context, principal model.Principal, project, taskID, id string, actual ArchiveMode) (string, error) {
				preflights++
				if principal != actor || project != op.project || taskID != op.task || id != op.id || actual != mode {
					t.Fatal("status migration changed the original actor, target or content admission mode")
				}
				return "", refused
			})
			out, err := op.execution.ArchiveStatus(t.Context(), actor, op.project, op.task, op.id)
			if !errors.Is(err, refused) || !reflect.DeepEqual(out, previous) || scopes != 1 || preflights != 1 || d.migration != nil || len(op.execution.archiveSlots) != 0 || len(op.execution.archivePreflightSlots) != 0 {
				t.Fatalf("preflight refusal was hidden, escalated or leaked a reservation: out=%+v scopes=%d preflights=%d err=%v", out, scopes, preflights, err)
			}
		})
	}
}

func TestArchiveStatusReaderMigrationClosesBeforeReturningNewStatus(t *testing.T) {
	for _, closeFails := range []bool{false, true} {
		t.Run(map[bool]string{false: "released", true: "close failure"}[closeFails], func(t *testing.T) {
			op, d, r, _, _, _ := legacyArchiveReviewFixture(t)
			actor := op.principal
			actor.UserID = uuid.NewString()
			previous := d.status
			closeFailure := errors.New("archive reader residency close failed")
			if closeFails {
				op.execution.files = archivePermitFailureStorage{Storage: op.execution.files, failure: closeFailure}
			}
			statusScopes, contentScopes, preflights := 0, 0, 0
			op.execution.archiveRun = func(_ context.Context, principal model.Principal, project, taskID, id string, finalize bool, work func(*Access) error) error {
				if principal != actor || project != op.project || taskID != op.task || id != op.id {
					t.Fatal("reader migration changed its actor or original archive target")
				}
				if finalize {
					statusScopes++
					if statusScopes > 1 && (d.migration == nil || d.migration.Phase != "verified") {
						t.Fatal("new status read preceded successful content migration")
					}
				} else {
					contentScopes++
				}
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			op.execution.SetArchivePreflight(func(_ context.Context, principal model.Principal, project, taskID, id string, mode ArchiveMode) (string, error) {
				preflights++
				if principal != actor || project != op.project || taskID != op.task || id != op.id || mode != ArchiveV1Read {
					t.Fatal("authorized reader acquired the owner finalization path")
				}
				return r.Owner, nil
			})
			out, err := op.execution.ArchiveStatus(t.Context(), actor, op.project, op.task, op.id)
			if d.migration == nil || d.migration.Phase != "verified" || contentScopes == 0 || preflights != 1 || d.leases != 0 || len(op.execution.archiveSlots) != 0 || len(op.execution.archivePreflightSlots) != 0 {
				t.Fatalf("reader migration skipped read scopes or leaked resources: out=%+v status=%d content=%d preflights=%d err=%v", out, statusScopes, contentScopes, preflights, err)
			}
			if closeFails {
				if !errors.Is(err, closeFailure) || statusScopes != 1 || !reflect.DeepEqual(out, previous) {
					t.Fatalf("failed content close reported a new ready result: out=%+v status=%d err=%v", out, statusScopes, err)
				}
			} else if err != nil || statusScopes != 2 || out.SchemaVersion != 3 || out.Migration == nil {
				t.Fatalf("released reader did not return the migrated status: out=%+v status=%d err=%v", out, statusScopes, err)
			}
		})
	}
}

func TestArchiveStatusMigrationRetainsContentScopeFailureAndReleasesPermit(t *testing.T) {
	for _, ownerFinalization := range []bool{false, true} {
		t.Run(map[bool]string{false: "reader", true: "owner finalization"}[ownerFinalization], func(t *testing.T) {
			op, d, r, _, _, _ := legacyArchiveReviewFixture(t)
			actor := op.principal
			mode := ArchiveV1Upload
			if !ownerFinalization {
				actor.Kind, mode = model.SessionCredential, ArchiveV1Read
			}
			previous := d.status
			cause := errors.New("original archive content scope failed")
			scopes, preflights := 0, 0
			op.execution.archiveRun = func(_ context.Context, principal model.Principal, project, taskID, id string, finalize bool, work func(*Access) error) error {
				scopes++
				if principal != actor || project != op.project || taskID != op.task || id != op.id || scopes > 2 {
					t.Fatal("failed content scope continued or changed its actor or target")
				}
				if scopes == 1 {
					if !finalize {
						t.Fatal("status did not use its original status scope")
					}
					return work(&Access{tx: &operationTx{dao: d}, record: r})
				}
				if finalize != ownerFinalization {
					t.Fatal("content scope changed finalization authority")
				}
				return cause
			}
			op.execution.SetArchivePreflight(func(_ context.Context, principal model.Principal, project, taskID, id string, actual ArchiveMode) (string, error) {
				preflights++
				if principal != actor || project != op.project || taskID != op.task || id != op.id || actual != mode {
					t.Fatal("content scope failure changed preflight authority")
				}
				return r.Owner, nil
			})
			out, err := op.execution.ArchiveStatus(t.Context(), actor, op.project, op.task, op.id)
			if !errors.Is(err, cause) || !reflect.DeepEqual(out, previous) || scopes != 2 || preflights != 1 || d.migration != nil || d.leases != 0 || len(op.execution.archiveSlots) != 0 || len(op.execution.archivePreflightSlots) != 0 {
				t.Fatalf("content failure was hidden or retained its permit: out=%+v scopes=%d preflights=%d err=%v", out, scopes, preflights, err)
			}
		})
	}
}

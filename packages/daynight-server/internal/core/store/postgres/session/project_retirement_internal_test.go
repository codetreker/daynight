package session

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type retirementExecTx struct {
	pgx.Tx
	calls  int
	failAt int
	cause  error
}

func (tx *retirementExecTx) Exec(_ context.Context, _ string, _ ...any) (pgconn.CommandTag, error) {
	tx.calls++
	if tx.calls == tx.failAt {
		return pgconn.CommandTag{}, tx.cause
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func TestProjectRetirementQueryFailuresAndScope(t *testing.T) {
	ctx := t.Context()
	cause := errors.New("retirement query failed")
	dao := &projectRetirementDAO{tx: failedQueryTx{err: cause}, projectID: "project"}
	if _, err := dao.LockProjectSessions(ctx, "different", "", 128); err == nil {
		t.Fatal("wrong project scope accepted")
	}
	if _, err := dao.LockProjectSessions(ctx, "project", "", 128); !errors.Is(err, cause) {
		t.Fatalf("query error lost: %v", err)
	}
	for _, stage := range []string{"scan", "iteration"} {
		t.Run(stage, func(t *testing.T) {
			rows := &failedRows{}
			if stage == "scan" {
				rows.next = true
				rows.scanError = cause
			} else {
				rows.errorAfterRows = cause
			}
			dao := &projectRetirementDAO{tx: rowsTx{rows: rows}, projectID: "project"}
			if _, err := dao.LockProjectSessions(ctx, "project", "", 128); !errors.Is(err, cause) {
				t.Fatalf("stream error lost: %v", err)
			}
			if !rows.closed {
				t.Fatal("row stream was not closed")
			}
		})
	}
}

func TestProjectRetirementApplyErrorsPreserveCause(t *testing.T) {
	ctx := t.Context()
	cause := errors.New("retirement statement failed")
	for _, failAt := range []int{1, 2} {
		t.Run(map[int]string{1: "session", 2: "receipt"}[failAt], func(t *testing.T) {
			tx := &retirementExecTx{failAt: failAt, cause: cause}
			dao := &projectRetirementDAO{tx: tx, projectID: "project"}
			if err := dao.ApplyProjectSessionRetirement(ctx, []store.ProjectSessionRetirementPlan{{ID: "id", Backend: "web"}}); !errors.Is(err, cause) {
				t.Fatalf("statement error lost: %v", err)
			}
			if tx.calls != failAt {
				t.Fatalf("unexpected statement count %d", tx.calls)
			}
		})
	}
	tx := &retirementExecTx{}
	dao := &projectRetirementDAO{tx: tx, projectID: "project"}
	if err := dao.ApplyProjectSessionRetirement(ctx, []store.ProjectSessionRetirementPlan{{SnapshotPatch: map[string]any{"invalid": make(chan int)}}}); err == nil || tx.calls != 0 {
		t.Fatalf("invalid plan reached database: %v, %d", err, tx.calls)
	}
	if err := dao.ApplyProjectSessionRetirement(ctx, []store.ProjectSessionRetirementPlan{{ID: "id", Backend: "web"}}); err != nil || tx.calls != 2 {
		t.Fatalf("valid plan: %v, %d", err, tx.calls)
	}
}

package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

func TestProjectWorkerClaimAdmissionSharesTransactionAndCompletion(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	ctx := t.Context()
	rejected := errors.New("reject project operation")
	for index, commit := range []bool{false, true} {
		user, id := queryID(10+index*2), queryID(11+index*2)
		var retained store.WorkerClaimAdmissionDAO
		completion, err := db.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
			tx := scope.(*ProjectTx).tx
			if _, err := tx.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,configuration_revision,configuration_updated_at,desired_configuration) VALUES($1,$2,statement_timestamp(),statement_timestamp(),'{}','{}',19,statement_timestamp(),'{"only":"uncommitted"}')`, user, id); err != nil {
				return err
			}
			retained = scope.WorkerClaimAdmissionDAO()
			got, err := retained.ClaimWorkerConfiguration(ctx, user, id)
			if err != nil {
				return err
			}
			if got == nil || got.Revision != "19" || string(got.Raw) != `{"only": "uncommitted"}` {
				t.Fatalf("accessor failed to read enclosing transaction's uncommitted row: %+v", got)
			}
			if commit {
				return nil
			}
			return rejected
		})
		expected := store.TransactionNotCommitted
		if commit {
			expected = store.TransactionCommitted
		}
		if completion.Outcome != expected || (commit && err != nil) || (!commit && !errors.Is(err, rejected)) {
			t.Fatalf("completion: %+v %v", completion, err)
		}
		var exists bool
		if err := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workers WHERE user_id=$1 AND worker_id=$2)`, user, id).Scan(&exists); err != nil || exists != commit {
			t.Fatalf("enclosing transaction persistence: %v %v", exists, err)
		}
		if got, err := retained.ClaimWorkerConfiguration(context.Background(), user, id); got != nil || !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("capability escaped transaction lifetime: %+v %v", got, err)
		}
	}
}

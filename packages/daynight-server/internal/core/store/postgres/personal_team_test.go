package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func identitySession(userID, subject string) (model.User, model.Session) {
	now := time.Now().UTC()
	hash := sha256.Sum256([]byte(uuid.NewString()))
	return model.User{ID: userID, UniAuthID: subject}, model.Session{ID: uuid.NewString(), TokenHash: hash[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
}

func TestProjectCreationPersonalLookupFailuresPreserveStateAndCause(t *testing.T) {
	for _, failure := range []string{"missing-team", "team-query", "owner-query"} {
		t.Run(failure, func(t *testing.T) {
			s := isolatedStore(t)
			user, principal, session := testAuthRecords(t, s)
			ctx := context.Background()
			switch failure {
			case "missing-team":
				mustQueryExec(t, s, `DELETE FROM teams WHERE personal_user_id=$1`, user.ID)
			case "team-query":
				mustQueryExec(t, s, `DROP TABLE teams`)
			case "owner-query":
				mustQueryExec(t, s, `DROP TABLE team_members`)
			}
			project, err := s.CreatePrivateProject(ctx, principal, uuid.NewString(), "Rejected", "host:repo")
			var transaction *TransactionError
			if err == nil || project != (model.Project{}) || !errors.As(err, &transaction) ||
				transaction.CommitAttempted || transaction.CleanupFailed || transaction.Outcome != TransactionNotCommitted {
				t.Fatalf("failed Personal lookup returned a project or uncertain transaction: %#v %#v %v", project, transaction, err)
			}
			if failure == "missing-team" {
				if errors.Is(err, model.ErrNotFound) || transaction.Cause.Error() != "user Personal Team is missing" {
					t.Fatalf("missing Personal Team did not retain its integrity error: %v", err)
				}
				var teams int
				if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM teams`).Scan(&teams); err != nil || teams != 0 {
					t.Fatalf("project creation repaired missing Personal Team: %d %v", teams, err)
				}
			} else {
				var databaseError *pgconn.PgError
				if !errors.As(err, &databaseError) || databaseError.Code != "42P01" || !errors.Is(transaction.Cause, databaseError) {
					t.Fatalf("Personal lookup lost original database cause: %#v %v", databaseError, err)
				}
			}
			var unchanged bool
			if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM projects)=0
				AND (SELECT count(*) FROM project_ownership)=0 AND (SELECT count(*) FROM project_grants)=0
				AND (SELECT count(*) FROM sessions)=1
				AND EXISTS(SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2)`, session.ID, user.ID).Scan(&unchanged); err != nil || !unchanged {
				t.Fatalf("failed Personal lookup changed project, ownership, grant or session rows: %v %v", unchanged, err)
			}
		})
	}
}

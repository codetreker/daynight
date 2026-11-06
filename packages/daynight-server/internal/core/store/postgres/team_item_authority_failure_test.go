package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/teamitem"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/puddle/v2"
)

func TestTeamItemAuthorityRejectsCredentialSubstitutionBeforeStorage(t *testing.T) {
	credential := uuid.NewString()
	valid := core.Authority{Principal: model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: credential}, Kind: "pat", ID: credential}
	for _, change := range []struct {
		name  string
		apply func(*core.Authority)
	}{
		{"missing principal", func(a *core.Authority) { a.Principal = model.Principal{} }},
		{"different authority", func(a *core.Authority) { a.ID = uuid.NewString() }},
		{"different credential kind", func(a *core.Authority) { a.Kind = "oauth" }},
		{"session credential", func(a *core.Authority) { a.Principal.Kind = model.SessionCredential; a.Kind = "session" }},
	} {
		t.Run(change.name, func(t *testing.T) {
			authority := valid
			change.apply(&authority)
			// No pool exists: rejecting a substituted authority must precede I/O.
			err := (&Store{}).AuthorizeTeamItem(t.Context(), authority, core.Target{Kind: "team", TeamID: uuid.NewString()})
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
				t.Fatalf("substituted authority: %v", err)
			}
		})
	}
}

func TestTeamItemAuthorityPreservesUnavailablePoolCause(t *testing.T) {
	pool, err := pgxpool.New(t.Context(), "postgresql://unused@127.0.0.1:1/unreachable?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	pool.Close()
	credential := uuid.NewString()
	authority := core.Authority{Principal: model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: credential}, Kind: "pat", ID: credential}
	err = (&Store{Pool: pool}).AuthorizeTeamItem(context.Background(), authority, core.Target{Kind: "team", TeamID: uuid.NewString()})
	var storage *store.Error
	var refusal *model.Fault
	if !errors.Is(err, puddle.ErrClosedPool) || !errors.As(err, &storage) || storage.Phase != "begin item authority check" || errors.As(err, &refusal) {
		t.Fatalf("unavailable persistence was masked as an authorization refusal: %v", err)
	}
}

func TestTeamItemAuthorityPreservesCredentialQueryFailure(t *testing.T) {
	s, actor, team := storeTeamFixture(t)
	authority := itemPAT(t, s, actor.UserID)
	mustQueryExec(t, s, `DROP TABLE personal_access_tokens`)
	err := s.AuthorizeTeamItem(t.Context(), authority, core.Target{Kind: "team", TeamID: team.ID})
	var driver *pgconn.PgError
	var storage *store.Error
	var refusal *model.Fault
	if !errors.As(err, &driver) || driver.Code != "42P01" || !errors.As(err, &storage) || storage.Phase != "lock item credential" || errors.As(err, &refusal) {
		t.Fatalf("credential persistence failure was masked as missing authority: %v", err)
	}
	if failed, state := store.DatabaseErrorFacts(err); !failed || state != driver.Code {
		t.Fatalf("database failure classification lost: failure=%v state=%q err=%v", failed, state, err)
	}
}

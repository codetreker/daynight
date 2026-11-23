package postgres

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	workerstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/jackc/pgx/v5"
	"time"
)

type credentialAuthorization struct{ tx pgx.Tx }

func (s credentialAuthorization) CurrentCredentialAuthorization(ctx context.Context, p model.Principal, origin string, lock bool) (model.CredentialAuthorization, error) {
	mode := ""
	if lock {
		mode = " FOR SHARE"
	}
	c, err := pg.ThreadCredential(ctx, s.tx, p, mode)
	if errors.Is(err, model.ErrNotFound) {
		return model.CredentialAuthorization{}, model.Unauthenticated(err)
	}
	if err != nil {
		return model.CredentialAuthorization{}, err
	}
	if lock && c.ExpiresAt != nil {
		// A locking query can evaluate its expiry predicate before waiting. Read
		// the database clock after acquisition so a lock wait cannot extend life.
		var now time.Time
		if err := s.tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
			return model.CredentialAuthorization{}, err
		}
		if !c.ExpiresAt.After(now) {
			return model.CredentialAuthorization{}, model.Unauthenticated(nil)
		}
	}
	a := model.CredentialAuthorization{Principal: p, Policy: c.ScopePolicy}
	switch p.Kind {
	case model.SessionCredential:
		a.Profile = model.SessionProfile
	case model.PATCredential:
		a.Profile = model.ScopedPATProfile
	case model.OAuthCredential:
		var profile string
		err = s.tx.QueryRow(ctx, `SELECT g.scope FROM oauth_grants g JOIN oauth_access_tokens a ON a.grant_id=g.id AND a.user_id=g.user_id WHERE a.id=$1 AND a.user_id=$2 AND ((g.scope='daynight:mcp' AND g.resource=$3) OR (g.scope='daynight:api' AND g.resource=$4 AND g.client_id='societas-bot'))`, p.CredentialID, p.UserID, origin+"/mcp", origin+"/api/v1").Scan(&profile)
		if errors.Is(err, pgx.ErrNoRows) {
			return model.CredentialAuthorization{}, model.Unauthenticated(err)
		}
		if err != nil {
			return model.CredentialAuthorization{}, err
		}
		if profile == "daynight:mcp" {
			a.Profile = model.ScopedMCPProfile
		} else {
			a.Profile = model.OAuthAPIProfile
		}
	default:
		return model.CredentialAuthorization{}, model.Unauthenticated(nil)
	}
	return a, a.Validate()
}

func (s *Snapshot) CurrentCredentialAuthorization(ctx context.Context, p model.Principal, origin string, lock bool) (model.CredentialAuthorization, error) {
	if lock {
		return model.CredentialAuthorization{}, errors.New("read-only snapshot cannot lock credential")
	}
	return (credentialAuthorization{s.tx}).CurrentCredentialAuthorization(ctx, p, origin, false)
}

type authorizedWorkerScope struct {
	*workerstore.Writer
	credentialAuthorization
}
type authorizedBotScope struct {
	*botstore.Writer
	credentialAuthorization
}
type authorizedPromptSnapshot struct {
	store.PromptSnapshot
	credentialAuthorization
}

func (s teamWriteScope) CurrentCredentialAuthorization(ctx context.Context, p model.Principal, origin string, lock bool) (model.CredentialAuthorization, error) {
	return (credentialAuthorization{s.tx}).CurrentCredentialAuthorization(ctx, p, origin, lock)
}
func (s *sessionScope) CurrentCredentialAuthorization(ctx context.Context, p model.Principal, origin string, lock bool) (model.CredentialAuthorization, error) {
	return (credentialAuthorization{s.tx}).CurrentCredentialAuthorization(ctx, p, origin, lock)
}
func (s projectDirectMemberScope) CurrentCredentialAuthorization(ctx context.Context, p model.Principal, origin string, lock bool) (model.CredentialAuthorization, error) {
	return (credentialAuthorization{s.tx}).CurrentCredentialAuthorization(ctx, p, origin, lock)
}

func (s *usageScope) CurrentCredentialAuthorization(ctx context.Context, p model.Principal, origin string, lock bool) (model.CredentialAuthorization, error) {
	return (credentialAuthorization{s.tx}).CurrentCredentialAuthorization(ctx, p, origin, lock)
}

func (s *promptTx) CurrentCredentialAuthorization(ctx context.Context, p model.Principal, origin string, lock bool) (model.CredentialAuthorization, error) {
	return (credentialAuthorization{s.tx}).CurrentCredentialAuthorization(ctx, p, origin, lock)
}

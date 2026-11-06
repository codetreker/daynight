package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *Store) AuthorizeTeamItem(ctx context.Context, a model.TeamItemAuthority, target model.TeamItemTarget) error {
	if model.RequirePrincipal(a.Principal) != nil || string(a.Principal.Kind) != a.Kind || (a.Kind != "pat" && a.Kind != "oauth") || (a.Kind == "pat" && a.Principal.CredentialID != a.ID) {
		return model.Unauthenticated(nil)
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return pg.QueryError("begin item authority check", err)
	}
	// Row locks require a read-write PostgreSQL transaction, but this fence only
	// executes SELECTs, so confirmed closed-connection cleanup remains read-only.
	return transactReadOnly(ctx, tx, func(tx pgx.Tx) error { return authorizeTeamItem(ctx, tx, a, target) })
}

func itemAuthorityError(operation string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Unauthenticated(err)
	}
	return pg.QueryError(operation, err)
}

func authorizeTeamItem(ctx context.Context, tx pgx.Tx, a model.TeamItemAuthority, target model.TeamItemTarget) error {
	var id string
	if target.Kind == "project" {
		if err := tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, target.ProjectID).Scan(&id); err != nil {
			return pg.QueryError("lock item Project", err)
		}
		if err := tx.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1 AND team_id=$2 FOR SHARE`, target.ProjectID, target.TeamID).Scan(&id); err != nil {
			return pg.QueryError("lock item ownership", err)
		}
	}
	// Team writers lock the Team before its memberships. Keep the same order;
	// locking a joined row set would leave the acquisition order to the planner.
	var owner *string
	var nameNull bool
	if err := tx.QueryRow(ctx, `SELECT personal_user_id::text,name IS NULL FROM teams WHERE id=$1 FOR SHARE`, target.TeamID).Scan(&owner, &nameNull); err != nil {
		return pg.QueryError("lock item Team", err)
	}
	var role model.ProjectRole
	if err := tx.QueryRow(ctx, `SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE`, target.TeamID, a.Principal.UserID).Scan(&role); err != nil {
		return pg.QueryError("lock item Team membership", err)
	}
	if owner != nil && (*owner != a.Principal.UserID || !nameNull || role != model.ProjectAdmin) {
		return model.ErrNotFound
	}
	if owner == nil && nameNull {
		return model.ErrNotFound
	}
	if target.Kind == "member" {
		if err := tx.QueryRow(ctx, `SELECT user_id::text FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE`, target.TeamID, target.UserID).Scan(&id); err != nil {
			return pg.QueryError("lock target item membership", err)
		}
	}
	var grantExpiry time.Time
	if a.Kind == "oauth" {
		if a.Resource == "" || a.Scope == "" {
			return model.Unauthenticated(nil)
		}
		if err := tx.QueryRow(ctx, `SELECT expires_at FROM oauth_grants WHERE id=$1 AND user_id=$2 AND resource=$3 AND scope=$4 AND revoked_at IS NULL FOR SHARE`, a.ID, a.Principal.UserID, a.Resource, a.Scope).Scan(&grantExpiry); err != nil {
			return itemAuthorityError("lock item OAuth grant", err)
		}
	}
	var expiry *time.Time
	var err error
	if a.Kind == "oauth" {
		err = tx.QueryRow(ctx, `SELECT expires_at FROM oauth_access_tokens WHERE id=$1 AND user_id=$2 AND grant_id=$3 FOR SHARE`, a.Principal.CredentialID, a.Principal.UserID, a.ID).Scan(&expiry)
	} else {
		err = tx.QueryRow(ctx, `SELECT expires_at FROM personal_access_tokens WHERE id=$1 AND user_id=$2 FOR SHARE`, a.Principal.CredentialID, a.Principal.UserID).Scan(&expiry)
	}
	if err != nil {
		return itemAuthorityError("lock item credential", err)
	}
	var valid bool
	if a.Kind == "oauth" {
		err = tx.QueryRow(ctx, `SELECT $1::timestamptz>clock_timestamp() AND $2::timestamptz>clock_timestamp()`, expiry, grantExpiry).Scan(&valid)
	} else {
		err = tx.QueryRow(ctx, `SELECT $1::timestamptz IS NULL OR $1::timestamptz>clock_timestamp()`, expiry).Scan(&valid)
	}
	if err != nil {
		return pg.QueryError("recheck item credential expiry", err)
	}
	if !valid {
		return model.Unauthenticated(nil)
	}
	return nil
}

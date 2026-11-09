// Package eligibility implements the transaction-bound webhook eligibility DAO.
package eligibility

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/jackc/pgx/v5"
)

type dao struct{ tx pgx.Tx }

func New(tx pgx.Tx) store.WebhookEligibilityDAO { return &dao{tx} }

func (d *dao) ReadEligibility(ctx context.Context, owner webhook.Owner, projectID, actor string) (store.WebhookEligibility, error) {
	if owner.Kind != "personal" && owner.Kind != "team" {
		return store.WebhookEligibility{}, fmt.Errorf("invalid webhook owner kind")
	}
	var live bool
	var name, teamID, teamExists *string
	var ownerAccess, actorAccess bool
	// One new RC statement after any subscription lock wait sees the complete
	// union of current sources without acquiring any source or endpoint lock.
	err := d.tx.QueryRow(ctx, `SELECT p.id IS NOT NULL AND p.deleted_at IS NULL,
        p.name,o.team_id::text,t.id::text,
        EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=o.team_id AND m.user_id=$2::uuid)
          OR EXISTS(SELECT 1 FROM project_grants g WHERE g.project_id=$1::uuid AND g.user_id=$2::uuid),
        EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=o.team_id AND m.user_id=NULLIF($3,'')::uuid)
          OR EXISTS(SELECT 1 FROM project_grants g WHERE g.project_id=$1::uuid AND g.user_id=NULLIF($3,'')::uuid)
        FROM (SELECT $1::uuid AS id) input LEFT JOIN projects p ON p.id=input.id
        LEFT JOIN project_ownership o ON o.project_id=p.id LEFT JOIN teams t ON t.id=o.team_id`, projectID, owner.ID, actor).Scan(&live, &name, &teamID, &teamExists, &ownerAccess, &actorAccess)
	if err != nil {
		return store.WebhookEligibility{}, pg.QueryError("read webhook eligibility", err)
	}
	return webhook.EvaluateEligibility(owner, webhook.EligibilityFacts{
		ProjectLive: live, ProjectName: name, TeamID: teamID,
		TeamPresent: teamExists != nil, OwnerAccess: ownerAccess, ActorAccess: actorAccess,
	})
}

func (d *dao) LockAffected(ctx context.Context, f store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	if (f.ProjectID == "") == (f.TeamID == "") || (f.TeamOwner && (f.TeamID == "" || f.UserID != "")) || (!f.TeamOwner && f.TeamID != "" && f.UserID == "") {
		return nil, fmt.Errorf("invalid webhook eligibility filter")
	}
	// An orphaned live project cannot be attributed to any Team. Include it for
	// this user so the subsequent eligibility read rejects the corrupt state.
	rows, err := d.tx.Query(ctx, `SELECT s.id::text,s.project_id::text,s.owner_kind,s.owner_id::text,s.authorization_state,s.authorization_epoch
        FROM webhook_subscriptions s
        WHERE s.deleted_at IS NULL
          AND ($1::text='' OR s.project_id=NULLIF($1,'')::uuid)
          AND ($2::text='' OR CASE WHEN $4::boolean THEN s.owner_kind='team' AND s.owner_id=NULLIF($2,'')::uuid
				 ELSE s.owner_kind='personal' AND s.owner_id=NULLIF($3,'')::uuid AND (
				   EXISTS (SELECT 1 FROM project_ownership o WHERE o.project_id=s.project_id AND o.team_id=NULLIF($2,'')::uuid)
				   OR EXISTS (SELECT 1 FROM projects p WHERE p.id=s.project_id AND p.deleted_at IS NULL
				       AND NOT EXISTS (SELECT 1 FROM project_ownership o WHERE o.project_id=p.id))) END)
          AND ($3::text='' OR (s.owner_kind='personal' AND s.owner_id=NULLIF($3,'')::uuid))
        ORDER BY s.id FOR UPDATE OF s`, f.ProjectID, f.TeamID, f.UserID, f.TeamOwner)
	if err != nil {
		return nil, pg.QueryError("lock webhook subscriptions", err)
	}
	defer rows.Close()
	result := []store.WebhookAuthorization{}
	for rows.Next() {
		var a store.WebhookAuthorization
		if err := rows.Scan(&a.ID, &a.ProjectID, &a.Owner.Kind, &a.Owner.ID, &a.State, &a.Epoch); err != nil {
			return nil, pg.QueryError("scan webhook subscription", err)
		}
		if a.Epoch <= 0 || (a.State != "active" && a.State != "confirmation_required") || (a.Owner.Kind != "personal" && a.Owner.Kind != "team") {
			return nil, fmt.Errorf("invalid webhook subscription authorization")
		}
		result = append(result, a)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook subscriptions", err)
	}
	return result, nil
}
func (d *dao) Revoke(ctx context.Context, id string, epoch int64) error {
	tag, err := d.tx.Exec(ctx, `UPDATE webhook_subscriptions SET authorization_state='confirmation_required', authorization_epoch=authorization_epoch+1,updated_at=statement_timestamp() WHERE id=$1 AND deleted_at IS NULL AND authorization_state='active' AND authorization_epoch=$2`, id, epoch)
	if err != nil {
		return pg.QueryError("revoke webhook authorization", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("webhook authorization changed while locked")
	}
	return nil
}

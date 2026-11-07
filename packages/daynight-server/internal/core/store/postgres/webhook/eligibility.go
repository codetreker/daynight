package webhook

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	wh "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/jackc/pgx/v5"
)

type eligibility struct{ tx pgx.Tx }

func NewEligibility(tx pgx.Tx) store.WebhookEligibilityDAO { return &eligibility{tx: tx} }

func (e *eligibility) RefreshAffected(ctx context.Context, change store.WebhookEligibilityChange) error {
	var ownerKind, ownerID any
	if change.DeletedOwner != nil {
		ownerKind, ownerID = change.DeletedOwner.Kind, change.DeletedOwner.ID
	}
	rows, err := e.tx.Query(ctx, `SELECT s.id::text FROM webhook_subscriptions s WHERE s.deleted_at IS NULL AND (
        s.project_id=ANY($1::uuid[]) OR
        (s.owner_kind='personal' AND ($5::uuid[] IS NULL OR cardinality($5::uuid[])=0 OR s.owner_id=ANY($5::uuid[])) AND EXISTS(SELECT 1 FROM project_ownership o WHERE o.project_id=s.project_id AND o.team_id=ANY($2::uuid[]))) OR
        (s.owner_kind=$3::text AND s.owner_id=$4::uuid)) ORDER BY s.id FOR UPDATE`, change.ProjectIDs, change.TeamIDs, ownerKind, ownerID, change.UserIDs)
	if err != nil {
		return pg.QueryError("lock affected Webhook subscriptions", err)
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return pg.QueryError("lock affected Webhook subscriptions", err)
	}
	if len(ids) == 0 {
		return nil
	}
	// The read follows every subscription lock wait and deliberately takes no
	// ownership, Team or grant locks. It observes the effective permission union
	// after a competing source transaction has crossed the same subscription fence.
	rows, err = e.tx.Query(ctx, `SELECT s.id::text,s.authorization_state,s.authorization_epoch,p.id IS NOT NULL,o.project_id IS NOT NULL,t.id IS NOT NULL,
        p.id IS NOT NULL AND o.project_id IS NOT NULL AND t.id IS NOT NULL AND
        CASE s.owner_kind WHEN 'team' THEN o.team_id=s.owner_id AND t.personal_user_id IS NULL
        WHEN 'personal' THEN EXISTS(SELECT 1 FROM users u WHERE u.id=s.owner_id) AND
            (EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=o.team_id AND m.user_id=s.owner_id) OR
             EXISTS(SELECT 1 FROM project_grants g WHERE g.project_id=s.project_id AND g.user_id=s.owner_id))
        ELSE false END AS eligible
        FROM webhook_subscriptions s LEFT JOIN projects p ON p.id=s.project_id AND p.deleted_at IS NULL
        LEFT JOIN project_ownership o ON o.project_id=p.id LEFT JOIN teams t ON t.id=o.team_id
        WHERE s.id=ANY($1::uuid[]) AND s.deleted_at IS NULL ORDER BY s.id`, ids)
	if err != nil {
		return pg.QueryError("read current Webhook permission union", err)
	}
	lost := []string{}
	for rows.Next() {
		var id string
		var state wh.AuthorizationState
		var epoch int64
		var valid bool
		var live, ownership, ownerTeam bool
		if err = rows.Scan(&id, &state, &epoch, &live, &ownership, &ownerTeam, &valid); err != nil {
			break
		}
		if live && (!ownership || !ownerTeam) {
			err = fmt.Errorf("live Webhook Project ownership is missing or inconsistent")
			break
		}
		if epoch <= 0 || state != wh.AuthorizationActive && state != wh.AuthorizationConfirmationRequired {
			err = fmt.Errorf("stored Webhook authorization continuity is invalid")
			break
		}
		if !valid && state == wh.AuthorizationActive {
			lost = append(lost, id)
		}
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return pg.QueryError("read current Webhook permission union", err)
	}
	if len(lost) != 0 {
		if _, err := e.tx.Exec(ctx, `UPDATE webhook_subscriptions SET authorization_state='confirmation_required',authorization_epoch=authorization_epoch+1,updated_at=statement_timestamp()
            WHERE id=ANY($1::uuid[])`, lost); err != nil {
			return pg.QueryError("record interrupted Webhook authorization", err)
		}
	}
	return nil
}

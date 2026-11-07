package team_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

type teamEligibilityFailure struct {
	cause   error
	changes *[]store.WebhookEligibilityChange
}

func (d teamEligibilityFailure) RefreshAffected(_ context.Context, change store.WebhookEligibilityChange) error {
	*d.changes = append(*d.changes, change)
	return d.cause
}

type teamEligibilityScope struct {
	store.TeamWriteScope
	failure teamEligibilityFailure
}

func (s teamEligibilityScope) WebhookEligibilityDAO() store.WebhookEligibilityDAO { return s.failure }

type teamEligibilityStore struct {
	*postgres.Store
	failure teamEligibilityFailure
}

func (s teamEligibilityStore) WriteTeam(ctx context.Context, id string, op func(store.TeamWriteScope) error) (store.Completion, error) {
	return s.Store.WriteTeam(ctx, id, func(scope store.TeamWriteScope) error {
		return op(teamEligibilityScope{TeamWriteScope: scope, failure: s.failure})
	})
}

func TestTeamWebhookRefreshFailureRollsBackACLChanges(t *testing.T) {
	for _, operation := range []string{"remove", "bounded remove", "role", "bounded role", "invitation", "delete", "bounded delete"} {
		t.Run(operation, func(t *testing.T) {
			_, db, _, actor := projectService(t)
			ctx := context.Background()
			healthy := teamservice.NewTeams(db)
			team := newTestTeam(t, healthy, actor, "Webhook access")
			member := servicePrincipal(t, db)
			invite, err := healthy.CreateInvitation(ctx, actor, team.ID, actor.UserID)
			if err != nil {
				t.Fatal(err)
			}
			var membership model.TeamMember
			if operation != "invitation" {
				joined, err := healthy.AcceptInvitation(ctx, member, invite.Secret, member.UserID)
				if err != nil {
					t.Fatal(err)
				}
				membership = joined.Membership
			}
			cause := &model.Fault{Code: "forbidden", Message: "injected eligibility failure"}
			changes := []store.WebhookEligibilityChange{}
			broken := teamservice.NewTeams(teamEligibilityStore{Store: db, failure: teamEligibilityFailure{cause: cause, changes: &changes}})
			input := coreteam.ChangeTeamMember{Version: membership.Version, Role: model.ProjectAdmin, ExpectedUserID: actor.UserID}
			switch operation {
			case "remove":
				_, err = broken.RemoveMember(ctx, actor, team.ID, member.UserID, input)
			case "bounded remove":
				_, err = broken.RemoveMemberBounded(ctx, actor, team.ID, member.UserID, input, 1<<20)
			case "role":
				_, err = broken.SetMemberRole(ctx, actor, team.ID, member.UserID, input)
			case "bounded role":
				_, err = broken.SetMemberRoleBounded(ctx, actor, team.ID, member.UserID, input, 1<<20)
			case "invitation":
				_, err = broken.AcceptInvitation(ctx, member, invite.Secret, member.UserID)
			case "delete":
				err = broken.Delete(ctx, actor, team.ID, coreteam.ChangeTeam{Name: *team.Name, Version: team.Version, ExpectedUserID: actor.UserID})
			case "bounded delete":
				err = broken.DeleteBounded(ctx, actor, team.ID, coreteam.ChangeTeam{Name: *team.Name, Version: team.Version, ExpectedUserID: actor.UserID}, 1<<20)
			}
			if !errors.Is(err, cause) {
				t.Fatalf("refresh failure was lost: %v", err)
			}
			want := store.WebhookEligibilityChange{TeamIDs: []string{team.ID}, UserIDs: []string{member.UserID}}
			if operation == "delete" || operation == "bounded delete" {
				want = store.WebhookEligibilityChange{DeletedOwner: &webhookmodel.Owner{Kind: webhookmodel.TeamOwner, ID: team.ID}}
			}
			if !reflect.DeepEqual(changes, []store.WebhookEligibilityChange{want}) {
				t.Fatalf("refresh selection: %#v", changes)
			}
			if _, err := healthy.Get(ctx, actor, team.ID); err != nil {
				t.Fatalf("Team deletion escaped rollback: %v", err)
			}
			if operation == "invitation" {
				var members, consumed int
				if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM team_members WHERE team_id=$1 AND user_id=$2), (SELECT count(*) FROM team_invitations WHERE id=$3 AND consumed_at IS NOT NULL)`, team.ID, member.UserID, invite.Invitation.ID).Scan(&members, &consumed); err != nil || members != 0 || consumed != 0 {
					t.Fatalf("invitation effects escaped rollback: %d %d %v", members, consumed, err)
				}
			} else {
				current, err := healthy.Member(ctx, actor, team.ID, member.UserID)
				if err != nil || current != membership {
					t.Fatalf("membership effect escaped rollback: %#v %v", current, err)
				}
			}
			changes = nil
			_, err = broken.RemoveMember(ctx, actor, team.ID, member.UserID, coreteam.ChangeTeamMember{Version: membership.Version + 1, ExpectedUserID: actor.UserID})
			if err == nil || len(changes) != 0 {
				t.Fatalf("refused membership write invoked refresh: %#v %v", changes, err)
			}
		})
	}
}

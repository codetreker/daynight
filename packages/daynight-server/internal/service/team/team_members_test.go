package team_test

import (
	"context"
	"errors"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func TestTeamMemberServiceLifecycle(t *testing.T) {
	_, db, _, admin := projectService(t)
	ctx := context.Background()
	s := teamservice.NewTeams(db)
	member := servicePrincipal(t, db)
	outsider := servicePrincipal(t, db)
	team := newTestTeam(t, s, admin, "members")
	invite, err := s.CreateInvitation(ctx, admin, team.ID, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	joined, err := s.AcceptInvitation(ctx, member, invite.Secret, member.UserID)
	if err != nil {
		t.Fatal(err)
	}
	items, err := s.Members(ctx, member, team.ID)
	if err != nil || len(items) != 2 || items[1].Membership.UserID != member.UserID || items[1].Membership.Version != joined.Membership.Version {
		t.Fatalf("members %#v %v", items, err)
	}
	_, err = s.Members(ctx, outsider, team.ID)
	teamFault(t, err, "not_found")
	_, err = s.SetMemberRole(ctx, member, team.ID, admin.UserID, coreteam.ChangeTeamMember{Version: team.Membership.Version, Role: model.ProjectMemberRole, ExpectedUserID: member.UserID})
	teamFault(t, err, "forbidden")
	_, err = s.RemoveMember(ctx, member, team.ID, admin.UserID, coreteam.ChangeTeamMember{Version: team.Membership.Version, ExpectedUserID: member.UserID})
	teamFault(t, err, "forbidden")
	_, err = s.SetMemberRole(ctx, admin, team.ID, uuid.NewString(), coreteam.ChangeTeamMember{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: admin.UserID})
	teamFault(t, err, "not_found")
	_, err = s.SetMemberRole(ctx, admin, team.ID, member.UserID, coreteam.ChangeTeamMember{Version: joined.Membership.Version + 1, Role: model.ProjectMemberRole, ExpectedUserID: admin.UserID})
	teamFault(t, err, "version_conflict")
	_, err = s.SetMemberRole(ctx, admin, team.ID, admin.UserID, coreteam.ChangeTeamMember{Version: team.Membership.Version, Role: model.ProjectMemberRole, ExpectedUserID: admin.UserID})
	teamFault(t, err, "last_admin")
	_, err = s.RemoveMember(ctx, admin, team.ID, admin.UserID, coreteam.ChangeTeamMember{Version: team.Membership.Version, ExpectedUserID: admin.UserID})
	teamFault(t, err, "last_admin")
	promoted, err := s.SetMemberRole(ctx, admin, team.ID, member.UserID, coreteam.ChangeTeamMember{Version: joined.Membership.Version, Role: model.ProjectAdmin, ExpectedUserID: admin.UserID})
	if err != nil || promoted.Membership.Role != model.ProjectAdmin || promoted.Membership.Version <= joined.Membership.Version || *promoted.ActorRole != model.ProjectAdmin {
		t.Fatalf("promotion %#v %v", promoted, err)
	}
	same, err := s.SetMemberRole(ctx, admin, team.ID, member.UserID, coreteam.ChangeTeamMember{Version: promoted.Membership.Version, Role: model.ProjectAdmin, ExpectedUserID: admin.UserID})
	if err != nil || !reflect.DeepEqual(same, promoted) {
		t.Fatalf("no-op %#v %v", same, err)
	}
	demoted, err := s.SetMemberRole(ctx, member, team.ID, member.UserID, coreteam.ChangeTeamMember{Version: promoted.Membership.Version, Role: model.ProjectMemberRole, ExpectedUserID: member.UserID})
	if err != nil || *demoted.ActorRole != model.ProjectMemberRole {
		t.Fatalf("self demote %#v %v", demoted, err)
	}
	removed, err := s.RemoveMember(ctx, member, team.ID, member.UserID, coreteam.ChangeTeamMember{Version: demoted.Membership.Version, ExpectedUserID: member.UserID})
	if err != nil || removed.ActorRole != nil || removed.Membership != demoted.Membership {
		t.Fatalf("self exit %#v %v", removed, err)
	}
	_, err = s.Members(ctx, member, team.ID)
	teamFault(t, err, "not_found")
	invite, err = s.CreateInvitation(ctx, admin, team.ID, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	rejoined, err := s.AcceptInvitation(ctx, member, invite.Secret, member.UserID)
	if err != nil || rejoined.Membership.Version <= demoted.Membership.Version {
		t.Fatalf("ABA %#v %v", rejoined, err)
	}
	_, err = s.RemoveMember(ctx, admin, team.ID, member.UserID, coreteam.ChangeTeamMember{Version: demoted.Membership.Version, ExpectedUserID: admin.UserID})
	teamFault(t, err, "version_conflict")
	removed, err = s.RemoveMember(ctx, admin, team.ID, member.UserID, coreteam.ChangeTeamMember{Version: rejoined.Membership.Version, ExpectedUserID: admin.UserID})
	if err != nil || removed.ActorRole == nil || *removed.ActorRole != model.ProjectAdmin {
		t.Fatalf("remove %#v %v", removed, err)
	}
	var personal string
	if err = db.Pool.QueryRow(ctx, `SELECT id::text FROM teams WHERE personal_user_id=$1`, admin.UserID).Scan(&personal); err != nil {
		t.Fatal(err)
	}
	for _, remove := range []bool{false, true} {
		input := coreteam.ChangeTeamMember{Version: 1, Role: model.ProjectMemberRole, ExpectedUserID: admin.UserID}
		if remove {
			_, err = s.RemoveMember(ctx, admin, personal, admin.UserID, input)
		} else {
			_, err = s.SetMemberRole(ctx, admin, personal, admin.UserID, input)
		}
		teamFault(t, err, "personal_team_immutable")
	}
}

func TestTeamMemberServiceValidationAndFailures(t *testing.T) {
	_, db, url, actor := projectService(t)
	other := servicePrincipal(t, db)
	ctx := context.Background()
	var count atomic.Int32
	traced := tracedTasks(t, url, taskQueryAction{match: func(string) bool { count.Add(1); return false }})
	s := teamservice.NewTeams(traced)
	for _, remove := range []bool{false, true} {
		input := coreteam.ChangeTeamMember{Version: 1, Role: model.ProjectMemberRole, ExpectedUserID: other.UserID}
		var err error
		if remove {
			_, err = s.RemoveMember(ctx, actor, uuid.NewString(), actor.UserID, input)
		} else {
			_, err = s.SetMemberRole(ctx, actor, uuid.NewString(), actor.UserID, input)
		}
		teamFault(t, err, "identity_mismatch")
	}
	if count.Load() != 0 {
		t.Fatalf("identity mismatch issued %d SQL queries", count.Load())
	}
	s = teamservice.NewTeams(nil)
	_, err := s.Members(ctx, model.Principal{}, uuid.NewString())
	teamFault(t, err, "unauthenticated")
	_, err = s.Members(ctx, actor, "invalid")
	teamFault(t, err, "invalid_input")
	for _, input := range []struct {
		p          model.Principal
		team, user string
		change     coreteam.ChangeTeamMember
		code       string
	}{
		{model.Principal{}, uuid.NewString(), actor.UserID, coreteam.ChangeTeamMember{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: actor.UserID}, "unauthenticated"},
		{actor, "invalid", actor.UserID, coreteam.ChangeTeamMember{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: actor.UserID}, "invalid_input"},
		{actor, uuid.NewString(), strings.ToUpper("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), coreteam.ChangeTeamMember{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: actor.UserID}, "invalid_input"},
		{actor, uuid.NewString(), actor.UserID, coreteam.ChangeTeamMember{Version: 0, Role: model.ProjectAdmin, ExpectedUserID: actor.UserID}, "invalid_input"},
		{actor, uuid.NewString(), actor.UserID, coreteam.ChangeTeamMember{Version: 1, Role: "invalid", ExpectedUserID: actor.UserID}, "invalid_input"},
	} {
		_, err = s.SetMemberRole(ctx, input.p, input.team, input.user, input.change)
		teamFault(t, err, input.code)
	}
	s = teamservice.NewTeams(db)
	team := newTestTeam(t, s, actor, "broken")
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = s.Members(canceled, actor, team.ID)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("read cancellation %v", err)
	}
	_, err = s.SetMemberRole(canceled, actor, team.ID, actor.UserID, coreteam.ChangeTeamMember{Version: team.Membership.Version, Role: model.ProjectAdmin, ExpectedUserID: actor.UserID})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("write cancellation %v", err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	items, err := s.Members(ctx, actor, team.ID)
	if err == nil || items != nil {
		t.Fatalf("broken profile returned partial results %#v %v", items, err)
	}
}

func TestTeamMemberServiceConcurrentAdminTransitions(t *testing.T) {
	_, db, _, admin := projectService(t)
	member := servicePrincipal(t, db)
	ctx := context.Background()
	s := teamservice.NewTeams(db)
	for _, remove := range []bool{false, true} {
		team := newTestTeam(t, s, admin, "race")
		invitation, err := s.CreateInvitation(ctx, admin, team.ID, admin.UserID)
		if err != nil {
			t.Fatal(err)
		}
		joined, err := s.AcceptInvitation(ctx, member, invitation.Secret, member.UserID)
		if err != nil {
			t.Fatal(err)
		}
		promoted, err := s.SetMemberRole(ctx, admin, team.ID, member.UserID, coreteam.ChangeTeamMember{Version: joined.Membership.Version, Role: model.ProjectAdmin, ExpectedUserID: admin.UserID})
		if err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		errs := make([]error, 2)
		for i, p := range []model.Principal{admin, member} {
			i, p := i, p
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				v := team.Membership.Version
				if i == 1 {
					v = promoted.Membership.Version
				}
				input := coreteam.ChangeTeamMember{Version: v, Role: model.ProjectMemberRole, ExpectedUserID: p.UserID}
				if remove {
					_, errs[i] = s.RemoveMember(ctx, p, team.ID, p.UserID, input)
				} else {
					_, errs[i] = s.SetMemberRole(ctx, p, team.ID, p.UserID, input)
				}
			}()
		}
		close(start)
		wg.Wait()
		successes, refused := 0, 0
		for _, err := range errs {
			if err == nil {
				successes++
				continue
			}
			var f *model.Fault
			if errors.As(err, &f) && f.Code == "last_admin" {
				refused++
				continue
			}
			t.Fatal(err)
		}
		if successes != 1 || refused != 1 {
			t.Fatalf("concurrent results %v", errs)
		}
	}
}

func TestTeamMemberQueryCancellationPreservesFailure(t *testing.T) {
	for _, tc := range []struct {
		name, fragment            string
		read, remove, adminTarget bool
	}{
		{name: "snapshot team", fragment: "FROM teams t", read: true},
		{name: "write actor", fragment: "FROM teams t"},
		{name: "target", fragment: "WHERE team_id=$1 AND user_id=$2 FOR UPDATE"},
		{name: "count admins", fragment: "SELECT count(*) FROM team_members", adminTarget: true},
		{name: "remove", fragment: "DELETE FROM team_members", remove: true},
		{name: "change role", fragment: "UPDATE team_members SET role"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, db, url, actor := projectService(t)
			other := servicePrincipal(t, db)
			s := teamservice.NewTeams(db)
			ctx := context.Background()
			team := newTestTeam(t, s, actor, "cancel")
			var version int64
			if err := db.Pool.QueryRow(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member') RETURNING version`, team.ID, other.UserID).Scan(&version); err != nil {
				t.Fatal(err)
			}
			target := other.UserID
			role := model.ProjectAdmin
			if tc.adminTarget {
				target = actor.UserID
				version = team.Membership.Version
				role = model.ProjectMemberRole
			}
			opctx, cancel := context.WithCancel(ctx)
			defer cancel()
			traced := tracedTasks(t, url, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, tc.fragment) }, start: cancel})
			guarded := teamservice.NewTeams(traced)
			var err error
			if tc.read {
				_, err = guarded.Members(opctx, actor, team.ID)
			} else if tc.remove {
				_, err = guarded.RemoveMember(opctx, actor, team.ID, target, coreteam.ChangeTeamMember{Version: version, ExpectedUserID: actor.UserID})
			} else {
				_, err = guarded.SetMemberRole(opctx, actor, team.ID, target, coreteam.ChangeTeamMember{Version: version, Role: role, ExpectedUserID: actor.UserID})
			}
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("lost cancellation cause: %v", err)
			}
			items, err := s.Members(ctx, actor, team.ID)
			if err != nil || len(items) != 2 || items[0].Membership.Version != team.Membership.Version || items[1].Membership.Version != version && !tc.adminTarget {
				t.Fatalf("canceled operation changed members: %#v %v", items, err)
			}
		})
	}
}

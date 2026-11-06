package team

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type personalTeamFixture struct {
	created       bool
	facts         store.PersonalTeamFacts
	failure       error
	ownerCalls    int
	ownerFailure  error
	lookupFailure error
	teamID        string
	ownerTeamID   string
	ownerUserID   string
	ownerTime     time.Time
}

func (f *personalTeamFixture) InsertPersonalTeam(_ context.Context, id string, _ string, _ time.Time) (bool, error) {
	f.teamID = id
	return f.created, f.failure
}
func (f *personalTeamFixture) InsertPersonalOwner(_ context.Context, id, user string, now time.Time) error {
	f.ownerCalls++
	f.ownerTeamID, f.ownerUserID, f.ownerTime = id, user, now
	return f.ownerFailure
}
func (f *personalTeamFixture) PersonalTeam(context.Context, string) (store.PersonalTeamFacts, error) {
	return f.facts, f.lookupFailure
}
func TestBootstrapPersonalTeamValidatesExistingOwner(t *testing.T) {
	for _, test := range []struct {
		name, id        string
		members, owners int64
		want            string
	}{{"missing", "", 0, 0, "user Personal Team is missing"}, {"no owner", "team", 0, 0, "Personal Team owner membership is invalid"}, {"wrong role", "team", 1, 0, "Personal Team owner membership is invalid"}, {"additional member", "team", 2, 1, "Personal Team owner membership is invalid"}, {"valid", "team", 1, 1, ""}} {
		t.Run(test.name, func(t *testing.T) {
			f := &personalTeamFixture{facts: store.PersonalTeamFacts{ID: test.id, MemberCount: test.members, OwnerAdminCount: test.owners}}
			team, err := BootstrapPersonalTeam(context.Background(), f, "user", time.Now())
			if test.want != "" {
				if err == nil || err.Error() != test.want {
					t.Fatalf("integrity error = %v", err)
				}
				return
			}
			if err != nil || team.ID != test.id || team.Kind != "personal" || f.ownerCalls != 0 {
				t.Fatalf("team = %#v, error %v", team, err)
			}
		})
	}
	failure := errors.New("lookup failed")
	f := &personalTeamFixture{failure: failure}
	_, err := BootstrapPersonalTeam(context.Background(), f, "user", time.Now())
	if !errors.Is(err, failure) {
		t.Fatalf("cause lost: %v", err)
	}
}

func TestBootstrapPersonalTeamCreatesOwnerAndPreservesFailures(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	f := &personalTeamFixture{created: true}
	result, err := BootstrapPersonalTeam(ctx, f, "user", now)
	if err != nil || result.Kind != "personal" || result.ID == "" || result.ID != f.teamID || f.ownerTeamID != result.ID || f.ownerUserID != "user" || !f.ownerTime.Equal(now) || f.ownerCalls != 1 {
		t.Fatalf("new Personal Team or owner: %#v %#v %v", result, f, err)
	}
	for _, stage := range []string{"insert", "owner", "lookup"} {
		t.Run(stage, func(t *testing.T) {
			failure := errors.New(stage + " failed")
			f := &personalTeamFixture{}
			switch stage {
			case "insert":
				f.failure = failure
			case "owner":
				f.created, f.ownerFailure = true, failure
			case "lookup":
				f.lookupFailure = failure
			}
			result, err := BootstrapPersonalTeam(ctx, f, "user", now)
			if result.ID != "" || !errors.Is(err, failure) {
				t.Fatalf("failure not preserved: %#v %v", result, err)
			}
		})
	}
}

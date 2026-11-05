package team

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type personalTeamFixture struct {
	created    bool
	facts      store.PersonalTeamFacts
	failure    error
	ownerCalls int
}

func (f *personalTeamFixture) InsertPersonalTeam(context.Context, string, string, time.Time) (bool, error) {
	return f.created, f.failure
}
func (f *personalTeamFixture) InsertPersonalOwner(context.Context, string, string, time.Time) error {
	f.ownerCalls++
	return nil
}
func (f *personalTeamFixture) PersonalTeam(context.Context, string) (store.PersonalTeamFacts, error) {
	return f.facts, f.failure
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

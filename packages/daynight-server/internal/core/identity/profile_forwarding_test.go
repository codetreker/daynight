package identity

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type claimedProfileDAO struct {
	store.IdentityDAO
	t         *testing.T
	ctx       context.Context
	now       time.Time
	want      model.User
	canonical model.User
	calls     int
}

func (d *claimedProfileDAO) UpsertUser(ctx context.Context, got model.User, now time.Time) (model.User, error) {
	d.t.Helper()
	d.calls++
	if d.calls != 1 || ctx != d.ctx || now != d.now {
		d.t.Fatal("profile write context, UTC time or call count changed")
	}
	id, err := uuid.Parse(got.ID)
	if err != nil || id == uuid.Nil {
		d.t.Fatalf("profile write has invalid generated ID %q", got.ID)
	}
	want := cloneClaimedProfile(d.want)
	want.ID = got.ID
	if !reflect.DeepEqual(got, want) {
		d.t.Fatalf("profile write=%#v want=%#v", got, want)
	}
	return cloneClaimedProfile(d.canonical), nil
}

func TestCompleteLoginForwardsCompleteClaimedProfile(t *testing.T) {
	for _, persona := range []string{"alice", "bob", "alice-updated", "alice-null"} {
		t.Run(persona, func(t *testing.T) {
			now := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
			claimed := rootClaimedProfile(persona)
			canonical := cloneClaimedProfile(claimed)
			canonical.ID = "a50e772d-0dc9-4bde-afef-12d3cbb9f260"
			canonical.PersonalTeam = model.TeamRef{ID: "afe063ed-f3f8-4f70-8f20-af0c6493d4b1", Kind: "personal"}
			if persona == "bob" {
				canonical.ID = "bf84dd53-62bf-4b7e-8476-51c16bbabbd2"
				canonical.PersonalTeam.ID = "b7fdd87c-b68e-4fe6-9fe4-29e93e3af813"
			}
			canonical.CreatedAt, canonical.UpdatedAt = now.Add(-time.Hour), now
			dao := &claimedProfileDAO{t: t, ctx: t.Context(), now: now, want: cloneClaimedProfile(claimed), canonical: cloneClaimedProfile(canonical)}
			input := cloneClaimedProfile(claimed)
			got, err := NewIdentity("https://daynight.example/auth/callback").CompleteLogin(t.Context(), dao, input, now)
			if err != nil || !reflect.DeepEqual(got, canonical) || dao.calls != 1 {
				t.Fatalf("complete profile=%#v want=%#v calls=%d err=%v", got, canonical, dao.calls, err)
			}
			if !reflect.DeepEqual(input, claimed) {
				t.Fatal("completing login mutated the claimed profile")
			}
		})
	}
}

func rootClaimedProfile(persona string) model.User {
	text := func(value string) *string { return &value }
	boolean := func(value bool) *bool { return &value }
	user := model.User{UniAuthID: "github:alice"}
	switch persona {
	case "alice":
		user.Email, user.EmailVerified, user.Name, user.AvatarURL = text("shared@example.test"), boolean(true), text("Alice"), text("https://images.example.test/alice.png")
	case "bob":
		user.UniAuthID = "github:bob"
		user.Email, user.EmailVerified, user.Name, user.AvatarURL = text("shared@example.test"), boolean(true), text("Bob"), text("https://images.example.test/bob.png")
	case "alice-updated":
		user.Email, user.EmailVerified, user.Name, user.AvatarURL = text("refreshed@example.test"), boolean(false), text("Alice Updated"), text("https://images.example.test/alice-updated.png")
	case "alice-null":
	default:
		panic("unknown claimed profile")
	}
	return user
}

func cloneClaimedProfile(user model.User) model.User {
	clone := func(value *string) *string {
		if value == nil {
			return nil
		}
		copy := *value
		return &copy
	}
	user.Email, user.Name, user.AvatarURL = clone(user.Email), clone(user.Name), clone(user.AvatarURL)
	user.PersonalTeam.Name = clone(user.PersonalTeam.Name)
	if user.EmailVerified != nil {
		value := *user.EmailVerified
		user.EmailVerified = &value
	}
	return user
}

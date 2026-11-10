package identity

import (
	"context"
	"errors"
	"net/url"
	"slices"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

func TestCompleteLoginPreservesRootProfileVariants(t *testing.T) {
	for _, persona := range []string{"alice", "bob", "alice-updated", "alice-null"} {
		t.Run(persona, func(t *testing.T) {
			f := newIdentityHTTPFixture(t)
			profile := rootProfileClaim(persona)
			f.replies[persona] = identityReply{200, map[string]any{
				"provider": "github", "id": profile.UniAuthID,
				"email": profile.Email, "email_verified": profile.EmailVerified,
				"name": profile.Name, "avatar_url": profile.AvatarURL, "origin": map[string]any{},
			}}
			query := url.Values{"state": {secret.Random("")}, "code": {persona}}
			wantQuery := url.Values{"state": {query.Get("state")}, "code": {persona}}
			binding := secret.Random("")
			pending := model.LoginTransaction{ID: "90f67eb6-57c7-4af7-8d82-6c18d902198d", Provider: "github", ReturnPath: "/projects?view=tasks", StateHash: secret.Hash(query.Get("state")), BrowserBindingHash: secret.Hash(binding), ScopeHash: []byte("browser-scope"), ExpiresAt: f.now.Add(time.Hour)}
			f.transaction()
			f.transaction()
			consumeScope, writeScope := f.transactions[0].scope, f.transactions[1].scope
			f.plan = []string{"validate-callback", "write", "consume", "finish", "provider", "profile", "new-session", "write", "upsert", "bootstrap", "session", "finish"}
			f.identity.ops.validateCallback = func(got url.Values, gotBinding string) error {
				f.hit("validate-callback")
				f.equal(got, wantQuery)
				f.equal(gotBinding, binding)
				return nil
			}
			f.identity.ops.consumeLogin = func(ctx context.Context, dao store.IdentityDAO, state, gotBinding string, now time.Time) (model.LoginTransaction, error) {
				f.hit("consume")
				if ctx != f.ctx || dao != consumeScope.identity {
					t.Fatal("consume context or scope identity changed")
				}
				f.equal([]any{state, gotBinding, now}, []any{wantQuery.Get("state"), binding, f.now})
				out := pending
				out.StateHash, out.BrowserBindingHash, out.ScopeHash = slices.Clone(pending.StateHash), slices.Clone(pending.BrowserBindingHash), slices.Clone(pending.ScopeHash)
				return out, nil
			}
			f.identity.ops.validateProvider = func(expected, actual string, mismatch error) error {
				f.hit("provider")
				f.equal([]string{expected, actual}, []string{"github", "github"})
				var protocol *uniauth.ProtocolError
				if !errors.As(mismatch, &protocol) || protocol.Reason != "provider_mismatch" {
					t.Fatalf("provider mismatch cause=%v", mismatch)
				}
				return nil
			}
			wantClaim := cloneRootProfile(profile)
			f.identity.ops.admitProfileFields = func(got model.User) error {
				f.hit("profile")
				f.equal(got, wantClaim)
				return nil
			}
			canonical := cloneRootProfile(profile)
			canonical.ID = "a50e772d-0dc9-4bde-afef-12d3cbb9f260"
			team := model.TeamRef{ID: "afe063ed-f3f8-4f70-8f20-af0c6493d4b1", Kind: "personal"}
			if persona == "bob" {
				canonical.ID = "bf84dd53-62bf-4b7e-8476-51c16bbabbd2"
				team.ID = "b7fdd87c-b68e-4fe6-9fe4-29e93e3af813"
			}
			canonical.CreatedAt, canonical.UpdatedAt = f.now.Add(-time.Hour), f.now
			canonical.PersonalTeam = team
			value := secret.Random("dnst_")
			session := model.Session{ID: "ccd40738-cf0e-49a7-8750-3f7476d0f710", TokenHash: secret.Hash(value), CreatedAt: f.now, ExpiresAt: f.now.Add(core.SessionLifetime)}
			f.identity.ops.newSession = func(now time.Time) (model.Session, string) {
				f.hit("new-session")
				f.equal(now, f.now)
				out := session
				out.TokenHash = slices.Clone(session.TokenHash)
				return out, value
			}
			f.identity.ops.completeLogin = func(ctx context.Context, dao store.IdentityDAO, got model.User, now time.Time) (model.User, error) {
				f.hit("upsert")
				if ctx != f.ctx || dao != writeScope.identity {
					t.Fatal("complete context or scope identity changed")
				}
				f.equal(now, f.now)
				f.equal(got, wantClaim)
				return cloneRootProfile(canonical), nil
			}
			f.identity.ops.bootstrapPersonalTeam = func(ctx context.Context, dao store.PersonalTeamDAO, id string, now time.Time) (model.TeamRef, error) {
				f.hit("bootstrap")
				if ctx != f.ctx || dao != writeScope.personal {
					t.Fatal("personal team context or scope identity changed")
				}
				f.equal([]any{id, now}, []any{canonical.ID, f.now})
				return team, nil
			}
			wantSession := session
			wantSession.UserID, wantSession.TokenHash = canonical.ID, slices.Clone(session.TokenHash)
			f.identity.ops.createSession = func(ctx context.Context, dao store.IdentityDAO, got model.Session) error {
				f.hit("session")
				if ctx != f.ctx || dao != writeScope.identity {
					t.Fatal("session context or scope identity changed")
				}
				f.equal(got, wantSession)
				return nil
			}
			got, err := f.identity.CompleteLogin(f.ctx, query, binding)
			if err != nil {
				t.Fatal(err)
			}
			f.equal(got, core.LoginCompletion{LoginID: pending.ID, ReturnPath: pending.ReturnPath, User: cloneRootProfile(canonical), Session: wantSession, Secret: value})
			f.equal(query, wantQuery)
			if f.calls.Load() != 1 {
				t.Fatalf("SDK result requests=%d want=1", f.calls.Load())
			}
		})
	}
}

func rootProfileClaim(persona string) model.User {
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
		panic("unknown root profile")
	}
	return user
}

func cloneRootProfile(user model.User) model.User {
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

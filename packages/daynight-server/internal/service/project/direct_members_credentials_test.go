package project

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

const directCredentialResource = "https://example.test/api/v1"

func issueDirectOAuth(t *testing.T, f *membershipFixture, user string) coreoauth.IssuedFamily {
	t.Helper()
	var issued coreoauth.IssuedFamily
	_, err := f.database.WriteCredentialFamily(t.Context(), func(scope store.CredentialFamilyScope) error {
		var err error
		issued, err = coreoauth.IssueAPIFamily(t.Context(), scope.CredentialFamilyDAO(), user, directCredentialResource, time.Now())
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return issued
}

func assertNoDirectGrant(t *testing.T, f *membershipFixture, project, user string) {
	t.Helper()
	var count int
	if err := f.database.Pool.QueryRow(t.Context(), `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2`, project, user).Scan(&count); err != nil || count != 0 {
		t.Fatalf("unexpected persisted grant count=%d err=%v", count, err)
	}
}

func TestDirectMemberOAuthBinding(t *testing.T) {
	for _, scenario := range []string{"valid", "audience", "scope", "client", "user", "credential"} {
		t.Run(scenario, func(t *testing.T) {
			f := newMembershipFixture(t)
			owner, target := f.user(t), f.user(t)
			project := f.project(t, owner, "OAuth binding")
			issued := issueDirectOAuth(t, f, owner.UserID)
			actor := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID, CredentialID: issued.AccessID}
			resource := directCredentialResource
			switch scenario {
			case "audience":
				resource = "https://other.example/api/v1"
			case "scope", "client":
				column, value := "scope", "daynight:mcp"
				if scenario == "client" {
					column, value = "client_id", "foreign-client"
				}
				if _, err := f.database.Pool.Exec(t.Context(), `UPDATE oauth_grants SET `+column+`=$2, expires_at=created_at+interval '1 day' WHERE id=$1`, issued.Grant.ID, value); err != nil {
					t.Fatal(err)
				}
			case "user":
				actor.UserID = target.UserID
			case "credential":
				actor.CredentialID = uuid.NewString()
			}
			result, err := NewDirectMembers(f.database, resource).AddExistingMember(t.Context(), actor, project.ID, target.UserID, actor.UserID)
			if scenario == "valid" {
				if err != nil || !result.Added || result.Participant.UserID != target.UserID {
					t.Fatalf("valid OAuth: %+v %v", result, err)
				}
				return
			}
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
				t.Fatalf("invalid OAuth admitted: %+v %v", result, err)
			}
			assertNoDirectGrant(t, f, project.ID, target.UserID)
		})
	}
}

func TestDirectMemberCredentialRevokedWhileWaiting(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.PATCredential, model.OAuthCredential} {
		t.Run(string(kind), func(t *testing.T) {
			f := newMembershipFixture(t)
			owner, target := f.user(t), f.user(t)
			project := f.project(t, owner, "Revocation")
			actor, grant := owner, ""
			if kind == model.PATCredential {
				pat := testutil.DeviceCredential(time.Now().UTC())
				pat.UserID = owner.UserID
				if _, err := f.database.WriteIdentity(t.Context(), func(scope store.IdentityScope) error { return scope.IdentityDAO().InsertPAT(t.Context(), pat) }); err != nil {
					t.Fatal(err)
				}
				actor = model.Principal{Kind: kind, UserID: owner.UserID, CredentialID: pat.ID}
			} else if kind == model.OAuthCredential {
				issued := issueDirectOAuth(t, f, owner.UserID)
				actor, grant = model.Principal{Kind: kind, UserID: owner.UserID, CredentialID: issued.AccessID}, issued.Grant.ID
			}
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			holder, err := f.database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			if _, err = holder.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				_, err := NewDirectMembers(f.database, directCredentialResource).AddExistingMember(ctx, actor, project.ID, target.UserID, actor.UserID)
				done <- err
			}()
			waitDirectLock(t, ctx, f.database, "SELECT id::text FROM projects WHERE id=% FOR UPDATE%")
			query, id := `DELETE FROM sessions WHERE id=$1`, actor.CredentialID
			if kind == model.PATCredential {
				query = `DELETE FROM personal_access_tokens WHERE id=$1`
			}
			if kind == model.OAuthCredential {
				query, id = `UPDATE oauth_grants SET revoked_at=clock_timestamp() WHERE id=$1`, grant
			}
			if _, err = holder.Exec(ctx, query, id); err != nil {
				t.Fatal(err)
			}
			if err = holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			var fault *model.Fault
			if err = testutil.ReceiveQueryResult(t, ctx, done); !errors.As(err, &fault) || fault.Code != "unauthenticated" {
				t.Fatalf("revocation admitted: %v", err)
			}
			assertNoDirectGrant(t, f, project.ID, target.UserID)
		})
	}
}

func TestDirectMemberExpiryDuringEligibilityWaitRollsBack(t *testing.T) {
	f := newMembershipFixture(t)
	owner, target := f.user(t), f.user(t)
	project := f.project(t, owner, "Expiry")
	issued := issueDirectOAuth(t, f, owner.UserID)
	actor := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID, CredentialID: issued.AccessID}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	subscription := uuid.NewString()
	if _, err := f.database.Pool.Exec(ctx, `INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'confirmation_required',1,now(),now())`, subscription, uuid.NewString(), project.ID, target.UserID); err != nil {
		t.Fatal(err)
	}
	expires := time.Now().UTC().Add(2 * time.Second)
	if _, err := f.database.Pool.Exec(ctx, `UPDATE oauth_access_tokens SET expires_at=$2 WHERE id=$1`, actor.CredentialID, expires); err != nil {
		t.Fatal(err)
	}
	holder, err := f.database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err = holder.Exec(ctx, `SELECT id FROM webhook_subscriptions WHERE id=$1 FOR UPDATE`, subscription); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := NewDirectMembers(f.database, directCredentialResource).AddExistingMember(ctx, actor, project.ID, target.UserID, actor.UserID)
		done <- err
	}()
	waitDirectLock(t, ctx, f.database, "SELECT s.id::text,s.project_id::text%")
	for {
		var expired bool
		if err = f.database.Pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1::timestamptz`, expires).Scan(&expired); err != nil {
			t.Fatal(err)
		}
		if expired {
			break
		}
		if err = testutil.WaitThreadClock(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if err = holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var fault *model.Fault
	if err = testutil.ReceiveQueryResult(t, ctx, done); !errors.As(err, &fault) || fault.Code != "unauthenticated" {
		t.Fatalf("expired credential admitted: %v", err)
	}
	assertNoDirectGrant(t, f, project.ID, target.UserID)
	var state string
	var epoch int
	if err = f.database.Pool.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, subscription).Scan(&state, &epoch); err != nil || state != "confirmation_required" || epoch != 1 {
		t.Fatalf("eligibility persisted: %s %d %v", state, epoch, err)
	}
}

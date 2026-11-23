package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestAuthorizationScopeRollsBackIssuedFamilyAfterUpdateFailure(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newAuthorizationReceiverFixture(t, "update-failure-client", "approved")
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	before := authorizationReceiverRow(t, ctx, f.database, "oauth_authorizations", "id", f.authorization.ID)
	counts := authorizationReceiverCounts(t, ctx, f.database)
	const fault = "authorization_receiver_update_failure"
	if _, err := f.database.Pool.Exec(ctx, `CREATE FUNCTION authorization_receiver_update_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'authorization receiver update failure' USING ERRCODE='P0001'; END $$;
 CREATE TRIGGER authorization_receiver_update_failure BEFORE UPDATE ON oauth_authorizations FOR EACH ROW EXECUTE FUNCTION authorization_receiver_update_failure()`); err != nil {
		t.Fatal(err)
	}
	removeFault := func(ctx context.Context) error {
		if _, err := f.database.Pool.Exec(ctx, `DROP TRIGGER IF EXISTS authorization_receiver_update_failure ON oauth_authorizations; DROP FUNCTION IF EXISTS authorization_receiver_update_failure()`); err != nil {
			return err
		}
		return checkFaultTriggerRemoved(ctx, f.database, fault, "oauth_authorizations")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := removeFault(ctx); err != nil {
			t.Errorf("remove authorization update fault: %v", err)
		}
	})
	consumed := f.authorization
	consumed.Status, consumed.GrantID, consumed.RetainUntil = "consumed", f.issue.Grant.ID, f.issue.Grant.ExpiresAt.Add(24*time.Hour)
	issueAndUpdate := func(scope store.AuthorizationScope) error {
		if err := scope.CredentialFamilyDAO().IssueFamily(ctx, f.issue); err != nil {
			return err
		}
		return scope.AuthorizationDAO().UpdateAuthorization(ctx, consumed)
	}
	completion, err := f.database.WriteAuthorizations(ctx, issueAndUpdate)
	var failure *pgconn.PgError
	if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &failure) || failure.Code != "P0001" {
		t.Fatalf("update fault completion=%+v, error=%v", completion, err)
	}
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_authorizations", "id", f.authorization.ID, before)
	if got := authorizationReceiverCounts(t, ctx, f.database); got != counts {
		t.Fatalf("failed update retained family rows: got %v, want %v", got, counts)
	}
	if got := authorizationReceiverClientCounts(t, ctx, f.database, f.client.ID); got != ([3]int64{}) {
		t.Fatalf("failed client retained issued rows: %v", got)
	}
	if err := removeFault(ctx); err != nil {
		t.Fatal(err)
	}
	completion, err = f.database.WriteAuthorizations(ctx, issueAndUpdate)
	authorizationReceiverCommitted(t, completion, err)
	var complete bool
	if err := f.database.Pool.QueryRow(ctx, `SELECT to_jsonb(row)=($2::jsonb || jsonb_build_object('status','consumed','grant_id',$3::text,'retain_until',to_jsonb($4::timestamptz))) FROM oauth_authorizations row WHERE id=$1`, consumed.ID, before, consumed.GrantID, consumed.RetainUntil).Scan(&complete); err != nil || !complete {
		t.Fatalf("retry did not persist complete consumed authorization: match=%t, error=%v", complete, err)
	}
	want := [3]int64{counts[0] + 1, counts[1] + 1, counts[2] + 1}
	if got := authorizationReceiverCounts(t, ctx, f.database); got != want {
		t.Fatalf("retry family counts: got %v, want %v", got, want)
	}
	if got := authorizationReceiverClientCounts(t, ctx, f.database, f.client.ID); got != ([3]int64{1, 1, 1}) {
		t.Fatalf("retry family client relationships: %v", got)
	}
}

func TestAuthorizationScopeRollsBackClientPin(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newAuthorizationReceiverFixture(t, "dnoac_pin_receiver", "approved")
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	before := authorizationReceiverRow(t, ctx, f.database, "oauth_authorizations", "id", f.authorization.ID)
	clientBefore := authorizationReceiverRow(t, ctx, f.database, "oauth_clients", "id", f.client.ID)
	counts := authorizationReceiverCounts(t, ctx, f.database)
	at := f.now.Add(time.Minute)
	refusal := errors.New("fresh time after actual pin failed")
	pin := func(scope store.AuthorizationScope) error {
		pinned, err := scope.OAuthClientDAO().PinClient(ctx, f.client.ID, at)
		if err != nil {
			return err
		}
		if pinned.ID != f.client.ID || !bytes.Equal(pinned.Metadata, f.client.Metadata) || !pinned.CreatedAt.Equal(f.client.CreatedAt) || !pinned.LastUsedAt.Equal(at) || !pinned.ExpiresAt.Equal(at.Add(7*24*time.Hour)) {
			return fmt.Errorf("actual pin did not apply expected touch: %+v", pinned)
		}
		return nil
	}
	completion, err := f.database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		if err := pin(scope); err != nil {
			return err
		}
		return refusal
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, refusal) {
		t.Fatalf("post-pin failure completion=%+v, error=%v", completion, err)
	}
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_authorizations", "id", f.authorization.ID, before)
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_clients", "id", f.client.ID, clientBefore)
	if got := authorizationReceiverCounts(t, ctx, f.database); got != counts {
		t.Fatalf("post-pin failure changed family counts: got %v, want %v", got, counts)
	}
	completion, err = f.database.WriteAuthorizations(ctx, pin)
	authorizationReceiverCommitted(t, completion, err)
	var complete bool
	if err := f.database.Pool.QueryRow(ctx, `SELECT to_jsonb(row)=($2::jsonb || jsonb_build_object('last_used_at',to_jsonb($3::timestamptz),'expires_at',to_jsonb($4::timestamptz))) FROM oauth_clients row WHERE id=$1`, f.client.ID, clientBefore, at, at.Add(7*24*time.Hour)).Scan(&complete); err != nil || !complete {
		t.Fatalf("pin retry did not persist only its touch: match=%t, error=%v", complete, err)
	}
}

func TestAuthorizationScopeRollsBackFamilyRevocation(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newAuthorizationReceiverFixture(t, "revocation-client", "approved")
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	consumed := f.authorization
	consumed.Status, consumed.GrantID, consumed.RetainUntil = "consumed", f.issue.Grant.ID, f.issue.Grant.ExpiresAt.Add(24*time.Hour)
	completion, err := f.database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		if err := scope.CredentialFamilyDAO().IssueFamily(ctx, f.issue); err != nil {
			return err
		}
		return scope.AuthorizationDAO().UpdateAuthorization(ctx, consumed)
	})
	authorizationReceiverCommitted(t, completion, err)
	before := authorizationReceiverRow(t, ctx, f.database, "oauth_authorizations", "id", consumed.ID)
	grantBefore := authorizationReceiverRow(t, ctx, f.database, "oauth_grants", "id", f.issue.Grant.ID)
	accessBefore := authorizationReceiverRow(t, ctx, f.database, "oauth_access_tokens", "id", f.issue.AccessID)
	refreshBefore := authorizationReceiverRow(t, ctx, f.database, "oauth_refresh_tokens", "token_hash", f.issue.RefreshHash)
	counts := authorizationReceiverCounts(t, ctx, f.database)
	refusal := errors.New("failure after actual family revocation")
	completion, err = f.database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		changed, err := scope.CredentialFamilyDAO().RevokeFamily(ctx, f.issue.Grant.ID, f.now)
		if err != nil {
			return err
		}
		if !changed {
			return errors.New("initial revocation did not change grant")
		}
		return refusal
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, refusal) {
		t.Fatalf("revocation failure completion=%+v, error=%v", completion, err)
	}
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_authorizations", "id", consumed.ID, before)
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_grants", "id", f.issue.Grant.ID, grantBefore)
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_access_tokens", "id", f.issue.AccessID, accessBefore)
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_refresh_tokens", "token_hash", f.issue.RefreshHash, refreshBefore)
	if got := authorizationReceiverCounts(t, ctx, f.database); got != counts {
		t.Fatalf("revocation rollback changed family counts: got %v, want %v", got, counts)
	}
	completion, err = f.database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		identity, err := scope.CredentialFamilyDAO().AuthenticateAccess(ctx, f.issue.AccessHash, []store.OAuthBinding{{Resource: f.issue.Grant.Resource, Scope: f.issue.Grant.Scope}}, f.now)
		if err != nil {
			return err
		}
		want := store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential, UserID: f.issue.Grant.UserID, CredentialID: f.issue.AccessID}, GrantID: f.issue.Grant.ID, ExpiresAt: f.issue.AccessExpiresAt}
		if identity != want {
			return fmt.Errorf("restored access identity=%+v, want %+v", identity, want)
		}
		return nil
	})
	authorizationReceiverCommitted(t, completion, err)
}

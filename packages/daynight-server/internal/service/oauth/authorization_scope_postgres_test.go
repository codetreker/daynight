package oauth

import (
	"context"
	"errors"
	"net/url"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestScopedAuthorizationPersistsApprovalAtomicallyAndRefreshUsesCurrentPolicy(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	database, err := postgres.Open(ctx, testsupport.ServiceDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	principal := testsupport.ServicePrincipal(t, database)
	now := time.Now().UTC().Truncate(time.Microsecond)
	binding := secret.Random(core.BindingPrefix)
	record := core.NewAuthorization(core.AuthorizationRequest{ID: uuid.NewString(), Binding: binding, ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Scope: core.Scope, Challenge: fixtureChallenge(), State: "state", StatePresent: true, Client: fixtureAuthorization("", now).Client}, now)
	completion, err := database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		inserted, err := scope.AuthorizationDAO().InsertAuthorization(ctx, record, 10000, now)
		if err == nil && !inserted {
			t.Fatal("authorization capacity unexpectedly exhausted")
		}
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("seed pending authorization: %+v %v", completion, err)
	}
	catalog := scopeCatalog(t)
	service, err := NewAuthorizationsWithScopes(database, &Clients{}, core.PublicAdmission{}, "https://server.example", catalog)
	if err != nil {
		t.Fatal(err)
	}
	read := func() store.OAuthAuthorization {
		t.Helper()
		var a store.OAuthAuthorization
		c, e := database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
			var e error
			a, e = scope.AuthorizationDAO().Authorization(ctx, record.ID, false)
			return e
		})
		if e != nil || c.Outcome != store.TransactionCommitted {
			t.Fatalf("read authorization: %+v %v", c, e)
		}
		return a
	}
	view, err := service.InspectV2(ctx, record.ID, binding, principal)
	if err != nil || view.Status != "pending" || view.CatalogRevision == nil || *view.CatalogRevision != catalog.CatalogRevision {
		t.Fatalf("old pending request could not resume: %+v %v", view, err)
	}
	input := ScopedDecisionInput{DecisionInput: DecisionInput{RequestID: record.ID, Binding: binding, ExpectedUserID: principal.UserID, Decision: "approve", Principal: principal}, CatalogRevision: "stale", Scopes: []scopepolicy.ScopeID{"task:write", "task:read"}}
	if _, err = service.Decide(ctx, input.DecisionInput); !errors.Is(err, core.ErrInvalidAuthorization) {
		t.Fatalf("old approval accepted: %v", err)
	}
	if _, err = service.DecideV2(ctx, input); err == nil {
		t.Fatal("stale catalog accepted")
	}
	input.CatalogRevision = catalog.CatalogRevision
	input.Scopes = nil
	if _, err = service.DecideV2(ctx, input); err == nil {
		t.Fatal("empty approval accepted")
	}
	if got := read(); got.Status != "pending" || got.ApprovedScopes != nil {
		t.Fatalf("refusal mutated pending request: %+v", got)
	}
	input.Scopes = []scopepolicy.ScopeID{"task:write", "task:read"}
	decided, err := service.DecideV2(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	callback, err := url.Parse(decided.RedirectURI)
	if err != nil {
		t.Fatal(err)
	}
	if callback.Query().Get("state") != "state" || callback.Query().Get("iss") != "https://server.example" {
		t.Fatal("callback bindings changed")
	}
	approved := read()
	selected := []scopepolicy.ScopeID{"task:read", "task:write"}
	if approved.Status != "approved" || !reflect.DeepEqual(approved.ApprovedScopes, selected) {
		t.Fatalf("approval not persisted: %+v", approved)
	}
	view, err = service.InspectV2(ctx, record.ID, binding, principal)
	if err != nil || view.Status != "approved" || view.CatalogRevision != nil {
		t.Fatalf("terminal inspection: %+v %v", view, err)
	}
	if _, err = service.DecideV2(ctx, input); !errors.Is(err, core.ErrInvalidAuthorization) {
		t.Fatalf("terminal approval accepted: %v", err)
	}
	redeem := fixtureRedeem()
	redeem.Code = callback.Query().Get("code")
	if _, err = database.Pool.Exec(ctx, `CREATE FUNCTION refuse_scoped_code_consumption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='consumed' THEN RAISE EXCEPTION 'injected authorization consumption failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_scoped_code_consumption BEFORE UPDATE ON oauth_authorizations FOR EACH ROW EXECUTE FUNCTION refuse_scoped_code_consumption()`); err != nil {
		t.Fatal(err)
	}
	failed, err := service.RedeemCode(ctx, redeem)
	if err == nil || failed.AccessToken != "" || failed.RefreshToken != "" {
		t.Fatalf("failed transaction exposed credentials: %+v %v", failed, err)
	}
	var grants int
	if err = database.Pool.QueryRow(ctx, `SELECT count(*) FROM oauth_grants WHERE user_id=$1`, principal.UserID).Scan(&grants); err != nil {
		t.Fatal(err)
	}
	if grants != 0 || read().Status != "approved" {
		t.Fatal("code consumption failure committed a partial grant")
	}
	if _, err = database.Pool.Exec(ctx, `DROP TRIGGER refuse_scoped_code_consumption ON oauth_authorizations; DROP FUNCTION refuse_scoped_code_consumption()`); err != nil {
		t.Fatal(err)
	}
	tokens, err := service.RedeemCode(ctx, redeem)
	if err != nil {
		t.Fatal(err)
	}
	consumed := read()
	if consumed.Status != "consumed" || consumed.GrantID == "" || tokens.Scope != core.Scope {
		t.Fatalf("code was not consumed once with original protocol: %+v %+v", consumed, tokens)
	}
	authenticate := func(token string, wantVersion int64, want []scopepolicy.ScopeID) {
		t.Helper()
		var policy core.AccessPolicy
		c, e := database.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
			var e error
			policy, e = core.AuthenticateAccessPolicy(ctx, scope.CredentialFamilyDAO().(store.OAuthScopeDAO), token, record.Resource, time.Now().UTC())
			return e
		})
		if e != nil || c.Outcome != store.TransactionCommitted || policy.GrantID != consumed.GrantID || policy.Authorization.Policy == nil || policy.Authorization.Policy.Version() != wantVersion || !reflect.DeepEqual(policy.Authorization.Policy.Scopes(), want) {
			t.Fatalf("current policy read: %+v %+v %v", policy, c, e)
		}
	}
	authenticate(tokens.AccessToken, 1, selected)
	reduced := []scopepolicy.ScopeID{"task:read"}
	completion, err = database.WriteGrantLifecycle(ctx, func(dao store.GrantLifecycleDAO) error {
		_, err := core.UpdateSessionGrantScope(ctx, dao, dao.(store.OAuthScopeDAO), principal, principal.UserID, consumed.GrantID, 1, reduced, time.Now().UTC())
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("edit policy: %+v %v", completion, err)
	}
	rotated, err := core.NewGrantLifecycle(database).Rotate(ctx, tokens.RefreshToken, record.ClientID, record.Resource, nil)
	if err != nil || rotated.Grant == nil || rotated.Grant.ID != consumed.GrantID || rotated.Grant.Scope != core.Scope {
		t.Fatalf("refresh protocol changed: %+v %v", rotated, err)
	}
	authenticate(tokens.AccessToken, 2, reduced)
	authenticate(rotated.AccessToken, 2, reduced)
	if _, err = service.RedeemCode(ctx, redeem); !errors.Is(err, core.ErrInvalidGrant) {
		t.Fatalf("code replay accepted: %v", err)
	}
	var identity core.AccessPolicy
	completion, err = database.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		var e error
		identity, e = core.AuthenticateAccessPolicy(ctx, scope.CredentialFamilyDAO().(store.OAuthScopeDAO), rotated.AccessToken, record.Resource, time.Now().UTC())
		return e
	})
	var fault *model.Fault
	if err == nil || !errors.As(err, &fault) || fault.Code != "unauthenticated" || completion.Outcome != store.TransactionNotCommitted || identity.GrantID != "" {
		t.Fatalf("replayed code did not revoke refreshed family: %+v %+v %v", identity, completion, err)
	}
}

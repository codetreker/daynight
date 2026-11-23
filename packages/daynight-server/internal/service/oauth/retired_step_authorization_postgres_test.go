package oauth

import (
	"context"
	"net/url"
	"reflect"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestRetiredStepOAuthApprovalSurvivesCatalogChange(t *testing.T) {
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
	record := core.NewAuthorization(core.AuthorizationRequest{ID: uuid.NewString(), Binding: binding, ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Scope: core.Scope, Challenge: fixtureChallenge(), Client: fixtureAuthorization("", now).Client}, now)
	completion, err := database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		inserted, err := scope.AuthorizationDAO().InsertAuthorization(ctx, record, 10000, now)
		if err == nil && !inserted {
			t.Fatal("authorization capacity unexpectedly exhausted")
		}
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("seed pending: %+v %v", completion, err)
	}
	old, err := scopepolicy.NewCatalogSnapshot(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read", "step:read", "step:write"})
	if err != nil {
		t.Fatal(err)
	}
	current, err := scopepolicy.NewCatalogSnapshot(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"})
	if err != nil {
		t.Fatal(err)
	}
	before, err := NewAuthorizationsWithScopes(database, &Clients{}, core.PublicAdmission{}, "https://server.example", old)
	if err != nil {
		t.Fatal(err)
	}
	after, err := NewAuthorizationsWithScopes(database, &Clients{}, core.PublicAdmission{}, "https://server.example", current)
	if err != nil {
		t.Fatal(err)
	}
	selected := []scopepolicy.ScopeID{"step:read", "step:write", "task:read"}
	pendingBinding := secret.Random(core.BindingPrefix)
	pending := core.NewAuthorization(core.AuthorizationRequest{ID: uuid.NewString(), Binding: pendingBinding, ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Scope: core.Scope, Challenge: fixtureChallenge(), Client: fixtureAuthorization("", now).Client}, now)
	completion, err = database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		inserted, err := scope.AuthorizationDAO().InsertAuthorization(ctx, pending, 10000, now)
		if err == nil && !inserted {
			t.Fatal("authorization capacity unexpectedly exhausted")
		}
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("seed second pending: %+v %v", completion, err)
	}
	view, err := after.InspectV2(ctx, pending.ID, pendingBinding, principal)
	if err != nil || view.Status != "pending" || view.CatalogRevision == nil || *view.CatalogRevision != current.CatalogRevision || old.CatalogRevision == current.CatalogRevision {
		t.Fatalf("pending inspection after switch: %+v %v", view, err)
	}
	pendingInput := ScopedDecisionInput{DecisionInput: DecisionInput{RequestID: pending.ID, Binding: pendingBinding, ExpectedUserID: principal.UserID, Decision: "approve", Principal: principal}, CatalogRevision: old.CatalogRevision, Scopes: selected}
	if _, err := after.DecideV2(ctx, pendingInput); err == nil {
		t.Fatal("old catalog revision accepted")
	}
	pendingInput.CatalogRevision = current.CatalogRevision
	if _, err := after.DecideV2(ctx, pendingInput); err == nil {
		t.Fatal("retired scopes accepted")
	}
	pendingInput.Scopes = []scopepolicy.ScopeID{"task:read"}
	if _, err := after.DecideV2(ctx, pendingInput); err != nil {
		t.Fatalf("current decision: %v", err)
	}
	decision, err := before.DecideV2(ctx, ScopedDecisionInput{DecisionInput: DecisionInput{RequestID: record.ID, Binding: binding, ExpectedUserID: principal.UserID, Decision: "approve", Principal: principal}, CatalogRevision: old.CatalogRevision, Scopes: selected})
	if err != nil {
		t.Fatal(err)
	}
	callback, err := url.Parse(decision.RedirectURI)
	if err != nil {
		t.Fatal(err)
	}
	redeem := fixtureRedeem()
	redeem.Code = callback.Query().Get("code")
	tokens, err := after.RedeemCode(ctx, redeem)
	if err != nil || tokens.AccessToken == "" {
		t.Fatalf("redemption after switch failed: %v", err)
	}
	var policy core.AccessPolicy
	completion, err = database.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		var e error
		policy, e = core.AuthenticateAccessPolicy(ctx, scope.CredentialFamilyDAO().(store.OAuthScopeDAO), tokens.AccessToken, record.Resource, time.Now().UTC())
		return e
	})
	if err != nil || completion.Outcome != store.TransactionCommitted || policy.GrantID == "" || policy.Authorization.Policy == nil || !reflect.DeepEqual(policy.Authorization.Policy.Scopes(), selected) {
		t.Fatalf("redeemed policy: %+v %+v %v", policy, completion, err)
	}
}

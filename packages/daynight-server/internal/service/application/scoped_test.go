package application

import (
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/credentialpolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
)

func TestScopedApplicationRetainsPolicySourcesAndSharedEngine(t *testing.T) {
	database, files := borrowedDependencies(t)
	const origin = "https://daynight.test"
	const callback = origin + "/callback"
	preview, err := identity.NewPreviewSSO(database, origin, "https://preview.daynight.test", callback)
	if err != nil {
		t.Fatal(err)
	}
	app, err := NewScoped(database, files, nil, callback, preview, time.Second, origin, []scopepolicy.ScopeID{"webhook:deliver"}, nil)
	if err != nil || app == nil || app.Scoped == nil {
		t.Fatalf("scoped assembly: app=%v error=%v", app, err)
	}
	verifySharedEngine(t, app)
	actual, ok := app.Identity.(*identity.Identity)
	if !ok || actual.CallbackURL() != callback || actual.PreviewSSO() != preview {
		t.Fatalf("scoped identity lost its callback or preview dependency: %v", app.Identity)
	}
	catalog, enabled := actual.DeviceScopeCatalog()
	if !enabled || !reflect.DeepEqual(catalog, app.Scoped.PATCatalog) {
		t.Fatal("identity does not use the published PAT catalog")
	}
	if app.Scoped.Credentials.Database != database || app.Scoped.Credentials.Origin != origin || !app.Workers.ScopesEnabled() || !app.Teams.ScopeProtected() {
		t.Fatal("scoped modules lost their shared policy source, origin or admission")
	}
	if app.Scoped.Attachments == nil || app.Scoped.Threads == nil || app.Scoped.Session == nil || app.Scoped.Observations != app.TaskObservations {
		t.Fatal("scoped application published incomplete or distinct protocol adapters")
	}
}

func TestRetiredStepScopesAreNotOfferedButRemainValidForEdits(t *testing.T) {
	for _, kind := range []scopepolicy.CredentialType{scopepolicy.PAT, scopepolicy.MCP} {
		t.Run(string(kind), func(t *testing.T) {
			entries, err := scopepolicy.Catalog(kind)
			if err != nil {
				t.Fatal(err)
			}
			var all []scopepolicy.ScopeID
			for _, entry := range entries {
				all = append(all, entry.ID)
			}
			old, err := scopepolicy.NewCatalogSnapshot(kind, all)
			if err != nil {
				t.Fatal(err)
			}
			current, err := availableCatalog(kind, nil)
			if err != nil {
				t.Fatal(err)
			}
			if old.CatalogRevision == current.CatalogRevision {
				t.Fatal("retirement did not change revision")
			}
			remaining := slices.DeleteFunc(slices.Clone(all), func(id scopepolicy.ScopeID) bool { return id == "step:read" || id == "step:write" })
			want, err := scopepolicy.NewCatalogSnapshot(kind, remaining)
			if err != nil || !reflect.DeepEqual(current, want) {
				t.Fatalf("other choices changed: %v", err)
			}
			for _, group := range current.Groups {
				if slices.Contains(group.ScopeIDs, "step:read") || slices.Contains(group.ScopeIDs, "step:write") {
					t.Fatal("retired scope offered")
				}
			}
			if slices.Contains(current.DefaultScopes, "step:read") || slices.Contains(current.DefaultScopes, "step:write") {
				t.Fatal("retired scope selected by default")
			}
			existing := []scopepolicy.ScopeID{"step:read", "step:write", "task:read"}
			if _, err := scopepolicy.NewPolicy(kind, existing, 1); err != nil {
				t.Fatalf("historical policy rejected: %v", err)
			}
			if _, err := current.ValidateSelection(kind, existing); err == nil {
				t.Fatal("new selection accepted retired scopes")
			}
			if _, err := current.ValidateEditSelection(kind, existing, existing); err != nil {
				t.Fatalf("retaining historical scopes: %v", err)
			}
			if _, err := current.ValidateEditSelection(kind, []scopepolicy.ScopeID{"task:read"}, existing); err != nil {
				t.Fatalf("removing historical scopes: %v", err)
			}
			if _, err := current.ValidateEditSelection(kind, existing, []scopepolicy.ScopeID{"task:read"}); err == nil {
				t.Fatal("re-added retired scopes")
			}
		})
	}
}

func TestScopedApplicationRejectsMissingWorkerPromptReader(t *testing.T) {
	app, err := NewScoped(nil, nil, nil, "https://daynight.test/callback", nil, time.Second, "https://daynight.test", nil, nil)
	if app != nil || err == nil || !strings.Contains(err.Error(), "worker prompt snapshot reader is required") {
		t.Fatalf("missing transaction dependency published a partial application: app=%v error=%v", app, err)
	}
}

func TestDeploymentCatalogOmitsUnavailableOperations(t *testing.T) {
	full, err := availableCatalog(scopepolicy.PAT, nil)
	if err != nil {
		t.Fatal(err)
	}
	trimmed, err := availableCatalog(scopepolicy.PAT, []scopepolicy.ScopeID{"webhook:deliver", "github:manage"})
	if err != nil {
		t.Fatal(err)
	}
	if full.CatalogRevision == trimmed.CatalogRevision {
		t.Fatal("availability does not change catalog revision")
	}
	for _, g := range trimmed.Groups {
		for _, id := range g.ScopeIDs {
			if id == "webhook:deliver" || id == "github:manage" {
				t.Fatal("unavailable operation offered")
			}
		}
	}
	for _, id := range trimmed.DefaultScopes {
		if id == "team:write" {
			t.Fatal("team mutation selected by default")
		}
	}
	mcp, err := availableCatalog(scopepolicy.MCP, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range mcp.DefaultScopes {
		if id == "worker:complete" {
			t.Fatal("worker execution selected by default")
		}
	}
	if _, err := availableCatalog("invalid", nil); err == nil {
		t.Fatal("unknown credential type accepted")
	}
}

func TestScopedBotAssemblyRejectsMissingSharedBroker(t *testing.T) {
	source := &credentialpolicy.Source{Origin: "https://daynight.test"}
	if got, err := newScopedBots(nil, nil, source); got != nil || err == nil || !strings.Contains(err.Error(), "requester authority is required") {
		t.Fatalf("missing producer broker published a Bot service: %v %v", got, err)
	}
}

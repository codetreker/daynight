package application

import (
	"reflect"
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

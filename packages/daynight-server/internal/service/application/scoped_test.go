package application

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"testing"
)

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

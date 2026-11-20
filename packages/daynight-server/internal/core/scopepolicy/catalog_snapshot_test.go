package scopepolicy

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestCatalogSnapshotUsesAvailableEntriesAndStableRevision(t *testing.T) {
	ids := []ScopeID{"team:write", "task:write", "team:read", "task:read"}
	catalog, err := NewCatalogSnapshot(PAT, ids)
	if err != nil {
		t.Fatal(err)
	}
	wantGroups := []CatalogGroup{{ID: "task", ScopeIDs: []ScopeID{"task:read", "task:write"}}, {ID: "team", ScopeIDs: []ScopeID{"team:read", "team:write"}}}
	if !reflect.DeepEqual(catalog.Groups, wantGroups) {
		t.Fatalf("groups = %#v", catalog.Groups)
	}
	if !reflect.DeepEqual(catalog.DefaultScopes, []ScopeID{"task:read", "task:write", "team:read"}) {
		t.Fatalf("defaults = %v", catalog.DefaultScopes)
	}
	reordered, err := NewCatalogSnapshot(PAT, []ScopeID{"task:read", "team:read", "task:write", "team:write"})
	if err != nil || reordered.CatalogRevision != catalog.CatalogRevision {
		t.Fatalf("reordered revision = %q, err = %v", reordered.CatalogRevision, err)
	}
	changed, err := NewCatalogSnapshot(PAT, ids[:3])
	if err != nil || changed.CatalogRevision == catalog.CatalogRevision {
		t.Fatalf("changed revision = %q, err = %v", changed.CatalogRevision, err)
	}
	encoded, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		CatalogRevision string         `json:"catalogRevision"`
		Groups          []CatalogGroup `json:"groups"`
		DefaultScopes   []ScopeID      `json:"defaultScopes"`
	}
	if err := json.Unmarshal(encoded, &response); err != nil || response.CatalogRevision != catalog.CatalogRevision || !reflect.DeepEqual(response.Groups, wantGroups) {
		t.Fatalf("response = %s, err = %v", encoded, err)
	}
}

func TestCatalogSnapshotSelection(t *testing.T) {
	catalog, err := NewCatalogSnapshot(PAT, []ScopeID{"task:read", "task:write"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := catalog.ValidateSelection(PAT, []ScopeID{"task:write", "task:read"})
	if err != nil || !reflect.DeepEqual(got, []ScopeID{"task:read", "task:write"}) {
		t.Fatalf("selection = %v, err = %v", got, err)
	}
	for _, ids := range [][]ScopeID{nil, {"task:read", "task:read"}, {"team:read"}, {"unknown"}} {
		if _, err := catalog.ValidateSelection(PAT, ids); err == nil {
			t.Errorf("accepted %v", ids)
		}
	}
	if _, err := catalog.ValidateSelection(MCP, []ScopeID{"task:read"}); err == nil {
		t.Error("accepted wrong credential type")
	}
	if _, err := NewCatalogSnapshot(PAT, []ScopeID{"task:read", "task:read"}); err == nil {
		t.Error("accepted duplicate available IDs")
	}
	if _, err := NewCatalogSnapshot(MCP, []ScopeID{"worker:claim"}); err == nil {
		t.Error("accepted inapplicable ID")
	}
	empty, err := NewCatalogSnapshot(PAT, nil)
	if err != nil || len(empty.Groups) != 0 || len(empty.DefaultScopes) != 0 {
		t.Fatalf("empty catalog = %#v, err = %v", empty, err)
	}
	if _, err := empty.ValidateSelection(PAT, []ScopeID{"task:read"}); err == nil {
		t.Error("empty catalog accepted scope")
	}
	mcp, err := NewCatalogSnapshot(MCP, []ScopeID{"worker:complete", "team:read", "team:write"})
	if err != nil || !reflect.DeepEqual(mcp.DefaultScopes, []ScopeID{"team:read"}) {
		t.Fatalf("MCP defaults = %v, err = %v", mcp.DefaultScopes, err)
	}
}

func TestCatalogSnapshotCloneAndMutation(t *testing.T) {
	original, err := NewCatalogSnapshot(PAT, []ScopeID{"task:read", "task:write"})
	if err != nil {
		t.Fatal(err)
	}
	copy := original.Clone()
	copy.Groups[0].ScopeIDs[0] = "team:read"
	copy.DefaultScopes[0] = "team:read"
	if _, err := copy.ValidateSelection(PAT, []ScopeID{"team:read"}); err == nil {
		t.Fatal("accepted changed catalog under old revision")
	}
	if _, err := original.ValidateSelection(PAT, []ScopeID{"task:read"}); err != nil {
		t.Fatalf("clone changed original: %v", err)
	}
}

package scopepolicy

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

func ids(entries []Entry) []ScopeID {
	out := make([]ScopeID, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.ID)
	}
	return out
}

func TestCatalogDefaultsAndApplicability(t *testing.T) {
	for _, kind := range []CredentialType{PAT, MCP} {
		entries, err := Catalog(kind)
		if err != nil {
			t.Fatal(err)
		}
		seen := map[ScopeID]bool{}
		for _, e := range entries {
			if e.ID == "" || e.Group == "" || e.LabelKey == "" || seen[e.ID] {
				t.Fatalf("invalid entry: %+v", e)
			}
			seen[e.ID] = true
		}
		selected, err := Defaults(kind, ids(entries))
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			want := e.Group != "team" || e.ID == "team:read"
			if kind == MCP && e.Group == "worker-execution" {
				want = false
			}
			if slices.Contains(selected, e.ID) != want {
				t.Errorf("%s default %s", kind, e.ID)
			}
		}
		if !slices.Contains(selected, ScopeID("agent:authorize")) {
			t.Fatal("agent authorization not selected")
		}
		if kind == MCP && (!seen["worker:complete"] || seen["worker:claim"] || seen["worker:read"] || seen["session:control"]) {
			t.Fatalf("incorrect MCP applicability: %v", seen)
		}
		entries[0].ID = "changed"
		again, _ := Catalog(kind)
		if again[0].ID == "changed" {
			t.Fatal("catalog leaked mutable storage")
		}
	}
	if _, err := Catalog("unknown"); err == nil {
		t.Fatal("accepted unknown type")
	}
	if v, err := Defaults(PAT, nil); err != nil || len(v) != 0 {
		t.Fatalf("empty available: %v %v", v, err)
	}
	if _, err := Defaults(MCP, []ScopeID{"worker:claim"}); err == nil {
		t.Fatal("accepted inapplicable scope")
	}
}

func TestNormalizeAndPersistedPolicy(t *testing.T) {
	for _, tc := range []struct {
		kind CredentialType
		ids  []ScopeID
	}{{PAT, nil}, {PAT, []ScopeID{"task:read", "task:read"}}, {PAT, []ScopeID{"bad"}}, {MCP, []ScopeID{"worker:claim"}}, {"unknown", []ScopeID{"task:read"}}} {
		if _, err := Normalize(tc.kind, tc.ids); err == nil {
			t.Fatalf("accepted %+v", tc)
		}
	}
	original := []ScopeID{"task:write", "task:read"}
	normalized, err := Normalize(PAT, original)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(normalized, []ScopeID{"task:read", "task:write"}) || original[0] != "task:write" {
		t.Fatal("normalization or ownership")
	}
	if _, err := NewPolicy(PAT, original, 1); err == nil {
		t.Fatal("accepted noncanonical persisted set")
	}
	if _, err := NewPolicy(PAT, normalized, 0); err == nil {
		t.Fatal("accepted invalid version")
	}
	p, err := NewPolicy(PAT, normalized, 7)
	if err != nil {
		t.Fatal(err)
	}
	normalized[0] = "bad"
	copy := p.Scopes()
	copy[0] = "bad"
	if p.Kind() != PAT || p.Version() != 7 || !slices.Equal(p.Scopes(), []ScopeID{"task:read", "task:write"}) {
		t.Fatal("snapshot was mutated")
	}
	if err := (Policy{}).Require("task:read"); err == nil {
		t.Fatal("zero policy allowed")
	}
	if err := p.Require(); err == nil {
		t.Fatal("empty requirement allowed")
	}
}

func TestCombinedRequirementsAndSavedScopeOnCatalogGrowth(t *testing.T) {
	requirements, err := Requirements(TaskWrite, AgentAuthorize, TaskWrite)
	if err != nil {
		t.Fatal(err)
	}
	p, err := NewPolicy(PAT, []ScopeID{"task:write"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Require(requirements...); !errors.Is(err, ErrInsufficientScope) {
		t.Fatalf("combined operation: %v", err)
	}
	p, err = NewPolicy(PAT, []ScopeID{"agent:authorize", "task:write"}, 2)
	if err != nil || p.Require(requirements...) != nil {
		t.Fatal("complete combination denied")
	}
	if _, err := Requirements("unknown"); err == nil {
		t.Fatal("unknown operation accepted")
	}
	if _, err := Requirements(); err == nil {
		t.Fatal("empty operation accepted")
	}
	old := catalog
	catalog = append(slices.Clone(catalog), Entry{ID: "task:new", Group: "task", LabelKey: "task:new", PAT: true, MCP: true})
	defer func() { catalog = old }()
	available, _ := Catalog(PAT)
	selected, err := Defaults(PAT, ids(available))
	if err != nil || !slices.Contains(selected, ScopeID("task:new")) {
		t.Fatal("new scope not offered")
	}
	if err := p.Require("task:new"); !errors.Is(err, ErrInsufficientScope) {
		t.Fatal("saved policy gained new scope")
	}
}

func TestEveryCatalogScopeHasOperation(t *testing.T) {
	for _, e := range catalog {
		op := Operation(strings.Replace(string(e.ID), ":", ".", 1))
		got, err := Requirements(op)
		if err != nil || len(got) != 1 || got[0] != e.ID {
			t.Fatalf("operation for %s: %v %v", e.ID, got, err)
		}
	}
}

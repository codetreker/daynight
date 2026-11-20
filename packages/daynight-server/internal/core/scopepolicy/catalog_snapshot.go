package scopepolicy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// CatalogGroup contains the currently available entries in display order.
type CatalogGroup struct {
	ID       string    `json:"id"`
	ScopeIDs []ScopeID `json:"scopeIds"`
}

// CatalogSnapshot is a deployment's available choices and their defaults.
// Its revision covers the ordered groups and defaults, not future catalog entries.
type CatalogSnapshot struct {
	CatalogRevision string         `json:"catalogRevision"`
	Groups          []CatalogGroup `json:"groups"`
	DefaultScopes   []ScopeID      `json:"defaultScopes"`
	kind            CredentialType
}

// NewCatalogSnapshot selects only explicitly available IDs. An empty selection
// creates an empty catalog; it never grants all registered permissions.
func NewCatalogSnapshot(kind CredentialType, available []ScopeID) (CatalogSnapshot, error) {
	entries, err := Catalog(kind)
	if err != nil {
		return CatalogSnapshot{}, err
	}
	if len(available) > 0 {
		if _, err := Normalize(kind, available); err != nil {
			return CatalogSnapshot{}, err
		}
	}
	allowed := make(map[ScopeID]bool, len(available))
	for _, id := range available {
		allowed[id] = true
	}
	groups := make([]CatalogGroup, 0)
	for _, entry := range entries {
		if !allowed[entry.ID] {
			continue
		}
		if len(groups) == 0 || groups[len(groups)-1].ID != entry.Group {
			groups = append(groups, CatalogGroup{ID: entry.Group, ScopeIDs: []ScopeID{}})
		}
		last := &groups[len(groups)-1]
		last.ScopeIDs = append(last.ScopeIDs, entry.ID)
	}
	defaults, err := Defaults(kind, available)
	if err != nil {
		return CatalogSnapshot{}, err
	}
	revision, err := catalogRevision(groups, defaults)
	if err != nil {
		return CatalogSnapshot{}, err
	}
	return CatalogSnapshot{CatalogRevision: revision, Groups: groups, DefaultScopes: defaults, kind: kind}, nil
}

func catalogRevision(groups []CatalogGroup, defaults []ScopeID) (string, error) {
	payload, err := json.Marshal(struct {
		Groups   []CatalogGroup `json:"groups"`
		Defaults []ScopeID      `json:"defaultScopes"`
	}{groups, defaults})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}

// Clone keeps the catalog owned by its consumer independent of caller slices.
func (c CatalogSnapshot) Clone() CatalogSnapshot {
	result := c
	result.Groups = make([]CatalogGroup, len(c.Groups))
	for i, group := range c.Groups {
		result.Groups[i] = CatalogGroup{ID: group.ID, ScopeIDs: append([]ScopeID{}, group.ScopeIDs...)}
	}
	result.DefaultScopes = append([]ScopeID{}, c.DefaultScopes...)
	return result
}

// ValidateSelection checks a new selection against this snapshot and returns a
// normalized independent set. Saved unavailable entries must be handled by the
// editing operation, which has the existing policy as additional input.
func (c CatalogSnapshot) ValidateSelection(kind CredentialType, ids []ScopeID) ([]ScopeID, error) {
	if c.kind != kind || c.CatalogRevision == "" {
		return nil, fmt.Errorf("catalog does not match credential type %q", kind)
	}
	revision, err := catalogRevision(c.Groups, c.DefaultScopes)
	if err != nil || revision != c.CatalogRevision {
		return nil, fmt.Errorf("catalog contents do not match revision")
	}
	normalized, err := Normalize(kind, ids)
	if err != nil {
		return nil, err
	}
	available := make(map[ScopeID]bool)
	for _, group := range c.Groups {
		for _, id := range group.ScopeIDs {
			available[id] = true
		}
	}
	for _, id := range normalized {
		if !available[id] {
			return nil, fmt.Errorf("scope %q is unavailable", id)
		}
	}
	return normalized, nil
}

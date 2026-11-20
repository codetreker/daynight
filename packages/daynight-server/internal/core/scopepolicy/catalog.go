// Package scopepolicy defines the internal business-scope catalog and admission rules.
// It does not replace credential validity, resource authorization, or profile binding.
package scopepolicy

import (
	"fmt"
	"sort"
)

type ScopeID string
type CredentialType string

const (
	PAT CredentialType = "pat"
	MCP CredentialType = "mcp"
)

// Entry has stable identifiers and display order. LabelKey is interpreted by the UI.
type Entry struct {
	ID       ScopeID
	Group    string
	LabelKey string
	PAT      bool
	MCP      bool
}

// catalog order is the display order, independent of the canonical set order.
var catalog = []Entry{
	{ID: "task:read", Group: "task", LabelKey: "task:read", PAT: true, MCP: true},
	{ID: "task:write", Group: "task", LabelKey: "task:write", PAT: true, MCP: true},
	{ID: "task:assign", Group: "task", LabelKey: "task:assign", PAT: true, MCP: true},
	{ID: "task:dependencies", Group: "task", LabelKey: "task:dependencies", PAT: true, MCP: true},
	{ID: "task:status", Group: "task", LabelKey: "task:status", PAT: true, MCP: true},
	{ID: "task:delete", Group: "task", LabelKey: "task:delete", PAT: true, MCP: true},
	{ID: "step:read", Group: "step", LabelKey: "step:read", PAT: true, MCP: true},
	{ID: "step:write", Group: "step", LabelKey: "step:write", PAT: true, MCP: true},
	{ID: "thread:read", Group: "thread", LabelKey: "thread:read", PAT: true, MCP: true},
	{ID: "thread:post", Group: "thread", LabelKey: "thread:post", PAT: true, MCP: true},
	{ID: "attachment:read", Group: "attachment", LabelKey: "attachment:read", PAT: true, MCP: true},
	{ID: "attachment:upload", Group: "attachment", LabelKey: "attachment:upload", PAT: true, MCP: true},
	{ID: "attachment:delete", Group: "attachment", LabelKey: "attachment:delete", PAT: true, MCP: true},
	{ID: "agent:authorize", Group: "agent", LabelKey: "agent:authorize", PAT: true, MCP: true},
	{ID: "worker:claim", Group: "worker-execution", LabelKey: "worker:claim", PAT: true, MCP: false},
	{ID: "worker:release", Group: "worker-execution", LabelKey: "worker:release", PAT: true, MCP: false},
	{ID: "worker:complete", Group: "worker-execution", LabelKey: "worker:complete", PAT: true, MCP: true},
	{ID: "worker:retry", Group: "worker-execution", LabelKey: "worker:retry", PAT: true, MCP: false},
	{ID: "worker:recover", Group: "worker-execution", LabelKey: "worker:recover", PAT: true, MCP: false},
	{ID: "worker:report", Group: "worker-execution", LabelKey: "worker:report", PAT: true, MCP: false},
	{ID: "worker:read", Group: "worker-management", LabelKey: "worker:read", PAT: true, MCP: false},
	{ID: "worker:configure", Group: "worker-management", LabelKey: "worker:configure", PAT: true, MCP: false},
	{ID: "worker:inspect", Group: "worker-management", LabelKey: "worker:inspect", PAT: true, MCP: false},
	{ID: "session:read", Group: "session", LabelKey: "session:read", PAT: true, MCP: true},
	{ID: "session:send", Group: "session", LabelKey: "session:send", PAT: true, MCP: true},
	{ID: "session:control", Group: "session", LabelKey: "session:control", PAT: true, MCP: false},
	{ID: "session:produce", Group: "session", LabelKey: "session:produce", PAT: true, MCP: false},
	{ID: "session:delete", Group: "session", LabelKey: "session:delete", PAT: true, MCP: false},
	{ID: "project:read", Group: "project", LabelKey: "project:read", PAT: true, MCP: true},
	{ID: "project:write", Group: "project", LabelKey: "project:write", PAT: true, MCP: true},
	{ID: "project:members", Group: "project", LabelKey: "project:members", PAT: true, MCP: false},
	{ID: "project:invitations", Group: "project", LabelKey: "project:invitations", PAT: true, MCP: false},
	{ID: "project:invitation-read", Group: "project", LabelKey: "project:invitation-read", PAT: true, MCP: true},
	{ID: "project:invitation-accept", Group: "project", LabelKey: "project:invitation-accept", PAT: true, MCP: true},
	{ID: "project:repository", Group: "project", LabelKey: "project:repository", PAT: true, MCP: true},
	{ID: "project:transfer", Group: "project", LabelKey: "project:transfer", PAT: true, MCP: true},
	{ID: "project:delete", Group: "project", LabelKey: "project:delete", PAT: true, MCP: false},
	{ID: "team:read", Group: "team", LabelKey: "team:read", PAT: true, MCP: true},
	{ID: "team:write", Group: "team", LabelKey: "team:write", PAT: true, MCP: true},
	{ID: "team:members", Group: "team", LabelKey: "team:members", PAT: true, MCP: true},
	{ID: "team:invitations", Group: "team", LabelKey: "team:invitations", PAT: true, MCP: true},
	{ID: "team:invitation-read", Group: "team", LabelKey: "team:invitation-read", PAT: true, MCP: true},
	{ID: "team:invitation-accept", Group: "team", LabelKey: "team:invitation-accept", PAT: true, MCP: true},
	{ID: "team:leave", Group: "team", LabelKey: "team:leave", PAT: true, MCP: true},
	{ID: "team:delete", Group: "team", LabelKey: "team:delete", PAT: true, MCP: true},
	{ID: "tag:read", Group: "tag", LabelKey: "tag:read", PAT: true, MCP: true},
	{ID: "tag:write", Group: "tag", LabelKey: "tag:write", PAT: true, MCP: true},
	{ID: "tag:delete", Group: "tag", LabelKey: "tag:delete", PAT: true, MCP: true},
	{ID: "bot:read", Group: "bot", LabelKey: "bot:read", PAT: true, MCP: true},
	{ID: "bot:write", Group: "bot", LabelKey: "bot:write", PAT: true, MCP: true},
	{ID: "bot:delete", Group: "bot", LabelKey: "bot:delete", PAT: true, MCP: true},
	{ID: "assistant-task:read", Group: "assistant-task", LabelKey: "assistant-task:read", PAT: true, MCP: false},
	{ID: "assistant-task:write", Group: "assistant-task", LabelKey: "assistant-task:write", PAT: true, MCP: false},
	{ID: "assistant-task:operate", Group: "assistant-task", LabelKey: "assistant-task:operate", PAT: true, MCP: false},
	{ID: "assistant-task:delete", Group: "assistant-task", LabelKey: "assistant-task:delete", PAT: true, MCP: false},
	{ID: "assistant-task:inbox", Group: "assistant-task", LabelKey: "assistant-task:inbox", PAT: true, MCP: false},
	{ID: "webhook:read", Group: "webhook", LabelKey: "webhook:read", PAT: true, MCP: false},
	{ID: "webhook:write", Group: "webhook", LabelKey: "webhook:write", PAT: true, MCP: false},
	{ID: "webhook:delete", Group: "webhook", LabelKey: "webhook:delete", PAT: true, MCP: false},
	{ID: "webhook:secret", Group: "webhook", LabelKey: "webhook:secret", PAT: true, MCP: false},
	{ID: "webhook:deliver", Group: "webhook", LabelKey: "webhook:deliver", PAT: true, MCP: false},
	{ID: "account:write", Group: "account", LabelKey: "account:write", PAT: true, MCP: false},
	{ID: "prompt:read", Group: "prompt", LabelKey: "prompt:read", PAT: true, MCP: false},
	{ID: "prompt:write", Group: "prompt", LabelKey: "prompt:write", PAT: true, MCP: false},
	{ID: "usage:read", Group: "usage", LabelKey: "usage:read", PAT: true, MCP: false},
	{ID: "github:read", Group: "github", LabelKey: "github:read", PAT: true, MCP: false},
	{ID: "github:manage", Group: "github", LabelKey: "github:manage", PAT: true, MCP: false},
}

// Catalog returns a copy. Entries unsupported by the credential type are omitted.
func Catalog(kind CredentialType) ([]Entry, error) {
	if kind != PAT && kind != MCP {
		return nil, fmt.Errorf("invalid credential type %q", kind)
	}
	entries := make([]Entry, 0, len(catalog))
	for _, e := range catalog {
		if kind == PAT && e.PAT || kind == MCP && e.MCP {
			entries = append(entries, e)
		}
	}
	return entries, nil
}

// Normalize validates explicit choices and returns an independent, sorted set.
// Approval and editing require at least one choice. No group or wildcard is stored.
func Normalize(kind CredentialType, ids []ScopeID) ([]ScopeID, error) {
	entries, err := Catalog(kind)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("at least one scope is required")
	}
	valid := make(map[ScopeID]bool, len(entries))
	for _, e := range entries {
		valid[e.ID] = true
	}
	seen := make(map[ScopeID]bool, len(ids))
	out := make([]ScopeID, 0, len(ids))
	for _, id := range ids {
		if !valid[id] {
			return nil, fmt.Errorf("invalid scope %q for %s", id, kind)
		}
		if seen[id] {
			return nil, fmt.Errorf("duplicate scope %q", id)
		}
		seen[id] = true
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}

// Defaults selects from the supplied currently available IDs, not the whole catalog.
// The result is a snapshot: future catalog additions do not alter it.
func Defaults(kind CredentialType, available []ScopeID) ([]ScopeID, error) {
	if _, err := Catalog(kind); err != nil {
		return nil, err
	}
	if len(available) == 0 {
		return []ScopeID{}, nil
	}
	ids, err := Normalize(kind, available)
	if err != nil {
		return nil, err
	}
	entries, _ := Catalog(kind)
	groups := make(map[ScopeID]string, len(entries))
	for _, e := range entries {
		groups[e.ID] = e.Group
	}
	selected := make([]ScopeID, 0, len(ids))
	for _, id := range ids {
		if groups[id] == "team" && id != "team:read" || kind == MCP && groups[id] == "worker-execution" {
			continue
		}
		selected = append(selected, id)
	}
	return selected, nil
}

package scopepolicy

import (
	"slices"
	"testing"
)

func TestWebhookAvailability(t *testing.T) {
	full, err := Catalog(PAT)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name         string
		capabilities WebhookCapabilities
		want         []ScopeID
	}{
		{"unmounted", WebhookCapabilities{}, nil},
		{"unmounted with runtime", WebhookCapabilities{ConfigurationExpansion: true, Dispatch: true}, nil},
		{"management only", WebhookCapabilities{Management: true}, []ScopeID{"webhook:read", "webhook:write", "webhook:delete", "webhook:secret"}},
		{"expansion only", WebhookCapabilities{Management: true, ConfigurationExpansion: true}, []ScopeID{"webhook:read", "webhook:write", "webhook:delete", "webhook:secret", "webhook:deliver"}},
		{"dispatch only", WebhookCapabilities{Management: true, Dispatch: true}, []ScopeID{"webhook:read", "webhook:write", "webhook:delete", "webhook:secret", "webhook:deliver"}},
		{"all", WebhookCapabilities{Management: true, ConfigurationExpansion: true, Dispatch: true}, []ScopeID{"webhook:read", "webhook:write", "webhook:delete", "webhook:secret", "webhook:deliver"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			filtered := FilterWebhookAvailability(full, tc.capabilities)
			var got []ScopeID
			for _, entry := range filtered {
				if entry.Group == "webhook" {
					got = append(got, entry.ID)
				}
			}
			if !slices.Equal(got, tc.want) {
				t.Fatalf("webhook scopes = %v, want %v", got, tc.want)
			}
			for _, entry := range full {
				if entry.Group != "webhook" && !slices.Contains(filtered, entry) {
					t.Fatalf("unrelated scope %s removed", entry.ID)
				}
			}
			defaults, err := Defaults(PAT, ids(filtered))
			if err != nil {
				t.Fatal(err)
			}
			if slices.Contains(defaults, ScopeID("webhook:deliver")) != slices.Contains(tc.want, ScopeID("webhook:deliver")) {
				t.Fatalf("defaults = %v", defaults)
			}
		})
	}
	if !slices.Contains(ids(full), ScopeID("webhook:deliver")) {
		t.Fatal("filter changed the registry")
	}
	if _, err := NewPolicy(PAT, []ScopeID{"webhook:deliver"}, 1); err != nil {
		t.Fatalf("unavailable saved scope became invalid: %v", err)
	}
	mcp, err := Catalog(MCP)
	if err != nil {
		t.Fatal(err)
	}
	if got := FilterWebhookAvailability(mcp, WebhookCapabilities{Management: true, ConfigurationExpansion: true, Dispatch: true}); !slices.Equal(got, mcp) {
		t.Fatal("filter added Webhook to MCP")
	}
}

package mcp

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
)

func TestUnclassifiedBotToolsRemainClosedAlongsideScopedProject(t *testing.T) {
	for _, order := range []string{"bot first", "authentication first"} {
		t.Run(order, func(t *testing.T) {
			f := newEntryFixture(t)
			bots := &fakeBotOperations{bot: sampleBot()}
			deletions := &fakeBotDeletion{bot: sampleBot()}
			auth := testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"all": scopedTestAuthorization(t, "bot:delete", "bot:read", "bot:write", "project:read")}}
			if order == "bot first" {
				if err := RegisterBotTools(f.entry, bots, deletions); err != nil {
					t.Fatal(err)
				}
			}
			if err := f.entry.EnableScopedAuthentication(auth); err != nil {
				t.Fatal(err)
			}
			if order == "authentication first" {
				if err := RegisterBotTools(f.entry, bots, deletions); err != nil {
					t.Fatal(err)
				}
			}
			if err := RegisterBotTools(f.entry, &fakeBotOperations{}, &fakeBotDeletion{}); err == nil {
				t.Fatal("duplicate Bot tools accepted")
			}
			if err := RegisterScopedProjectTools(f.entry, &scopedProjectFixture{visible: true}, &identityservice.Identity{}, "https://daynight.test"); err != nil {
				t.Fatal(err)
			}
			c := &structClient{t: t, client: f.client(t, "2026-07-28", "all")}
			c.call("project_list", map[string]any{}, false)
			for _, tc := range []struct {
				name  string
				args  map[string]any
				write bool
			}{
				{"bot_list", map[string]any{}, false},
				{"bot_show", map[string]any{"botId": botTestID}, false},
				{"bot_create", map[string]any{"name": "new"}, true},
				{"bot_delete", map[string]any{"botId": botTestID, "ifVersion": "1"}, true},
			} {
				v := c.call(tc.name, tc.args, true)
				e := object(t, v["error"])
				if e["code"] != "forbidden" || v["data"] != nil || tc.write && e["writeOutcome"] != "not_committed" {
					t.Fatalf("%s was not closed: %#v", tc.name, v)
				}
			}
			if bots.createCalls != 0 || bots.listCalls != 0 || bots.readCalls != 0 || deletions.calls != 0 {
				t.Fatal("unclassified Bot service was called")
			}
			auth.policies["all"] = scopedTestAuthorization(t, "bot:read")
			v := c.call("project_list", map[string]any{}, true)
			if object(t, v["error"])["code"] != "insufficient_scope" {
				t.Fatalf("project policy was not refreshed: %#v", v)
			}
			v = c.call("bot_list", map[string]any{}, true)
			if object(t, v["error"])["code"] != "forbidden" || bots.listCalls != 0 {
				t.Fatalf("unclassified Bot opened after policy change: %#v", v)
			}
		})
	}
}

func TestLegacyBotRegistrationWorksWithoutScopedAuthentication(t *testing.T) {
	f := newEntryFixture(t)
	bots := &fakeBotOperations{bot: sampleBot()}
	deletions := &fakeBotDeletion{bot: sampleBot()}
	if err := RegisterBotTools(f.entry, bots, deletions); err != nil {
		t.Fatal(err)
	}
	c := &structClient{t: t, client: f.client(t, "2026-07-28", "alice")}
	v := c.call("bot_show", map[string]any{"botId": botTestID}, false)
	if object(t, v["data"])["id"] != botTestID || bots.readCalls != 1 || bots.principal.UserID != "alice" {
		t.Fatalf("legacy Bot result: %#v, calls=%d", v, bots.readCalls)
	}
}

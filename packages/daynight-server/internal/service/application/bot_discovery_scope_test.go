package application

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

func TestScopedBotCreationUsesInternalDiscoveryAuthority(t *testing.T) {
	_, db, _, owner := testsupport.ProjectService(t)
	app, err := NewScoped(db, nil, nil, "", nil, time.Second, "https://daynight.test", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer app.WorkerReadOnly.Close()
	t.Cleanup(func() {
		if err := app.Engine.Stop(t.Context()); err != nil {
			t.Error(err)
		}
	})
	newPAT := func(t *testing.T, ids ...scopepolicy.ScopeID) model.Principal {
		t.Helper()
		ids, err := scopepolicy.Normalize(scopepolicy.PAT, ids)
		if err != nil {
			t.Fatal(err)
		}
		policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
		if err != nil {
			t.Fatal(err)
		}
		p := model.Principal{Kind: model.PATCredential, UserID: owner.UserID, CredentialID: uuid.NewString()}
		hash := sha256.Sum256([]byte(p.CredentialID))
		_, err = db.WriteIdentity(t.Context(), func(s store.IdentityScope) error {
			return s.IdentityDAO().InsertPAT(t.Context(), model.PersonalAccessToken{ID: p.CredentialID, UserID: p.UserID, TokenHash: hash[:], Name: "Bot discovery", CreatedAt: time.Now(), ScopePolicy: &policy})
		})
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	producer := newPAT(t, "worker:report")
	workerID := uuid.NewString()
	telemetry := `{"platform":"linux","machine":{"id":"host","name":"host"},"assistantHost":{"creationConfigurationVersion":1,"protocolVersion":1,"observedAt":"2026-11-07T00:00:00Z","defaultCwd":"/work","defaultProvider":"codex","providers":[{"provider":"codex","available":true,"reason":null,"model":null,"args":[]}]}}`
	telemetry = strings.ReplaceAll(telemetry, "2026-11-07T00:00:00Z", time.Now().UTC().Format(time.RFC3339Nano))
	if _, err = db.Pool.Exec(t.Context(), `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,clock_timestamp(),clock_timestamp(),$3::jsonb,'{"state":"unavailable","items":[]}')`, owner.UserID, workerID, telemetry); err != nil {
		t.Fatal(err)
	}
	connection, err := app.WorkerReadOnly.Connect(t.Context(), producer, workerID, ro.Hello{Type: "hello", Protocol: ro.Protocol, CapabilityGeneration: uuid.NewString(), Operations: []string{"model.list"}})
	if err != nil {
		t.Fatal(err)
	}
	selected, effort := "model-a", "low"
	for _, tc := range []struct {
		mcp               bool
		name              string
		overrides         model.BotOverrides
		preference        bool
		removed           string
		revoke, attention bool
		pages             int
	}{
		{name: "MCP explicit model", mcp: true, overrides: model.BotOverrides{Model: &selected}, pages: 1},
		{name: "explicit model", overrides: model.BotOverrides{Model: &selected}, pages: 1},
		{name: "explicit reasoning", overrides: model.BotOverrides{ReasoningEffort: &effort}, pages: 1},
		{name: "stored preferences", preference: true, pages: 2},
		{name: "bot write removed during discovery", removed: "bot:write", pages: 1},
		{name: "bot read removed during discovery", removed: "bot:read", pages: 1},
		{name: "session read removed during discovery", removed: "session:read", pages: 1},
		{name: "credential revoked during discovery", revoke: true, pages: 1},
		{name: "attention removed during producer delivery", removed: "assistant-task:read", attention: true, pages: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, table := range []string{"bot_worker_preferences", "bot_configuration_preferences", "bot_model_preferences", "bot_effort_preferences"} {
				if _, err := db.Pool.Exec(t.Context(), "DELETE FROM "+table+" WHERE user_id=$1", owner.UserID); err != nil {
					t.Fatal(err)
				}
			}

			scopes := []scopepolicy.ScopeID{"bot:read", "bot:write", "session:read"}
			if tc.attention {
				scopes = append(scopes, "assistant-task:read")
			}
			actor := newPAT(t, scopes...)
			if tc.mcp {
				actor.Kind = model.OAuthCredential
				actor.CredentialID = uuid.NewString()
				canonical, err := scopepolicy.Normalize(scopepolicy.MCP, scopes)
				if err != nil {
					t.Fatal(err)
				}
				policy, err := scopepolicy.NewPolicy(scopepolicy.MCP, canonical, 1)
				if err != nil {
					t.Fatal(err)
				}
				now := time.Now()
				grantID := uuid.NewString()
				hash := sha256.Sum256([]byte(actor.CredentialID))
				refresh := sha256.Sum256([]byte(grantID))
				_, err = db.WriteCredentialFamily(t.Context(), func(sc store.CredentialFamilyScope) error {
					return sc.CredentialFamilyDAO().IssueFamily(t.Context(), store.OAuthFamilyIssue{Grant: store.OAuthGrant{ID: grantID, UserID: actor.UserID, ClientID: "client", ClientSnapshot: []byte(`{}`), Resource: "https://daynight.test/mcp", Scope: "daynight:mcp", CreatedAt: now, ExpiresAt: now.Add(time.Hour), ScopePolicy: &policy}, AccessID: actor.CredentialID, AccessHash: hash[:], RefreshHash: refresh[:], AccessExpiresAt: now.Add(time.Hour)})
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			if tc.preference {
				if _, err := db.Pool.Exec(t.Context(), `INSERT INTO bot_model_preferences(user_id,worker_id,provider,model,creation_order) VALUES($1,$2,'codex','model-a',1) ON CONFLICT(user_id,worker_id,provider) DO UPDATE SET model='model-a'`, owner.UserID, workerID); err != nil {
					t.Fatal(err)
				}
				if _, err := db.Pool.Exec(t.Context(), `INSERT INTO bot_effort_preferences(user_id,worker_id,provider,model,reasoning_effort,creation_order) VALUES($1,$2,'codex','model-a','low',1) ON CONFLICT(user_id,worker_id,provider,model) DO UPDATE SET reasoning_effort='low'`, owner.UserID, workerID); err != nil {
					t.Fatal(err)
				}
			}
			if tc.removed != "" || tc.revoke || tc.attention {
				tc.overrides.Model = &selected
			}
			request := botcore.CreateBot{ID: uuid.NewString(), Name: "Native selection", Overrides: tc.overrides}
			ctx := t.Context()
			if tc.attention {
				ctx = botcore.WithAttentionProjection(ctx)
			}
			type outcome struct {
				bot model.Bot
				err error
			}
			done := make(chan outcome, 1)
			go func() { got, err := app.Bots.CreateResolved(ctx, actor, request); done <- outcome{got, err} }()
			for page := 0; page < tc.pages; page++ {
				var message ro.Message
				select {
				case message = <-connection.Messages:
				case got := <-done:
					t.Fatalf("creation ended before discovery: %+v %v", got.bot, got.err)
				case <-time.After(5 * time.Second):
					t.Fatal("model discovery was not dispatched")
				}
				if message.Type != "request" || message.Operation != "model.list" {
					t.Fatalf("unexpected Worker message: %+v", message)
				}
				if tc.revoke {
					if _, err := db.Pool.Exec(t.Context(), `DELETE FROM personal_access_tokens WHERE id=$1`, actor.CredentialID); err != nil {
						t.Fatal(err)
					}
				} else if tc.removed != "" {
					remaining := []string{}
					for _, id := range scopes {
						if string(id) != tc.removed {
							remaining = append(remaining, string(id))
						}
					}
					if _, err := db.Pool.Exec(t.Context(), `UPDATE personal_access_tokens SET business_scopes=$2,scope_version=scope_version+1 WHERE id=$1`, actor.CredentialID, remaining); err != nil {
						t.Fatal(err)
					}
				}
				var input ro.ModelInput
				if err := json.Unmarshal(message.Input, &input); err != nil {
					t.Fatal(err)
				}
				if input.Provider != "codex" || input.Cwd == nil || *input.Cwd != "/work" {
					t.Fatalf("wrong model discovery input: %+v", input)
				}
				modelSource := "native"
				if input.Model != nil {
					modelSource = "explicit"
					if *input.Model != selected {
						t.Fatalf("wrong selected model: %s", *input.Model)
					}
				}
				result := ro.ModelResult{SchemaVersion: 1, Provider: "codex", Cwd: "/work", ConfigurationGeneration: strings.Repeat("a", 64), CatalogGeneration: "ca62d2bb-d4bf-47b8-93bd-d57e5a7fcefd", Models: []ro.ModelOption{{ID: selected, Label: "Model A", Aliases: []string{}, ReasoningEfforts: []string{"low", "high"}, DefaultReasoningEffort: &effort}}, Defaults: ro.ModelDefaults{Model: ro.ModelDefault{Value: &selected, Source: modelSource}, ReasoningEffort: ro.ModelDefault{Value: &effort, Source: "native"}}}
				raw, err := json.Marshal(result)
				if err != nil {
					t.Fatal(err)
				}
				response := ro.Message{Fence: message.Fence, Type: "result", RequestID: message.RequestID, Result: raw}
				// Producer context has no Bot projection marker. Pending authority must carry it.
				if err := app.WorkerReadOnly.Deliver(t.Context(), connection, response); err != nil {
					t.Fatal(err)
				}
			}
			var got outcome
			select {
			case got = <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("creation did not finish")
			}
			if tc.removed != "" || tc.revoke {
				if tc.revoke {
					var fault *model.Fault
					if !errors.As(got.err, &fault) || fault.Code != "unauthenticated" {
						t.Fatalf("revocation delivered result: %+v %v", got.bot, got.err)
					}
				} else if !errors.Is(got.err, scopepolicy.ErrInsufficientScope) {
					t.Fatalf("scope removal delivered result: %+v %v", got.bot, got.err)
				}
				var count int
				if err := db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM bots WHERE id=$1`, request.ID).Scan(&count); err != nil || count != 0 {
					t.Fatalf("refused discovery persisted Bot: %d %v", count, err)
				}
			} else if got.err != nil || got.bot.ID != request.ID || got.bot.ResolvedConfiguration.Model == nil || *got.bot.ResolvedConfiguration.Model != selected || got.bot.ResolvedConfiguration.ReasoningEffort == nil || *got.bot.ResolvedConfiguration.ReasoningEffort != effort {
				t.Fatalf("Bot creation without worker:inspect: %+v %v", got.bot, got.err)
			}
		})
	}
	inspector := newPAT(t, "bot:read", "worker:read")
	if _, err := app.Bots.DefaultsFor(t.Context(), inspector, model.BotOverrides{WorkerID: &workerID, Model: &selected}); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("public Defaults granted inspection: %v", err)
	}
	if _, err := app.WorkerReadOnly.Request(t.Context(), inspector, workerID, ro.Request{RequestID: uuid.NewString(), Operation: "model.list", Input: json.RawMessage(`{"provider":"codex"}`)}); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("public broker granted inspection: %v", err)
	}
}

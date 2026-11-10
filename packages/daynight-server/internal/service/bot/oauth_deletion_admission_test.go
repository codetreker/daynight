package bot

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestOAuthDeletionRefusalsPreserveAdmissionOrder(t *testing.T) {
	for _, afterBot := range []bool{true, false} {
		t.Run(map[bool]string{true: "after Bot", false: "initial credential"}[afterBot], func(t *testing.T) {
			ctx := context.WithValue(t.Context(), struct{}{}, "OAuth deletion")
			p := model.Principal{Kind: model.OAuthCredential, UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "f6666666-6666-4666-8666-666666666666"}
			now := time.Date(2026, 11, 11, 1, 0, 0, 123456000, time.UTC)
			bot := func() model.Bot {
				return model.Bot{ID: "a4444444-4444-4444-8444-444444444444", OwnerUserID: p.UserID, WorkerID: "b5555555-5555-4555-8555-555555555555", Name: "OAuth Bot", Version: 1, CreatedAt: now, UpdatedAt: now,
					ResolvedConfiguration: model.BotConfiguration{WorkerID: "b5555555-5555-4555-8555-555555555555", Cwd: "/workspace", Provider: "codex", Args: []string{}}}
			}
			request := store.DeleteBot{Version: 1, DeletionID: "c6666666-6666-4666-8666-666666666666"}
			proposal := func() model.Bot {
				v := bot()
				v.Deletion = &model.BotDeletion{DeletionID: request.DeletionID, RequestedVersion: 1, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
				return v
			}
			names := []string{"write", "credential", "write_done"}
			expected := map[string]int{"credential": 1}
			if afterBot {
				names = []string{"write", "credential", "bot", "owner", "request", "sessions", "revoke", "save", "credential", "write_done"}
				expected = map[string]int{"credential": 2, "bot": 1, "sessions": 1, "revoke": 1}
			}
			plan := newPlan(t, names...)
			calls := expectSessionDeletionProofCalls(t, expected)
			credentials := 0
			dao := &sessionDeletionProofDAO{calls: calls,
				credential: func(actual context.Context, actor model.Principal, at time.Time) error {
					plan.call("credential")
					identical(t, actual, ctx)
					same(t, actor, p)
					same(t, at, now)
					credentials++
					if afterBot && credentials == 1 {
						return nil
					}
					return model.ErrNotFound
				},
				sessions: func(actual context.Context, id string) ([]store.BotSession, error) {
					plan.call("sessions")
					identical(t, actual, ctx)
					same(t, id, bot().ID)
					return []store.BotSession{}, nil
				},
				revoke: func(actual context.Context, id string) error {
					plan.call("revoke")
					identical(t, actual, ctx)
					same(t, id, bot().ID)
					return nil
				},
			}
			bots := &sessionDeletionProofBots{calls: calls, read: func(actual context.Context, id string) (model.Bot, error) {
				plan.call("bot")
				identical(t, actual, ctx)
				same(t, id, bot().ID)
				return bot(), nil
			}}
			callbackExpected := &model.Fault{Code: "unauthenticated", Message: "Credential expired or was revoked."}
			finalError := &model.Fault{Code: "unauthenticated", Message: "Credential expired or was revoked."}
			completion := store.Completion{Outcome: store.TransactionNotCommitted}
			writer := sessionDeletionProofWriter{write: func(actual context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
				plan.call("write")
				identical(t, actual, ctx)
				callbackFreshFault(callbackExpected).check(t, fn(sessionDeletionProofScope{dao: dao, bots: bots}))
				plan.call("write_done")
				return completion, finalError
			}}
			live := &discardedSessions{}
			svc := NewDeletions(writer, nil, live)
			svc.now = func() time.Time { return now }
			svc.operations = deletionOperations{
				owner: func(v model.Bot, actor model.Principal) error {
					plan.call("owner")
					same(t, v, bot())
					same(t, actor, p)
					return nil
				},
				request: func(v model.Bot, input store.DeleteBot) (bool, error) {
					plan.call("request")
					same(t, v, bot())
					same(t, input, request)
					return false, nil
				},
				save: func(actual context.Context, d store.BotWriteDAO, v model.Bot) (model.Bot, error) {
					plan.call("save")
					identical(t, actual, ctx)
					identical(t, d, bots)
					same(t, v, proposal())
					out := proposal()
					out.Version = 2
					return out, nil
				},
			}
			out, err := svc.DeleteBot(ctx, p, bot().ID, request)
			same(t, err, finalError)
			same(t, out, model.Bot{})
			same(t, len(live.ids), 0)
		})
	}
}

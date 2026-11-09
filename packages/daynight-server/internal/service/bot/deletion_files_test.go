package bot

import (
	"context"
	"errors"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestDeletionCleanupRemovesActualOrphanArchiveInOwnedNamespace(t *testing.T) {
	p, bot, request := sessionDeletionProofIdentity()
	id := uuid.NewString()
	bot.SessionID = &id
	bot.Deletion = &model.BotDeletion{DeletionID: request.DeletionID, RequestedVersion: request.Version, WorkerCleanup: model.BotCleanupResult{State: "completed"}, ServerCleanup: model.BotCleanupResult{State: "pending"}, ReceiptDigest: "original-receipt"}
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if e := files.Close(); e != nil {
			t.Error(e)
		}
	})
	namespace, err := sessionarchive.NewNamespace(sessionarchive.Users, p.UserID, id)
	if err != nil {
		t.Fatal(err)
	}
	orphan := namespace.Directory() + "/orphan.json"
	if _, err = files.Put(t.Context(), sessionarchive.Bucket, orphan, strings.NewReader("private")); err != nil {
		t.Fatal(err)
	}
	calls := expectSessionDeletionProofCalls(t, map[string]int{"credential": 1, "bot": 1, "sessions": 1, "remove": 1, "redact": 1, "save": 1})
	dao := &sessionDeletionProofDAO{calls: calls, credential: func(context.Context, model.Principal, time.Time) error { return nil }, sessions: func(context.Context, string) ([]store.BotSession, error) {
		return []store.BotSession{{ID: id, Owner: p.UserID, Scope: "test", Backend: "web"}}, nil
	}, remove: func(ctx context.Context, session, key string) error {
		same(t, session, id)
		same(t, key, bot.ID)
		object, e := files.Open(ctx, sessionarchive.Bucket, orphan)
		if e == nil {
			if closeError := object.Body.Close(); closeError != nil {
				t.Error(closeError)
			}
		}
		if !errors.Is(e, fs.ErrNotExist) {
			t.Fatalf("row removed before actual files: %v", e)
		}
		return nil
	}, redact: func(context.Context, string) error { return nil }}
	bots := &sessionDeletionProofBots{calls: calls, read: func(context.Context, string) (model.Bot, error) { return bot, nil }, save: func(_ context.Context, key string, value *model.BotDeletion) (model.Bot, error) {
		same(t, key, bot.ID)
		same(t, value.ServerCleanup.State, "completed")
		same(t, value.ReceiptDigest, "original-receipt")
		out := bot
		out.SessionID = nil
		out.Deletion = value
		return out, nil
	}}
	live := &discardedSessions{}
	s := NewDeletions(sessionDeletionProofTransaction(t, t.Context(), sessionDeletionProofScope{dao: dao, bots: bots}, store.TransactionCommitted, nil, nil), files, live)
	bindDeletionFacts(t, s, bots, p, bot, request, deletionFacts{ctx: t.Context(), calls: map[string]int{"owner": 1, "server": 1, "save": 1}, serverChange: true})
	got, err := s.clean(t.Context(), p, bot.ID, request.DeletionID)
	if err != nil {
		t.Fatal(err)
	}
	same(t, got.SessionID, (*string)(nil))
	same(t, live.ids, []string{id})
}

package bot

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type deletionFacts struct {
	ctx                                                           context.Context
	receipt                                                       *BotDeletionReceipt
	calls                                                         map[string]int
	ownerError, requestError, workerError, serverError, saveError error
	replay, workerChange, needsProof, serverChange, failChange    bool
}

func bindDeletionFacts(t *testing.T, s *Deletions, dao store.BotWriteDAO, p model.Principal, bot model.Bot, request store.DeleteBot, facts deletionFacts) {
	t.Helper()
	remaining := facts.calls
	take := func(name string) {
		t.Helper()
		if remaining[name] < 1 {
			t.Errorf("unexpected deletion operation %s", name)
			panic("unexpected deletion operation " + name)
		}
		remaining[name]--
	}
	t.Cleanup(func() {
		for n, left := range remaining {
			if left != 0 {
				t.Errorf("operation %s remaining calls %d", n, left)
			}
		}
	})
	s.operations = deletionOperations{
		owner: func(v model.Bot, actor model.Principal) error {
			take("owner")
			same(t, v, bot)
			same(t, actor, p)
			return facts.ownerError
		},
		request: func(v model.Bot, input store.DeleteBot) (bool, error) {
			take("request")
			same(t, v, bot)
			same(t, input, request)
			return facts.replay, facts.requestError
		},
		save: func(ctx context.Context, d store.BotWriteDAO, v model.Bot) (model.Bot, error) {
			take("save")
			identical(t, ctx, facts.ctx)
			identical(t, d, dao)
			same(t, v.ID, bot.ID)
			same(t, v.OwnerUserID, bot.OwnerUserID)
			if facts.saveError != nil {
				return model.Bot{}, facts.saveError
			}
			return d.SaveBotDeletion(ctx, v.ID, v.Deletion)
		},
		worker: func(v model.Bot, worker, id string, result model.BotCleanupResult, digest string) (bool, bool, error) {
			take("worker")
			same(t, v, bot)
			same(t, worker, bot.WorkerID)
			same(t, id, request.DeletionID)
			raw, err := json.Marshal(*facts.receipt)
			if err != nil {
				t.Fatal(err)
			}
			same(t, result, facts.receipt.Result)
			same(t, digest, fmt.Sprintf("%x", sha256.Sum256(raw)))
			return facts.workerChange, facts.needsProof, facts.workerError
		},
		server: func(v model.Bot, id string) (bool, error) {
			take("server")
			same(t, v.ID, bot.ID)
			same(t, id, request.DeletionID)
			return facts.serverChange, facts.serverError
		},
		fail: func(v *model.Bot, id string) (bool, error) {
			take("fail")
			same(t, v.ID, bot.ID)
			same(t, id, request.DeletionID)
			if facts.failChange {
				code := "server_cleanup_failed"
				v.Deletion.ServerCleanup = model.BotCleanupResult{State: "failed", Code: &code}
			}
			return facts.failChange, nil
		},
	}
}

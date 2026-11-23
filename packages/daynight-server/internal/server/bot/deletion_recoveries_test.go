package bot_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func (f *botDefinitionsFixture) DeletionRecoveries(ctx context.Context, p model.Principal, page model.PageRequest) (botcore.DeletionRecoveryPage, error) {
	return botDefinitionResult[botcore.DeletionRecoveryPage](f.invoke(ctx, p, "DeletionRecoveries", "", page))
}

func TestBotDeletionRecoveriesHTTP(t *testing.T) {
	f := newBotDefinitionsFixture(t, io.Discard)
	path := "/api/v1/me/bot-deletion-recoveries"
	response := f.request(http.MethodGet, path, "", &botDefinitionCall{method: "DeletionRecoveries", input: model.PageRequest{Limit: 50}, result: botcore.DeletionRecoveryPage{}})
	empty := decodeResponse[api.BotDeletionRecoveryPage](t, response, 200)
	if empty.Items == nil || len(empty.Items) != 0 || empty.NextCursor != nil {
		t.Fatalf("empty page: %s", response.Body)
	}
	cursor := "recovery-page"
	item := botcore.DeletionRecovery{BotID: botDefinitionsID, Version: 9007199254740993, DeletionID: botDefinitionsIntent, RequestedVersion: 9007199254740992, WorkerID: botDefinitionsWorker,
		RecoveryRequired: true, WorkerCleanup: model.BotCleanupResult{State: "failed", Code: botObservationPointer("execution_evidence_missing")}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	response = f.request(http.MethodGet, path+"?limit=1&cursor="+cursor, "", &botDefinitionCall{method: "DeletionRecoveries", input: model.PageRequest{Limit: 1, Cursor: &cursor}, result: botcore.DeletionRecoveryPage{Items: []botcore.DeletionRecovery{item}, NextCursor: &cursor}})
	page := decodeResponse[api.BotDeletionRecoveryPage](t, response, 200)
	if len(page.Items) != 1 || page.Items[0].BotID != item.BotID || page.Items[0].Version != item.Version || page.NextCursor == nil || *page.NextCursor != cursor || !strings.Contains(response.Body.String(), `"version":"9007199254740993"`) {
		t.Fatalf("page: %s", response.Body)
	}
	for _, query := range []string{"?limit=0", "?limit=101", "?extra=1", "?limit=1&limit=2"} {
		assertProjectError(t, f.request(http.MethodGet, path+query, "", nil), 400, "invalid_input")
	}
	assertProjectError(t, f.dispatch(http.MethodGet, path, "", botDefinitionAnonymous, nil), 401, "unauthenticated")
	assertProjectError(t, f.request(http.MethodPost, path, "{}", nil), 405, "method_not_allowed")
	assertProjectError(t, f.request(http.MethodGet, path, "", &botDefinitionCall{method: "DeletionRecoveries", input: model.PageRequest{Limit: 50}, err: &model.Fault{Code: "insufficient_scope", Message: "scope"}}), 403, "forbidden")
}

package bot

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type DeletionRecoveryPage struct {
	Items      []DeletionRecovery
	NextCursor *string
}

func deletionRecoveryListScope(principal model.Principal) query.ListScope {
	return query.ListScope{Kind: "bot-deletion-recoveries", WorkerUserID: &principal.UserID}
}

func DeletionRecoveryListPage(principal model.Principal, request model.PageRequest) (store.Page, error) {
	return query.ListPage(request, deletionRecoveryListScope(principal))
}

func ListDeletionRecoveries(ctx context.Context, snapshot store.SnapshotScope, principal model.Principal, page store.Page, admit func() error) (store.BotPage, error) {
	if _, err := snapshot.CredentialDAO().Credential(ctx, principal); err != nil {
		return store.BotPage{}, botCredentialError(err)
	}
	if admit == nil {
		return store.BotPage{}, errors.New("Bot deletion recovery list admission is required")
	}
	if err := admit(); err != nil {
		return store.BotPage{}, err
	}
	reader, ok := snapshot.BotDAO().(store.BotDeletionRecoveryLister)
	if !ok {
		return store.BotPage{}, errors.New("Bot deletion recovery list reader is unavailable")
	}
	return reader.BotDeletionRecoveries(ctx, principal.UserID, page)
}

func DeletionRecoveryListCursor(principal model.Principal, records store.BotPage) (*string, error) {
	if !records.HasMore {
		return nil, nil
	}
	if len(records.Items) == 0 {
		return nil, errors.New("Bot deletion recovery page has no cursor boundary")
	}
	last := records.Items[len(records.Items)-1]
	cursor, err := query.EncodeListCursor(deletionRecoveryListScope(principal), last.CreatedAt, last.ID)
	if err != nil {
		return nil, err
	}
	return &cursor, nil
}

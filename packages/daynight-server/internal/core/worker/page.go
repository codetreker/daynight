package worker

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ListPage binds a worker cursor to its owning user.
func ListPage(request model.PageRequest, userID string) (store.Page, error) {
	return query.ListPage(request, query.ListScope{Kind: "workers", WorkerUserID: &userID})
}

// ListCursor encodes the stable creation position for the same owner.
func ListCursor(userID string, createdAt time.Time, workerID string) (string, error) {
	return query.EncodeListCursor(query.ListScope{Kind: "workers", WorkerUserID: &userID}, createdAt, workerID)
}

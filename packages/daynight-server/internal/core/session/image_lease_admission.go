package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func acquireImageResourceLease(ctx context.Context, dao store.SessionResourceDAO, lease store.SessionResourceLease) error {
	lease.Admission = store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}
	return dao.AcquireSessionResourceLease(ctx, lease)
}

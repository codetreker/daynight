package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (tx *DAO) ListSessionMediaLeases(ctx context.Context) ([]store.SessionResourceLease, error) {
	rows, err := tx.tx.Query(ctx, `SELECT session_id::text,lease_id::text,owner_id::text,kind,COALESCE(resource_id::text,''),delete_epoch FROM session_resource_leases ORDER BY session_id,lease_id`)
	if err != nil {
		return nil, mediaQueryError("list media recovery leases", err)
	}
	defer rows.Close()
	out := []store.SessionResourceLease{}
	for rows.Next() {
		var lease store.SessionResourceLease
		if err = rows.Scan(&lease.SessionID, &lease.ID, &lease.OwnerID, &lease.Kind, &lease.ResourceID, &lease.DeleteEpoch); err != nil {
			return nil, mediaQueryError("read media recovery lease", err)
		}
		out = append(out, lease)
	}
	return out, mediaQueryError("list media recovery leases", rows.Err())
}

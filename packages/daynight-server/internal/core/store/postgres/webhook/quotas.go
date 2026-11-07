package webhook

import (
	"context"
	"crypto/sha256"
	"fmt"
	"slices"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	wh "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func OwnerBucket(owner wh.Owner) int {
	digest := sha256.Sum256([]byte(string(owner.Kind) + "\x00" + owner.ID))
	return int(digest[0] % 16)
}

func (w *writer) lockBudget(ctx context.Context, owner wh.Owner, pruneAt *time.Time) error {
	if owner != w.owner || !w.configurationLock {
		return fmt.Errorf("Webhook budget does not match its configuration scope")
	}
	if w.budgetLocked {
		return nil
	}
	bucket := OwnerBucket(owner)
	var locked int
	if err := w.tx.QueryRow(ctx, `SELECT bucket FROM webhook_quota_buckets WHERE bucket=$1 FOR UPDATE`, bucket).Scan(&locked); err != nil {
		return pg.QueryError("lock Webhook storage bucket", err)
	}
	if pruneAt != nil {
		if err := w.pruneOperations(ctx, bucket, *pruneAt); err != nil {
			return err
		}
	}
	if _, err := w.tx.Exec(ctx, `INSERT INTO webhook_quota_owners(owner_kind,owner_id,bucket) VALUES($1,$2,$3) ON CONFLICT(owner_kind,owner_id) DO NOTHING`, owner.Kind, owner.ID, bucket); err != nil {
		return pg.QueryError("initialize Webhook owner budget", err)
	}
	if err := w.tx.QueryRow(ctx, `SELECT bucket FROM webhook_quota_owners WHERE owner_kind=$1 AND owner_id=$2 FOR UPDATE`, owner.Kind, owner.ID).Scan(&locked); err != nil {
		return pg.QueryError("lock Webhook owner budget", err)
	}
	if locked != bucket {
		return fmt.Errorf("stored Webhook owner budget bucket is inconsistent")
	}
	w.budgetLocked = true
	return nil
}

func (w *writer) pruneOperations(ctx context.Context, bucket int, now time.Time) error {
	rows, err := w.tx.Query(ctx, `DELETE FROM webhook_operations o USING webhook_quota_owners q WHERE q.owner_kind=o.owner_kind AND q.owner_id=o.owner_id AND q.bucket=$1
        AND o.expires_at<=$2 RETURNING o.owner_kind,o.owner_id::text`, bucket, now)
	if err != nil {
		return pg.QueryError("expire Webhook operation receipts", err)
	}
	counts := map[wh.Owner]int64{}
	var count int64
	for rows.Next() {
		var owner wh.Owner
		if err = rows.Scan(&owner.Kind, &owner.ID); err != nil {
			break
		}
		counts[owner]++
		count++
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return pg.QueryError("expire Webhook operation receipts", err)
	}
	owners := make([]wh.Owner, 0, len(counts))
	for owner := range counts {
		owners = append(owners, owner)
	}
	slices.SortFunc(owners, func(a, b wh.Owner) int {
		if a.Kind != b.Kind {
			if a.Kind < b.Kind {
				return -1
			}
			return 1
		}
		if a.ID < b.ID {
			return -1
		}
		if a.ID > b.ID {
			return 1
		}
		return 0
	})
	for _, owner := range owners {
		tag, err := w.tx.Exec(ctx, `UPDATE webhook_quota_owners SET operations_used=operations_used-$3 WHERE owner_kind=$1 AND owner_id=$2 AND operations_used>=$3`, owner.Kind, owner.ID, counts[owner])
		if err != nil {
			return pg.QueryError("release expired Webhook owner receipts", err)
		}
		if tag.RowsAffected() != 1 {
			return fmt.Errorf("Webhook owner receipt accounting is inconsistent")
		}
	}
	if count != 0 {
		tag, err := w.tx.Exec(ctx, `UPDATE webhook_quota_buckets SET operations_used=operations_used-$2 WHERE bucket=$1 AND operations_used>=$2`, bucket, count)
		if err != nil {
			return pg.QueryError("release expired Webhook bucket receipts", err)
		}
		if tag.RowsAffected() != 1 {
			return fmt.Errorf("Webhook bucket receipt accounting is inconsistent")
		}
	}
	return nil
}

func (w *writer) ReserveOperation(ctx context.Context, owner wh.Owner, now time.Time) error {
	if w.operationReserved {
		return fmt.Errorf("Webhook operation receipt is already reserved")
	}
	policy, err := w.Policy(ctx)
	if err != nil {
		return err
	}
	if err := w.lockBudget(ctx, owner, &now); err != nil {
		return err
	}
	var bucketUsed, ownerUsed int64
	if err := w.tx.QueryRow(ctx, `SELECT b.operations_used,q.operations_used FROM webhook_quota_buckets b JOIN webhook_quota_owners q ON q.bucket=b.bucket
        WHERE q.owner_kind=$1 AND q.owner_id=$2`, owner.Kind, owner.ID).Scan(&bucketUsed, &ownerUsed); err != nil {
		return pg.QueryError("read Webhook receipt budget", err)
	}
	if bucketUsed >= policy.OperationBucketLimit || ownerUsed >= policy.OperationOwnerLimit {
		return &model.Fault{Code: "operation_capacity", Message: "Webhook operation receipt capacity is reached"}
	}
	if _, err := w.tx.Exec(ctx, `UPDATE webhook_quota_buckets SET operations_used=operations_used+1 WHERE bucket=$1`, OwnerBucket(owner)); err != nil {
		return pg.QueryError("reserve Webhook bucket receipt", err)
	}
	if _, err := w.tx.Exec(ctx, `UPDATE webhook_quota_owners SET operations_used=operations_used+1 WHERE owner_kind=$1 AND owner_id=$2`, owner.Kind, owner.ID); err != nil {
		return pg.QueryError("reserve Webhook owner receipt", err)
	}
	w.operationReserved = true
	return nil
}

func (w *writer) ReserveConfiguration(ctx context.Context, owner wh.Owner, cost store.WebhookChangeCost) error {
	if !w.operationReserved || w.configurationCost {
		return fmt.Errorf("Webhook configuration budget is already reserved")
	}
	policy, err := w.Policy(ctx)
	if err != nil {
		return err
	}
	if err := w.lockBudget(ctx, owner, nil); err != nil {
		return err
	}
	var bucket, current store.WebhookChangeCost
	err = w.tx.QueryRow(ctx, `SELECT b.records_used,b.bytes_used,b.active_records_used,b.active_bytes_used,q.records_used,q.bytes_used,q.active_records_used,q.active_bytes_used
        FROM webhook_quota_buckets b JOIN webhook_quota_owners q ON q.bucket=b.bucket WHERE q.owner_kind=$1 AND q.owner_id=$2`, owner.Kind, owner.ID).Scan(
		&bucket.Records, &bucket.Bytes, &bucket.ActiveRecords, &bucket.ActiveBytes, &current.Records, &current.Bytes, &current.ActiveRecords, &current.ActiveBytes)
	if err != nil {
		return pg.QueryError("read Webhook configuration budget", err)
	}
	within := func(current store.WebhookChangeCost, records, bytes, activeRecords, activeBytes int64) bool {
		return cost.Records >= -current.Records && cost.Records <= records-current.Records &&
			cost.Bytes >= -current.Bytes && cost.Bytes <= bytes-current.Bytes &&
			cost.ActiveRecords >= -current.ActiveRecords && cost.ActiveRecords <= activeRecords-current.ActiveRecords &&
			cost.ActiveBytes >= -current.ActiveBytes && cost.ActiveBytes <= activeBytes-current.ActiveBytes
	}
	if !within(bucket, policy.BucketRecordLimit, policy.BucketBytesLimit, policy.BucketActiveRecordLimit, policy.BucketActiveBytesLimit) ||
		!within(current, policy.OwnerRecordLimit, policy.OwnerBytesLimit, policy.OwnerActiveRecordLimit, policy.OwnerActiveBytesLimit) {
		return &model.Fault{Code: "webhook_capacity_unavailable", Message: "Webhook configuration storage capacity is unavailable"}
	}
	if _, err := w.tx.Exec(ctx, `UPDATE webhook_quota_buckets SET records_used=records_used+$2,bytes_used=bytes_used+$3,active_records_used=active_records_used+$4,active_bytes_used=active_bytes_used+$5 WHERE bucket=$1`,
		OwnerBucket(owner), cost.Records, cost.Bytes, cost.ActiveRecords, cost.ActiveBytes); err != nil {
		return pg.QueryError("reserve Webhook bucket configuration", err)
	}
	if _, err := w.tx.Exec(ctx, `UPDATE webhook_quota_owners SET records_used=records_used+$3,bytes_used=bytes_used+$4,active_records_used=active_records_used+$5,active_bytes_used=active_bytes_used+$6 WHERE owner_kind=$1 AND owner_id=$2`,
		owner.Kind, owner.ID, cost.Records, cost.Bytes, cost.ActiveRecords, cost.ActiveBytes); err != nil {
		return pg.QueryError("reserve Webhook owner configuration", err)
	}
	w.configurationCost = true
	return nil
}

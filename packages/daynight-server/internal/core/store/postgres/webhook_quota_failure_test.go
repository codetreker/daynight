package postgres

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	wh "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type webhookQuotaState struct {
	Endpoints, Receipts, Owners                                                        int64
	OwnerRecords, OwnerBytes, OwnerActiveRecords, OwnerActiveBytes, OwnerReceipts      int64
	BucketRecords, BucketBytes, BucketActiveRecords, BucketActiveBytes, BucketReceipts int64
}

func readWebhookQuotaState(t *testing.T, database *Store) webhookQuotaState {
	t.Helper()
	var state webhookQuotaState
	err := database.Pool.QueryRow(context.Background(), `SELECT
        (SELECT count(*) FROM webhook_endpoints),(SELECT count(*) FROM webhook_operations),(SELECT count(*) FROM webhook_quota_owners),
        (SELECT coalesce(sum(records_used),0) FROM webhook_quota_owners),(SELECT coalesce(sum(bytes_used),0) FROM webhook_quota_owners),
        (SELECT coalesce(sum(active_records_used),0) FROM webhook_quota_owners),(SELECT coalesce(sum(active_bytes_used),0) FROM webhook_quota_owners),
        (SELECT coalesce(sum(operations_used),0) FROM webhook_quota_owners),
        (SELECT sum(records_used) FROM webhook_quota_buckets),(SELECT sum(bytes_used) FROM webhook_quota_buckets),
        (SELECT sum(active_records_used) FROM webhook_quota_buckets),(SELECT sum(active_bytes_used) FROM webhook_quota_buckets),(SELECT sum(operations_used) FROM webhook_quota_buckets)`).Scan(
		&state.Endpoints, &state.Receipts, &state.Owners, &state.OwnerRecords, &state.OwnerBytes, &state.OwnerActiveRecords, &state.OwnerActiveBytes, &state.OwnerReceipts,
		&state.BucketRecords, &state.BucketBytes, &state.BucketActiveRecords, &state.BucketActiveBytes, &state.BucketReceipts)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func webhookQuotaFixture(t *testing.T, expired bool) (*Store, wh.Endpoint) {
	t.Helper()
	database, actor, _, project := membershipFixture(t)
	endpoint := storedWebhook(t, actor, project)
	receipt := webhookReceipt(endpoint, uuid.NewString())
	if _, err := database.WriteWebhook(context.Background(), endpoint.Owner, receipt.OperationID, func(scope store.WebhookWriteScope) error {
		return insertStoredWebhook(context.Background(), scope, endpoint, receipt)
	}); err != nil {
		t.Fatal(err)
	}
	if expired {
		past := time.Now().UTC().Add(-31 * 24 * time.Hour)
		if _, err := database.Pool.Exec(context.Background(), `UPDATE webhook_operations SET recorded_at=$1,expires_at=$2`, past, past.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	return database, endpoint
}

func assertWebhookQuotaFailure(t *testing.T, database *Store, before webhookQuotaState, err, cause error) {
	t.Helper()
	var failure *store.TransactionError
	if err == nil || !errors.As(err, &failure) || failure.Outcome != store.TransactionNotCommitted || failure.CommitAttempted {
		t.Fatalf("quota failure became accepted or uncertain: %v %#v", err, failure)
	}
	if cause != nil && !errors.Is(err, cause) {
		t.Fatalf("original quota failure was lost: %v", err)
	}
	if after := readWebhookQuotaState(t, database); !reflect.DeepEqual(after, before) {
		t.Fatalf("failed quota change retained partial state: before=%#v after=%#v", before, after)
	}
}

type webhookQuotaCancelTx struct {
	pgx.Tx
	cancel                          context.CancelFunc
	rowAt, execAt, rows, executions int
}

func (tx *webhookQuotaCancelTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	tx.rows++
	if tx.rows == tx.rowAt {
		tx.cancel()
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}

func (tx *webhookQuotaCancelTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tx.executions++
	if tx.executions == tx.execAt {
		tx.cancel()
	}
	return tx.Tx.Exec(ctx, sql, args...)
}

func TestWebhookReceiptReservationCancellationRollsBackEveryMutationStage(t *testing.T) {
	for _, test := range []struct {
		name           string
		row, execution int
	}{
		{"policy read", 1, 0},
		{"bucket lock", 2, 0},
		{"owner lock", 3, 0},
		{"receipt occupancy read", 4, 0},
		{"owner initialization", 0, 1},
		{"bucket reservation", 0, 2},
		{"owner reservation", 0, 3},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, endpoint := webhookQuotaFixture(t, false)
			before := readWebhookQuotaState(t, database)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			tx, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			wrapped := &webhookQuotaCancelTx{Tx: tx, cancel: cancel, rowAt: test.row, execAt: test.execution}
			err = transact(ctx, wrapped, func(raw pgx.Tx) error {
				dao := pgwebhook.NewWriter(raw, endpoint.Owner, uuid.NewString())
				if err := dao.LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: endpoint.Owner, ActorUserID: endpoint.Owner.ID}); err != nil {
					return err
				}
				return dao.ReserveOperation(ctx, endpoint.Owner, time.Now())
			})
			assertWebhookQuotaFailure(t, database, before, err, context.Canceled)
		})
	}
}

func TestWebhookConfigurationReservationFailureRestoresReceiptAndStorageBudgets(t *testing.T) {
	for _, test := range []struct {
		name           string
		row, execution int
	}{
		{"policy read", 1, 0},
		{"configuration occupancy read", 2, 0},
		{"bucket configuration update", 0, 1},
		{"owner configuration update", 0, 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, endpoint := webhookQuotaFixture(t, false)
			before := readWebhookQuotaState(t, database)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			tx, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			wrapped := &webhookQuotaCancelTx{Tx: tx, cancel: cancel}
			err = transact(ctx, wrapped, func(raw pgx.Tx) error {
				dao := pgwebhook.NewWriter(raw, endpoint.Owner, uuid.NewString())
				if err := dao.LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: endpoint.Owner, ActorUserID: endpoint.Owner.ID}); err != nil {
					return err
				}
				if err := dao.ReserveOperation(ctx, endpoint.Owner, time.Now()); err != nil {
					return err
				}
				wrapped.rowAt, wrapped.execAt, wrapped.rows, wrapped.executions = test.row, test.execution, 0, 0
				return dao.ReserveConfiguration(ctx, endpoint.Owner, store.WebhookChangeCost{Records: 1, Bytes: 2048, ActiveRecords: 1, ActiveBytes: 2048})
			})
			assertWebhookQuotaFailure(t, database, before, err, context.Canceled)
		})
	}
}

func TestWebhookQuotaScopesCannotReserveForAnotherOwnerOrReserveTwice(t *testing.T) {
	for _, test := range []string{"operation before configuration lock", "other operation owner", "duplicate operation reservation", "configuration before operation reservation", "other configuration owner", "duplicate configuration reservation"} {
		t.Run(test, func(t *testing.T) {
			database, endpoint := webhookQuotaFixture(t, false)
			before := readWebhookQuotaState(t, database)
			ctx := context.Background()
			tx, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			err = transact(ctx, tx, func(raw pgx.Tx) error {
				dao := pgwebhook.NewWriter(raw, endpoint.Owner, uuid.NewString())
				if test == "operation before configuration lock" {
					return dao.ReserveOperation(ctx, endpoint.Owner, time.Now())
				}
				if err := dao.LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: endpoint.Owner, ActorUserID: endpoint.Owner.ID}); err != nil {
					return err
				}
				if test == "configuration before operation reservation" {
					return dao.ReserveConfiguration(ctx, endpoint.Owner, store.WebhookChangeCost{})
				}
				other := wh.Owner{Kind: wh.PersonalOwner, ID: uuid.NewString()}
				if test == "other operation owner" {
					return dao.ReserveOperation(ctx, other, time.Now())
				}
				if err := dao.ReserveOperation(ctx, endpoint.Owner, time.Now()); err != nil {
					return err
				}
				if test == "duplicate operation reservation" {
					return dao.ReserveOperation(ctx, endpoint.Owner, time.Now())
				}
				if test == "other configuration owner" {
					return dao.ReserveConfiguration(ctx, other, store.WebhookChangeCost{})
				}
				if err := dao.ReserveConfiguration(ctx, endpoint.Owner, store.WebhookChangeCost{Records: 1, Bytes: 2048}); err != nil {
					return err
				}
				return dao.ReserveConfiguration(ctx, endpoint.Owner, store.WebhookChangeCost{Records: 1, Bytes: 2048})
			})
			assertWebhookQuotaFailure(t, database, before, err, nil)
		})
	}
}

func TestWebhookReceiptExpiryStreamFailureCannotDropRetainedReceipts(t *testing.T) {
	for _, mode := range []string{"query", "scan", "stream"} {
		t.Run(mode, func(t *testing.T) {
			database, endpoint := webhookQuotaFixture(t, true)
			before := readWebhookQuotaState(t, database)
			ctx := context.Background()
			tx, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			cause := errors.New("receipt expiry stream failed")
			wrapped := teamMembersFailureTx{Tx: tx, cause: cause, scan: mode == "scan", failQuery: mode == "query"}
			err = transact(ctx, wrapped, func(raw pgx.Tx) error {
				dao := pgwebhook.NewWriter(raw, endpoint.Owner, uuid.NewString())
				if err := dao.LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: endpoint.Owner, ActorUserID: endpoint.Owner.ID}); err != nil {
					return err
				}
				return dao.ReserveOperation(ctx, endpoint.Owner, time.Now())
			})
			assertWebhookQuotaFailure(t, database, before, err, cause)
		})
	}
}

func TestWebhookReceiptExpiryAccountingFailureRollsBackDeletionAndReleases(t *testing.T) {
	for _, test := range []struct {
		name, setup string
		driver      bool
	}{
		{"owner release", `CREATE FUNCTION reject_receipt_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operations_used<OLD.operations_used THEN RAISE EXCEPTION 'receipt release rejected'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_release BEFORE UPDATE OF operations_used ON webhook_quota_owners FOR EACH ROW EXECUTE FUNCTION reject_receipt_release()`, true},
		{"bucket release", `CREATE FUNCTION reject_receipt_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operations_used<OLD.operations_used THEN RAISE EXCEPTION 'receipt release rejected'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_release BEFORE UPDATE OF operations_used ON webhook_quota_buckets FOR EACH ROW EXECUTE FUNCTION reject_receipt_release()`, true},
		{"missing owner slot", `UPDATE webhook_quota_owners SET operations_used=0`, false},
		{"missing bucket slot", `UPDATE webhook_quota_buckets SET operations_used=0`, false},
		{"inconsistent owner bucket", `UPDATE webhook_quota_owners SET bucket=(bucket+1)%16`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, endpoint := webhookQuotaFixture(t, true)
			ctx := context.Background()
			if _, err := database.Pool.Exec(ctx, test.setup); err != nil {
				t.Fatal(err)
			}
			before := readWebhookQuotaState(t, database)
			tx, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			err = transact(ctx, tx, func(raw pgx.Tx) error {
				dao := pgwebhook.NewWriter(raw, endpoint.Owner, uuid.NewString())
				if err := dao.LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: endpoint.Owner, ActorUserID: endpoint.Owner.ID}); err != nil {
					return err
				}
				return dao.ReserveOperation(ctx, endpoint.Owner, time.Now())
			})
			assertWebhookQuotaFailure(t, database, before, err, nil)
			if test.driver {
				var databaseError *pgconn.PgError
				if !errors.As(err, &databaseError) || databaseError.Code != "P0001" {
					t.Fatalf("database rejection lost its original SQL state: %v", err)
				}
			}
		})
	}
}

func TestWebhookExpiredReceiptsReleaseEveryOwnerInTheSharedBucket(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	firstActor := webhookQuotaRaceActor(t, database, "11111111-1111-4111-8111-111111111111")
	secondActor := webhookQuotaRaceActor(t, database, "22222222-2222-4222-8222-000000000003")
	firstProject, err := database.CreatePrivateProject(ctx, firstActor, uuid.NewString(), "First receipt owner", "https://example.com/first")
	if err != nil {
		t.Fatal(err)
	}
	secondProject, err := database.CreatePrivateProject(ctx, secondActor, uuid.NewString(), "Second receipt owner", "https://example.com/second")
	if err != nil {
		t.Fatal(err)
	}
	first, second := storedWebhook(t, firstActor, firstProject), storedWebhook(t, secondActor, secondProject)
	if pgwebhook.OwnerBucket(first.Owner) != pgwebhook.OwnerBucket(second.Owner) {
		t.Fatal("receipt owners must share the coordinated bucket")
	}
	for _, endpoint := range []wh.Endpoint{first, second} {
		receipt := webhookReceipt(endpoint, uuid.NewString())
		if _, err := database.WriteWebhook(ctx, endpoint.Owner, receipt.OperationID, func(scope store.WebhookWriteScope) error { return insertStoredWebhook(ctx, scope, endpoint, receipt) }); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().UTC().Add(-31 * 24 * time.Hour)
	if _, err := database.Pool.Exec(ctx, `UPDATE webhook_operations SET recorded_at=$1,expires_at=$2`, past, past.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	before := readWebhookQuotaState(t, database)
	receipt := webhookReceipt(first, uuid.NewString())
	receipt.Kind, receipt.Effect = wh.EndpointPatch, wh.EffectUnchanged
	if _, err := database.WriteWebhook(ctx, first.Owner, receipt.OperationID, func(scope store.WebhookWriteScope) error {
		dao := scope.WebhookDAO()
		if err := dao.LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: first.Owner, ActorUserID: firstActor.UserID, EndpointID: first.ID}); err != nil {
			return err
		}
		if err := dao.ReserveOperation(ctx, first.Owner, receipt.RecordedAt); err != nil {
			return err
		}
		return dao.InsertOperation(ctx, receipt)
	}); err != nil {
		t.Fatal(err)
	}
	after := readWebhookQuotaState(t, database)
	if after.Endpoints != before.Endpoints || after.OwnerRecords != before.OwnerRecords || after.OwnerBytes != before.OwnerBytes || after.BucketRecords != before.BucketRecords || after.BucketBytes != before.BucketBytes || after.Receipts != 1 || after.OwnerReceipts != 1 || after.BucketReceipts != 1 {
		t.Fatalf("expired receipt recycling changed protected configuration or retained slots: before=%#v after=%#v", before, after)
	}
	var firstSlots, secondSlots int64
	if err := database.Pool.QueryRow(ctx, `SELECT (SELECT operations_used FROM webhook_quota_owners WHERE owner_kind=$1 AND owner_id=$2),(SELECT operations_used FROM webhook_quota_owners WHERE owner_kind=$1 AND owner_id=$3)`, first.Owner.Kind, first.Owner.ID, second.Owner.ID).Scan(&firstSlots, &secondSlots); err != nil {
		t.Fatal(err)
	}
	if firstSlots != 1 || secondSlots != 0 {
		t.Fatalf("shared bucket released the wrong owners: first=%d second=%d", firstSlots, secondSlots)
	}
}

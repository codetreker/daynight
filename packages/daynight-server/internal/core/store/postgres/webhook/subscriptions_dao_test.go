package webhook

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	model "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestSubscriptionDAOIdentityAndDatabaseFailures(t *testing.T) {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	for _, path := range []string{"../migrations/048_webhook_management.sql", "../migrations/049_webhook_subscriptions.sql", "../migrations/051_webhook_delivery.sql", "../migrations/052_webhook_redelivery.sql"} {
		sql, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = conn.Exec(ctx, string(sql)); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	dao := New(tx)
	now := time.Now().UTC().Truncate(time.Microsecond)
	owner := model.Owner{Kind: "personal", ID: uuid.NewString()}
	ep := model.Endpoint{ID: uuid.NewString(), Owner: owner, Name: "Endpoint", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://example.test", DestinationConfiguration: sampleDestination(), ActiveKeyID: uuid.NewString(), CreatedAt: now, UpdatedAt: now}
	if err = dao.PutEndpoint(ctx, ep); err != nil {
		t.Fatal(err)
	}
	sub := model.Subscription{ID: uuid.NewString(), EndpointID: ep.ID, ProjectID: uuid.NewString(), Owner: owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: now, UpdatedAt: now}
	if err = dao.PutSubscription(ctx, sub); err != nil {
		t.Fatal(err)
	}
	binding := model.Binding{ID: uuid.NewString(), SubscriptionID: sub.ID, EventType: "task.created", CreatedAt: now}
	if err = dao.PutBinding(ctx, binding); err != nil {
		t.Fatal(err)
	}
	items, err := dao.LockSubscriptions(ctx, ep.ID)
	if err != nil || len(items) != 1 || items[0].ID != sub.ID {
		t.Fatalf("lock subscriptions: %#v %v", items, err)
	}
	bindings, err := dao.Bindings(ctx, sub.ID)
	if err != nil || len(bindings) != 1 || bindings[0].ID != binding.ID {
		t.Fatalf("read bindings: %#v %v", bindings, err)
	}
	mismatch := sub
	mismatch.ProjectID = uuid.NewString()
	if err = dao.PutSubscription(ctx, mismatch); err == nil {
		t.Fatal("subscription project identity changed")
	}
	mismatch = sub
	mismatch.Owner.ID = uuid.NewString()
	if err = dao.PutSubscription(ctx, mismatch); err == nil {
		t.Fatal("subscription owner identity changed")
	}
	wrongBinding := binding
	wrongBinding.EventType = "task.deleted"
	if err = dao.PutBinding(ctx, wrongBinding); err == nil {
		t.Fatal("binding event identity changed")
	}
	save := func(test func(*DAO) error) error {
		sp, err := tx.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		result := test(New(sp))
		if err := sp.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		return result
	}
	assertSQL := func(err error, code string) {
		t.Helper()
		var pgerr *pgconn.PgError
		if !errors.As(err, &pgerr) || pgerr.Code != code {
			t.Fatalf("expected SQLSTATE %s, got %v", code, err)
		}
	}
	invalid := sub
	invalid.ID = uuid.NewString()
	invalid.AuthorizationEpoch = 0
	assertSQL(save(func(d *DAO) error { return d.PutSubscription(ctx, invalid) }), "23514")
	duplicate := binding
	duplicate.ID = uuid.NewString()
	assertSQL(save(func(d *DAO) error { return d.PutBinding(ctx, duplicate) }), "23505")
	assertSQL(save(func(d *DAO) error { _, err := d.LockSubscriptions(ctx, "invalid-uuid"); return err }), "22P02")
	assertSQL(save(func(d *DAO) error { _, err := d.Bindings(ctx, "invalid-uuid"); return err }), "22P02")
	sp, err := tx.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = sp.Exec(ctx, `ALTER TABLE webhook_bindings RENAME TO inaccessible_webhook_bindings`); err != nil {
		t.Fatal(err)
	}
	_, err = New(sp).LockSubscriptions(ctx, ep.ID)
	assertSQL(err, "42P01")
	if err = sp.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	sp, err = tx.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = sp.Exec(ctx, `ALTER TABLE webhook_bindings ALTER COLUMN event_type DROP NOT NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err = sp.Exec(ctx, `UPDATE webhook_bindings SET event_type=NULL WHERE id=$1`, binding.ID); err != nil {
		t.Fatal(err)
	}
	_, err = New(sp).Bindings(ctx, sub.ID)
	var scanErr pgx.ScanArgError
	if !errors.As(err, &scanErr) || scanErr.ColumnIndex != 2 {
		t.Fatalf("corrupt binding scan: %v", err)
	}
	if err = sp.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	bindings, err = dao.Bindings(ctx, sub.ID)
	if err != nil || len(bindings) != 1 || bindings[0].EventType != binding.EventType {
		t.Fatalf("failed writes changed binding: %#v %v", bindings, err)
	}
	items, err = dao.Subscriptions(ctx, ep.ID)
	if err != nil || len(items) != 1 || items[0].ProjectID != sub.ProjectID || items[0].AuthorizationEpoch != 1 {
		t.Fatalf("failed writes changed subscription: %#v %v", items, err)
	}
}

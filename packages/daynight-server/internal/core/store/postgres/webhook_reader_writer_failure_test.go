package postgres

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	whcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wh "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func webhookStoredFailureFixture(t *testing.T) (*Store, model.Principal, model.Project, wh.Endpoint) {
	t.Helper()
	database, actor, _, project := membershipFixture(t)
	endpoint := storedWebhook(t, actor, project)
	receipt := webhookReceipt(endpoint, uuid.NewString())
	if _, err := database.WriteWebhook(context.Background(), endpoint.Owner, receipt.OperationID, func(scope store.WebhookWriteScope) error {
		return insertStoredWebhook(context.Background(), scope, endpoint, receipt)
	}); err != nil {
		t.Fatal(err)
	}
	return database, actor, project, endpoint
}

func reserveWebhookFailureDAO(ctx context.Context, tx pgx.Tx, before, after wh.Endpoint, receipt wh.OperationReceipt) (store.WebhookWriteDAO, error) {
	dao := pgwebhook.NewWriter(tx, after.Owner, receipt.OperationID)
	ids := whcore.ProjectIDs(after)
	if err := dao.LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: after.Owner, ActorUserID: after.Owner.ID, EndpointID: before.ID, ProjectIDs: ids, RequiredProjectIDs: ids, Expansion: true}); err != nil {
		return nil, err
	}
	if err := dao.ReserveOperation(ctx, after.Owner, receipt.RecordedAt); err != nil {
		return nil, err
	}
	afterCost, err := whcore.ConfigurationCost(after)
	if err != nil {
		return nil, err
	}
	beforeCost := store.WebhookChangeCost{}
	if before.ID != "" {
		beforeCost, err = whcore.ConfigurationCost(before)
		if err != nil {
			return nil, err
		}
	}
	if err := dao.ReserveConfiguration(ctx, after.Owner, whcore.CostDifference(afterCost, beforeCost)); err != nil {
		return nil, err
	}
	return dao, nil
}

func TestWebhookOwnerReadFailuresDoNotBecomeLostPermission(t *testing.T) {
	for _, test := range []struct {
		name, dropped string
		kind          wh.OwnerKind
	}{
		{"personal owner storage", "users", wh.PersonalOwner},
		{"shared owner storage", "teams", wh.TeamOwner},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, actor, team := storeTeamFixture(t)
			ctx := context.Background()
			owner := wh.Owner{Kind: test.kind, ID: actor.UserID}
			if owner.Kind == wh.TeamOwner {
				owner.ID = team.ID
			}
			tx, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			err = transact(ctx, tx, func(raw pgx.Tx) error {
				if _, err := raw.Exec(ctx, "DROP TABLE "+pgx.Identifier{test.dropped}.Sanitize()+" CASCADE"); err != nil {
					return err
				}
				access, err := pgwebhook.NewReader(raw).OwnerAccess(ctx, owner, actor.UserID)
				if access.CanRead || access.CanManage {
					t.Fatalf("failed permission query published access: %#v", access)
				}
				return err
			})
			var driver *pgconn.PgError
			failed, state := store.DatabaseErrorFacts(err)
			if !errors.As(err, &driver) || driver.Code != "42P01" || !failed || state != "42P01" {
				t.Fatalf("owner storage failure lost its cause: %v", err)
			}
			if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
				access, err := scope.WebhookDAO().OwnerAccess(ctx, owner, actor.UserID)
				if err == nil && (!access.CanRead || !access.CanManage) {
					t.Fatalf("owner access failed to recover after rollback: %#v", access)
				}
				return err
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
	t.Run("unrecognized persisted owner", func(t *testing.T) {
		database, actor, _, _ := webhookStoredFailureFixture(t)
		err := database.ReadSnapshot(context.Background(), func(scope store.SnapshotScope) error {
			access, err := scope.WebhookDAO().OwnerAccess(context.Background(), wh.Owner{Kind: "unrecognized", ID: actor.UserID}, actor.UserID)
			if access.CanRead || access.CanManage {
				t.Fatalf("unrecognized owner published access: %#v", access)
			}
			return err
		})
		if err == nil {
			t.Fatal("unrecognized owner became an ordinary denied permission")
		}
	})
}

func TestWebhookConfigurationReadsRejectPartialStreams(t *testing.T) {
	database, _, _, endpoint := webhookStoredFailureFixture(t)
	ctx := context.Background()
	for _, stage := range []struct {
		name   string
		packet int
	}{{"signing keys", 1}, {"subscriptions", 2}, {"event bindings", 3}} {
		for _, mode := range []string{"query", "scan", "stream"} {
			t.Run(stage.name+" "+mode, func(t *testing.T) {
				tx, err := database.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				err = transact(ctx, tx, func(raw pgx.Tx) error {
					wrapped := &faultQueryTx{Tx: raw, failAt: stage.packet, scan: mode == "scan", iteration: mode == "stream"}
					result, err := pgwebhook.NewReader(wrapped).Endpoint(ctx, endpoint.Owner, endpoint.ID)
					if !reflect.DeepEqual(result, wh.Endpoint{}) {
						t.Fatalf("failed %s read published a partial endpoint: %#v", stage.name, result)
					}
					return err
				})
				if !errors.Is(err, injectedReadFailure) {
					t.Fatalf("configuration read lost its original failure: %v", err)
				}
				if result := readStoredWebhook(t, database, endpoint.Owner, endpoint.ID); !reflect.DeepEqual(result, endpoint) {
					t.Fatalf("read failure changed stored configuration: %#v", result)
				}
			})
		}
	}
}

func TestWebhookConfigurationLocksPropagateStreamAndSourceFailures(t *testing.T) {
	database, _, project, endpoint := webhookStoredFailureFixture(t)
	ctx := context.Background()
	for _, stage := range []struct {
		name   string
		packet int
	}{{"subscriptions", 1}, {"event bindings", 2}} {
		for _, mode := range []string{"query", "scan", "stream"} {
			t.Run(stage.name+" "+mode, func(t *testing.T) {
				tx, err := database.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				err = transact(ctx, tx, func(raw pgx.Tx) error {
					wrapped := &faultQueryTx{Tx: raw, failAt: stage.packet, scan: mode == "scan", iteration: mode == "stream"}
					dao := pgwebhook.NewWriter(wrapped, endpoint.Owner, uuid.NewString())
					return dao.LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: endpoint.Owner, ActorUserID: endpoint.Owner.ID, EndpointID: endpoint.ID})
				})
				if !errors.Is(err, injectedReadFailure) {
					t.Fatalf("configuration lock lost its failure: %v", err)
				}
			})
		}
	}
	for _, test := range []struct {
		name     string
		request  store.WebhookConfigurationLock
		mutation string
	}{
		{"required Project is absent", store.WebhookConfigurationLock{Owner: endpoint.Owner, ActorUserID: endpoint.Owner.ID, ProjectIDs: []string{uuid.NewString()}, Expansion: true}, ""},
		{"live ownership is absent", store.WebhookConfigurationLock{Owner: endpoint.Owner, ActorUserID: endpoint.Owner.ID, ProjectIDs: []string{project.ID}, RequiredProjectIDs: []string{project.ID}, Expansion: true}, "DELETE FROM project_ownership"},
		{"required Team is absent", store.WebhookConfigurationLock{Owner: wh.Owner{Kind: wh.TeamOwner, ID: uuid.NewString()}, ActorUserID: endpoint.Owner.ID}, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := test.request
			if test.name == "required Project is absent" {
				request.RequiredProjectIDs = request.ProjectIDs
			}
			tx, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			err = transact(ctx, tx, func(raw pgx.Tx) error {
				if test.mutation != "" {
					if _, err := raw.Exec(ctx, test.mutation); err != nil {
						return err
					}
				}
				return pgwebhook.NewWriter(raw, request.Owner, uuid.NewString()).LockConfiguration(ctx, request)
			})
			if err == nil || !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("missing mandatory source was accepted: %v", err)
			}
		})
	}
}

func TestWebhookWriterFailuresRollbackConfigurationAndReservation(t *testing.T) {
	for _, test := range []struct{ name, operation string }{
		{"create before reservation", "unreserved create"},
		{"save before reservation", "unreserved save"},
		{"create policy read", "create policy"},
		{"create endpoint count", "create count"},
		{"create SQL refusal", "create SQL"},
		{"create empty event selection", "create selection"},
		{"save partial prior configuration", "save read"},
		{"save policy read", "save policy"},
		{"save SQL refusal", "save SQL"},
		{"receipt before reservation", "unreserved receipt"},
		{"receipt fingerprint damage", "receipt fingerprint"},
		{"receipt SQL refusal", "receipt SQL"},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, actor, project, original := webhookStoredFailureFixture(t)
			ctx := context.Background()
			desired := storedWebhook(t, actor, project)
			before := wh.Endpoint{}
			if test.operation == "unreserved save" || test.operation == "save read" || test.operation == "save policy" || test.operation == "save SQL" {
				before, desired = original, original
				desired.ConfigVersion++
				desired.Name = "Updated notifications"
			}
			receipt := webhookReceipt(desired, uuid.NewString())
			tx, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			err = transact(ctx, tx, func(raw pgx.Tx) error {
				if test.operation == "unreserved create" {
					return pgwebhook.NewWriter(raw, desired.Owner, receipt.OperationID).InsertEndpoint(ctx, desired)
				}
				if test.operation == "unreserved save" {
					return pgwebhook.NewWriter(raw, desired.Owner, receipt.OperationID).SaveEndpoint(ctx, desired, 1)
				}
				if test.operation == "unreserved receipt" {
					return pgwebhook.NewWriter(raw, desired.Owner, receipt.OperationID).InsertOperation(ctx, receipt)
				}
				wrapped := &faultQueryTx{Tx: raw}
				dao, err := reserveWebhookFailureDAO(ctx, wrapped, before, desired, receipt)
				if err != nil {
					return err
				}
				switch test.operation {
				case "create policy", "save policy":
					if _, err := raw.Exec(ctx, "DROP TABLE webhook_policies"); err != nil {
						return err
					}
				case "create count":
					if _, err := raw.Exec(ctx, "DROP TABLE webhook_endpoints"); err != nil {
						return err
					}
				case "create SQL", "save SQL", "receipt SQL":
					table, event := "webhook_endpoints", "INSERT"
					if test.operation == "save SQL" {
						event = "UPDATE"
					}
					if test.operation == "receipt SQL" {
						table = "webhook_operations"
					}
					if _, err := raw.Exec(ctx, `CREATE FUNCTION refuse_webhook_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Webhook storage refusal' USING ERRCODE='23514'; END $$; CREATE TRIGGER refuse_webhook_write BEFORE `+event+` ON `+table+` FOR EACH ROW EXECUTE FUNCTION refuse_webhook_write()`); err != nil {
						return err
					}
				case "create selection":
					desired.Subscriptions[0].Bindings = []wh.Binding{}
				case "save read":
					wrapped.calls, wrapped.failAt = 0, 1
				case "receipt fingerprint":
					receipt.Fingerprint = "damaged"
				}
				if before.ID != "" {
					return dao.SaveEndpoint(ctx, desired, before.ConfigVersion)
				}
				if err := dao.InsertEndpoint(ctx, desired); err != nil {
					return err
				}
				return dao.InsertOperation(ctx, receipt)
			})
			var completion *store.TransactionError
			if err == nil || !errors.As(err, &completion) || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("failed writer did not roll back: %v", err)
			}
			if test.operation == "save read" && !errors.Is(err, injectedReadFailure) {
				t.Fatalf("prior read failure lost its cause: %v", err)
			}
			if test.operation == "create policy" || test.operation == "create count" || test.operation == "save policy" || test.operation == "create SQL" || test.operation == "save SQL" || test.operation == "receipt SQL" {
				var driver *pgconn.PgError
				if !errors.As(err, &driver) || driver.Code != "42P01" && driver.Code != "23514" {
					t.Fatalf("database refusal lost its driver cause: %v", err)
				}
			}
			if got := readStoredWebhook(t, database, original.Owner, original.ID); !reflect.DeepEqual(got, original) {
				t.Fatalf("failed writer changed original configuration: %#v", got)
			}
			var endpoints, operations, ownerSlots int64
			if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_endpoints),(SELECT count(*) FROM webhook_operations),operations_used FROM webhook_quota_owners WHERE owner_kind=$1 AND owner_id=$2`, original.Owner.Kind, original.Owner.ID).Scan(&endpoints, &operations, &ownerSlots); err != nil {
				t.Fatal(err)
			}
			if endpoints != 1 || operations != 1 || ownerSlots != 1 {
				t.Fatalf("writer refusal retained a partial effect: endpoints=%d operations=%d ownerSlots=%d", endpoints, operations, ownerSlots)
			}
		})
	}
}

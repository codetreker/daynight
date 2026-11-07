package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	wh "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestWebhookAdvisoryAndObservationFailuresCannotConfirmWrites(t *testing.T) {
	t.Run("advisory cancellation", func(t *testing.T) {
		database := isolatedStore(t)
		tx, err := database.Pool.Begin(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		called := false
		err = writeWebhookTx(ctx, tx, wh.Owner{Kind: wh.PersonalOwner, ID: uuid.NewString()}, uuid.NewString(), func(store.WebhookWriteScope) error { called = true; return nil })
		completion, err := teamCompletion("Webhook write", err)
		if called || !errors.Is(err, context.Canceled) || completion.Outcome != store.TransactionNotCommitted {
			t.Fatalf("advisory failure admitted an effect: called=%t completion=%#v err=%v", called, completion, err)
		}
	})
	t.Run("observation cancellation", func(t *testing.T) {
		database := isolatedStore(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		observed := false
		completion, err := database.WriteWebhook(ctx, wh.Owner{Kind: wh.PersonalOwner, ID: uuid.NewString()}, uuid.NewString(), func(scope store.WebhookWriteScope) error {
			before, err := scope.ObservedAt(ctx)
			_, offset := before.Zone()
			if err != nil || before.IsZero() || offset != 0 {
				t.Fatalf("valid database observation was not UTC: %s %v", before, err)
			}
			cancel()
			now, err := scope.ObservedAt(ctx)
			observed = true
			if !now.IsZero() || !errors.Is(err, context.Canceled) {
				t.Fatalf("failed observation manufactured a clock: %s %v", now, err)
			}
			return err
		})
		if !observed || !errors.Is(err, context.Canceled) || completion.Outcome != store.TransactionNotCommitted {
			t.Fatalf("observation failure confirmed a write: %#v %v", completion, err)
		}
	})
	t.Run("closed persistence", func(t *testing.T) {
		database := isolatedStore(t)
		database.Close()
		called := false
		completion, err := database.WriteWebhook(context.Background(), wh.Owner{Kind: wh.PersonalOwner, ID: uuid.NewString()}, uuid.NewString(), func(store.WebhookWriteScope) error { called = true; return nil })
		failed, _ := store.DatabaseErrorFacts(err)
		if err == nil || called || !failed || completion.Outcome != store.TransactionNotCommitted {
			t.Fatalf("unavailable persistence accepted mutation: called=%t completion=%#v err=%v", called, completion, err)
		}
	})
}

func webhookEligibilityFailureFixture(t *testing.T) (*Store, model.Principal, model.Project, wh.Endpoint) {
	t.Helper()
	database, _, target, project := membershipFixture(t)
	ctx := context.Background()
	if _, err := database.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
		_, err := scope.ProjectDAO().CreateGrant(ctx, target.UserID, model.ProjectMemberRole)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	endpoint := storedWebhook(t, target, project)
	receipt := webhookReceipt(endpoint, uuid.NewString())
	if _, err := database.WriteWebhook(ctx, endpoint.Owner, receipt.OperationID, func(scope store.WebhookWriteScope) error { return insertStoredWebhook(ctx, scope, endpoint, receipt) }); err != nil {
		t.Fatal(err)
	}
	return database, target, project, endpoint
}

func requireWebhookEligibilitySourceRollback(t *testing.T, database *Store, target model.Principal, project model.Project, endpoint wh.Endpoint) {
	t.Helper()
	var grants int64
	var state wh.AuthorizationState
	var epoch int64
	if err := database.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2),authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$3`, project.ID, target.UserID, endpoint.Subscriptions[0].ID).Scan(&grants, &state, &epoch); err != nil {
		t.Fatal(err)
	}
	if grants != 1 || state != wh.AuthorizationActive || epoch != 1 {
		t.Fatalf("failed eligibility refresh left partial source effect: grants=%d state=%s epoch=%d", grants, state, epoch)
	}
}

func TestWebhookEligibilityStreamFailuresRollBackTheAccessSource(t *testing.T) {
	for _, test := range []struct {
		name         string
		query        int
		scan, stream bool
	}{
		{"subscription query", 1, false, false}, {"subscription scan", 1, true, false}, {"subscription stream", 1, false, true},
		{"current qualification query", 2, false, false}, {"current qualification scan", 2, true, false}, {"current qualification stream", 2, false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, target, project, endpoint := webhookEligibilityFailureFixture(t)
			ctx := context.Background()
			completion, err := database.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
				if err := scope.ProjectDAO().RemoveMember(ctx, target.UserID); err != nil {
					return err
				}
				raw := scope.(*ProjectTx).tx
				eligibility := pgwebhook.NewEligibility(&faultQueryTx{Tx: raw, failAt: test.query, scan: test.scan, iteration: test.stream})
				return eligibility.RefreshAffected(ctx, store.WebhookEligibilityChange{ProjectIDs: []string{project.ID}})
			})
			if !errors.Is(err, injectedReadFailure) || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("eligibility read failure became acceptance: %#v %v", completion, err)
			}
			requireWebhookEligibilitySourceRollback(t, database, target, project, endpoint)
		})
	}
}

func TestWebhookEligibilityWriteFailureKeepsOriginalDriverCause(t *testing.T) {
	database, target, project, endpoint := webhookEligibilityFailureFixture(t)
	ctx := context.Background()
	if _, err := database.Pool.Exec(ctx, `CREATE FUNCTION reject_webhook_eligibility() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'eligibility persistence refused'; END $$;
        CREATE TRIGGER reject_webhook_eligibility BEFORE UPDATE ON webhook_subscriptions FOR EACH ROW EXECUTE FUNCTION reject_webhook_eligibility()`); err != nil {
		t.Fatal(err)
	}
	completion, err := database.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
		if err := scope.ProjectDAO().RemoveMember(ctx, target.UserID); err != nil {
			return err
		}
		return scope.WebhookEligibilityDAO().RefreshAffected(ctx, store.WebhookEligibilityChange{ProjectIDs: []string{project.ID}})
	})
	var driver *pgconn.PgError
	failed, state := store.DatabaseErrorFacts(err)
	if !errors.As(err, &driver) || driver.Code != "P0001" || !failed || state != "P0001" || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("eligibility failure lost driver facts: %#v %v", completion, err)
	}
	requireWebhookEligibilitySourceRollback(t, database, target, project, endpoint)
}

func TestWebhookEligibilityCorruptionCannotMasqueradeAsRevocation(t *testing.T) {
	for _, test := range []struct{ name, damage string }{
		{"live ownership", `DELETE FROM project_ownership WHERE project_id=$1`},
		{"authorization state", `ALTER TABLE webhook_subscriptions DROP CONSTRAINT webhook_subscriptions_authorization_state_check; UPDATE webhook_subscriptions SET authorization_state='broken'`},
		{"authorization epoch", `ALTER TABLE webhook_subscriptions DROP CONSTRAINT webhook_subscriptions_authorization_epoch_check; UPDATE webhook_subscriptions SET authorization_epoch=0`},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, target, project, endpoint := webhookEligibilityFailureFixture(t)
			ctx := context.Background()
			var err error
			if test.name == "live ownership" {
				_, err = database.Pool.Exec(ctx, test.damage, project.ID)
			} else {
				_, err = database.Pool.Exec(ctx, test.damage)
			}
			if err != nil {
				t.Fatal(err)
			}
			completion, err := database.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
				if err := scope.ProjectDAO().RemoveMember(ctx, target.UserID); err != nil {
					return err
				}
				return scope.WebhookEligibilityDAO().RefreshAffected(ctx, store.WebhookEligibilityChange{ProjectIDs: []string{project.ID}})
			})
			failed, _ := store.DatabaseErrorFacts(err)
			var refusal *model.Fault
			if err == nil || !failed || errors.As(err, &refusal) || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("damaged qualification became ordinary refusal: %#v %v", completion, err)
			}
			var grants int64
			if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, target.UserID).Scan(&grants); err != nil || grants != 1 {
				t.Fatalf("source mutation survived damaged qualification: %d %v", grants, err)
			}
			if test.name == "live ownership" {
				requireWebhookEligibilitySourceRollback(t, database, target, project, endpoint)
			}
		})
	}
}

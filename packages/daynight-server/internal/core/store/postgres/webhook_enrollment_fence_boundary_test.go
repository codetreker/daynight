package postgres

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type enrollmentFenceOutcome struct {
	completion store.Completion
	err        error
}

func enrollmentFenceStore(t *testing.T, base *Store) (*Store, uint32) {
	t.Helper()
	config := base.Pool.Config().Copy()
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var pid uint32
	if err = pool.QueryRow(t.Context(), `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	return &Store{Pool: pool}, pid
}

func awaitEnrollmentProjectFence(t *testing.T, ctx context.Context, observer *Store, blocker, reader uint32, query string, result <-chan enrollmentFenceOutcome) {
	t.Helper()
	for {
		var blocked bool
		var active string
		if err := observer.Pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2)),query FROM pg_stat_activity WHERE pid=$2`, blocker, reader).Scan(&blocked, &active); err != nil {
			t.Fatal(err)
		}
		if blocked {
			if active != query {
				t.Fatalf("wait was not on the production Project fence: %q", active)
			}
			return
		}
		select {
		case got := <-result:
			t.Fatalf("operation completed before Project fence wait: %v %v", got.completion, got.err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestWebhookEnrollmentAndGrantRevocationFenceAbsentSubscription(t *testing.T) {
	for _, first := range []string{"enrollment", "revocation"} {
		t.Run(first, func(t *testing.T) {
			base := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
			defer cancel()
			target, team, project := uuid.NewString(), uuid.NewString(), uuid.NewString()
			mustQueryExec(t, base, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, target)
			mustQueryExec(t, base, `INSERT INTO teams(id,name) VALUES($1,'source owner')`, team)
			mustQueryExec(t, base, `INSERT INTO projects(id,name,repo_url) VALUES($1,'source','https://example.org')`, project)
			mustQueryExec(t, base, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team)
			mustQueryExec(t, base, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project, target)
			enrollment, enrollmentPID := enrollmentFenceStore(t, base)
			revocation, revocationPID := enrollmentFenceStore(t, base)
			owner, endpoint, key, receipt := webhookStoredFixture(t)
			owner = wm.Owner{Kind: "personal", ID: target}
			endpoint.Owner, key.EndpointID = owner, endpoint.ID
			receipt.Owner, receipt.ActorID = owner, target
			sub := wm.Subscription{ID: uuid.NewString(), EndpointID: endpoint.ID, ProjectID: project, Owner: owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: receipt.RecordedAt, UpdatedAt: receipt.RecordedAt}
			binding := wm.Binding{ID: uuid.NewString(), SubscriptionID: sub.ID, EventType: "task.created", CreatedAt: receipt.RecordedAt}
			held, release, preRead := make(chan struct{}), make(chan struct{}), make(chan string, 1)
			var releaseOnce sync.Once
			var enrollmentDone, revocationDone <-chan struct{}
			defer func() {
				cancel()
				releaseOnce.Do(func() { close(release) })
				cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
				defer stop()
				for _, done := range []<-chan struct{}{enrollmentDone, revocationDone} {
					if done == nil {
						continue
					}
					select {
					case <-done:
					case <-cleanup.Done():
						t.Error("enrollment boundary transaction did not drain")
					}
				}
			}()
			accessRevoked := errors.New("enrollment source access revoked")
			startEnrollment := func() <-chan enrollmentFenceOutcome {
				result, done := make(chan enrollmentFenceOutcome, 1), make(chan struct{})
				enrollmentDone = done
				go func() {
					defer close(done)
					completion, err := enrollment.WriteWebhook(ctx, owner, receipt.ID, func(sc store.WebhookWriteScope) error {
						before, err := sc.EligibilityDAO().ReadEligibility(ctx, owner, project, target)
						if err != nil {
							return err
						}
						preRead <- before.Status
						if err = sc.LockConfigurationSources(ctx, owner, target, []string{project}); err != nil {
							return err
						}
						current, err := sc.EligibilityDAO().ReadEligibility(ctx, owner, project, target)
						if err != nil {
							return err
						}
						if current.Status != "eligible" {
							return accessRevoked
						}
						if first == "enrollment" {
							close(held)
							select {
							case <-release:
							case <-ctx.Done():
								return ctx.Err()
							}
						}
						w := sc.WebhookWriter()
						if err = w.PutEndpoint(ctx, endpoint); err != nil {
							return err
						}
						if err = w.PutSigningKey(ctx, key); err != nil {
							return err
						}
						if err = w.PutSubscription(ctx, sub); err != nil {
							return err
						}
						if err = w.PutBinding(ctx, binding); err != nil {
							return err
						}
						return w.PutOperation(ctx, receipt)
					})
					result <- enrollmentFenceOutcome{completion, err}
				}()
				return result
			}
			startRevocation := func() <-chan enrollmentFenceOutcome {
				result, done := make(chan enrollmentFenceOutcome, 1), make(chan struct{})
				revocationDone = done
				go func() {
					defer close(done)
					completion, err := revocation.WriteProject(ctx, project, func(sc store.ProjectWriteScope) error {
						if err := sc.ProjectDAO().RemoveMember(ctx, target); err != nil {
							return err
						}
						dao := sc.EligibilityDAO()
						rows, err := dao.LockAffected(ctx, store.WebhookEligibilityFilter{ProjectID: project, UserID: target})
						if err != nil {
							return err
						}
						current, err := dao.ReadEligibility(ctx, owner, project, target)
						if err != nil {
							return err
						}
						if current.Status != "access_revoked" {
							return fmt.Errorf("grant removal did not change current eligibility: %s", current.Status)
						}
						if first == "revocation" {
							if len(rows) != 0 {
								return fmt.Errorf("subscription already existed before enrollment")
							}
							close(held)
							select {
							case <-release:
							case <-ctx.Done():
								return ctx.Err()
							}
						} else {
							if len(rows) != 1 || rows[0].ID != sub.ID || rows[0].State != "active" || rows[0].Epoch != 1 {
								return fmt.Errorf("waiting revocation missed new committed subscription: %+v", rows)
							}
							if err = dao.Revoke(ctx, rows[0].ID, rows[0].Epoch); err != nil {
								return err
							}
						}
						return nil
					})
					result <- enrollmentFenceOutcome{completion, err}
				}()
				return result
			}
			waitHeld := func(result <-chan enrollmentFenceOutcome) {
				t.Helper()
				select {
				case <-held:
				case got := <-result:
					t.Fatalf("transaction failed before held boundary: %v %v", got.completion, got.err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
			var enrolled, revoked <-chan enrollmentFenceOutcome
			if first == "enrollment" {
				enrolled = startEnrollment()
				waitHeld(enrolled)
				var absent int
				if err := base.Pool.QueryRow(ctx, `SELECT count(*) FROM webhook_subscriptions WHERE owner_id=$1`, target).Scan(&absent); err != nil || absent != 0 {
					t.Fatalf("enrollment fence did not precede insertion: %d %v", absent, err)
				}
				revoked = startRevocation()
				awaitEnrollmentProjectFence(t, ctx, base, enrollmentPID, revocationPID, `SELECT id::text FROM projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, revoked)
			} else {
				revoked = startRevocation()
				waitHeld(revoked)
				enrolled = startEnrollment()
				select {
				case status := <-preRead:
					if status != "eligible" {
						t.Fatalf("enrollment pre-read did not see original grant: %s", status)
					}
				case got := <-enrolled:
					t.Fatalf("enrollment ended before pre-read: %v", got.err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				awaitEnrollmentProjectFence(t, ctx, base, revocationPID, enrollmentPID, `SELECT deleted_at IS NOT NULL FROM projects WHERE id=$1 FOR UPDATE`, enrolled)
			}
			releaseOnce.Do(func() { close(release) })
			var enrollmentResult, revocationResult enrollmentFenceOutcome
			select {
			case enrollmentResult = <-enrolled:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			select {
			case revocationResult = <-revoked:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if revocationResult.err != nil || revocationResult.completion.Outcome != store.TransactionCommitted {
				t.Fatalf("revocation completion: %v %v", revocationResult.completion, revocationResult.err)
			}
			if first == "enrollment" {
				if enrollmentResult.err != nil || enrollmentResult.completion.Outcome != store.TransactionCommitted {
					t.Fatalf("enrollment completion: %v %v", enrollmentResult.completion, enrollmentResult.err)
				}
				if err := base.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
					rows, err := sc.WebhookDAO().Subscriptions(ctx, endpoint.ID)
					if err != nil {
						return err
					}
					if len(rows) != 1 || rows[0].ID != sub.ID || rows[0].AuthorizationState != "confirmation_required" || rows[0].AuthorizationEpoch != 2 {
						return fmt.Errorf("enrollment-first committed state: %+v", rows)
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			} else {
				if !errors.Is(enrollmentResult.err, accessRevoked) || enrollmentResult.completion.Outcome != store.TransactionNotCommitted {
					t.Fatalf("locked eligibility did not reject enrollment: %v %v", enrollmentResult.completion, enrollmentResult.err)
				}
				var endpoints, keys, subscriptions, bindings, receipts int
				if err := base.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1),(SELECT count(*) FROM webhook_signing_keys WHERE endpoint_id=$2),(SELECT count(*) FROM webhook_subscriptions WHERE owner_id=$1),(SELECT count(*) FROM webhook_bindings WHERE subscription_id=$3),(SELECT count(*) FROM webhook_operations WHERE owner_id=$1)`, target, endpoint.ID, sub.ID).Scan(&endpoints, &keys, &subscriptions, &bindings, &receipts); err != nil || endpoints+keys+subscriptions+bindings+receipts != 0 {
					t.Fatalf("revocation-first produced effects: %d/%d/%d/%d/%d error=%v", endpoints, keys, subscriptions, bindings, receipts, err)
				}
			}
			var grants int
			if err := base.Pool.QueryRow(ctx, `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2`, project, target).Scan(&grants); err != nil || grants != 0 {
				t.Fatalf("grant revocation was not committed: %d %v", grants, err)
			}
		})
	}
}

package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func webhookStoredFixture(t *testing.T) (webhook.Owner, webhook.Endpoint, webhook.SigningKey, webhook.Operation) {
	t.Helper()
	owner := webhook.Owner{Kind: "personal", ID: uuid.NewString()}
	id, keyID := uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	configuration := []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://example.org/hook"}}`)
	endpoint := webhook.Endpoint{ID: id, Owner: owner, Name: "sample", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://example.org", DestinationConfiguration: configuration, ActiveKeyID: keyID, CreatedAt: now, UpdatedAt: now}
	key := webhook.SigningKey{EndpointID: id, ID: keyID, Slot: "current", Secret: bytes.Repeat([]byte{2}, 32), CreatedAt: now}
	receipt := webhook.Operation{Owner: owner, ID: uuid.NewString(), ActorID: owner.ID, Kind: "endpoint.create", TargetID: id, IssuedAt: now.Format(time.RFC3339Nano), RequestSHA256: strings.Repeat("a", 64), Fingerprint: strings.Repeat("b", 64), Effect: "applied", ConfigVersion: 1, DestinationRevisionAfter: 1, RecordedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour)}
	return owner, endpoint, key, receipt
}

func TestWebhookReceiptInsertFailureRollsBackEffects(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	owner, endpoint, key, initial := webhookStoredFixture(t)
	completion, err := s.WriteWebhook(ctx, owner, initial.ID, func(sc store.WebhookWriteScope) error {
		dao := sc.WebhookWriter()
		if err := dao.PutEndpoint(ctx, endpoint); err != nil {
			return err
		}
		if err := dao.PutSigningKey(ctx, key); err != nil {
			return err
		}
		return dao.PutOperation(ctx, initial)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("setup: %v %v", completion, err)
	}
	mustQueryExec(t, s, `CREATE FUNCTION reject_webhook_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1901', MESSAGE='receipt storage failure'; END $$; CREATE TRIGGER reject_webhook_receipt BEFORE INSERT ON webhook_operations FOR EACH ROW EXECUTE FUNCTION reject_webhook_receipt()`)
	originalSecret := bytes.Clone(key.Secret)
	endpoint.Name, endpoint.ConfigVersion = "changed", 2
	key.Secret = bytes.Clone(key.Secret)
	key.Secret[len(key.Secret)-1] ^= 1
	receipt := initial
	receipt.ID, receipt.Kind, receipt.ConfigVersion = uuid.NewString(), "endpoint.update", 2
	completion, err = s.WriteWebhook(ctx, owner, receipt.ID, func(sc store.WebhookWriteScope) error {
		dao := sc.WebhookWriter()
		if err := dao.PutEndpoint(ctx, endpoint); err != nil {
			return err
		}
		if err := dao.PutSigningKey(ctx, key); err != nil {
			return err
		}
		return dao.PutOperation(ctx, receipt)
	})
	failed, code := store.DatabaseErrorFacts(err)
	if completion.Outcome != store.TransactionNotCommitted || !failed || code != "P1901" {
		t.Fatalf("completion=%v database=%v code=%s error=%v", completion, failed, code, err)
	}
	if err := s.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		got, err := sc.WebhookDAO().Endpoint(ctx, owner, endpoint.ID)
		if err != nil {
			return err
		}
		keys, err := sc.WebhookDAO().SigningKeys(ctx, endpoint.ID)
		if err != nil {
			return err
		}
		if got.Name != "sample" || got.ConfigVersion != 1 || len(keys) != 1 || !bytes.Equal(keys[0].Secret, originalSecret) {
			t.Fatalf("partial effects: endpoint=%#v keys=%#v", got, keys)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var receipts int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM webhook_operations`).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 1 {
		t.Fatalf("receipt count=%d", receipts)
	}
}

func TestWebhookOperationFenceCanonicalUUID(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	o := webhook.Owner{Kind: "personal", ID: uuid.NewString()}
	id := uuid.NewString()
	locked := make(chan struct{})
	release := make(chan struct{})
	entered := make(chan struct{})
	result := make(chan error, 2)
	go func() {
		_, err := s.WriteWebhook(ctx, o, id, func(store.WebhookWriteScope) error { close(locked); <-release; return nil })
		result <- err
	}()
	<-locked
	go func() {
		upper := o
		upper.ID = strings.ToUpper(o.ID)
		_, err := s.WriteWebhook(ctx, upper, strings.ToUpper(id), func(store.WebhookWriteScope) error { close(entered); return nil })
		result <- err
	}()
	blocked := false
	for i := 0; i < 100; i++ {
		var count int
		if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			blocked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case <-entered:
		t.Fatal("same operation passed fence")
	default:
	}
	close(release)
	if !blocked {
		t.Fatal("same operation did not block on fence")
	}
	for i := 0; i < 2; i++ {
		if err := <-result; err != nil {
			t.Fatal(err)
		}
	}
}

func TestWebhookAuthorityRecheckedAfterTeamLockWait(t *testing.T) {
	s, actor, team := storeTeamFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, team.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, team.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := s.WriteWebhook(ctx, webhook.Owner{Kind: "team", ID: team.ID}, uuid.NewString(), func(sc store.WebhookWriteScope) error {
			if err := sc.LockAuthority(ctx, webhook.Owner{Kind: "team", ID: team.ID}, actor.UserID); err != nil {
				return err
			}
			current, err := sc.TeamDAO().Team(ctx, actor.UserID, team.ID)
			if err != nil {
				return err
			}
			if string(current.Membership.Role) != "member" {
				return errors.New("stale team membership")
			}
			_, err = sc.LockCredential(ctx, actor)
			return err
		})
		result <- err
	}()
	blocked := false
	for i := 0; i < 100; i++ {
		var count int
		if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			blocked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("authority lock did not wait")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestWebhookAuthorityRejectsMissingContainers(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	user := uuid.NewString()
	base := webhook.Owner{Kind: "personal", ID: user}
	team := uuid.NewString()
	mustQueryExec(t, s, `INSERT INTO teams(id,name) VALUES($1,'Team')`, team)
	for _, target := range []webhook.Owner{{Kind: "personal", ID: uuid.NewString()}, {Kind: "invalid", ID: user}, {Kind: "team", ID: uuid.NewString()}, {Kind: "team", ID: team}} {
		completion, err := s.WriteWebhook(ctx, base, uuid.NewString(), func(sc store.WebhookWriteScope) error { return sc.LockAuthority(ctx, target, user) })
		if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("owner %#v: %v %v", target, completion, err)
		}
	}
}

func TestWebhookCredentialObservationAfterRowLockWait(t *testing.T) {
	for _, mode := range []string{"natural expiry", "revocation"} {
		t.Run(mode, func(t *testing.T) {
			s := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
			defer cancel()
			user, session := uuid.NewString(), uuid.NewString()
			mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, user)
			var expiry time.Time
			if err := s.Pool.QueryRow(ctx, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,decode(repeat('ab',32),'hex'),now(),clock_timestamp()+CASE WHEN $3='natural expiry' THEN interval '500 milliseconds' ELSE interval '1 day' END) RETURNING expires_at`, session, user, mode).Scan(&expiry); err != nil {
				t.Fatal(err)
			}
			locked, err := s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer locked.Rollback(context.Background())
			if _, err = locked.Exec(ctx, `SELECT id FROM sessions WHERE id=$1 FOR UPDATE`, session); err != nil {
				t.Fatal(err)
			}
			blocker := locked.Conn().PgConn().PID()
			started := make(chan uint32, 1)
			results := make(chan error, 1)
			principal := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: session}
			go func() {
				completion, err := s.WriteWebhook(ctx, webhook.Owner{Kind: "personal", ID: user}, uuid.NewString(), func(sc store.WebhookWriteScope) error {
					started <- sc.(*webhookScope).tx.Conn().PgConn().PID()
					credential, err := sc.LockCredential(ctx, principal)
					if mode == "revocation" {
						if err == nil {
							return fmt.Errorf("revoked credential remained readable")
						}
						if !errors.Is(err, model.ErrNotFound) {
							return err
						}
						return nil
					}
					if err != nil {
						return err
					}
					observed, err := sc.ObservedAt(ctx)
					if err != nil {
						return err
					}
					if credential.ExpiresAt == nil || !credential.ExpiresAt.Equal(expiry) || observed.Before(expiry) {
						return fmt.Errorf("lock wait did not expose current credential time: expiry=%v observed=%v", credential.ExpiresAt, observed)
					}
					return nil
				})
				if err == nil && completion.Outcome != store.TransactionCommitted {
					err = fmt.Errorf("observation transaction: %v", completion)
				}
				results <- err
			}()
			var reader uint32
			select {
			case reader = <-started:
			case err := <-results:
				t.Fatalf("credential read failed before lock: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			for {
				var blocked bool
				if err = s.Pool.QueryRow(ctx, `SELECT $1::integer = ANY(pg_blocking_pids($2))`, blocker, reader).Scan(&blocked); err != nil {
					t.Fatal(err)
				}
				if blocked {
					break
				}
				select {
				case err := <-results:
					t.Fatalf("credential read did not wait: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(5 * time.Millisecond):
				}
			}
			if mode == "revocation" {
				if _, err = locked.Exec(ctx, `DELETE FROM sessions WHERE id=$1`, session); err != nil {
					t.Fatal(err)
				}
			} else {
				var live bool
				if err = s.Pool.QueryRow(ctx, `SELECT clock_timestamp() < $1`, expiry).Scan(&live); err != nil || !live {
					t.Fatalf("credential expired before its lock wait was observed: live=%t err=%v", live, err)
				}
				for {
					var expired bool
					if err = s.Pool.QueryRow(ctx, `SELECT clock_timestamp() >= $1`, expiry).Scan(&expired); err != nil {
						t.Fatal(err)
					}
					if expired {
						break
					}
					select {
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					case <-time.After(5 * time.Millisecond):
					}
				}
			}
			if err = locked.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-results:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}

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
			owner = webhook.Owner{Kind: "personal", ID: target}
			endpoint.Owner, key.EndpointID = owner, endpoint.ID
			receipt.Owner, receipt.ActorID = owner, target
			sub := webhook.Subscription{ID: uuid.NewString(), EndpointID: endpoint.ID, ProjectID: project, Owner: owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: receipt.RecordedAt, UpdatedAt: receipt.RecordedAt}
			binding := webhook.Binding{ID: uuid.NewString(), SubscriptionID: sub.ID, EventType: "task.created", CreatedAt: receipt.RecordedAt}
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

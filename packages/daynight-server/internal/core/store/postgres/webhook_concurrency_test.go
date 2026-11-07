package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	whcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wh "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

type webhookAccessRace struct {
	database *Store
	admin    model.Principal
	member   model.Principal
	team     model.Team
	project  model.Project
	endpoint wh.Endpoint
}

func webhookAccessRaceFixture(t *testing.T, initial string, subscribed bool) webhookAccessRace {
	t.Helper()
	database, admin, team := storeTeamFixture(t)
	_, member, _ := testAuthRecords(t, database)
	project, _, err := database.CreateProjectInTeam(context.Background(), admin, uuid.NewString(), "Webhook access race", "https://example.com/race", &team.ID)
	if err != nil {
		t.Fatal(err)
	}
	fixture := webhookAccessRace{database: database, admin: admin, member: member, team: team, project: project}
	if _, err := fixture.change(context.Background(), initial, nil, nil); err != nil {
		t.Fatal(err)
	}
	fixture.endpoint = storedWebhook(t, member, project)
	if subscribed {
		receipt := webhookReceipt(fixture.endpoint, uuid.NewString())
		if _, err := database.WriteWebhook(context.Background(), fixture.endpoint.Owner, receipt.OperationID, func(scope store.WebhookWriteScope) error {
			return insertStoredWebhook(context.Background(), scope, fixture.endpoint, receipt)
		}); err != nil {
			t.Fatal(err)
		}
	}
	return fixture
}

func (f webhookAccessRace) change(ctx context.Context, kind string, beforeRefresh, afterRefresh func(uint32) error) (store.Completion, error) {
	if kind == "member-add" || kind == "member-remove" {
		return f.database.WriteTeam(ctx, f.team.ID, func(scope store.TeamWriteScope) error {
			var err error
			if kind == "member-add" {
				_, err = scope.TeamDAO().AddInvitedMember(ctx, f.member.UserID)
			} else {
				err = scope.TeamDAO().RemoveMember(ctx, f.member.UserID)
			}
			if err != nil {
				return err
			}
			pid := scope.(*teamWriteScope).tx.Conn().PgConn().PID()
			if beforeRefresh != nil {
				if err := beforeRefresh(pid); err != nil {
					return err
				}
			}
			if err := scope.WebhookEligibilityDAO().RefreshAffected(ctx, store.WebhookEligibilityChange{TeamIDs: []string{f.team.ID}, UserIDs: []string{f.member.UserID}}); err != nil {
				return err
			}
			if afterRefresh != nil {
				return afterRefresh(pid)
			}
			return nil
		})
	}
	if kind != "grant-add" && kind != "grant-remove" {
		return store.Completion{}, fmt.Errorf("unknown source mutation %q", kind)
	}
	return f.database.WriteProject(ctx, f.project.ID, func(scope store.ProjectWriteScope) error {
		var err error
		if kind == "grant-add" {
			_, err = scope.ProjectDAO().CreateGrant(ctx, f.member.UserID, model.ProjectMemberRole)
		} else {
			err = scope.ProjectDAO().RemoveMember(ctx, f.member.UserID)
		}
		if err != nil {
			return err
		}
		pid := scope.(*ProjectTx).tx.Conn().PgConn().PID()
		if beforeRefresh != nil {
			if err := beforeRefresh(pid); err != nil {
				return err
			}
		}
		if err := scope.WebhookEligibilityDAO().RefreshAffected(ctx, store.WebhookEligibilityChange{ProjectIDs: []string{f.project.ID}}); err != nil {
			return err
		}
		if afterRefresh != nil {
			return afterRefresh(pid)
		}
		return nil
	})
}

func awaitWebhookRelease(ctx context.Context, release <-chan struct{}) error {
	select {
	case <-release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func awaitWebhookRacePID(t *testing.T, ctx context.Context, ready <-chan uint32, done <-chan error) uint32 {
	t.Helper()
	select {
	case pid := <-ready:
		return pid
	case err := <-done:
		t.Fatalf("transaction ended before its required lock: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	return 0
}

func awaitWebhookRaceResult(t *testing.T, ctx context.Context, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	return ctx.Err()
}

func webhookRaceReadAccess(t *testing.T, ctx context.Context, f webhookAccessRace) bool {
	t.Helper()
	var canRead bool
	err := f.database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		facts, err := scope.WebhookDAO().Projects(ctx, f.endpoint.Owner, f.member.UserID, []string{f.project.ID})
		if err != nil {
			return err
		}
		if len(facts) != 1 {
			return errors.New("missing current Project qualification")
		}
		canRead = facts[0].CanRead
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return canRead
}

func TestWebhookConcurrentSourceHandoverUsesPostWaitPermissionUnion(t *testing.T) {
	for _, test := range []struct {
		name, initial, first, second string
		continuous                   bool
	}{
		{"grant commit before membership removal", "member-add", "grant-add", "member-remove", true},
		{"membership loss before grant commit", "member-add", "member-remove", "grant-add", false},
		{"membership commit before grant removal", "grant-add", "member-add", "grant-remove", true},
		{"grant loss before membership commit", "grant-add", "grant-remove", "member-add", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := webhookAccessRaceFixture(t, test.initial, true)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if !webhookRaceReadAccess(t, ctx, f) {
				t.Fatal("fixture has no initial qualification")
			}
			firstLocked := make(chan uint32, 1)
			firstRelease := make(chan struct{})
			firstDone := make(chan error, 1)
			go func() {
				_, err := f.change(ctx, test.first, nil, func(pid uint32) error { firstLocked <- pid; return awaitWebhookRelease(ctx, firstRelease) })
				firstDone <- err
			}()
			blocker := awaitWebhookRacePID(t, ctx, firstLocked, firstDone)
			secondChanged := make(chan uint32, 1)
			secondRefreshed := make(chan struct{}, 1)
			secondRelease := make(chan struct{})
			secondDone := make(chan error, 1)
			go func() {
				_, err := f.change(ctx, test.second, func(pid uint32) error { secondChanged <- pid; return nil }, func(uint32) error { secondRefreshed <- struct{}{}; return awaitWebhookRelease(ctx, secondRelease) })
				secondDone <- err
			}()
			awaitWebhookRacePID(t, ctx, secondChanged, secondDone)
			waitTransferTeamLock(t, ctx, f.database, "SELECT s.id::text FROM webhook_subscriptions", blocker)
			if !webhookRaceReadAccess(t, ctx, f) {
				t.Fatal("uncommitted handover removed visible qualification")
			}
			close(firstRelease)
			if err := awaitWebhookRaceResult(t, ctx, firstDone); err != nil {
				t.Fatal(err)
			}
			select {
			case <-secondRefreshed:
			case err := <-secondDone:
				t.Fatalf("second source failed before refresh: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if got := webhookRaceReadAccess(t, ctx, f); got != test.continuous {
				t.Fatalf("committed qualification gap=%t, wanted continuous=%t", !got, test.continuous)
			}
			close(secondRelease)
			if err := awaitWebhookRaceResult(t, ctx, secondDone); err != nil {
				t.Fatal(err)
			}
			if !webhookRaceReadAccess(t, ctx, f) {
				t.Fatal("final access source did not commit")
			}
			endpoint := readStoredWebhook(t, f.database, f.endpoint.Owner, f.endpoint.ID)
			subscription := endpoint.Subscriptions[0]
			state, epoch := wh.AuthorizationActive, int64(1)
			if !test.continuous {
				state, epoch = wh.AuthorizationConfirmationRequired, 2
			}
			if subscription.AuthorizationState != state || subscription.AuthorizationEpoch != epoch || subscription.Bindings[0].ID != f.endpoint.Subscriptions[0].Bindings[0].ID {
				t.Fatalf("handover destroyed its original continuity proof: %#v", subscription)
			}
		})
	}
}

func prepareWebhookEnrollment(ctx context.Context, scope store.WebhookWriteScope, f webhookAccessRace, operationID string) (wh.Endpoint, error) {
	dao := scope.WebhookDAO()
	if err := dao.LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: f.endpoint.Owner, ActorUserID: f.member.UserID, ProjectIDs: []string{f.project.ID}, RequiredProjectIDs: []string{f.project.ID}, Expansion: true}); err != nil {
		return wh.Endpoint{}, err
	}
	access, err := dao.OwnerAccess(ctx, f.endpoint.Owner, f.member.UserID)
	if err != nil {
		return wh.Endpoint{}, err
	}
	projects, err := dao.Projects(ctx, f.endpoint.Owner, f.member.UserID, []string{f.project.ID})
	if err != nil {
		return wh.Endpoint{}, err
	}
	now, err := scope.ObservedAt(ctx)
	if err != nil {
		return wh.Endpoint{}, err
	}
	digest := sha256.Sum256([]byte(operationID))
	input := whcore.CreateInput{Operation: whcore.Operation{ID: operationID, IssuedAt: now.Format(time.RFC3339Nano), ExpectedUserID: f.member.UserID, RequestSHA256: fmt.Sprintf("%x", digest)}, Name: "Enrollment", Enabled: true,
		Destination: wh.Destination{Kind: "http", AdapterVersion: 1, Configuration: wh.HTTPConfiguration{URL: "https://receiver.example/events"}}, Subscriptions: []whcore.SubscriptionInput{{ProjectID: f.project.ID, EventTypes: []string{"task.paused"}}}}
	prepared, err := whcore.PrepareCreate(input, f.endpoint.Owner, access, projects, now)
	if err != nil {
		return wh.Endpoint{}, err
	}
	endpoint := prepared.Endpoint
	endpoint.EncryptedDestination = []byte("opaque enrollment destination")
	endpoint.SigningKeys[0].EncryptedSecret = []byte("opaque enrollment signing secret")
	receipt := webhookReceipt(endpoint, operationID)
	if err := dao.ReserveOperation(ctx, endpoint.Owner, now); err != nil {
		return wh.Endpoint{}, err
	}
	cost, err := whcore.ConfigurationCost(endpoint)
	if err != nil {
		return wh.Endpoint{}, err
	}
	if err := dao.ReserveConfiguration(ctx, endpoint.Owner, cost); err != nil {
		return wh.Endpoint{}, err
	}
	if err := dao.InsertEndpoint(ctx, endpoint); err != nil {
		return wh.Endpoint{}, err
	}
	if err := dao.InsertOperation(ctx, receipt); err != nil {
		return wh.Endpoint{}, err
	}
	return endpoint, nil
}

func TestWebhookEnrollmentAndGrantRevocationShareTheProjectRootFence(t *testing.T) {
	for _, enrollFirst := range []bool{true, false} {
		name := "revocation commits before enrollment"
		if enrollFirst {
			name = "enrollment commits before revocation"
		}
		t.Run(name, func(t *testing.T) {
			f := webhookAccessRaceFixture(t, "grant-add", false)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			operationID := uuid.NewString()
			locked := make(chan uint32, 1)
			release := make(chan struct{})
			firstDone := make(chan error, 1)
			secondDone := make(chan error, 1)
			created := make(chan wh.Endpoint, 1)
			if enrollFirst {
				go func() {
					_, err := f.database.WriteWebhook(ctx, f.endpoint.Owner, operationID, func(scope store.WebhookWriteScope) error {
						endpoint, err := prepareWebhookEnrollment(ctx, scope, f, operationID)
						if err != nil {
							return err
						}
						created <- endpoint
						locked <- scope.(*webhookScope).tx.Conn().PgConn().PID()
						return awaitWebhookRelease(ctx, release)
					})
					firstDone <- err
				}()
				blocker := awaitWebhookRacePID(t, ctx, locked, firstDone)
				go func() { _, err := f.change(ctx, "grant-remove", nil, nil); secondDone <- err }()
				waitTransferTeamLock(t, ctx, f.database, "SELECT id::text FROM projects", blocker)
				close(release)
				if err := awaitWebhookRaceResult(t, ctx, firstDone); err != nil {
					t.Fatal(err)
				}
				if err := awaitWebhookRaceResult(t, ctx, secondDone); err != nil {
					t.Fatal(err)
				}
				endpoint := <-created
				stored := readStoredWebhook(t, f.database, endpoint.Owner, endpoint.ID)
				if stored.Subscriptions[0].AuthorizationState != wh.AuthorizationConfirmationRequired || stored.Subscriptions[0].AuthorizationEpoch != 2 {
					t.Fatalf("revocation missed newly committed subscription: %#v", stored.Subscriptions[0])
				}
			} else {
				go func() {
					_, err := f.change(ctx, "grant-remove", nil, func(pid uint32) error { locked <- pid; return awaitWebhookRelease(ctx, release) })
					firstDone <- err
				}()
				blocker := awaitWebhookRacePID(t, ctx, locked, firstDone)
				if !webhookRaceReadAccess(t, ctx, f) {
					t.Fatal("precommit source check lost its valid snapshot")
				}
				go func() {
					_, err := f.database.WriteWebhook(ctx, f.endpoint.Owner, operationID, func(scope store.WebhookWriteScope) error {
						endpoint, err := prepareWebhookEnrollment(ctx, scope, f, operationID)
						if err == nil {
							created <- endpoint
						}
						return err
					})
					secondDone <- err
				}()
				waitTransferTeamLock(t, ctx, f.database, "SELECT id::text FROM projects", blocker)
				close(release)
				if err := awaitWebhookRaceResult(t, ctx, firstDone); err != nil {
					t.Fatal(err)
				}
				err := awaitWebhookRaceResult(t, ctx, secondDone)
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "forbidden" {
					t.Fatalf("post-fence enrollment did not reject lost qualification: %v", err)
				}
				var endpoints, subscriptions, operations, slots int64
				if err := f.database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_endpoints),(SELECT count(*) FROM webhook_subscriptions),(SELECT count(*) FROM webhook_operations),(SELECT sum(operations_used) FROM webhook_quota_buckets)`).Scan(&endpoints, &subscriptions, &operations, &slots); err != nil {
					t.Fatal(err)
				}
				if endpoints != 0 || subscriptions != 0 || operations != 0 || slots != 0 {
					t.Fatalf("rejected enrollment retained partial data: %d %d %d %d", endpoints, subscriptions, operations, slots)
				}
			}
			if webhookRaceReadAccess(t, ctx, f) {
				t.Fatal("actual revocation did not commit")
			}
		})
	}
}

func webhookQuotaRaceActor(t *testing.T, database *Store, id string) model.Principal {
	t.Helper()
	now := time.Now().UTC()
	digest := sha256.Sum256([]byte("quota-credential/" + id))
	session := model.Session{ID: uuid.NewString(), TokenHash: digest[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	if _, err := seedIdentitySession(database, context.Background(), model.User{ID: id, UniAuthID: "quota-test:" + id}, session); err != nil {
		t.Fatal(err)
	}
	principal, err := testAuthenticate(database, context.Background(), model.SessionCredential, digest[:], now)
	if err != nil {
		t.Fatal(err)
	}
	return principal
}

func runWebhookQuotaContenders(t *testing.T, ctx context.Context, database *Store, first, second wh.Endpoint, firstReceipt, secondReceipt wh.OperationReceipt, expectedCode string) {
	t.Helper()
	locked := make(chan uint32, 1)
	release := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		_, err := database.WriteWebhook(ctx, first.Owner, firstReceipt.OperationID, func(scope store.WebhookWriteScope) error {
			if err := insertStoredWebhook(ctx, scope, first, firstReceipt); err != nil {
				return err
			}
			locked <- scope.(*webhookScope).tx.Conn().PgConn().PID()
			return awaitWebhookRelease(ctx, release)
		})
		firstDone <- err
	}()
	blocker := awaitWebhookRacePID(t, ctx, locked, firstDone)
	secondDone := make(chan error, 1)
	go func() {
		_, err := database.WriteWebhook(ctx, second.Owner, secondReceipt.OperationID, func(scope store.WebhookWriteScope) error {
			return insertStoredWebhook(ctx, scope, second, secondReceipt)
		})
		secondDone <- err
	}()
	waitTransferTeamLock(t, ctx, database, "SELECT bucket FROM webhook_quota_buckets", blocker)
	close(release)
	if err := awaitWebhookRaceResult(t, ctx, firstDone); err != nil {
		t.Fatal(err)
	}
	err := awaitWebhookRaceResult(t, ctx, secondDone)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != expectedCode {
		t.Fatalf("quota contender returned %v, wanted %s", err, expectedCode)
	}
	var winners, losers, loserReceipts int64
	if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE id=$1),(SELECT count(*) FROM webhook_endpoints WHERE id=$2),(SELECT count(*) FROM webhook_operations WHERE operation_id=$3)`, first.ID, second.ID, secondReceipt.OperationID).Scan(&winners, &losers, &loserReceipts); err != nil {
		t.Fatal(err)
	}
	if winners != 1 || losers != 0 || loserReceipts != 0 {
		t.Fatalf("quota contention retained wrong effects: winner=%d loser=%d loserReceipts=%d", winners, losers, loserReceipts)
	}
}

func TestWebhookDistinctOperationsCannotOverbookOneRemainingReceiptSlot(t *testing.T) {
	database, actor, _, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	base := storedWebhook(t, actor, project)
	baseReceipt := webhookReceipt(base, uuid.NewString())
	if _, err := database.WriteWebhook(ctx, base.Owner, baseReceipt.OperationID, func(scope store.WebhookWriteScope) error { return insertStoredWebhook(ctx, scope, base, baseReceipt) }); err != nil {
		t.Fatal(err)
	}
	policy := wh.DefaultPolicy()
	seeded := policy.OperationOwnerLimit - 1
	if _, err := database.Pool.Exec(ctx, `UPDATE webhook_quota_owners SET operations_used=$3 WHERE owner_kind=$1 AND owner_id=$2`, base.Owner.Kind, base.Owner.ID, seeded); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE webhook_quota_buckets SET operations_used=$2 WHERE bucket=$1`, pgwebhook.OwnerBucket(base.Owner), seeded); err != nil {
		t.Fatal(err)
	}
	first, second := storedWebhook(t, actor, project), storedWebhook(t, actor, project)
	first.Subscriptions, second.Subscriptions = []wh.Subscription{}, []wh.Subscription{}
	firstReceipt, secondReceipt := webhookReceipt(first, uuid.NewString()), webhookReceipt(second, uuid.NewString())
	runWebhookQuotaContenders(t, ctx, database, first, second, firstReceipt, secondReceipt, "operation_capacity")
	var ownerUsed, bucketUsed, newReceipts int64
	if err := database.Pool.QueryRow(ctx, `SELECT q.operations_used,b.operations_used,(SELECT count(*) FROM webhook_operations WHERE operation_id=ANY($3::uuid[])) FROM webhook_quota_owners q JOIN webhook_quota_buckets b ON b.bucket=q.bucket WHERE q.owner_kind=$1 AND q.owner_id=$2`, base.Owner.Kind, base.Owner.ID, []string{firstReceipt.OperationID, secondReceipt.OperationID}).Scan(&ownerUsed, &bucketUsed, &newReceipts); err != nil {
		t.Fatal(err)
	}
	if ownerUsed != seeded+1 || bucketUsed != seeded+1 || newReceipts != 1 {
		t.Fatalf("receipt slots overbooked: owner=%d bucket=%d newReceipts=%d", ownerUsed, bucketUsed, newReceipts)
	}
}

func TestWebhookDifferentOwnersCannotOverbookOneSharedBucketConfiguration(t *testing.T) {
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	// These owners share a storage bucket while their Project and Team roots differ.
	firstActor := webhookQuotaRaceActor(t, database, "11111111-1111-4111-8111-111111111111")
	secondActor := webhookQuotaRaceActor(t, database, "22222222-2222-4222-8222-000000000003")
	firstProject, err := database.CreatePrivateProject(ctx, firstActor, uuid.NewString(), "First private", "https://example.com/first")
	if err != nil {
		t.Fatal(err)
	}
	secondProject, err := database.CreatePrivateProject(ctx, secondActor, uuid.NewString(), "Second private", "https://example.com/second")
	if err != nil {
		t.Fatal(err)
	}
	first, second := storedWebhook(t, firstActor, firstProject), storedWebhook(t, secondActor, secondProject)
	bucket := pgwebhook.OwnerBucket(first.Owner)
	if bucket != pgwebhook.OwnerBucket(second.Owner) || firstProject.Ownership.TeamID == secondProject.Ownership.TeamID {
		t.Fatal("quota fixture did not separate source roots in one shared bucket")
	}
	firstCost, err := whcore.ConfigurationCost(first)
	if err != nil {
		t.Fatal(err)
	}
	secondCost, err := whcore.ConfigurationCost(second)
	if err != nil {
		t.Fatal(err)
	}
	if firstCost.Bytes != secondCost.Bytes {
		t.Fatal("quota contenders must require the same positive configuration cost")
	}
	seeded := wh.DefaultPolicy().BucketBytesLimit - firstCost.Bytes
	if _, err := database.Pool.Exec(ctx, `UPDATE webhook_quota_buckets SET bytes_used=$2 WHERE bucket=$1`, bucket, seeded); err != nil {
		t.Fatal(err)
	}
	firstReceipt, secondReceipt := webhookReceipt(first, uuid.NewString()), webhookReceipt(second, uuid.NewString())
	runWebhookQuotaContenders(t, ctx, database, first, second, firstReceipt, secondReceipt, "webhook_capacity_unavailable")
	var bucketBytes, bucketRecords, bucketOperations, ownerBytes, ownerOperations, loserOwnerRows int64
	if err := database.Pool.QueryRow(ctx, `SELECT b.bytes_used,b.records_used,b.operations_used,q.bytes_used,q.operations_used,(SELECT count(*) FROM webhook_quota_owners WHERE owner_kind=$3 AND owner_id=$4) FROM webhook_quota_buckets b JOIN webhook_quota_owners q ON q.bucket=b.bucket WHERE b.bucket=$1 AND q.owner_id=$2`, bucket, first.Owner.ID, second.Owner.Kind, second.Owner.ID).Scan(&bucketBytes, &bucketRecords, &bucketOperations, &ownerBytes, &ownerOperations, &loserOwnerRows); err != nil {
		t.Fatal(err)
	}
	if bucketBytes != seeded+firstCost.Bytes || bucketRecords != firstCost.Records || bucketOperations != 1 || ownerBytes != firstCost.Bytes || ownerOperations != 1 || loserOwnerRows != 0 {
		t.Fatalf("shared bucket accounting changed incorrectly: bytes=%d records=%d operations=%d ownerBytes=%d ownerOperations=%d loserOwnerRows=%d", bucketBytes, bucketRecords, bucketOperations, ownerBytes, ownerOperations, loserOwnerRows)
	}
}

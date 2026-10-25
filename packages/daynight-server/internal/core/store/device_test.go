package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
)

func deviceStoreHash(value string) []byte { hash := sha256.Sum256([]byte(value)); return hash[:] }
func deviceStoreGrant(t *testing.T, s *Store, now time.Time) core.DeviceAuthorization {
	t.Helper()
	d := core.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: deviceStoreHash(uuid.NewString()), UserCode: "BCDFGHJKLM", Status: "pending", CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute), NextPollAt: now.Add(5 * time.Second), PollIntervalSeconds: 5}
	if err := s.CreateDeviceAuthorization(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	return d
}
func deviceStoreCredential(now time.Time) core.Credential {
	return core.Credential{ID: uuid.NewString(), Kind: core.PATCredential, Name: "Daynight CLI", TokenHash: deviceStoreHash(uuid.NewString()), CreatedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour)}
}
func requireDeviceStoreFailure(t *testing.T, err error) {
	t.Helper()
	var failure *Error
	if !errors.As(err, &failure) || errors.Unwrap(err) == nil {
		t.Fatalf("operational error chain lost: %v", err)
	}
}

func TestDeviceStoreDecisionPollingAndCredentialOwnership(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	_, alice, _ := testAuthRecords(t, s)
	_, bob, _ := testAuthRecords(t, s)
	now := time.Now().UTC().Truncate(time.Microsecond)
	d := deviceStoreGrant(t, s, now)
	for _, p := range []core.Principal{alice, bob} {
		got, err := s.InspectDeviceAuthorization(ctx, p, d.UserCode, now)
		if err != nil || got.Status != "pending" || got.UserID != nil || !got.ExpiresAt.Equal(d.ExpiresAt) {
			t.Fatalf("pending grant: %+v %v", got, err)
		}
	}
	c := deviceStoreCredential(now)
	outcome, err := s.RedeemDeviceAuthorization(ctx, d.DeviceCodeHash, c)
	if err != nil || outcome != "slow_down" {
		t.Fatalf("early poll: %s %v", outcome, err)
	}
	c = deviceStoreCredential(now.Add(10 * time.Second))
	outcome, err = s.RedeemDeviceAuthorization(ctx, d.DeviceCodeHash, c)
	if err != nil || outcome != "authorization_pending" {
		t.Fatalf("pending poll: %s %v", outcome, err)
	}
	inspected, err := s.InspectDeviceAuthorization(ctx, alice, d.UserCode, now)
	if err != nil || inspected.PollIntervalSeconds != 10 || !inspected.NextPollAt.Equal(now.Add(20*time.Second)) {
		t.Fatalf("persistent throttle: %+v %v", inspected, err)
	}
	outcome, err = s.DecideDeviceAuthorization(ctx, alice, d.UserCode, "approved", now)
	if err != nil || outcome != "" {
		t.Fatalf("approval: %s %v", outcome, err)
	}
	if _, err = s.InspectDeviceAuthorization(ctx, bob, d.UserCode, now); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("other account inspected decided grant: %v", err)
	}
	if _, err = s.DecideDeviceAuthorization(ctx, bob, d.UserCode, "denied", now); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("other account changed decided grant: %v", err)
	}
	outcome, err = s.DecideDeviceAuthorization(ctx, alice, d.UserCode, "denied", now)
	if err != nil || outcome != "approved" {
		t.Fatalf("duplicate decision: %s %v", outcome, err)
	}
	c = deviceStoreCredential(now.Add(20 * time.Second))
	outcome, err = s.RedeemDeviceAuthorization(ctx, d.DeviceCodeHash, c)
	if err != nil || outcome != "" {
		t.Fatalf("redemption: %s %v", outcome, err)
	}
	pat, err := s.Authenticate(ctx, core.PATCredential, c.TokenHash, c.CreatedAt)
	if err != nil || pat.UserID != alice.UserID {
		t.Fatalf("issued credential owner: %+v %v", pat, err)
	}
	inspected, err = s.InspectDeviceAuthorization(ctx, alice, d.UserCode, now)
	if err != nil || inspected.Status != "consumed" {
		t.Fatalf("consumed grant: %+v %v", inspected, err)
	}
	outcome, err = s.RedeemDeviceAuthorization(ctx, d.DeviceCodeHash, deviceStoreCredential(c.CreatedAt))
	if err != nil || outcome != "invalid_grant" {
		t.Fatalf("repeated redemption: %s %v", outcome, err)
	}
	if err = s.DeleteCurrentPAT(ctx, core.Principal{CredentialID: pat.CredentialID, UserID: bob.UserID, Kind: core.PATCredential}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Authenticate(ctx, core.PATCredential, c.TokenHash, c.CreatedAt); err != nil {
		t.Fatal("another account deleted credential")
	}
	if err = s.DeleteCurrentPAT(ctx, pat); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Authenticate(ctx, core.PATCredential, c.TokenHash, c.CreatedAt); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("logout retained credential: %v", err)
	}
}

func TestDeviceStoreAtomicRedemptionAndConcurrentConsumption(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	_, alice, _ := testAuthRecords(t, s)
	now := time.Now().UTC()
	d := deviceStoreGrant(t, s, now)
	if outcome, err := s.DecideDeviceAuthorization(ctx, alice, d.UserCode, "approved", now); err != nil || outcome != "" {
		t.Fatalf("approval: %s %v", outcome, err)
	}
	c := deviceStoreCredential(now.Add(5 * time.Second))
	c.TokenHash = []byte{1}
	_, err := s.RedeemDeviceAuthorization(ctx, d.DeviceCodeHash, c)
	requireDeviceStoreFailure(t, err)
	inspected, err := s.InspectDeviceAuthorization(ctx, alice, d.UserCode, now)
	if err != nil || inspected.Status != "approved" {
		t.Fatal("failed credential insertion consumed authorization")
	}
	outcomes := make(chan string, 8)
	failures := make(chan error, 8)
	start := make(chan struct{})
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() {
			<-start
			outcome, err := s.RedeemDeviceAuthorization(ctx, d.DeviceCodeHash, deviceStoreCredential(now.Add(5*time.Second)))
			outcomes <- outcome
			failures <- err
		})
	}
	close(start)
	workers.Wait()
	close(outcomes)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	success := 0
	for outcome := range outcomes {
		if outcome == "" {
			success++
		} else if outcome != "invalid_grant" {
			t.Fatalf("concurrent outcome: %s", outcome)
		}
	}
	var count int
	if err = s.Pool.QueryRow(ctx, `SELECT count(*) FROM personal_access_tokens`).Scan(&count); err != nil || count != 1 || success != 1 {
		t.Fatalf("atomic credentials: %d successes %d %v", count, success, err)
	}
}

func TestDeviceStoreTerminalStatesAndSessionBoundaries(t *testing.T) {
	for _, status := range []string{"denied", "expired"} {
		t.Run(status, func(t *testing.T) {
			s := isolatedStore(t)
			ctx := context.Background()
			_, alice, _ := testAuthRecords(t, s)
			now := time.Now().UTC()
			d := deviceStoreGrant(t, s, now)
			want := "access_denied"
			if status == "denied" {
				if _, err := s.DecideDeviceAuthorization(ctx, alice, d.UserCode, "denied", now); err != nil {
					t.Fatal(err)
				}
			} else {
				now = d.ExpiresAt
				want = "expired_token"
				if result, err := s.DecideDeviceAuthorization(ctx, alice, d.UserCode, "approved", now); err != nil || result != "expired" {
					t.Fatalf("expired decision: %s %v", result, err)
				}
			}
			outcome, err := s.RedeemDeviceAuthorization(ctx, d.DeviceCodeHash, deviceStoreCredential(now))
			if err != nil || outcome != want {
				t.Fatalf("terminal redemption: %s %v", outcome, err)
			}
			outcome, err = s.RedeemDeviceAuthorization(ctx, deviceStoreHash("unknown"), deviceStoreCredential(now))
			if err != nil || outcome != "invalid_grant" {
				t.Fatalf("unknown grant: %s %v", outcome, err)
			}
			if _, err = s.InspectDeviceAuthorization(ctx, alice, "BCDFGHJKLN", now); !errors.Is(err, core.ErrNotFound) {
				t.Fatalf("unknown code: %v", err)
			}
			pat := alice
			pat.Kind = core.PATCredential
			if _, err = s.InspectDeviceAuthorization(ctx, pat, d.UserCode, now); !errors.Is(err, core.ErrNotFound) {
				t.Fatalf("PAT inspected grant: %v", err)
			}
			if err = s.DeleteSession(ctx, alice); err != nil {
				t.Fatal(err)
			}
			if _, err = s.DecideDeviceAuthorization(ctx, alice, d.UserCode, "approved", now); !errors.Is(err, core.ErrNotFound) {
				t.Fatalf("revoked session decided grant: %v", err)
			}
		})
	}
}

func TestDeviceStorePersistentRateAndCleanupBounds(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	buckets := []core.DeviceRateBucket{{Hash: deviceStoreHash("global"), Limit: 4}, {Hash: deviceStoreHash("actor"), Limit: 2}}
	for range 2 {
		allowed, err := s.TakeDeviceRate(ctx, buckets, now)
		if err != nil || !allowed {
			t.Fatalf("allowed rate: %t %v", allowed, err)
		}
	}
	allowed, err := s.TakeDeviceRate(ctx, buckets, now)
	if err != nil || allowed {
		t.Fatalf("actor limit: %t %v", allowed, err)
	}
	for range 2 {
		allowed, err = s.TakeDeviceRate(ctx, buckets[:1], now)
		if err != nil {
			t.Fatal(err)
		}
	}
	if allowed {
		t.Fatal("global rate not shared")
	}
	if _, err = s.Pool.Exec(ctx, `INSERT INTO device_authorization_limits (bucket_hash,attempts,expires_at) SELECT sha256(i::text::bytea),1,$1 FROM generate_series(1,200) i`, now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	allowed, err = s.TakeDeviceRate(ctx, buckets, now.Add(time.Minute))
	if err != nil || !allowed {
		t.Fatalf("rate reset depended on cleanup batch: %t %v", allowed, err)
	}
	var expired int
	if err = s.Pool.QueryRow(ctx, `SELECT count(*) FROM device_authorization_limits WHERE expires_at <= $1`, now).Scan(&expired); err != nil || expired != 100 {
		t.Fatalf("bounded rate cleanup: %d %v", expired, err)
	}
	if _, err = s.Pool.Exec(ctx, `INSERT INTO device_authorizations (id,device_code_hash,user_code,status,created_at,expires_at,next_poll_at,poll_interval_seconds) SELECT md5(i::text)::uuid,sha256(i::text::bytea),'BCDFGHJKL'||substring('BCDFGHJKLMNPQRSTVWXZ' from i for 1),'pending',$1::timestamptz-interval '3 hours',$1::timestamptz-interval '2 hours',$1,5 FROM generate_series(1,20) i`, now); err != nil {
		t.Fatal(err)
	}
	deviceStoreGrant(t, s, now)
	var count int
	if err = s.Pool.QueryRow(ctx, `SELECT count(*) FROM device_authorizations`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("expired grant cleanup: %d %v", count, err)
	}
}

func TestDeviceStoreOperationalErrorsPreserveCause(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	_, alice, _ := testAuthRecords(t, s)
	now := time.Now().UTC()
	d := deviceStoreGrant(t, s, now)
	if _, err := s.Pool.Exec(ctx, `DROP TABLE device_authorizations`); err != nil {
		t.Fatal(err)
	}
	_, err := s.InspectDeviceAuthorization(ctx, alice, d.UserCode, now)
	requireDeviceStoreFailure(t, err)
	_, err = s.DecideDeviceAuthorization(ctx, alice, d.UserCode, "approved", now)
	requireDeviceStoreFailure(t, err)
	_, err = s.RedeemDeviceAuthorization(ctx, d.DeviceCodeHash, deviceStoreCredential(now))
	requireDeviceStoreFailure(t, err)
	requireDeviceStoreFailure(t, s.CreateDeviceAuthorization(ctx, d))
	if _, err = s.Pool.Exec(ctx, `DROP TABLE device_authorization_limits`); err != nil {
		t.Fatal(err)
	}
	_, err = s.TakeDeviceRate(ctx, []core.DeviceRateBucket{{Hash: deviceStoreHash("limit"), Limit: 1}}, now)
	requireDeviceStoreFailure(t, err)
	s.Close()
	_, err = s.TakeDeviceRate(ctx, nil, now)
	requireDeviceStoreFailure(t, err)
	requireDeviceStoreFailure(t, s.CreateDeviceAuthorization(ctx, d))
	_, err = s.RedeemDeviceAuthorization(ctx, d.DeviceCodeHash, deviceStoreCredential(now))
	requireDeviceStoreFailure(t, err)
	requireDeviceStoreFailure(t, s.DeleteCurrentPAT(ctx, alice))
}

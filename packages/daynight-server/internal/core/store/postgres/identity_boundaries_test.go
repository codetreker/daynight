package postgres

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func insertIdentityBundle(ctx context.Context, sc IdentityScope, subject string, now time.Time, sessionID string) (model.User, error) {
	user, err := sc.IdentityDAO().UpsertUser(ctx, model.User{ID: uuid.NewString(), UniAuthID: subject}, now)
	if err != nil {
		return model.User{}, err
	}
	teams := sc.PersonalTeamDAO()
	id := uuid.NewString()
	created, err := teams.InsertPersonalTeam(ctx, id, user.ID, now)
	if err != nil {
		return model.User{}, err
	}
	if created {
		if err := teams.InsertPersonalOwner(ctx, id, user.ID, now); err != nil {
			return model.User{}, err
		}
	}
	facts, err := teams.PersonalTeam(ctx, user.ID)
	if err != nil {
		return model.User{}, err
	}
	user.PersonalTeam = model.TeamRef{ID: facts.ID, Kind: "personal"}
	err = sc.IdentityDAO().InsertSession(ctx, model.Session{ID: sessionID, UserID: user.ID, TokenHash: deviceStoreHash(sessionID), CreatedAt: now, ExpiresAt: now.Add(time.Hour)})
	return user, err
}

func TestIdentityScopeConcurrentCanonicalOwnerAndSessions(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	now := time.Now().UTC().Truncate(time.Microsecond)
	const count = 8
	start := make(chan struct{})
	type result struct {
		user       model.User
		completion Completion
		err        error
	}
	results := make(chan result, count)
	var wg sync.WaitGroup
	for range count {
		wg.Go(func() {
			<-start
			var user model.User
			completion, err := s.WriteIdentity(ctx, func(sc IdentityScope) error {
				var err error
				user, err = insertIdentityBundle(ctx, sc, "concurrent-owner", now, uuid.NewString())
				return err
			})
			results <- result{user, completion, err}
		})
	}
	close(start)
	wg.Wait()
	close(results)
	var canonical model.User
	for result := range results {
		if result.err != nil || result.completion.Outcome != TransactionCommitted {
			t.Fatalf("concurrent identity: %#v %v", result.completion, result.err)
		}
		if canonical.ID == "" {
			canonical = result.user
		}
		if !reflect.DeepEqual(canonical, result.user) {
			t.Fatalf("canonical user/team changed: %#v %#v", canonical, result.user)
		}
	}
	var version int64
	var created time.Time
	if err := s.Pool.QueryRow(ctx, `SELECT version,created_at FROM team_members WHERE team_id=$1 AND user_id=$2 AND role='admin'`, canonical.PersonalTeam.ID, canonical.ID).Scan(&version, &created); err != nil {
		t.Fatal(err)
	}
	identityScopeTest(t, s, func(sc IdentityScope) error {
		got, err := insertIdentityBundle(ctx, sc, "concurrent-owner", now, uuid.NewString())
		if err == nil && !reflect.DeepEqual(got, canonical) {
			t.Fatalf("repeat changed canonical identity: %#v", got)
		}
		return err
	})
	var valid bool
	if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users)=1 AND (SELECT count(*) FROM teams)=1 AND (SELECT count(*) FROM team_members)=1 AND (SELECT count(*) FROM sessions)=$1 AND EXISTS(SELECT 1 FROM team_members WHERE team_id=$2 AND user_id=$3 AND version=$4 AND created_at=$5)`, count+1, canonical.PersonalTeam.ID, canonical.ID, version, created).Scan(&valid); err != nil || !valid {
		t.Fatalf("canonical persisted counts/metadata: %t %v", valid, err)
	}
}

func TestIdentityScopePersonalAndSessionFailuresRollbackAllWrites(t *testing.T) {
	for _, table := range []string{"teams", "team_members", "sessions"} {
		t.Run(table, func(t *testing.T) {
			s := isolatedStore(t)
			ctx := t.Context()
			now := time.Now().UTC()
			login := model.LoginTransaction{ID: uuid.NewString(), StateHash: deviceStoreHash("state"), BrowserBindingHash: deviceStoreHash("binding"), ScopeHash: deviceStoreHash("scope"), Provider: "github", ReturnPath: "/tasks", ExpiresAt: now.Add(time.Hour)}
			identityScopeTest(t, s, func(sc IdentityScope) error { return sc.IdentityDAO().InsertLogin(ctx, login) })
			identityScopeTest(t, s, func(sc IdentityScope) error {
				_, err := sc.IdentityDAO().ConsumeLogin(ctx, login.StateHash, login.BrowserBindingHash, now)
				return err
			})
			if _, err := s.Pool.Exec(ctx, `CREATE FUNCTION reject_identity_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test Personal initialization failure'; END $$; CREATE TRIGGER reject_identity_insert BEFORE INSERT ON `+table+` FOR EACH ROW EXECUTE FUNCTION reject_identity_insert()`); err != nil {
				t.Fatal(err)
			}
			completion, err := s.WriteIdentity(ctx, func(sc IdentityScope) error {
				_, err := insertIdentityBundle(ctx, sc, "rollback-owner", now, uuid.NewString())
				return err
			})
			var pg *pgconn.PgError
			if !errors.As(err, &pg) || pg.Code != "P0001" || completion.Outcome != TransactionNotCommitted {
				t.Fatalf("failure completion=%#v error=%v", completion, err)
			}
			var empty bool
			if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM login_transactions)=0 AND (SELECT count(*) FROM users)=0 AND (SELECT count(*) FROM teams)=0 AND (SELECT count(*) FROM team_members)=0 AND (SELECT count(*) FROM sessions)=0`).Scan(&empty); err != nil || !empty {
				t.Fatalf("partial identity or replayable login: %t %v", empty, err)
			}
		})
	}
}

func TestIdentityScopeCorruptPersonalFactsRollbackProfile(t *testing.T) {
	for _, damage := range []string{"missing-owner", "wrong-role", "additional-member"} {
		t.Run(damage, func(t *testing.T) {
			s := isolatedStore(t)
			ctx := t.Context()
			user, _, _ := testAuthRecords(t, s)
			originalName := "Display name"
			user.Name = &originalName
			ref := user.PersonalTeam
			identityScopeTest(t, s, func(sc IdentityScope) error {
				var err error
				user, err = sc.IdentityDAO().UpsertUser(ctx, user, user.UpdatedAt)
				user.PersonalTeam = ref
				return err
			})
			switch damage {
			case "missing-owner":
				if _, err := s.Pool.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1`, user.PersonalTeam.ID); err != nil {
					t.Fatal(err)
				}
			case "wrong-role":
				if _, err := s.Pool.Exec(ctx, `UPDATE team_members SET role='member' WHERE team_id=$1`, user.PersonalTeam.ID); err != nil {
					t.Fatal(err)
				}
			case "additional-member":
				other, _, _ := testAuthRecords(t, s)
				if _, err := s.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, user.PersonalTeam.ID, other.ID); err != nil {
					t.Fatal(err)
				}
			}
			refusal := errors.New("controlled ownership refusal")
			completion, err := s.WriteIdentity(ctx, func(sc IdentityScope) error {
				updated := user
				name := "Changed"
				updated.Name = &name
				if _, err := sc.IdentityDAO().UpsertUser(ctx, updated, time.Now().UTC()); err != nil {
					return err
				}
				facts, err := sc.PersonalTeamDAO().PersonalTeam(ctx, user.ID)
				if err != nil {
					return err
				}
				want := PersonalTeamFacts{ID: user.PersonalTeam.ID}
				if damage == "wrong-role" {
					want.MemberCount = 1
				}
				if damage == "additional-member" {
					want.MemberCount, want.OwnerAdminCount = 2, 1
				}
				if facts != want {
					t.Fatalf("corrupt facts=%#v want=%#v", facts, want)
				}
				return refusal
			})
			if !errors.Is(err, refusal) || completion.Outcome != TransactionNotCommitted {
				t.Fatalf("refusal lost: %#v %v", completion, err)
			}
			identityScopeTest(t, s, func(sc IdentityScope) error {
				got, _, err := sc.IdentityDAO().IdentityUser(ctx, user.ID)
				want := user
				want.PersonalTeam.ID, want.PersonalTeam.Kind = "", ""
				if err == nil && !reflect.DeepEqual(got, want) {
					t.Fatalf("failed scope committed profile: %#v %#v", got, user)
				}
				return err
			})
		})
	}
}

func TestIdentityScopeConcurrentLoginConsumption(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	now := time.Now().UTC()
	login := model.LoginTransaction{ID: uuid.NewString(), StateHash: deviceStoreHash("state"), BrowserBindingHash: deviceStoreHash("binding"), ScopeHash: deviceStoreHash("scope"), Provider: "github", ReturnPath: "/", ExpiresAt: now.Add(time.Hour)}
	identityScopeTest(t, s, func(sc IdentityScope) error { return sc.IdentityDAO().InsertLogin(ctx, login) })
	start := make(chan struct{})
	results := make(chan error, 8)
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			<-start
			completion, err := s.WriteIdentity(ctx, func(sc IdentityScope) error {
				got, err := sc.IdentityDAO().ConsumeLogin(ctx, login.StateHash, login.BrowserBindingHash, now)
				if err == nil && got.ID != login.ID {
					t.Error("consumed wrong login")
				}
				return err
			})
			if err == nil && completion.Outcome != TransactionCommitted {
				t.Error("consume not committed")
			}
			results <- err
		})
	}
	close(start)
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else if !errors.Is(err, model.ErrNotFound) {
			t.Fatal(err)
		}
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM login_transactions`).Scan(&count); err != nil || count != 0 || success != 1 {
		t.Fatalf("consumption=%d rows=%d %v", success, count, err)
	}
}

func waitIdentityLock(t *testing.T, ctx context.Context, s *Store, fragment string) {
	t.Helper()
	for {
		var waiting bool
		if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE $1)`, fragment).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("identity lock not observed for %q: %v", fragment, ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestIdentityScopeDeviceLocksExposeCurrentDecisionAndConsumption(t *testing.T) {
	for _, operation := range []string{"decision", "redemption"} {
		t.Run(operation, func(t *testing.T) {
			s := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			_, p, _ := testAuthRecords(t, s)
			now := time.Now().UTC().Truncate(time.Microsecond)
			d := model.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: deviceStoreHash("grant"), UserCode: "BCDFGHJKLM", CreatedAt: now, ExpiresAt: now.Add(time.Hour), NextPollAt: now, PollIntervalSeconds: 5}
			identityScopeTest(t, s, func(sc IdentityScope) error { return sc.IdentityDAO().InsertDevice(ctx, d) })
			if operation == "redemption" {
				identityScopeTest(t, s, func(sc IdentityScope) error {
					return sc.IdentityDAO().SetDeviceDecision(ctx, d.ID, "approved", p.UserID)
				})
			}
			locked, release := make(chan struct{}), make(chan struct{})
			first, second := make(chan error, 1), make(chan error, 1)
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
			}()
			credential := deviceStoreCredential(now)
			credential.UserID = p.UserID
			go func() {
				_, err := s.WriteIdentity(ctx, func(sc IdentityScope) error {
					dao := sc.IdentityDAO()
					if operation == "decision" {
						current, err := dao.DeviceByUserCode(ctx, p.UserID, d.UserCode, true)
						if err != nil {
							return err
						}
						if current.Status != "pending" {
							t.Error("initial decision not pending")
						}
						if err := dao.SetDeviceDecision(ctx, d.ID, "approved", p.UserID); err != nil {
							return err
						}
					} else {
						current, err := dao.LockDeviceByHash(ctx, d.DeviceCodeHash)
						if err != nil {
							return err
						}
						if current.Status != "approved" {
							t.Error("initial grant not approved")
						}
						if err := dao.InsertPAT(ctx, credential); err != nil {
							return err
						}
						if err := dao.ConsumeDevice(ctx, d.ID); err != nil {
							return err
						}
					}
					close(locked)
					select {
					case <-release:
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				})
				first <- err
			}()
			select {
			case <-locked:
			case err := <-first:
				t.Fatalf("first writer failed before lock barrier: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			go func() {
				_, err := s.WriteIdentity(ctx, func(sc IdentityScope) error {
					var current model.DeviceAuthorization
					var err error
					if operation == "decision" {
						current, err = sc.IdentityDAO().DeviceByUserCode(ctx, p.UserID, d.UserCode, true)
					} else {
						current, err = sc.IdentityDAO().LockDeviceByHash(ctx, d.DeviceCodeHash)
					}
					if err != nil {
						return err
					}
					want := "approved"
					if operation == "redemption" {
						want = "consumed"
					}
					if current.Status != want {
						t.Errorf("waiting reader saw stale status: %#v", current)
					}
					if operation == "decision" && (current.UserID == nil || *current.UserID != p.UserID) {
						t.Error("decision owner not persisted")
					}
					return nil
				})
				second <- err
			}()
			waitIdentityLock(t, ctx, s, "%FROM device_authorizations%FOR UPDATE%")
			close(release)
			if err := <-first; err != nil {
				t.Fatal(err)
			}
			if err := <-second; err != nil {
				t.Fatal(err)
			}
			var rows int
			if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM personal_access_tokens`).Scan(&rows); err != nil {
				t.Fatal(err)
			}
			want := 0
			if operation == "redemption" {
				want = 1
			}
			if rows != want {
				t.Fatalf("persisted credentials=%d want=%d", rows, want)
			}
		})
	}
}

func TestIdentityScopeDeviceMintFailurePreservesGrant(t *testing.T) {
	s := isolatedStore(t)
	ctx := t.Context()
	_, p, _ := testAuthRecords(t, s)
	now := time.Now().UTC().Truncate(time.Microsecond)
	d := model.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: deviceStoreHash("mint"), UserCode: "BCDFGHJKLM", CreatedAt: now, ExpiresAt: now.Add(time.Hour), NextPollAt: now, PollIntervalSeconds: 5}
	identityScopeTest(t, s, func(sc IdentityScope) error {
		if err := sc.IdentityDAO().InsertDevice(ctx, d); err != nil {
			return err
		}
		return sc.IdentityDAO().SetDeviceDecision(ctx, d.ID, "approved", p.UserID)
	})
	if _, err := s.Pool.Exec(ctx, `ALTER TABLE personal_access_tokens ADD CONSTRAINT reject_cli CHECK(name <> 'Daynight CLI (workstation)')`); err != nil {
		t.Fatal(err)
	}
	credential := deviceStoreCredential(now)
	credential.UserID = p.UserID
	credential.Name = "Daynight CLI (workstation)"
	mint := func(sc IdentityScope) error {
		dao := sc.IdentityDAO()
		if _, err := dao.LockDeviceByHash(ctx, d.DeviceCodeHash); err != nil {
			return err
		}
		if err := dao.InsertPAT(ctx, credential); err != nil {
			return err
		}
		return dao.ConsumeDevice(ctx, d.ID)
	}
	completion, err := s.WriteIdentity(ctx, mint)
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "23514" || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("mint failure: %#v %v", completion, err)
	}
	identityScopeTest(t, s, func(sc IdentityScope) error {
		got, err := sc.IdentityDAO().LockDeviceByHash(ctx, d.DeviceCodeHash)
		if err == nil && got.Status != "approved" {
			t.Fatalf("failed mint consumed grant: %#v", got)
		}
		return err
	})
	if _, err := s.Pool.Exec(ctx, `ALTER TABLE personal_access_tokens DROP CONSTRAINT reject_cli`); err != nil {
		t.Fatal(err)
	}
	identityScopeTest(t, s, mint)
	principal, err := testAuthenticate(s, ctx, model.PATCredential, credential.TokenHash, now)
	if err != nil || principal.UserID != p.UserID || principal.CredentialID != credential.ID {
		t.Fatalf("retried mint: %#v %v", principal, err)
	}
}

func TestIdentityScopePATLockReadsLatestExpiryAndRollsBackFailure(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	_, p, _ := testAuthRecords(t, s)
	now := time.Now().UTC().Truncate(time.Microsecond)
	credential := deviceStoreCredential(now)
	credential.UserID = p.UserID
	identityScopeTest(t, s, func(sc IdentityScope) error { return sc.IdentityDAO().InsertPAT(ctx, credential) })
	expiry := now.Add(time.Hour)
	locked, release := make(chan struct{}), make(chan struct{})
	first, second := make(chan error, 1), make(chan error, 1)
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	go func() {
		_, err := s.WriteIdentity(ctx, func(sc IdentityScope) error {
			dao := sc.IdentityDAO()
			if _, err := dao.LockActivePAT(ctx, p.UserID, credential.ID, now); err != nil {
				return err
			}
			if _, err := dao.SetPATExpiry(ctx, credential.ID, &expiry); err != nil {
				return err
			}
			close(locked)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		first <- err
	}()
	select {
	case <-locked:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	go func() {
		_, err := s.WriteIdentity(ctx, func(sc IdentityScope) error {
			got, err := sc.IdentityDAO().LockActivePAT(ctx, p.UserID, credential.ID, now)
			if err == nil {
				want := credential
				want.TokenHash = nil
				want.ExpiresAt = &expiry
				if !reflect.DeepEqual(got, want) {
					t.Errorf("stale expiry/metadata after lock: %#v want=%#v", got, want)
				}
			}
			return err
		})
		second <- err
	}()
	waitIdentityLock(t, ctx, s, "%FROM personal_access_tokens%FOR UPDATE%")
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `ALTER TABLE personal_access_tokens ADD CONSTRAINT preserve_expiry CHECK(expires_at IS NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	completion, err := s.WriteIdentity(ctx, func(sc IdentityScope) error {
		_, err := sc.IdentityDAO().SetPATExpiry(ctx, credential.ID, nil)
		return err
	})
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "23514" || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("expiry failure: %#v %v", completion, err)
	}
	var stored []byte
	var got time.Time
	if err := s.Pool.QueryRow(ctx, `SELECT token_hash,expires_at FROM personal_access_tokens WHERE id=$1`, credential.ID).Scan(&stored, &got); err != nil || !reflect.DeepEqual(stored, credential.TokenHash) || !got.Equal(expiry) {
		t.Fatalf("failed expiry changed credential: %v", err)
	}
}

func TestIdentityScopeDuplicateSessionRollsBackNewOwner(t *testing.T) {
	s := isolatedStore(t)
	ctx := t.Context()
	_, _, existing := testAuthRecords(t, s)
	completion, err := s.WriteIdentity(ctx, func(sc IdentityScope) error {
		_, err := insertIdentityBundle(ctx, sc, "rollback-user", time.Now().UTC(), existing.ID)
		return err
	})
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "23505" || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("duplicate session outcome=%#v %v", completion, err)
	}
	var retained bool
	if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users)=1 AND (SELECT count(*) FROM teams)=1 AND (SELECT count(*) FROM team_members)=1 AND (SELECT count(*) FROM sessions)=1 AND NOT EXISTS(SELECT FROM users WHERE uniauth_id='rollback-user')`).Scan(&retained); err != nil || !retained {
		t.Fatalf("duplicate session committed partial owner=%t %v", retained, err)
	}
}

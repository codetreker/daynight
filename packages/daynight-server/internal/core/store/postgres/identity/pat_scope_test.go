package identity_test

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	coreidentity "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/credentialusage"
	pgidentity "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestPATScopeStorage(t *testing.T) {
	tx, scope := identityTransaction(t)
	ctx, dao := t.Context(), scope.IdentityDAO()
	scoped := dao.(store.PATScopeDAO)
	now := time.Now().UTC().Truncate(time.Microsecond)
	user, err := dao.UpsertUser(ctx, model.User{ID: uuid.NewString(), UniAuthID: "scope-storage"}, now)
	requireNoError(t, err)
	original := []scopepolicy.ScopeID{"project:read", "task:read"}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, original, 1)
	requireNoError(t, err)
	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash("scoped-pat"), Name: "scoped", CreatedAt: now, ScopePolicy: &policy}
	requireNoError(t, dao.InsertPAT(ctx, pat))

	assertPolicy := func(got model.PersonalAccessToken, version int64, scopes []scopepolicy.ScopeID) {
		t.Helper()
		if got.ID != pat.ID || got.UserID != user.ID || got.ScopePolicy == nil || got.ScopePolicy.Version() != version || !slices.Equal(got.ScopePolicy.Scopes(), scopes) {
			t.Fatalf("unexpected PAT scope: %+v", got)
		}
	}
	got, err := scoped.PATByHash(ctx, pat.TokenHash, now)
	requireNoError(t, err)
	assertPolicy(got, 1, original)
	_, err = scoped.PATByHash(ctx, hash("other"), now)
	requireMissing(t, err)
	_, err = scoped.LockPATScope(ctx, uuid.NewString(), pat.ID)
	requireMissing(t, err)
	got, err = scoped.LockPATScope(ctx, user.ID, pat.ID)
	requireNoError(t, err)
	assertPolicy(got, 1, original)
	got, err = scoped.ReadLockedPATScope(ctx, user.ID, pat.ID)
	requireNoError(t, err)
	assertPolicy(got, 1, original)
	_, err = scoped.ReadLockedPATScope(ctx, uuid.NewString(), pat.ID)
	requireMissing(t, err)
	expiredAt := now.Add(-time.Hour)
	expired := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash("expired-scoped-pat"), Name: "expired", CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: &expiredAt, ScopePolicy: &policy}
	requireNoError(t, dao.InsertPAT(ctx, expired))
	other := model.PersonalAccessToken{ID: uuid.NewString(), UserID: uuid.NewString(), TokenHash: hash("other-owner-scoped-pat"), Name: "other", CreatedAt: now, ScopePolicy: &policy}
	requireNoError(t, dao.InsertPAT(ctx, other))
	list, err := scoped.ListPATScopes(ctx, user.ID)
	requireNoError(t, err)
	if len(list) != 2 || list[0].ID != expired.ID || list[1].ID != pat.ID || list[0].ScopePolicy == nil || list[0].ScopePolicy.Version() != 1 {
		t.Fatalf("scoped account list: %+v", list)
	}
	list, err = scoped.ListPATScopes(ctx, uuid.NewString())
	requireNoError(t, err)
	if len(list) != 0 {
		t.Fatalf("unrelated account list: %+v", list)
	}
	_, err = scoped.PATByHash(ctx, expired.TokenHash, now)
	requireMissing(t, err)
	_, err = scoped.ComparePATScope(ctx, uuid.NewString(), pat.ID, 1, []scopepolicy.ScopeID{"task:read"}, now)
	requireMissing(t, err)
	_, err = scoped.ComparePATScope(ctx, user.ID, pat.ID, 2, []scopepolicy.ScopeID{"task:read"}, now)
	requireMissing(t, err)
	if _, err = scoped.ComparePATScope(ctx, user.ID, pat.ID, 1, []scopepolicy.ScopeID{"task:read", "task:read"}, now); err == nil {
		t.Fatal("accepted duplicate scope IDs")
	}
	got, err = scoped.ComparePATScope(ctx, user.ID, pat.ID, 1, original, now)
	requireNoError(t, err)
	assertPolicy(got, 1, original)
	changed := []scopepolicy.ScopeID{"task:read"}
	got, err = scoped.ComparePATScope(ctx, user.ID, pat.ID, 1, changed, now)
	requireNoError(t, err)
	assertPolicy(got, 2, changed)
	_, err = scoped.ComparePATScope(ctx, user.ID, pat.ID, 1, original, now)
	requireMissing(t, err)

	used := now.Add(time.Minute)
	requireNoError(t, credentialusage.Write(ctx, tx, []model.CredentialUsageEvent{{Kind: model.UsageSubjectPAT, UserID: user.ID, SubjectID: pat.ID, At: used}}))
	got, err = scoped.PATByHash(ctx, pat.TokenHash, now)
	requireNoError(t, err)
	assertPolicy(got, 2, changed)
	if got.LastUsedAt == nil || !got.LastUsedAt.Equal(used) {
		t.Fatalf("last-used not recorded: %+v", got.LastUsedAt)
	}
	got, err = scoped.ComparePATScope(ctx, user.ID, pat.ID, 2, original, now)
	requireNoError(t, err)
	assertPolicy(got, 3, original)
	if got.LastUsedAt == nil || !got.LastUsedAt.Equal(used) {
		t.Fatalf("scope update changed last-used: %+v", got.LastUsedAt)
	}
	requireNoError(t, dao.DeletePAT(ctx, user.ID, pat.ID))
	_, err = scoped.PATByHash(ctx, pat.TokenHash, now)
	requireMissing(t, err)
	_, err = scoped.LockPATScope(ctx, user.ID, pat.ID)
	requireMissing(t, err)
	_, err = scoped.ComparePATScope(ctx, user.ID, pat.ID, 3, original, now)
	requireMissing(t, err)
}

func TestPATScopeRejectsMissingAndCorruptStorage(t *testing.T) {
	tx, scope := identityTransaction(t)
	ctx, dao := t.Context(), scope.IdentityDAO()
	scoped := dao.(store.PATScopeDAO)
	now := time.Now().UTC().Truncate(time.Microsecond)
	user, err := dao.UpsertUser(ctx, model.User{ID: uuid.NewString(), UniAuthID: "scope-corrupt"}, now)
	requireNoError(t, err)
	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash("legacy-pat"), Name: "legacy", CreatedAt: now}
	requireNoError(t, dao.InsertPAT(ctx, pat))
	for _, tc := range []struct {
		name    string
		ids     []string
		version *int64
	}{
		{name: "missing"},
		{name: "missing scopes", version: int64Ptr(1)},
		{name: "missing version", ids: []string{"task:read"}},
		{name: "unknown scope", ids: []string{"not:a-scope"}, version: int64Ptr(1)},
		{name: "duplicate", ids: []string{"task:read", "task:read"}, version: int64Ptr(1)},
		{name: "noncanonical", ids: []string{"task:read", "project:read"}, version: int64Ptr(1)},
		{name: "invalid version", ids: []string{"task:read"}, version: int64Ptr(0)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tx.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=$2,scope_version=$3 WHERE id=$1`, pat.ID, tc.ids, tc.version)
			requireNoError(t, err)
			if _, err := scoped.PATByHash(ctx, pat.TokenHash, now); err == nil || errors.Is(err, model.ErrNotFound) {
				t.Fatalf("corrupt hash read should fail explicitly: %v", err)
			}
			if _, err := scoped.LockPATScope(ctx, user.ID, pat.ID); err == nil || errors.Is(err, model.ErrNotFound) {
				t.Fatalf("corrupt locked read should fail explicitly: %v", err)
			}
			if _, err := scoped.ReadLockedPATScope(ctx, user.ID, pat.ID); err == nil || errors.Is(err, model.ErrNotFound) {
				t.Fatalf("corrupt shared read should fail explicitly: %v", err)
			}
			if items, err := scoped.ListPATScopes(ctx, user.ID); err == nil || len(items) != 0 {
				t.Fatalf("corrupt list should fail without partial results: %v %v", items, err)
			}
		})
	}
}

func int64Ptr(value int64) *int64 { return &value }

func TestPATScopeLockWaitRechecksExpiry(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user, session, _ := testutil.AuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 1)
	requireNoError(t, err)
	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash("lock-wait-scope"), Name: "expiring", CreatedAt: now.Add(-time.Hour), ScopePolicy: &policy}
	var expiry time.Time
	requireNoError(t, db.Pool.QueryRow(ctx, `SELECT clock_timestamp()+interval '2 seconds'`).Scan(&expiry))
	pat.ExpiresAt = &expiry
	identityScopeTest(t, db, func(scope store.IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, pat) })
	holder, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	_, err = holder.Exec(ctx, `SELECT id FROM personal_access_tokens WHERE id=$1 FOR UPDATE`, pat.ID)
	requireNoError(t, err)
	waiter, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	scope := pgidentity.NewScope(waiter, oauth.NewDAO(waiter))
	dao := scope.IdentityDAO()
	done := make(chan error, 1)
	finished := false
	defer func() {
		cancel()
		_ = holder.Rollback(context.Background())
		if !finished {
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("waiting edit did not stop during cleanup")
			}
		}
		_ = waiter.Rollback(context.Background())
	}()
	go func() {
		_, err := coreidentity.NewIdentity("").UpdatePATScope(ctx, dao, dao.(store.PATScopeDAO), dao.(store.PATManagementDAO), session, pat.ID, user.ID, 1, []scopepolicy.ScopeID{"project:read"}, now)
		done <- err
	}()
	for {
		var blocked bool
		err = db.Pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2::integer))`, int32(holder.Conn().PgConn().PID()), int32(waiter.Conn().PgConn().PID())).Scan(&blocked)
		requireNoError(t, err)
		if blocked {
			break
		}
		select {
		case err := <-done:
			finished = true
			t.Fatalf("edit returned before it waited on the PAT: %v", err)
		case <-ctx.Done():
			t.Fatal("edit did not wait for PAT lock")
		case <-time.After(10 * time.Millisecond):
		}
	}
	for {
		var expired bool
		requireNoError(t, db.Pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1`, expiry).Scan(&expired))
		if expired {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("PAT did not expire while waiting")
		case <-time.After(10 * time.Millisecond):
		}
	}
	requireNoError(t, holder.Commit(ctx))
	select {
	case err := <-done:
		finished = true
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "not_found" {
			t.Fatalf("expired edit: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("edit did not return after lock release")
	}
	requireNoError(t, waiter.Rollback(ctx))
	var ids []string
	var version int64
	requireNoError(t, db.Pool.QueryRow(ctx, `SELECT business_scopes,scope_version FROM personal_access_tokens WHERE id=$1`, pat.ID).Scan(&ids, &version))
	if version != 1 || !slices.Equal(ids, []string{"task:read"}) {
		t.Fatalf("expired edit persisted: %v version=%d", ids, version)
	}
}

func TestDeviceApprovedScopeStorage(t *testing.T) {
	tx, scope := identityTransaction(t)
	ctx, dao := t.Context(), scope.IdentityDAO()
	now := time.Now().UTC().Truncate(time.Microsecond)
	device := model.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: hash("approved-device"), UserCode: "BCDFGHJKLM", Status: "pending", CreatedAt: now, ExpiresAt: now.Add(time.Minute), NextPollAt: now, PollIntervalSeconds: 5}
	requireNoError(t, dao.InsertDevice(ctx, device))
	got, err := dao.LockDeviceByHash(ctx, device.DeviceCodeHash)
	requireNoError(t, err)
	if got.ApprovedScopes != nil {
		t.Fatalf("pending device scopes: %v", got.ApprovedScopes)
	}
	for _, tc := range []struct {
		name  string
		ids   []string
		valid bool
	}{
		{"approved", []string{"project:read", "task:read"}, true},
		{"unknown", []string{"unknown:scope"}, false},
		{"duplicate", []string{"task:read", "task:read"}, false},
		{"out of order", []string{"task:read", "project:read"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tx.Exec(ctx, `UPDATE device_authorizations SET approved_business_scopes=$2 WHERE id=$1`, device.ID, tc.ids)
			requireNoError(t, err)
			got, err := dao.LockDeviceByHash(ctx, device.DeviceCodeHash)
			if tc.valid {
				requireNoError(t, err)
				if !slices.Equal(got.ApprovedScopes, []scopepolicy.ScopeID{"project:read", "task:read"}) {
					t.Fatalf("scope scan: %v", got.ApprovedScopes)
				}
			} else if err == nil {
				t.Fatal("invalid approved scopes accepted")
			}
			_, err = dao.DeviceByUserCode(ctx, uuid.NewString(), device.UserCode, false)
			if (err == nil) != tc.valid {
				t.Fatalf("device code read error: %v", err)
			}
		})
	}
}

func TestPATScopeSharedReadExcludesWritesAndUsageDoesNotWait(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user, _, _ := testutil.AuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 1)
	requireNoError(t, err)
	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash("shared-scope"), Name: "shared", CreatedAt: now, ScopePolicy: &policy}
	identityScopeTest(t, db, func(scope store.IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, pat) })
	first, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	second, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	writer, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	defer func() {
		_ = first.Rollback(context.Background())
		_ = second.Rollback(context.Background())
		_ = writer.Rollback(context.Background())
	}()
	firstDAO := pgidentity.NewScope(first, oauth.NewDAO(first)).IdentityDAO().(store.PATScopeDAO)
	secondDAO := pgidentity.NewScope(second, oauth.NewDAO(second)).IdentityDAO().(store.PATScopeDAO)
	writeDAO := pgidentity.NewScope(writer, oauth.NewDAO(writer)).IdentityDAO().(store.PATScopeDAO)
	_, err = firstDAO.ReadLockedPATScope(ctx, user.ID, pat.ID)
	requireNoError(t, err)
	_, err = secondDAO.ReadLockedPATScope(ctx, user.ID, pat.ID)
	requireNoError(t, err)
	usage, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	err = credentialusage.Write(ctx, usage, []model.CredentialUsageEvent{{Kind: model.UsageSubjectPAT, UserID: user.ID, SubjectID: pat.ID, At: now.Add(time.Minute)}})
	var lockError *pgconn.PgError
	if !errors.As(err, &lockError) || lockError.Code != "55P03" {
		t.Fatalf("usage writer did not refuse the locked PAT with NOWAIT: %v", err)
	}
	requireNoError(t, usage.Rollback(ctx))
	done := make(chan error, 1)
	finished := false
	defer func() {
		cancel()
		_ = first.Rollback(context.Background())
		_ = second.Rollback(context.Background())
		if !finished {
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("writer did not stop")
			}
		}
	}()
	go func() {
		_, err := writeDAO.ComparePATScope(ctx, user.ID, pat.ID, 1, []scopepolicy.ScopeID{"project:read"}, now)
		done <- err
	}()
	waitForLock := func(holder int32) {
		t.Helper()
		for {
			var blocked bool
			requireNoError(t, db.Pool.QueryRow(ctx, `SELECT CASE WHEN $1::integer=0 THEN cardinality(pg_blocking_pids($2::integer))>0 ELSE $1::integer=ANY(pg_blocking_pids($2::integer)) END`, holder, int32(writer.Conn().PgConn().PID())).Scan(&blocked))
			if blocked {
				break
			}
			select {
			case err := <-done:
				finished = true
				t.Fatalf("write did not wait for readers: %v", err)
			case <-ctx.Done():
				t.Fatal("write did not wait for readers")
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
	waitForLock(0)
	requireNoError(t, first.Commit(ctx))
	waitForLock(int32(second.Conn().PgConn().PID()))
	requireNoError(t, second.Commit(ctx))
	select {
	case err := <-done:
		finished = true
		requireNoError(t, err)
	case <-ctx.Done():
		t.Fatal("write did not finish")
	}
	requireNoError(t, writer.Commit(ctx))
	identityScopeTest(t, db, func(scope store.IdentityScope) error {
		scoped := scope.IdentityDAO().(store.PATScopeDAO)
		got, err := scoped.PATByHash(ctx, pat.TokenHash, now)
		if err != nil {
			return err
		}
		if got.ScopePolicy == nil || got.ScopePolicy.Version() != 2 || !slices.Equal(got.ScopePolicy.Scopes(), []scopepolicy.ScopeID{"project:read"}) || got.LastUsedAt != nil {
			t.Fatalf("committed scope or usage: %+v", got)
		}
		_, err = scoped.ComparePATScope(ctx, user.ID, pat.ID, 1, []scopepolicy.ScopeID{"task:read"}, now)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("stale concurrent edit: %v", err)
		}
		return nil
	})
	usageTx, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	usedAt := now.Add(time.Minute)
	requireNoError(t, credentialusage.Write(ctx, usageTx, []model.CredentialUsageEvent{{Kind: model.UsageSubjectPAT, UserID: user.ID, SubjectID: pat.ID, At: usedAt}}))
	requireNoError(t, usageTx.Commit(ctx))
	identityScopeTest(t, db, func(scope store.IdentityScope) error {
		got, err := scope.IdentityDAO().(store.PATScopeDAO).PATByHash(ctx, pat.TokenHash, now)
		if err != nil {
			return err
		}
		if got.LastUsedAt == nil || !got.LastUsedAt.Equal(usedAt) || got.ScopePolicy == nil || got.ScopePolicy.Version() != 2 || !slices.Equal(got.ScopePolicy.Scopes(), []scopepolicy.ScopeID{"project:read"}) {
			t.Fatalf("committed usage changed scope or was not saved: %+v", got)
		}
		return nil
	})
	identityScopeTest(t, db, func(scope store.IdentityScope) error {
		return scope.IdentityDAO().DeletePAT(ctx, user.ID, pat.ID)
	})
	identityScopeTest(t, db, func(scope store.IdentityScope) error {
		scoped := scope.IdentityDAO().(store.PATScopeDAO)
		_, err := scoped.PATByHash(ctx, pat.TokenHash, now)
		requireMissing(t, err)
		_, err = scoped.ReadLockedPATScope(ctx, user.ID, pat.ID)
		requireMissing(t, err)
		return nil
	})
}

func TestPATScopeConcurrentSameVersion(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user, _, _ := testutil.AuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 1)
	requireNoError(t, err)
	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash("concurrent-scope"), Name: "concurrent", CreatedAt: now, ScopePolicy: &policy}
	identityScopeTest(t, db, func(scope store.IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, pat) })
	holder, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	defer holder.Rollback(context.Background())
	_, err = holder.Exec(ctx, `SELECT id FROM personal_access_tokens WHERE id=$1 FOR UPDATE`, pat.ID)
	requireNoError(t, err)
	first, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	second, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	type result struct {
		selected scopepolicy.ScopeID
		err      error
	}
	done := make(chan result, 2)
	remaining := 2
	defer func() {
		cancel()
		_ = holder.Rollback(context.Background())
		for remaining > 0 {
			select {
			case <-done:
				remaining--
			case <-time.After(5 * time.Second):
				t.Error("competing edits did not stop")
				return
			}
		}
	}()
	for _, op := range []struct {
		tx       pgx.Tx
		selected scopepolicy.ScopeID
	}{{first, "project:read"}, {second, "task:write"}} {
		go func() {
			defer op.tx.Rollback(context.Background())
			dao := pgidentity.NewScope(op.tx, oauth.NewDAO(op.tx)).IdentityDAO().(store.PATScopeDAO)
			_, err := dao.ComparePATScope(ctx, user.ID, pat.ID, 1, []scopepolicy.ScopeID{op.selected}, now)
			if err == nil {
				err = op.tx.Commit(ctx)
			}
			done <- result{op.selected, err}
		}()
	}
	for _, pid := range []int32{int32(first.Conn().PgConn().PID()), int32(second.Conn().PgConn().PID())} {
		for {
			var blocked bool
			requireNoError(t, db.Pool.QueryRow(ctx, `SELECT cardinality(pg_blocking_pids($1::integer))>0`, pid).Scan(&blocked))
			if blocked {
				break
			}
			select {
			case result := <-done:
				remaining--
				t.Fatalf("edit did not wait: %v", result.err)
			case <-ctx.Done():
				t.Fatal("edits did not wait")
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
	requireNoError(t, holder.Commit(ctx))
	var winner scopepolicy.ScopeID
	var successes, conflicts int
	for remaining > 0 {
		select {
		case outcome := <-done:
			remaining--
			if outcome.err == nil {
				successes++
				winner = outcome.selected
			} else if errors.Is(outcome.err, model.ErrNotFound) {
				conflicts++
			} else {
				t.Fatalf("edit failed: %v", outcome.err)
			}
		case <-ctx.Done():
			t.Fatal("competing edits did not finish")
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
	identityScopeTest(t, db, func(scope store.IdentityScope) error {
		got, err := scope.IdentityDAO().(store.PATScopeDAO).PATByHash(ctx, pat.TokenHash, now)
		if err != nil {
			return err
		}
		if got.ScopePolicy == nil || got.ScopePolicy.Version() != 2 || !slices.Equal(got.ScopePolicy.Scopes(), []scopepolicy.ScopeID{winner}) {
			t.Fatalf("competing writes persisted %+v", got)
		}
		return nil
	})
}

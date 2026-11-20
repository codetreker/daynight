package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestPATDescriptionConcurrentCASAndSessionExpiry(t *testing.T) {
	for _, expire := range []bool{false, true} {
		t.Run(map[bool]string{false: "cas", true: "session_expiry"}[expire], func(t *testing.T) {
			s := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			_, p, _ := testAuthRecords(t, s)
			now := time.Now().UTC().Truncate(time.Microsecond)
			credential := deviceStoreCredential(now)
			credential.UserID = p.UserID
			identityScopeTest(t, s, func(sc store.IdentityScope) error { return sc.IdentityDAO().InsertPAT(ctx, credential) })
			if expire {
				if _, err := s.Pool.Exec(ctx, `UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1`, p.CredentialID); err != nil {
					t.Fatal(err)
				}
			}
			blocker, err := s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback(context.Background())
			if _, err = blocker.Exec(ctx, `SELECT id FROM personal_access_tokens WHERE id=$1 FOR UPDATE`, credential.ID); err != nil {
				t.Fatal(err)
			}
			count := 2
			if expire {
				count = 1
			}
			results := make(chan error, count)
			for i := 0; i < count; i++ {
				go func(i int) {
					value := string(rune('A' + i))
					_, err := s.WriteIdentity(ctx, func(sc store.IdentityScope) error {
						dao := sc.IdentityDAO()
						_, _, err := core.NewIdentity("").UpdatePATDescription(ctx, dao, dao.(store.PATManagementDAO), p, credential.ID, p.UserID, nil, &value, now)
						return err
					})
					results <- err
				}(i)
			}
			waitIdentityLock(t, ctx, s, "%UPDATE personal_access_tokens SET description%")
			if expire {
				for {
					var passed bool
					if err := s.Pool.QueryRow(ctx, `SELECT expires_at<=clock_timestamp() FROM sessions WHERE id=$1`, p.CredentialID).Scan(&passed); err != nil {
						t.Fatal(err)
					}
					if passed {
						break
					}
					select {
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					case <-time.After(5 * time.Millisecond):
					}
				}
			}
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			var success, conflict, unauth int
			for i := 0; i < count; i++ {
				err := <-results
				if err == nil {
					success++
					continue
				}
				var fault *model.Fault
				if !errors.As(err, &fault) {
					t.Fatal(err)
				}
				switch fault.Code {
				case "version_conflict":
					conflict++
				case "unauthenticated":
					unauth++
				default:
					t.Fatal(err)
				}
			}
			if expire && (success != 0 || unauth != 1) || !expire && (success != 1 || conflict != 1) {
				t.Fatalf("results %d %d %d", success, conflict, unauth)
			}
			var description *string
			if err := s.Pool.QueryRow(ctx, `SELECT description FROM personal_access_tokens WHERE id=$1`, credential.ID).Scan(&description); err != nil {
				t.Fatal(err)
			}
			if expire && description != nil || !expire && (description == nil || (*description != "A" && *description != "B")) {
				t.Fatalf("stored description %v", description)
			}
		})
	}
}

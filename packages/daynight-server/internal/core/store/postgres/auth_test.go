package postgres

import (
	"context"
	"crypto/sha256"
	"testing"
	"time"


	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func testAuthRecords(t *testing.T, s *Store) (model.User, model.Principal, model.Session) {
	t.Helper()
	now := time.Now().UTC()
	hash := sha256.Sum256([]byte(uuid.NewString()))
	c := model.Session{ID: uuid.NewString(), TokenHash: hash[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	u, err := seedIdentitySession(s, context.Background(), model.User{ID: uuid.NewString(), UniAuthID: "github:" + uuid.NewString()}, c)
	if err != nil {
		t.Fatal(err)
	}
	p, err := testAuthenticate(s, context.Background(), model.SessionCredential, hash[:], now)
	if err != nil {
		t.Fatal(err)
	}
	return u, p, c
}

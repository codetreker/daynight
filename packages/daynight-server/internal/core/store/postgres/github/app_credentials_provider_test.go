package github_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	"github.com/google/uuid"
)

func TestAppCredentialReaderWithClientProvider(t *testing.T) {
	db, _ := dbFixture(t)
	ctx := t.Context()
	key, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	id := uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO github_apps
 (id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret)
 VALUES ($1,42,'name','remote','slug',$2,$3)`, id, keyPEM, []byte("secret")); err != nil {
		t.Fatal(err)
	}
	provider, err := service.NewClientProvider(github.NewAppCredentialReader(db.Pool))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := provider.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	first, releaseFirst, err := provider.Acquire(ctx, id, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseFirst()
	again, releaseAgain, err := provider.Acquire(ctx, id, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseAgain()
	if again != first {
		t.Fatal("same App and credential version did not share the client")
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE github_apps SET credential_version=2 WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, _, err := provider.Acquire(ctx, id, 1); !errors.Is(err, service.ErrCredentialChanged) {
		t.Fatalf("old version accepted: %v", err)
	}
	second, releaseSecond, err := provider.Acquire(ctx, id, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseSecond()
	if second == first {
		t.Fatal("new credential version reused the old client")
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE github_apps SET deleted_at=now(),private_key_pem=NULL,webhook_secret=NULL WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, _, err := provider.Acquire(ctx, id, 2); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted App accepted: %v", err)
	}
}

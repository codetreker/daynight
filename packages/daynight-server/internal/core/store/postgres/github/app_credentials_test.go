package github_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
)

func TestAppCredentialSnapshot(t *testing.T) {
	db, _ := dbFixture(t)
	ctx := t.Context()
	id := uuid.NewString()
	_, err := db.Pool.Exec(ctx, `INSERT INTO github_apps
 (id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret)
 VALUES ($1,42,'name','remote','slug',$2,$3)`, id, []byte("first key"), []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	reader := github.NewAppCredentialReader(db.Pool)
	want := githubpr.CredentialSnapshot{AppResourceID: id, GitHubAppID: 42, CredentialVersion: 1, PrivateKeyPEM: []byte("first key")}
	got, err := reader.Credentials(ctx, id)
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("initial snapshot: %+v %v", got, err)
	}
	_, err = db.Pool.Exec(ctx, `UPDATE github_apps SET private_key_pem=$2,credential_version=2 WHERE id=$1`, id, []byte("second key"))
	if err != nil {
		t.Fatal(err)
	}
	want.CredentialVersion, want.PrivateKeyPEM = 2, []byte("second key")
	got, err = reader.Credentials(ctx, id)
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("updated snapshot: %+v %v", got, err)
	}
	if got, err = reader.Credentials(ctx, uuid.NewString()); !errors.Is(err, model.ErrNotFound) || !reflect.DeepEqual(got, githubpr.CredentialSnapshot{}) {
		t.Fatalf("missing App: %+v %v", got, err)
	}
	for _, column := range []string{"private_key_pem", "webhook_secret"} {
		if _, err := db.Pool.Exec(ctx, `UPDATE github_apps SET `+column+`=NULL WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		if got, err = reader.Credentials(ctx, id); err == nil || errors.Is(err, model.ErrNotFound) || !reflect.DeepEqual(got, githubpr.CredentialSnapshot{}) {
			t.Fatalf("missing %s: %+v %v", column, got, err)
		}
		if _, err := db.Pool.Exec(ctx, `UPDATE github_apps SET `+column+`=$2 WHERE id=$1`, id, []byte("restored")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE github_apps SET deleted_at=now(), private_key_pem=NULL, webhook_secret=NULL WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if got, err = reader.Credentials(ctx, id); !errors.Is(err, model.ErrNotFound) || !reflect.DeepEqual(got, githubpr.CredentialSnapshot{}) {
		t.Fatalf("deleted App: %+v %v", got, err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if got, err = reader.Credentials(cancelled, id); !errors.Is(err, context.Canceled) || !reflect.DeepEqual(got, githubpr.CredentialSnapshot{}) {
		t.Fatalf("cancelled read: %+v %v", got, err)
	}
}

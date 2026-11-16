package postgres

import (
	"testing"
)

func TestStoreCredentialsReadsOnlyLiveApp(t *testing.T) {
	db, _, _, _, app, _ := projectAppScopeFixture(t)
	got, err := db.Credentials(t.Context(), app)
	if err != nil || got.AppResourceID != app || got.GitHubAppID != 9 || got.CredentialVersion != 1 || string(got.PrivateKeyPEM) != "k" {
		t.Fatalf("credentials: %+v %v", got, err)
	}
	mustQueryExec(t, db, `UPDATE github_apps SET webhook_secret=NULL WHERE id=$1`, app)
	if _, err := db.Credentials(t.Context(), app); err == nil {
		t.Fatal("missing credentials accepted")
	}
	mustQueryExec(t, db, `UPDATE github_apps SET deleted_at=now() WHERE id=$1`, app)
	if _, err := db.Credentials(t.Context(), app); err == nil {
		t.Fatal("deleted App accepted")
	}
}

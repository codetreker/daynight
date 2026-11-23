//go:build integration

package main

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
)

// The internal issuer prepares a real family while public application issuance
// remains outside this Session protocol flow's responsibility.
func sessionFlowAPIAccess(t *testing.T, f *fixture) string {
	t.Helper()
	database, err := postgres.Open(f.context, f.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	issuer, err := oauth.NewAPIIssuer(database, f.origin)
	if err != nil {
		t.Fatal(err)
	}
	issued, err := issuer.Issue(f.context, f.userID)
	if err != nil {
		t.Fatal(err)
	}
	return issued.AccessToken
}

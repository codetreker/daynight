//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func newApplicationFixture(t *testing.T, f *fixture) *fixture {
	t.Helper()
	database, err := pgxpool.New(f.context, f.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var externalID string
	if err := database.QueryRow(f.context, `SELECT uniauth_id FROM users WHERE id=$1`, f.userID).Scan(&externalID); err != nil || externalID == "" {
		t.Fatal("read the authenticated account's external identity failed")
	}
	body, err := json.Marshal(map[string]string{"externalUserId": externalID})
	if err != nil {
		t.Fatal("encode application identity failed")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(transport.CloseIdleConnections)
	plain := &http.Client{Timeout: 5 * time.Second, Transport: transport}
	response, data := applicationRequest(t, f, plain, "/api/v1/oauth/s2s/token", string(body), "application/json", "S2S "+f.s2sSharedKey)
	tokens := applicationTokenResponse(t, f, response, data)
	application := *f
	application.client = &http.Client{Timeout: 5 * time.Second, Transport: tokenTransport{token: tokens.AccessToken, next: transport}}
	return &application
}

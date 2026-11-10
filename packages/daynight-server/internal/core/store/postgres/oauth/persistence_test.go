package oauth_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func transaction(t *testing.T) (pgx.Tx, *oauth.DAO) {
	t.Helper()
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	tx, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return tx, oauth.NewDAO(tx)
}
func digest(value string) []byte { sum := sha256.Sum256([]byte(value)); return sum[:] }
func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func missing(t *testing.T, err error) {
	t.Helper()
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("expected absence, got %v", err)
	}
	if failed, _ := store.DatabaseErrorFacts(err); failed {
		t.Fatalf("absence marked as database failure: %v", err)
	}
}
func family(now time.Time, client string) store.OAuthFamilyIssue {
	return store.OAuthFamilyIssue{Grant: store.OAuthGrant{ID: uuid.NewString(), UserID: uuid.NewString(), ClientID: client, ClientSnapshot: []byte(`{"client_name":"Tool"}`), Resource: "https://example.test/mcp", Scope: "daynight:mcp", CreatedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour)}, AccessID: uuid.NewString(), AccessHash: digest(uuid.NewString()), RefreshHash: digest(uuid.NewString()), AccessExpiresAt: now.Add(time.Hour)}
}

func TestFamilyIssuanceAdmissionAndRevocation(t *testing.T) {
	tx, dao := transaction(t)
	ctx, now := t.Context(), time.Now().UTC().Truncate(time.Microsecond)
	issue := family(now, "client")
	_, err := tx.Exec(ctx, `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,$3,$3)`, issue.Grant.UserID, "family-owner", now)
	check(t, err)
	check(t, dao.IssueFamily(ctx, issue))
	got, err := dao.AuthenticateAccess(ctx, issue.AccessHash, issue.Grant.Resource, issue.Grant.Scope, now)
	check(t, err)
	if got.Principal != (model.Principal{Kind: model.OAuthCredential, UserID: issue.Grant.UserID, CredentialID: issue.AccessID}) || got.GrantID != issue.Grant.ID {
		t.Fatalf("access identity: %+v", got)
	}
	for _, input := range []struct {
		name            string
		hash            []byte
		resource, scope string
		at              time.Time
	}{
		{"refresh hash", issue.RefreshHash, issue.Grant.Resource, issue.Grant.Scope, now},
		{"other resource", issue.AccessHash, "https://other.test/mcp", issue.Grant.Scope, now},
		{"other scope", issue.AccessHash, issue.Grant.Resource, "other", now},
		{"expiry boundary", issue.AccessHash, issue.Grant.Resource, issue.Grant.Scope, issue.AccessExpiresAt},
	} {
		t.Run(input.name, func(t *testing.T) {
			_, err := dao.AuthenticateAccess(ctx, input.hash, input.resource, input.scope, input.at)
			missing(t, err)
		})
	}
	grant, err := dao.InspectGrant(ctx, issue.Grant.ID, false)
	check(t, err)
	if grant.ID != issue.Grant.ID || grant.UserID != issue.Grant.UserID || grant.ClientID != issue.Grant.ClientID || grant.Resource != issue.Grant.Resource || grant.Scope != issue.Grant.Scope || grant.RevokedAt != nil || !grant.ExpiresAt.Equal(issue.Grant.ExpiresAt) {
		t.Fatalf("grant projection: %+v", grant)
	}
	var user, grantID, client string
	var accessHash, refreshHash []byte
	var refreshExpiry time.Time
	check(t, tx.QueryRow(ctx, `SELECT a.user_id::text,r.grant_id::text,r.client_id,a.token_hash,r.token_hash,r.expires_at FROM oauth_access_tokens a JOIN oauth_refresh_tokens r ON r.grant_id=a.grant_id WHERE a.id=$1`, issue.AccessID).Scan(&user, &grantID, &client, &accessHash, &refreshHash, &refreshExpiry))
	if user != issue.Grant.UserID || grantID != issue.Grant.ID || client != issue.Grant.ClientID || string(accessHash) != string(issue.AccessHash) || string(refreshHash) != string(issue.RefreshHash) || !refreshExpiry.Equal(issue.Grant.ExpiresAt) {
		t.Fatal("family relationships or hashes diverged from grant")
	}
	active, err := dao.ActiveClientReferences(ctx, issue.Grant.ClientID, now)
	check(t, err)
	if !active {
		t.Fatal("live grant missing from client references")
	}
	foreign, err := dao.ActiveClientReferences(ctx, "other", now)
	check(t, err)
	if foreign {
		t.Fatal("foreign client acquired grant reference")
	}
	active, err = dao.ActiveClientReferences(ctx, issue.Grant.ClientID, issue.Grant.ExpiresAt)
	check(t, err)
	if active {
		t.Fatal("expired grant retained as active reference")
	}
	changed, err := dao.RevokeFamily(ctx, issue.Grant.ID, now)
	check(t, err)
	if !changed {
		t.Fatal("initial revocation did not report change")
	}
	changed, err = dao.RevokeFamily(ctx, issue.Grant.ID, now.Add(time.Minute))
	check(t, err)
	if changed {
		t.Fatal("repeat revocation reported change")
	}
	revoked, err := dao.InspectGrant(ctx, issue.Grant.ID, true)
	check(t, err)
	if revoked.RevokedAt == nil || revoked.RevokedAt.Before(now) {
		t.Fatalf("revocation timestamp: %+v", revoked)
	}
	_, err = dao.AuthenticateAccess(ctx, issue.AccessHash, issue.Grant.Resource, issue.Grant.Scope, now)
	missing(t, err)
	active, err = dao.ActiveClientReferences(ctx, issue.Grant.ClientID, now)
	check(t, err)
	if active {
		t.Fatal("revoked grant retained as active reference")
	}
	var accessCount, refreshCount int
	check(t, tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_access_tokens),(SELECT count(*) FROM oauth_refresh_tokens)`).Scan(&accessCount, &refreshCount))
	if accessCount != 0 || refreshCount != 1 {
		t.Fatalf("revocation rows: access=%d refresh=%d", accessCount, refreshCount)
	}
	_, err = dao.RevokeFamily(ctx, uuid.NewString(), now)
	missing(t, err)
}

func TestFamilyRejectsInvalidIssueBeforePersistence(t *testing.T) {
	tx, dao := transaction(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	valid := family(now, "client")
	for _, test := range []struct {
		name   string
		change func(*store.OAuthFamilyIssue)
	}{
		{"revoked grant", func(v *store.OAuthFamilyIssue) { v.Grant.RevokedAt = &now }},
		{"short access hash", func(v *store.OAuthFamilyIssue) { v.AccessHash = nil }},
		{"short refresh hash", func(v *store.OAuthFamilyIssue) { v.RefreshHash = nil }},
		{"nonpositive grant lifetime", func(v *store.OAuthFamilyIssue) { v.Grant.ExpiresAt = now }},
		{"long grant lifetime", func(v *store.OAuthFamilyIssue) { v.Grant.ExpiresAt = now.Add(30*24*time.Hour + time.Microsecond) }},
		{"31-day grant lifetime", func(v *store.OAuthFamilyIssue) { v.Grant.ExpiresAt = now.Add(31 * 24 * time.Hour) }},
		{"nonpositive access lifetime", func(v *store.OAuthFamilyIssue) { v.AccessExpiresAt = now }},
		{"long access lifetime", func(v *store.OAuthFamilyIssue) { v.AccessExpiresAt = now.Add(time.Hour + time.Microsecond) }},
		{"two-hour access lifetime", func(v *store.OAuthFamilyIssue) { v.AccessExpiresAt = now.Add(2 * time.Hour) }},
		{"access exceeds grant", func(v *store.OAuthFamilyIssue) { v.Grant.ExpiresAt = now.Add(time.Minute) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			issue := valid
			test.change(&issue)
			var fault *model.Fault
			err := dao.IssueFamily(t.Context(), issue)
			if !errors.As(err, &fault) || fault.Code != "invalid_input" {
				t.Fatalf("invalid issue: %v", err)
			}
		})
	}
	var count int
	check(t, tx.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM oauth_grants)+(SELECT count(*) FROM oauth_access_tokens)+(SELECT count(*) FROM oauth_refresh_tokens)`).Scan(&count))
	if count != 0 {
		t.Fatalf("invalid families persisted %d rows", count)
	}
}

func TestClientCapacityPinningAndExpiry(t *testing.T) {
	_, dao := transaction(t)
	ctx, now := t.Context(), time.Now().UTC().Truncate(time.Microsecond)
	client := store.OAuthClient{ID: "registered", Metadata: []byte(`{"client_name":"Tool"}`), CreatedAt: now, LastUsedAt: now, ExpiresAt: now.Add(7 * 24 * time.Hour)}
	if created, err := dao.InsertClient(ctx, client, 0, now); err == nil || created {
		t.Fatalf("invalid capacity accepted: %v %v", created, err)
	}
	created, err := dao.InsertClient(ctx, client, 1, now)
	check(t, err)
	if !created {
		t.Fatal("client not created")
	}
	overflow := client
	overflow.ID = "overflow"
	created, err = dao.InsertClient(ctx, overflow, 1, now)
	check(t, err)
	if created {
		t.Fatal("client capacity exceeded")
	}
	got, err := dao.Client(ctx, client.ID, false)
	check(t, err)
	if got.ID != client.ID || !got.CreatedAt.Equal(client.CreatedAt) || !got.LastUsedAt.Equal(client.LastUsedAt) || !got.ExpiresAt.Equal(client.ExpiresAt) {
		t.Fatalf("client projection: %+v", got)
	}
	pinned, err := dao.PinClient(ctx, client.ID, now.Add(time.Minute))
	check(t, err)
	if !pinned.LastUsedAt.Equal(now.Add(time.Minute)) || !pinned.ExpiresAt.Equal(now.Add(time.Minute+7*24*time.Hour)) {
		t.Fatalf("pinned client: %+v", pinned)
	}
	pinnedAgain, err := dao.PinClient(ctx, client.ID, now)
	check(t, err)
	if !pinnedAgain.LastUsedAt.Equal(pinned.LastUsedAt) {
		t.Fatalf("last-use clock moved backwards: %+v", pinnedAgain)
	}
	fresh, err := dao.FreshTime(ctx, now.Add(time.Hour))
	check(t, err)
	if !fresh.Equal(now.Add(time.Hour)) {
		t.Fatalf("future caller time discarded: %v", fresh)
	}
	expiredAt := pinned.ExpiresAt
	ids, err := dao.ExpiredClients(ctx, expiredAt, 10)
	check(t, err)
	if len(ids) != 1 || ids[0] != client.ID {
		t.Fatalf("expired clients: %v", ids)
	}
	_, err = dao.PinClient(ctx, client.ID, expiredAt)
	missing(t, err)

	issue := family(now, client.ID)
	check(t, dao.IssueFamily(ctx, issue))
	ids, err = dao.ExpiredClients(ctx, expiredAt, 10)
	check(t, err)
	if len(ids) != 0 {
		t.Fatalf("referenced client eligible for cleanup: %v", ids)
	}
	revived, err := dao.PinClient(ctx, client.ID, expiredAt)
	check(t, err)
	if !revived.LastUsedAt.Equal(expiredAt) || !revived.ExpiresAt.Equal(expiredAt.Add(7*24*time.Hour)) {
		t.Fatalf("referenced client not retained: %+v", revived)
	}
	created, err = dao.InsertClient(ctx, overflow, 1, now)
	check(t, err)
	if !created {
		t.Fatal("active referenced client incorrectly consumed capacity")
	}
	check(t, dao.DeleteClient(ctx, overflow.ID))
	_, err = dao.Client(ctx, overflow.ID, true)
	missing(t, err)
	_, err = dao.PinClient(ctx, "missing", now)
	missing(t, err)
}

func TestClientMetadataJSONBRoundTripBeyondWireLimit(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	const wireLimit = 65536
	uri := "https://client.example/" + strings.Repeat("a", wireLimit-100)
	request, err := json.Marshal(map[string]any{"redirect_uris": []string{uri}})
	check(t, err)
	id := "dnoac_" + strings.Repeat("A", 43)
	metadata := map[string]any{"client_id": id, "redirect_uris": []any{uri}, "token_endpoint_auth_method": "none"}
	encoded, err := json.Marshal(metadata)
	check(t, err)
	if len(uri) != 65459 || len(request) != 65481 || len(encoded) != 65581 || len(request) >= wireLimit || len(encoded) <= wireLimit {
		t.Fatalf("metadata boundary fixture: URI=%d request=%d stored=%d", len(uri), len(request), len(encoded))
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	client := store.OAuthClient{ID: id, Metadata: encoded, CreatedAt: now, LastUsedAt: now, ExpiresAt: now.Add(7 * 24 * time.Hour)}
	tx, err := db.Pool.Begin(ctx)
	check(t, err)
	defer tx.Rollback(context.Background())
	inserted, err := oauth.NewDAO(tx).InsertClient(ctx, client, 10000, now)
	check(t, err)
	if !inserted {
		t.Fatal("large metadata client was not inserted")
	}
	check(t, tx.Commit(ctx))

	tx, err = db.Pool.Begin(ctx)
	check(t, err)
	defer tx.Rollback(context.Background())
	dao := oauth.NewDAO(tx)
	stored, err := dao.Client(ctx, client.ID, false)
	check(t, err)
	var actual map[string]any
	check(t, json.Unmarshal(stored.Metadata, &actual))
	if stored.ID != client.ID || !stored.CreatedAt.Equal(client.CreatedAt) || !stored.LastUsedAt.Equal(client.LastUsedAt) || !stored.ExpiresAt.Equal(client.ExpiresAt) || len(stored.Metadata) <= wireLimit || !reflect.DeepEqual(actual, metadata) {
		t.Fatalf("large JSONB metadata roundtrip: bytes=%d metadataEqual=%t client=%s created=%s last=%s expiry=%s", len(stored.Metadata), reflect.DeepEqual(actual, metadata), stored.ID, stored.CreatedAt, stored.LastUsedAt, stored.ExpiresAt)
	}
	pinAt := now.Add(time.Minute)
	pinned, err := dao.PinClient(ctx, client.ID, pinAt)
	check(t, err)
	check(t, tx.Commit(ctx))
	var raw []byte
	var lastUsed, expires time.Time
	check(t, db.Pool.QueryRow(ctx, `SELECT metadata,last_used_at,expires_at FROM oauth_clients WHERE id=$1`, client.ID).Scan(&raw, &lastUsed, &expires))
	var persisted map[string]any
	check(t, json.Unmarshal(raw, &persisted))
	if !lastUsed.Equal(pinAt) || !expires.Equal(pinAt.Add(7*24*time.Hour)) || !pinned.LastUsedAt.Equal(lastUsed) || !pinned.ExpiresAt.Equal(expires) || !reflect.DeepEqual(persisted, metadata) {
		t.Fatalf("large metadata pin persistence: metadataEqual=%t last=%s expiry=%s", reflect.DeepEqual(persisted, metadata), lastUsed, expires)
	}
}

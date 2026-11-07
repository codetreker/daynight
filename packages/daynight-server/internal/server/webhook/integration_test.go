package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
)

type integrationHarness struct {
	*testsupport.AuthHarness[*authhttp.Authentication]
	alice, bob, charlie                   model.Principal
	aliceCookie, bobCookie, charlieCookie *http.Cookie
	team                                  model.Team
	project                               model.Project
	keyring                               *secretbox.Keyring
}

func newIntegrationHarness(t *testing.T) *integrationHarness {
	t.Helper()
	auth := testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, config.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
	h := &integrationHarness{AuthHarness: auth}
	h.aliceCookie, h.bobCookie, h.charlieCookie = auth.Login(t, "webhook-alice"), auth.Login(t, "webhook-bob"), auth.Login(t, "webhook-charlie")
	h.alice, h.bob, h.charlie = h.principal(t, h.aliceCookie), h.principal(t, h.bobCookie), h.principal(t, h.charlieCookie)
	var err error
	h.keyring, err = secretbox.New([]byte(`{"activeKeyId":"test-key","keys":{"test-key":"` + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)) + `"}}`))
	if err != nil {
		t.Fatal(err)
	}
	h.team, err = teamservice.NewTeams(h.Database).Create(context.Background(), h.alice, teamcore.CreateTeam{Name: "Webhook team", ExpectedUserID: h.alice.UserID})
	if err != nil {
		t.Fatal(err)
	}
	h.project, err = projectservice.NewProjects(h.Database).Create(context.Background(), h.alice, projectcore.CreateProject{Name: "Webhook project", RepoURL: "https://github.com/example/webhooks", TeamID: &h.team.ID, ExpectedUserID: h.alice.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Database.Pool.Exec(context.Background(), `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, h.team.ID, h.bob.UserID); err != nil {
		t.Fatal(err)
	}
	h.mount(t, h.Database, h.keyring, true)
	return h
}

func (h *integrationHarness) principal(t *testing.T, cookie *http.Cookie) model.Principal {
	t.Helper()
	request := httptest.NewRequest("GET", "/api/v1/me", nil)
	request.AddCookie(cookie)
	principal, err := h.Auth.AuthenticateRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	return principal
}

type persistence interface {
	store.SnapshotReader
	store.WebhookWriter
}

func (h *integrationHarness) mount(t *testing.T, database persistence, keys *secretbox.Keyring, expansion bool) {
	t.Helper()
	manager, err := webhookservice.New(database, keys, webhookservice.Settings{ConfigurationExpansionAvailable: expansion, DispatchEnabled: false})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	h.Auth.RegisterRoutes(mux)
	RegisterRoutes(mux, manager, h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
}

func (h *integrationHarness) call(method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	return h.Request(method, path, body, []*http.Cookie{cookie}, nil, h.Origin)
}

func (h *integrationHarness) newOperation(principal model.Principal) map[string]any {
	return map[string]any{"operationId": uuid.NewString(), "issuedAt": time.Now().UTC().Format(time.RFC3339Nano), "expectedUserId": principal.UserID}
}

func body(t *testing.T, value any) string { return testsupport.JSONBody(t, value) }

func createBody(h *integrationHarness, principal model.Principal) map[string]any {
	input := h.newOperation(principal)
	input["name"], input["enabled"] = "  Notifications  ", true
	input["destination"] = map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": "https://receiver.example/private?token=sensitive"}}
	input["subscriptions"] = []any{map[string]any{"id": nil, "projectId": h.project.ID, "eventTypes": []string{"task.paused", "task.created"}}}
	return input
}

type mutationResponse struct {
	Operation operationResponse `json:"operation"`
	Endpoint  json.RawMessage   `json:"endpoint"`
}
type rotationResponse struct {
	Operation operationResponse `json:"operation"`
	Signing   signingResponse   `json:"signing"`
}
type secretResponse struct{ EndpointID, ConfigVersion, KeyID, Scheme, Secret string }

func decoded[T any](t *testing.T, response *httptest.ResponseRecorder, status int) T {
	t.Helper()
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") == "" {
		t.Fatal("Webhook response lacks private principal admission headers")
	}
	return testsupport.DecodeResponse[T](t, response, status)
}

func decodeEndpoint(t *testing.T, raw json.RawMessage) endpointResponse {
	t.Helper()
	var value endpointResponse
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func errorStatus(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	testsupport.AssertProjectError(t, response, status, code)
}

func TestPersonalManagementLifecycleAndOriginalReceiptReplay(t *testing.T) {
	h := newIntegrationHarness(t)
	const base = "/api/v1/me/webhooks"
	input := createBody(h, h.alice)
	originalBody := body(t, input)
	createdResponse := h.call("POST", base, originalBody, h.aliceCookie)
	created := decoded[mutationResponse](t, createdResponse, 201)
	endpoint := decodeEndpoint(t, created.Endpoint)
	hash := sha256.Sum256([]byte(originalBody))
	if created.Operation.RequestSHA256 != hex.EncodeToString(hash[:]) || created.Operation.IssuedAt != input["issuedAt"] || endpoint.Owner.Kind != webhookmodel.PersonalOwner || endpoint.Owner.ID != h.alice.UserID || endpoint.ConfigVersion != "1" || endpoint.Name != "Notifications" || endpoint.Destination.URL == nil || len(endpoint.Subscriptions) != 1 {
		t.Fatalf("create contract: %+v %+v", created.Operation, endpoint)
	}
	if strings.Contains(createdResponse.Body.String(), "whsec_") || strings.Contains(createdResponse.Body.String(), "fingerprint") {
		t.Fatal("ordinary creation returned private signing or fingerprint material")
	}
	input["name"] = "Notifications"
	semanticReplay := body(t, input)
	replayed := decoded[mutationResponse](t, h.call("POST", base, semanticReplay, h.aliceCookie), 200)
	if replayed.Operation.RequestSHA256 != created.Operation.RequestSHA256 || decodeEndpoint(t, replayed.Endpoint).ID != endpoint.ID {
		t.Fatal("semantic replay lost the original byte receipt or produced another endpoint")
	}
	input["name"] = "Different intent"
	errorStatus(t, h.call("POST", base, body(t, input), h.aliceCookie), 409, "operation_conflict")
	input["name"] = "Notifications"
	path := base + "/" + endpoint.ID
	secret := decoded[secretResponse](t, h.call("GET", path+"/signing-secret", "", h.aliceCookie), 200)
	if !strings.HasPrefix(secret.Secret, "whsec_") || secret.KeyID != endpoint.Signing.ActiveKeyID {
		t.Fatal("separate signing secret did not identify the current primary key")
	}
	noop := h.newOperation(h.alice)
	noop["ifVersion"], noop["name"] = "1", "Notifications"
	unchanged := decoded[mutationResponse](t, h.call("PATCH", path, body(t, noop), h.aliceCookie), 200)
	if unchanged.Operation.Effect != webhookmodel.EffectUnchanged || unchanged.Operation.ConfigVersionAfter != "1" {
		t.Fatal("same-value update changed the configuration version")
	}
	stale := h.newOperation(h.alice)
	stale["ifVersion"], stale["name"] = "2", "Notifications"
	errorStatus(t, h.call("PATCH", path, body(t, stale), h.aliceCookie), 409, "version_conflict")
	rotation := h.newOperation(h.alice)
	rotation["ifVersion"], rotation["mode"] = "1", "overlap"
	rotationBody := body(t, rotation)
	first := decoded[rotationResponse](t, h.call("POST", path+"/signing-secret/rotations", rotationBody, h.aliceCookie), 200)
	if first.Signing.OverlapUntil == nil || first.Operation.KeyID == nil || first.Signing.ActiveKeyID == secret.KeyID || first.Operation.ConfigVersionAfter != "2" {
		t.Fatal("overlap rotation did not expose bounded non-secret results")
	}
	second := h.newOperation(h.alice)
	second["ifVersion"], second["mode"] = "2", "overlap"
	errorStatus(t, h.call("POST", path+"/signing-secret/rotations", body(t, second), h.aliceCookie), 409, "resource_conflict")
	second["mode"] = "immediate"
	next := decoded[rotationResponse](t, h.call("POST", path+"/signing-secret/rotations", body(t, second), h.aliceCookie), 200)
	if next.Signing.OverlapUntil != nil || next.Signing.ActiveKeyID == first.Signing.ActiveKeyID {
		t.Fatal("immediate rotation retained old overlap")
	}
	oldRotation := decoded[rotationResponse](t, h.call("POST", path+"/signing-secret/rotations", rotationBody, h.aliceCookie), 200)
	if oldRotation.Signing.ActiveKeyID != first.Signing.ActiveKeyID || !oldRotation.Signing.OverlapUntil.Equal(*first.Signing.OverlapUntil) {
		t.Fatal("old rotation replay reconstructed its result from later key state")
	}
	remove := h.newOperation(h.alice)
	remove["ifVersion"] = "3"
	deleted := decoded[mutationResponse](t, h.call("DELETE", path, body(t, remove), h.aliceCookie), 200)
	var tombstone map[string]json.RawMessage
	if err := json.Unmarshal(deleted.Endpoint, &tombstone); err != nil || len(tombstone) != 5 || tombstone["name"] != nil || tombstone["destination"] != nil {
		t.Fatal("deleted endpoint did not return the minimum tombstone")
	}
	oldRotation = decoded[rotationResponse](t, h.call("POST", path+"/signing-secret/rotations", rotationBody, h.aliceCookie), 200)
	if oldRotation.Signing.ActiveKeyID != first.Signing.ActiveKeyID || oldRotation.Signing.OverlapUntil == nil {
		t.Fatal("deletion destroyed the original rotation receipt metadata")
	}
	errorStatus(t, h.call("GET", path+"/signing-secret", "", h.aliceCookie), 404, "not_found")
	retained := decoded[operationResponse](t, h.call("GET", base+"/operations/"+created.Operation.OperationID, "", h.aliceCookie), 200)
	if retained.ConfigVersionAfter != "1" || retained.RequestSHA256 != created.Operation.RequestSHA256 {
		t.Fatal("later resource updates changed an original receipt")
	}
	list := decoded[struct {
		Items      []endpointSummaryResponse `json:"items"`
		NextCursor *string                   `json:"nextCursor"`
	}](t, h.call("GET", base, "", h.aliceCookie), 200)
	if list.Items == nil || len(list.Items) != 0 || list.NextCursor != nil {
		t.Fatal("deleted endpoint appears in the active list")
	}
	if strings.Contains(h.Logs.String(), "sensitive") || strings.Contains(h.Logs.String(), secret.Secret) {
		t.Fatal("HTTP diagnostics disclosed a URL credential or signing secret")
	}
}

func TestTeamReadOnlyViewsAndPersonalGrantContinuity(t *testing.T) {
	h := newIntegrationHarness(t)
	ctx := context.Background()
	teamBase := "/api/v1/teams/" + h.team.ID + "/webhooks"
	input := createBody(h, h.alice)
	original := body(t, input)
	created := decoded[mutationResponse](t, h.call("POST", teamBase, original, h.aliceCookie), 201)
	endpoint := decodeEndpoint(t, created.Endpoint)
	path := teamBase + "/" + endpoint.ID
	member := decoded[endpointResponse](t, h.call("GET", path, "", h.bobCookie), 200)
	if member.Destination.URL != nil || strings.Contains(member.Destination.DisplayURL, "private") || member.Capabilities.Manage || member.Capabilities.ReadSecret {
		t.Fatal("Team member received sensitive configuration or management capability")
	}
	errorStatus(t, h.call("GET", path+"/signing-secret", "", h.bobCookie), 403, "forbidden")
	errorStatus(t, h.call("POST", teamBase, body(t, createBody(h, h.bob)), h.bobCookie), 403, "forbidden")
	errorStatus(t, h.call("GET", path, "", h.charlieCookie), 403, "forbidden")
	list := decoded[struct {
		Items []endpointSummaryResponse `json:"items"`
	}](t, h.call("GET", teamBase+"?q=sensitive", "", h.bobCookie), 200)
	if len(list.Items) != 0 {
		t.Fatal("read-only search matched a hidden URL credential")
	}
	memberships := projectservice.NewMemberships(h.Database)
	invitation, err := memberships.CreateInvitation(ctx, h.alice, h.project.ID, h.alice.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := memberships.AcceptInvitation(ctx, h.charlie, invitation.Secret, h.charlie.UserID); err != nil {
		t.Fatal(err)
	}
	var initialVersion int64
	if err := h.Database.Pool.QueryRow(ctx, `SELECT version FROM project_grants WHERE project_id=$1 AND user_id=$2`, h.project.ID, h.charlie.UserID).Scan(&initialVersion); err != nil {
		t.Fatal(err)
	}
	grant, err := memberships.SetGrant(ctx, h.alice, h.project.ID, h.charlie.UserID, projectcore.SetProjectGrant{Version: &initialVersion, Role: model.ProjectAdmin, ExpectedUserID: h.alice.UserID})
	if err != nil || grant.Grant.UserID != h.charlie.UserID {
		t.Fatal(err)
	}
	personal := decoded[mutationResponse](t, h.call("POST", "/api/v1/me/webhooks", body(t, createBody(h, h.charlie)), h.charlieCookie), 201)
	personalEndpoint := decodeEndpoint(t, personal.Endpoint)
	if personalEndpoint.Owner.ID != h.charlie.UserID || personalEndpoint.Subscriptions[0].Eligibility != webhookmodel.Eligible {
		t.Fatal("personal owner could not select its directly shared project")
	}
	version := grant.Grant.Version
	if _, err := projectservice.NewMemberships(h.Database).RemoveGrant(ctx, h.alice, h.project.ID, h.charlie.UserID, projectcore.RemoveProjectMember{Version: version, ExpectedUserID: h.alice.UserID}); err != nil {
		t.Fatal(err)
	}
	personalPath := "/api/v1/me/webhooks/" + personalEndpoint.ID
	revoked := decoded[endpointResponse](t, h.call("GET", personalPath, "", h.charlieCookie), 200)
	if revoked.Subscriptions[0].Eligibility != webhookmodel.AccessRevoked || revoked.Subscriptions[0].ProjectName != nil {
		t.Fatal("revoked personal resource retained eligibility or project data")
	}
	invitation, err = memberships.CreateInvitation(ctx, h.alice, h.project.ID, h.alice.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := memberships.AcceptInvitation(ctx, h.charlie, invitation.Secret, h.charlie.UserID); err != nil {
		t.Fatal(err)
	}
	regranted := decoded[endpointResponse](t, h.call("GET", personalPath, "", h.charlieCookie), 200)
	if regranted.Subscriptions[0].Eligibility != webhookmodel.ConfirmationRequired {
		t.Fatal("regrant automatically reactivated a revoked subscription")
	}
	confirm := h.newOperation(h.charlie)
	confirm["ifVersion"], confirm["confirmProjectIds"] = regranted.ConfigVersion, []string{h.project.ID}
	confirmed := decoded[mutationResponse](t, h.call("PATCH", personalPath, body(t, confirm), h.charlieCookie), 200)
	if decodeEndpoint(t, confirmed.Endpoint).Subscriptions[0].Eligibility != webhookmodel.Eligible {
		t.Fatal("explicit authorized confirmation did not restore future eligibility")
	}
	if _, err := h.Database.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, h.team.ID, h.charlie.UserID); err != nil {
		t.Fatal(err)
	}
	var membershipVersion int64
	if err := h.Database.Pool.QueryRow(ctx, `SELECT version FROM team_members WHERE team_id=$1 AND user_id=$2`, h.team.ID, h.alice.UserID).Scan(&membershipVersion); err != nil {
		t.Fatal(err)
	}
	if _, err := teamservice.NewTeams(h.Database).SetMemberRole(ctx, h.alice, h.team.ID, h.alice.UserID, teamcore.ChangeTeamMember{Version: membershipVersion, Role: model.ProjectMemberRole, ExpectedUserID: h.alice.UserID}); err != nil {
		t.Fatal(err)
	}
	ownReceipt := decoded[operationResponse](t, h.call("GET", teamBase+"/operations/"+created.Operation.OperationID, "", h.aliceCookie), 200)
	if ownReceipt.ActorUserID != h.alice.UserID {
		t.Fatal("demoted current member could not recover their own operation")
	}
	errorStatus(t, h.call("GET", teamBase+"/operations/"+created.Operation.OperationID, "", h.bobCookie), 403, "forbidden")
	replay := decoded[mutationResponse](t, h.call("POST", teamBase, original, h.aliceCookie), 200)
	if decodeEndpoint(t, replay.Endpoint).Destination.URL != nil {
		t.Fatal("old operation replay restored management data after demotion")
	}
}

type shiftedClock struct {
	*postgres.Store
	shift time.Duration
}
type shiftedWriteScope struct {
	store.WebhookWriteScope
	shift time.Duration
}
type shiftedReadScope struct {
	store.SnapshotScope
	shift time.Duration
}

func (s shiftedWriteScope) ObservedAt(ctx context.Context) (time.Time, error) {
	now, err := s.WebhookWriteScope.ObservedAt(ctx)
	return now.Add(s.shift), err
}
func (s shiftedReadScope) ObservedAt(ctx context.Context) (time.Time, error) {
	now, err := s.SnapshotScope.ObservedAt(ctx)
	return now.Add(s.shift), err
}
func (d shiftedClock) ReadSnapshot(ctx context.Context, callback func(store.SnapshotScope) error) error {
	return d.Store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		return callback(shiftedReadScope{SnapshotScope: scope, shift: d.shift})
	})
}
func (d shiftedClock) WriteWebhook(ctx context.Context, owner webhookmodel.Owner, id string, callback func(store.WebhookWriteScope) error) (store.Completion, error) {
	return d.Store.WriteWebhook(ctx, owner, id, func(scope store.WebhookWriteScope) error {
		return callback(shiftedWriteScope{WebhookWriteScope: scope, shift: d.shift})
	})
}

func TestRetainedReceiptPrecedesFreshnessAndMaintenancePreservesCleanup(t *testing.T) {
	h := newIntegrationHarness(t)
	base := "/api/v1/me/webhooks"
	input := createBody(h, h.alice)
	original := body(t, input)
	created := decoded[mutationResponse](t, h.call("POST", base, original, h.aliceCookie), 201)
	endpoint := decodeEndpoint(t, created.Endpoint)
	h.mount(t, shiftedClock{Store: h.Database, shift: 6 * time.Minute}, h.keyring, false)
	if decoded[mutationResponse](t, h.call("POST", base, original, h.aliceCookie), 200).Operation.OperationID != created.Operation.OperationID {
		t.Fatal("retained receipt was rejected by operation freshness or maintenance")
	}
	newInput := createBody(h, h.alice)
	newInput["issuedAt"] = input["issuedAt"]
	errorStatus(t, h.call("POST", base, body(t, newInput), h.aliceCookie), 410, "operation_expired")
	blocked := createBody(h, h.alice)
	blocked["issuedAt"] = time.Now().UTC().Add(6 * time.Minute).Format(time.RFC3339Nano)
	errorStatus(t, h.call("POST", base, body(t, blocked), h.aliceCookie), 503, "webhooks_unavailable")
	pause := h.newOperation(h.alice)
	pause["issuedAt"], pause["ifVersion"], pause["enabled"] = blocked["issuedAt"], endpoint.ConfigVersion, false
	paused := decoded[mutationResponse](t, h.call("PATCH", base+"/"+endpoint.ID, body(t, pause), h.aliceCookie), 200)
	if decodeEndpoint(t, paused.Endpoint).Enabled {
		t.Fatal("maintenance prevented restrictive pause")
	}
	wrongIdentity := h.newOperation(h.bob)
	wrongIdentity["issuedAt"], wrongIdentity["ifVersion"], wrongIdentity["enabled"] = blocked["issuedAt"], paused.Operation.ConfigVersionAfter, false
	errorStatus(t, h.call("PATCH", base+"/"+endpoint.ID, body(t, wrongIdentity), h.aliceCookie), 409, "identity_mismatch")
}

func TestChangedConfigurationRewrapsAllLiveSecretsUnderActiveMaster(t *testing.T) {
	h := newIntegrationHarness(t)
	base := "/api/v1/me/webhooks"
	created := decoded[mutationResponse](t, h.call("POST", base, body(t, createBody(h, h.alice)), h.aliceCookie), 201)
	endpoint := decodeEndpoint(t, created.Endpoint)
	path := base + "/" + endpoint.ID
	before := decoded[secretResponse](t, h.call("GET", path+"/signing-secret", "", h.aliceCookie), 200)
	oldEncoded := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	newEncoded := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{8}, 32))
	keys, err := secretbox.New([]byte(`{"activeKeyId":"new-key","keys":{"test-key":"` + oldEncoded + `","new-key":"` + newEncoded + `"}}`))
	if err != nil {
		t.Fatal(err)
	}
	h.mount(t, h.Database, keys, true)
	update := h.newOperation(h.alice)
	update["ifVersion"], update["name"] = "1", "Updated notifications"
	changed := decoded[mutationResponse](t, h.call("PATCH", path, body(t, update), h.aliceCookie), 200)
	after := decoded[secretResponse](t, h.call("GET", path+"/signing-secret", "", h.aliceCookie), 200)
	if after.Secret != before.Secret || after.KeyID != before.KeyID || changed.Operation.DestinationRevisionAfter != "1" {
		t.Fatal("master rewrap changed decoded configuration or signing identity")
	}
	var endpointEnvelope, keyEnvelope []byte
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT encrypted_destination FROM webhook_endpoints WHERE id=$1`, endpoint.ID).Scan(&endpointEnvelope); err != nil {
		t.Fatal(err)
	}
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT encrypted_secret FROM webhook_signing_keys WHERE id=$1`, after.KeyID).Scan(&keyEnvelope); err != nil {
		t.Fatal(err)
	}
	for _, value := range [][]byte{endpointEnvelope, keyEnvelope} {
		var envelope secretbox.Envelope
		if json.Unmarshal(value, &envelope) != nil || envelope.MasterKeyID != "new-key" {
			t.Fatal("actual configuration write copied an old master reference")
		}
	}
	noop := h.newOperation(h.alice)
	noop["ifVersion"], noop["name"] = "2", "Updated notifications"
	decoded[mutationResponse](t, h.call("PATCH", path, body(t, noop), h.aliceCookie), 200)
	var unchanged []byte
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT encrypted_destination FROM webhook_endpoints WHERE id=$1`, endpoint.ID).Scan(&unchanged); err != nil || !bytes.Equal(unchanged, endpointEnvelope) {
		t.Fatal("no-op rewrote destination ciphertext")
	}
}

func TestWebhookProtocolRefusalsDoNotBecomeInternalErrors(t *testing.T) {
	h := newIntegrationHarness(t)
	base := "/api/v1/me/webhooks"
	errorStatus(t, h.call("POST", base, "{}"+strings.Repeat(" ", maxConfigurationBytes), h.aliceCookie), 413, "content_too_large")
	errorStatus(t, h.call("GET", base+"?enabled=1", "", h.aliceCookie), 400, "invalid_input")
	errorStatus(t, h.call("GET", base+"?limit=1&limit=2", "", h.aliceCookie), 400, "invalid_input")
	errorStatus(t, h.call("GET", base+"?cursor=", "", h.aliceCookie), 400, "invalid_input")
	errorStatus(t, h.call("GET", base+"/operations/"+uuid.NewString(), "", h.aliceCookie), 404, "not_found")
	input := createBody(h, h.alice)
	input["issuedAt"] = time.Now().UTC().Add(2 * time.Minute).Format(time.RFC3339Nano)
	errorStatus(t, h.call("POST", base, body(t, input), h.aliceCookie), 400, "invalid_operation_time")
	input = createBody(h, h.alice)
	input["destination"] = map[string]any{"kind": "slack", "adapterVersion": "1", "configuration": map[string]any{"url": "https://receiver.example/events"}}
	errorStatus(t, h.call("POST", base, body(t, input), h.aliceCookie), 409, "destination_unsupported")
	for _, path := range []string{"/api/v1/webhook-event-types", base} {
		response := h.call("PUT", path, `{}`, h.aliceCookie)
		errorStatus(t, response, 405, "method_not_allowed")
	}
	var count int
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM webhook_endpoints`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("refused requests applied endpoints: %d %v", count, err)
	}
}

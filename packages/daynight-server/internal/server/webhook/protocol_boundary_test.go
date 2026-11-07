package webhook

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	webhookcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDeletionAndRotationRequireExplicitOperationFields(t *testing.T) {
	valid := map[string]any{
		"operationId":    "11111111-1111-4111-8111-111111111111",
		"issuedAt":       "2026-11-07T00:00:00.000000000Z",
		"expectedUserId": "22222222-2222-4222-8222-222222222222",
		"ifVersion":      "9007199254740993",
	}
	for _, kind := range []string{"delete", "rotation"} {
		t.Run(kind, func(t *testing.T) {
			parse := func(input map[string]any) error {
				request := configurationRequest(body(t, input))
				if kind == "delete" {
					value, err := parseDelete(request)
					if err == nil && (value.IfVersion != 9007199254740993 || value.Operation.IssuedAt != valid["issuedAt"]) {
						t.Fatal("valid deletion lost its precise version or original timestamp")
					}
					return err
				}
				value, err := parseRotation(request)
				if err == nil && (value.IfVersion != 9007199254740993 || value.Operation.IssuedAt != valid["issuedAt"] || value.Mode != "immediate") {
					t.Fatal("valid rotation lost its operation or mode")
				}
				return err
			}
			copyInput := func() map[string]any {
				input := make(map[string]any, len(valid)+1)
				for key, value := range valid {
					input[key] = value
				}
				if kind == "rotation" {
					input["mode"] = "immediate"
				}
				return input
			}
			if err := parse(copyInput()); err != nil {
				t.Fatal(err)
			}
			for _, field := range []string{"operationId", "issuedAt", "expectedUserId", "ifVersion"} {
				for _, value := range []any{nil, 17, map[string]any{"private": "sensitive"}} {
					input := copyInput()
					input[field] = value
					assertInvalidOperationInput(t, parse(input))
				}
				input := copyInput()
				delete(input, field)
				assertInvalidOperationInput(t, parse(input))
			}
			for _, field := range []string{"operationId", "expectedUserId"} {
				input := copyInput()
				input[field] = "private?token=sensitive"
				assertInvalidOperationInput(t, parse(input))
			}
			for _, version := range []string{"0", "01", "+1", "9223372036854775808"} {
				input := copyInput()
				input["ifVersion"] = version
				assertInvalidOperationInput(t, parse(input))
			}
			if kind == "rotation" {
				for _, value := range []any{nil, 17} {
					input := copyInput()
					input["mode"] = value
					assertInvalidOperationInput(t, parse(input))
				}
				input := copyInput()
				delete(input, "mode")
				assertInvalidOperationInput(t, parse(input))
			}
		})
	}
}

func assertInvalidOperationInput(t *testing.T, err error) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "invalid_input" || strings.Contains(fault.Message, "sensitive") {
		t.Fatal("invalid operation input was accepted or disclosed its supplied value")
	}
}

func TestOperationReceiptSerializesPreciseNullablePublicResults(t *testing.T) {
	generation := int64(9007199254740993)
	overlap := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
	issued := "2026-11-07T00:00:00.000000000Z"
	receipt := webhookmodel.OperationReceipt{
		OperationID: "11111111-1111-4111-8111-111111111111", Kind: webhookmodel.SecretRotate,
		Owner:      webhookmodel.Owner{Kind: webhookmodel.PersonalOwner, ID: "22222222-2222-4222-8222-222222222222"},
		EndpointID: "33333333-3333-4333-8333-333333333333", ActorUserID: "22222222-2222-4222-8222-222222222222",
		IssuedAt: issued, RequestSHA256: strings.Repeat("a", 64), Fingerprint: "private-fingerprint-sentinel",
		Effect: webhookmodel.EffectApplied, ConfigVersionAfter: 9223372036854775807,
		DestinationRevisionAfter: 9007199254740993, GenerationAfter: &generation,
		SigningOverlapUntil: &overlap, RecordedAt: time.Date(2026, 11, 7, 2, 0, 0, 0, time.FixedZone("offset", 2*60*60)), ExpiresAt: overlap,
	}
	data, err := json.Marshal(operationView(receipt))
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || string(fields["generationAfter"]) != `"9007199254740993"` || string(fields["configVersionAfter"]) != `"9223372036854775807"` || string(fields["destinationRevisionAfter"]) != `"9007199254740993"` || string(fields["issuedAt"]) != `"`+issued+`"` {
		t.Fatal("operation receipt rounded a version or reformatted original issuedAt")
	}
	if fields["fingerprint"] != nil || fields["signingOverlapUntil"] != nil || bytes.Contains(data, []byte(receipt.Fingerprint)) || string(fields["recordedAt"]) != `"2026-11-07T00:00:00Z"` {
		t.Fatal("operation receipt disclosed internal result metadata or retained a non-UTC time")
	}
	receipt.GenerationAfter = nil
	data, err = json.Marshal(operationView(receipt))
	if err != nil || json.Unmarshal(data, &fields) != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"deliveryId", "generationAfter", "keyId"} {
		if string(fields[field]) != "null" {
			t.Fatal("nullable operation result was omitted or replaced by a fabricated value")
		}
	}
}

func TestNestedManagementRoutesRefuseUnsupportedMethodsAndUnknownResources(t *testing.T) {
	h := newIntegrationHarness(t)
	const base = "/api/v1/me/webhooks"
	created := decoded[mutationResponse](t, h.call("POST", base, body(t, createBody(h, h.alice)), h.aliceCookie), http.StatusCreated)
	endpoint := decodeEndpoint(t, created.Endpoint)
	path := base + "/" + endpoint.ID
	for _, request := range []struct{ method, suffix, allow string }{
		{"POST", "/signing-secret", "GET, HEAD"},
		{"DELETE", "/signing-secret", "GET, HEAD"},
		{"GET", "/signing-secret/rotations", "POST"},
		{"HEAD", "/signing-secret/rotations", "POST"},
	} {
		response := h.call(request.method, path+request.suffix, `{}`, h.aliceCookie)
		errorStatus(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != request.allow || strings.Contains(response.Body.String(), "sensitive") {
			t.Fatal("nested method refusal advertised the wrong methods or disclosed data")
		}
	}
	for _, suffix := range []string{"/unknown", "/deliveries", "/signing-secret/rotations/unknown"} {
		response := h.call("GET", path+suffix, "", h.aliceCookie)
		errorStatus(t, response, http.StatusNotFound, "not_found")
		if strings.Contains(response.Body.String(), "sensitive") {
			t.Fatal("unknown nested resource disclosed configuration")
		}
	}
	for _, method := range []string{"DELETE", "POST"} {
		requestPath := path
		input := h.newOperation(h.alice)
		input["ifVersion"] = "1"
		if method == "POST" {
			requestPath += "/signing-secret/rotations"
			input["mode"] = "immediate"
		}
		for _, field := range []string{"operationId", "issuedAt", "expectedUserId", "ifVersion"} {
			invalid := make(map[string]any, len(input))
			for key, value := range input {
				invalid[key] = value
			}
			delete(invalid, field)
			errorStatus(t, h.call(method, requestPath, body(t, invalid), h.aliceCookie), http.StatusBadRequest, "invalid_input")
		}
		input["issuedAt"] = "private?token=sensitive"
		response := h.call(method, requestPath, body(t, input), h.aliceCookie)
		errorStatus(t, response, http.StatusBadRequest, "invalid_input")
		if strings.Contains(response.Body.String(), "sensitive") {
			t.Fatal("malformed operation time was copied into a protocol error")
		}
		input = h.newOperation(h.alice)
		input["ifVersion"], input["mode"] = "2", "immediate"
		if method == "DELETE" {
			delete(input, "mode")
		}
		errorStatus(t, h.call(method, requestPath, body(t, input), h.aliceCookie), http.StatusConflict, "version_conflict")
		invalidPath := base + "/not-a-uuid"
		if method == "POST" {
			invalidPath += "/signing-secret/rotations"
		}
		errorStatus(t, h.call(method, invalidPath, body(t, input), h.aliceCookie), http.StatusBadRequest, "invalid_input")
	}
	var endpoints, operations int
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM webhook_endpoints),(SELECT count(*) FROM webhook_operations)`).Scan(&endpoints, &operations); err != nil || endpoints != 1 || operations != 1 {
		t.Fatal("protocol refusals applied another effect or receipt")
	}
	current := decoded[endpointResponse](t, h.call("GET", path, "", h.aliceCookie), http.StatusOK)
	if current.ConfigVersion != "1" || current.Lifecycle != "active" {
		t.Fatal("nested protocol refusals changed the endpoint")
	}
}

func TestNestedRouteMetadataMismatchDoesNotInvokeManagement(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	h := handler{logger: logger}
	request := httptest.NewRequest("GET", "/api/v1/me/webhooks/11111111-1111-4111-8111-111111111111/signing-secret", nil)
	request.SetPathValue("endpointId", "22222222-2222-4222-8222-222222222222")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.nested(w, r, model.Principal{})
	})).ServeHTTP(response, request)
	errorStatus(t, response, http.StatusNotFound, "not_found")
	if strings.Contains(logs.String(), "22222222-2222-4222-8222-222222222222") {
		t.Fatal("route metadata mismatch logged an unvalidated target path")
	}
}

func TestClosedManagementPersistenceReportsDependencyFailureWithoutEffects(t *testing.T) {
	h := newIntegrationHarness(t)
	pool, err := pgxpool.NewWithConfig(context.Background(), h.Database.Pool.Config().Copy())
	if err != nil {
		t.Fatal(err)
	}
	pool.Close()
	h.mount(t, &postgres.Store{Pool: pool}, h.keyring, true)
	const base = "/api/v1/me/webhooks"
	endpointPath := base + "/" + uuid.NewString()
	for _, request := range []struct {
		method, path string
		input        any
	}{
		{"GET", base, nil},
		{"GET", "/api/v1/webhook-event-types", nil},
		{"POST", base, createBody(h, h.alice)},
		{"DELETE", endpointPath, withBoundaryVersion(h.newOperation(h.alice), "1", "")},
		{"POST", endpointPath + "/signing-secret/rotations", withBoundaryVersion(h.newOperation(h.alice), "1", "immediate")},
	} {
		requestBody := ""
		if request.input != nil {
			requestBody = body(t, request.input)
		}
		response := h.call(request.method, request.path, requestBody, h.aliceCookie)
		errorStatus(t, response, http.StatusServiceUnavailable, "dependency_unavailable")
		if strings.Contains(response.Body.String(), "sensitive") || strings.Contains(response.Body.String(), `"items"`) {
			t.Fatal("unavailable persistence was projected as data or leaked destination details")
		}
	}
	var endpoints, operations int
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM webhook_endpoints),(SELECT count(*) FROM webhook_operations)`).Scan(&endpoints, &operations); err != nil || endpoints != 0 || operations != 0 {
		t.Fatal("unavailable management persistence applied a configuration or receipt")
	}
	if strings.Contains(h.Logs.String(), "sensitive") {
		t.Fatal("dependency failure diagnostics disclosed a destination credential")
	}
}

func withBoundaryVersion(input map[string]any, version, mode string) map[string]any {
	input["ifVersion"] = version
	if mode != "" {
		input["mode"] = mode
	}
	return input
}

type missingRotationResultKey struct{ management }

func (m missingRotationResultKey) Rotate(ctx context.Context, principal model.Principal, owner webhookmodel.Owner, id string, input webhookcore.RotateInput) (webhookservice.MutationResult, error) {
	result, err := m.management.Rotate(ctx, principal, owner, id, input)
	if err == nil {
		result.Operation.KeyID = nil
	}
	return result, err
}

func TestCommittedRotationWithUnavailableResponseResultRemainsRecoverable(t *testing.T) {
	h := newIntegrationHarness(t)
	const base = "/api/v1/me/webhooks"
	created := decoded[mutationResponse](t, h.call("POST", base, body(t, createBody(h, h.alice)), h.aliceCookie), http.StatusCreated)
	endpoint := decodeEndpoint(t, created.Endpoint)
	path := base + "/" + endpoint.ID
	manager, err := webhookservice.New(h.Database, h.keyring, webhookservice.Settings{ConfigurationExpansionAvailable: true})
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	mux := http.NewServeMux()
	RegisterRoutes(mux, missingRotationResultKey{management: manager}, h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	input := withBoundaryVersion(h.newOperation(h.alice), "1", "immediate")
	originalBody := body(t, input)
	response := h.call("POST", path+"/signing-secret/rotations", originalBody, h.aliceCookie)
	errorStatus(t, response, http.StatusServiceUnavailable, "write_outcome_unknown")
	if strings.Contains(response.Body.String(), "sensitive") || strings.Contains(response.Body.String(), "whsec_") {
		t.Fatal("unavailable committed result disclosed secret information")
	}
	operationID := input["operationId"].(string)
	receipt := decoded[operationResponse](t, h.call("GET", base+"/operations/"+operationID, "", h.aliceCookie), http.StatusOK)
	if receipt.KeyID == nil || receipt.ConfigVersionAfter != "2" || receipt.EndpointID != endpoint.ID {
		t.Fatal("response result failure destroyed the committed rotation receipt")
	}
	h.mount(t, h.Database, h.keyring, true)
	replayed := decoded[rotationResponse](t, h.call("POST", path+"/signing-secret/rotations", originalBody, h.aliceCookie), http.StatusOK)
	if replayed.Signing.ActiveKeyID != *receipt.KeyID || replayed.Operation.ConfigVersionAfter != "2" {
		t.Fatal("rotation response recovery applied another key change")
	}
	current := decoded[endpointResponse](t, h.call("GET", path, "", h.aliceCookie), http.StatusOK)
	if current.ConfigVersion != "2" || current.Signing.ActiveKeyID != *receipt.KeyID {
		t.Fatal("original rotation replay changed current key state")
	}
	var operations int
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM webhook_operations`).Scan(&operations); err != nil || operations != 2 {
		t.Fatal("rotation response recovery created an additional operation")
	}
}

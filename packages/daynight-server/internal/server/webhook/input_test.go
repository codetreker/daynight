package webhook

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

const operationJSON = `"operationId":"11111111-1111-4111-8111-111111111111","issuedAt":"2026-11-07T00:00:00.000000Z","expectedUserId":"22222222-2222-4222-8222-222222222222"`
const destinationJSON = `"destination":{"kind":"http","adapterVersion":"1","configuration":{"url":"https://receiver.example/private?token=sensitive"}}`

func configurationRequest(body string) *http.Request {
	request := httptest.NewRequest("POST", "/api/v1/me/webhooks", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json; charset=UTF-8")
	return request
}

func TestCreatePreservesOriginalOperationTimeAndRequestBytes(t *testing.T) {
	body := "{ " + operationJSON + `,"name":"notifications","enabled":true,` + destinationJSON + `,"subscriptions":[{"id":null,"projectId":"33333333-3333-4333-8333-333333333333","eventTypes":["task.paused"]}]}` + "\n"
	input, err := parseCreate(configurationRequest(body))
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte(body))
	if input.Operation.RequestSHA256 != hex.EncodeToString(hash[:]) || input.Operation.IssuedAt != "2026-11-07T00:00:00.000000Z" {
		t.Fatalf("operation lost original request identity: %+v", input.Operation)
	}
	if input.Destination.URL != "https://receiver.example/private?token=sensitive" || len(input.Subscriptions) != 1 || input.Subscriptions[0].ID != nil {
		t.Fatal("destination or explicit new subscription identity changed")
	}
	other, err := parseCreate(configurationRequest(strings.TrimSpace(body)))
	if err != nil || other.Operation.RequestSHA256 == input.Operation.RequestSHA256 {
		t.Fatal("lexically different request bodies share the byte hash")
	}
}

func TestNestedConfigurationValidationRejectsAmbiguousInput(t *testing.T) {
	valid := `{` + operationJSON + `,"name":"notifications","enabled":true,` + destinationJSON + `,"subscriptions":[]}`
	cases := []string{
		strings.Replace(valid, `"configuration":{"url":`, `"configuration":{"url":"https://other.example","url":`, 1),
		strings.Replace(valid, `"kind":"http"`, `"kind":"http","kind":"http"`, 1),
		strings.Replace(valid, `"configuration":{"url":`, `"configuration":{"authentication":"private","url":`, 1),
		strings.Replace(valid, `"subscriptions":[]`, `"subscriptions":[{"id":null,"projectId":"33333333-3333-4333-8333-333333333333","projectId":"33333333-3333-4333-8333-333333333333","eventTypes":["task.paused"]}]`, 1),
		strings.Replace(valid, `"subscriptions":[]`, `"subscriptions":[{"projectId":"33333333-3333-4333-8333-333333333333","eventTypes":["task.paused"]}]`, 1),
		strings.Replace(valid, `"subscriptions":[]`, `"subscriptions":[{"id":null,"projectId":"33333333-3333-4333-8333-333333333333","eventTypes":[null]}]`, 1),
		strings.Replace(valid, `"subscriptions":[]`, `"subscriptions":null`, 1),
		strings.Replace(valid, `"name":"notifications"`, `"name":"\ud800"`, 1),
		strings.Replace(valid, `"enabled":true`, `"enabled":null`, 1),
		valid + `{}`,
	}
	for _, body := range cases {
		_, err := parseCreate(configurationRequest(body))
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "invalid_input" || strings.Contains(fault.Message, "sensitive") {
			t.Fatalf("ambiguous configuration was accepted or disclosed: %v", err)
		}
	}
}

func TestConfigurationBodySizeAndReadErrors(t *testing.T) {
	for _, size := range []int{maxConfigurationBytes, maxConfigurationBytes + 1} {
		body := `{}` + strings.Repeat(" ", size-2)
		_, _, err := decodeConfiguration(configurationRequest(body))
		if size == maxConfigurationBytes {
			if err != nil {
				t.Fatal(err)
			}
		} else {
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "content_too_large" {
				t.Fatalf("oversize request result: %v", err)
			}
		}
	}
	cause := errors.New("test reader failure")
	request := configurationRequest(`{}`)
	request.Body = io.NopCloser(&failingBody{err: cause})
	_, _, err := decodeConfiguration(request)
	if !errors.Is(err, cause) {
		t.Fatal("request reader failure lost its cause")
	}
	for _, contentType := range []string{"", "text/json", "application/json; charset=latin1"} {
		request := configurationRequest(`{}`)
		request.Header.Set("Content-Type", contentType)
		if _, _, err := decodeConfiguration(request); err == nil {
			t.Fatalf("invalid content type accepted: %q", contentType)
		}
	}
	request = configurationRequest(`{}`)
	request.Header.Add("Content-Type", "application/json")
	if _, _, err := decodeConfiguration(request); err == nil {
		t.Fatal("duplicate Content-Type accepted")
	}
}

type failingBody struct{ err error }

func (r *failingBody) Read([]byte) (int, error) { return 0, r.err }

func TestPatchUsesPreciseVersionsAndExplicitEmptyCollections(t *testing.T) {
	input, err := parsePatch(configurationRequest(`{` + operationJSON + `,"ifVersion":"9007199254740993","subscriptions":[],"confirmProjectIds":[]}`))
	if err != nil || input.IfVersion != 9007199254740993 || input.Subscriptions == nil || len(*input.Subscriptions) != 0 || input.ConfirmProjectIDs == nil {
		t.Fatalf("precise version or explicit empty replacement lost: %+v %v", input, err)
	}
	for _, raw := range []string{`"01"`, `"+1"`, `"0"`, `"-1"`, `"1.0"`, `"9223372036854775808"`, `1`, `null`} {
		if _, err := parsePatch(configurationRequest(`{` + operationJSON + `,"ifVersion":` + raw + `,"enabled":false}`)); err == nil {
			t.Fatalf("invalid version accepted: %s", raw)
		}
	}
	for _, suffix := range []string{"", `,"name":null`, `,"subscriptions":null`, `,"confirmProjectIds":[null]`, `,"destination":null`} {
		if _, err := parsePatch(configurationRequest(`{` + operationJSON + `,"ifVersion":"1"` + suffix + `}`)); err == nil {
			t.Fatalf("invalid patch accepted: %s", suffix)
		}
	}
	request := configurationRequest(`{` + operationJSON + `,"ifVersion":"1","enabled":false}`)
	request.URL.RawQuery = "unexpected=private"
	if _, err := parsePatch(request); err == nil {
		t.Fatal("unknown mutation query accepted")
	}
}

func TestDeleteAndRotationHaveExactOperationIdentity(t *testing.T) {
	deleted, err := parseDelete(configurationRequest(`{` + operationJSON + `,"ifVersion":"9223372036854775807"}`))
	if err != nil || deleted.IfVersion != 9223372036854775807 {
		t.Fatalf("delete input: %+v %v", deleted, err)
	}
	rotated, err := parseRotation(configurationRequest(`{` + operationJSON + `,"ifVersion":"2","mode":"immediate"}`))
	if err != nil || rotated.Mode != "immediate" || rotated.Operation.IssuedAt != deleted.Operation.IssuedAt {
		t.Fatalf("rotation input: %+v %v", rotated, err)
	}
	if _, err := parseRotation(configurationRequest(`{` + operationJSON + `,"ifVersion":"2","mode":null}`)); err == nil {
		t.Fatal("null rotation mode accepted")
	}
	for _, value := range []string{"11111111-1111-4111-8111-11111111111A", "00000000-0000-0000-0000-000000000000", "not-an-id"} {
		if _, err := canonicalID(value); err == nil {
			t.Fatalf("noncanonical ID accepted: %q", value)
		}
	}
}

package webhook

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"

	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func TestEndpointCursorBindsCurrentPrincipalOwnerFilterAndDisclosure(t *testing.T) {
	on := true
	scope := cursorScope{PrincipalID: "11111111-1111-4111-8111-111111111111", Owner: webhookmodel.Owner{Kind: webhookmodel.TeamOwner, ID: "22222222-2222-4222-8222-222222222222"}, Search: "release", Enabled: &on, CanManage: true}
	endpoint := webhookmodel.Endpoint{ID: "33333333-3333-4333-8333-333333333333", CreatedAt: time.Date(2026, 11, 7, 1, 2, 3, 123, time.UTC)}
	cursor, err := nextCursor(scope, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	page, err := pageFor(ListInput{Limit: 50, Cursor: &cursor}, scope)
	if err != nil || page.After == nil || page.After.ID != endpoint.ID || !page.After.CreatedAt.Equal(endpoint.CreatedAt) {
		t.Fatalf("cursor position: %+v %v", page, err)
	}
	for _, change := range []func(*cursorScope){
		func(s *cursorScope) { s.PrincipalID = "44444444-4444-4444-8444-444444444444" },
		func(s *cursorScope) { s.Owner.Kind = webhookmodel.PersonalOwner },
		func(s *cursorScope) { s.Owner.ID = "55555555-5555-4555-8555-555555555555" },
		func(s *cursorScope) { s.Search = "other" },
		func(s *cursorScope) { s.Enabled = nil },
		func(s *cursorScope) { s.CanManage = false },
	} {
		other := scope
		change(&other)
		if _, err := pageFor(ListInput{Limit: 50, Cursor: &cursor}, other); err == nil {
			t.Fatal("cursor crossed its principal, owner, filter or disclosure scope")
		}
	}
	bytes, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		t.Fatal(err)
	}
	for _, changed := range []string{
		strings.Replace(string(bytes), `"version":1`, `"version":1,"version":1`, 1),
		strings.Replace(string(bytes), `"kind":"team"`, `"kind":"team","kind":"team"`, 1),
		strings.Replace(string(bytes), `"canManage":true`, `"canManage":null`, 1),
		strings.Replace(string(bytes), `"version":1`, `"version":2`, 1),
	} {
		encoded := base64.RawURLEncoding.EncodeToString([]byte(changed))
		if _, err := pageFor(ListInput{Limit: 50, Cursor: &encoded}, scope); err == nil {
			t.Fatal("malformed cursor accepted")
		}
	}
}

func TestEndpointListNormalizationHasBoundedExplicitFilters(t *testing.T) {
	input, err := normalizeList(ListInput{Search: "  release  ", Limit: 50})
	if err != nil || input.Search != "release" {
		t.Fatalf("search normalization: %+v %v", input, err)
	}
	empty := ""
	for _, input := range []ListInput{{Limit: 0}, {Limit: 101}, {Limit: 50, Cursor: &empty}, {Limit: 50, Search: strings.Repeat("你", 201)}, {Limit: 50, Search: "x\nprivate"}, {Limit: 50, Search: string([]byte{0xff})}} {
		if _, err := normalizeList(input); err == nil {
			t.Fatalf("invalid list request accepted: %+v", input)
		}
	}
}

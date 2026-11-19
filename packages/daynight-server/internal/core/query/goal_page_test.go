package query

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestGoalPageCursorBindsIdentityResourceAndLimit(t *testing.T) {
	scope := GoalPageScope{ProjectID: "11111111-1111-4111-8111-111111111111", GoalID: "22222222-2222-4222-8222-222222222222", UserID: "33333333-3333-4333-8333-333333333333", Limit: 20}
	after := "44444444-4444-4444-8444-444444444444"
	if got, err := GoalPageAfter(nil, scope); err != nil || got != "" {
		t.Fatalf("first page %q %v", got, err)
	}
	cursor := EncodeGoalCursor(scope, after)
	if got, err := GoalPageAfter(&cursor, scope); err != nil || got != after {
		t.Fatalf("continuation %q %v", got, err)
	}
	for _, changed := range []GoalPageScope{{ProjectID: scope.GoalID, GoalID: scope.GoalID, UserID: scope.UserID, Limit: 20}, {ProjectID: scope.ProjectID, GoalID: scope.UserID, UserID: scope.UserID, Limit: 20}, {ProjectID: scope.ProjectID, GoalID: scope.GoalID, UserID: scope.GoalID, Limit: 20}, {ProjectID: scope.ProjectID, GoalID: scope.GoalID, UserID: scope.UserID, Limit: 50}} {
		if _, err := GoalPageAfter(&cursor, changed); err == nil {
			t.Fatalf("accepted changed scope %+v", changed)
		}
	}
	data, _ := base64.RawURLEncoding.DecodeString(cursor)
	for _, bad := range []string{"", "invalid%", strings.Repeat("a", 10000), base64.RawURLEncoding.EncodeToString([]byte("{}")), base64.RawURLEncoding.EncodeToString(append(data, []byte(" {}")...)), base64.RawURLEncoding.EncodeToString([]byte(strings.Replace(string(data), `"version":1`, `"version":2`, 1))), base64.RawURLEncoding.EncodeToString([]byte(strings.Replace(string(data), `"after":"`+after+`"`, `"after":"bad"`, 1))), base64.RawURLEncoding.EncodeToString([]byte(strings.Replace(string(data), `"kind":"goal-successors"`, `"kind":"tasks"`, 1))), base64.RawURLEncoding.EncodeToString([]byte(strings.Replace(string(data), `"version":1`, `"unknown":true,"version":1`, 1)))} {
		if _, err := GoalPageAfter(&bad, scope); err == nil {
			t.Fatalf("accepted invalid cursor %q", bad)
		}
	}
}

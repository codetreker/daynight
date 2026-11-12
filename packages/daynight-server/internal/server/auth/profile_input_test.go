package auth

import (
	"strings"
	"testing"
)

func TestExternalUserInput(t *testing.T) {
	for _, raw := range []string{`{"externalUserId":"microsoft:tenant:object"}`, `{"externalUserId":"msft:object@tenant","profile":{}}`, `{"externalUserId":"msft:object@tenant","profile":{"name":null,"avatarUrl":null}}`} {
		input, err := DecodeExternalUserInput([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		user, err := ExternalUser(input)
		if err != nil || user.UniAuthID != "msft:object@tenant" || user.Name != nil || user.AvatarURL != nil || user.Email != nil || user.EmailVerified != nil {
			t.Fatalf("user=%+v err=%v", user, err)
		}
	}
	input, err := DecodeExternalUserInput([]byte(`{"externalUserId":"opaque:key","profile":{"name":" x\n","avatarUrl":""}}`))
	if err != nil {
		t.Fatal(err)
	}
	user, err := ExternalUser(input)
	if err != nil || *user.Name != " x\n" || *user.AvatarURL != "" {
		t.Fatalf("user=%+v err=%v", user, err)
	}
	for _, raw := range []string{
		`{}`, `{"externalUserId":null}`, `{"externalUserId":""}`, `{"externalUserId":3}`, `{"externalUserId":"a","externalUserId":"b"}`, `{"externalUserId":"a","email":"x"}`,
		`{"externalUserId":"a","profile":null}`, `{"externalUserId":"a","profile":{"name":"a","name":"b"}}`, `{"externalUserId":"a","profile":{"email":null}}`, `{"externalUserId":"a","profile":{"name":false}}`,
		`{"externalUserId":"\ud800"}`, `{"externalUserId":"a\u0000"}`, `{"externalUserId":"a\n"}`, `{"externalUserId":"microsoft:bad"}`, `{"externalUserId":"msft:o@t@bad"}`, `{"externalUserId":"a","profile":{"avatarUrl":"\ud800"}}`,
		`{"externalUserId":"` + strings.Repeat("a", 1025) + `"}`, `{"externalUserId":"a","profile":{"name":"` + strings.Repeat("a", 1025) + `"}}`, `{"externalUserId":"a","profile":{"avatarUrl":"` + strings.Repeat("a", (512<<10)+1) + `"}}`,
	} {
		if _, err := DecodeExternalUserInput([]byte(raw)); err == nil {
			t.Fatalf("accepted invalid input %.100q", raw)
		}
	}
}

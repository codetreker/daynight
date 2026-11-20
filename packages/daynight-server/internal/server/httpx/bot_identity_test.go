package httpx

import (
	"net/http/httptest"
	"testing"
)

func TestBotIdentityRequiresExactlyOneCanonicalIdentity(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	request := httptest.NewRequest("GET", "/", nil)
	if bot, err := BotIdentity(request); bot != nil || err != nil {
		t.Fatal("absent Bot should be a user")
	}
	request.Header.Set(BotIdentityHeader, id)
	bot, err := BotIdentity(request)
	if err != nil || bot == nil || *bot != id {
		t.Fatalf("bot: %v %v", bot, err)
	}
	for _, values := range [][]string{{}, {""}, {"bad"}, {"00000000-0000-0000-0000-000000000000"}, {"11111111-1111-4111-8111-11111111111A"}, {"{" + id + "}"}, {"11111111111141118111111111111111"}, {id, id}, {id + "," + id}} {
		request.Header["X-Daynight-Bot-Id"] = values
		if _, err := BotIdentity(request); err == nil {
			t.Errorf("accepted header %v", values)
		}
	}
}

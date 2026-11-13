package assistanttask

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestInputPreservesExactIDsAndIntegers(t *testing.T) {
	p := inputFields{fields: map[string]json.RawMessage{
		"id":         json.RawMessage(`"11111111-1111-4111-8111-111111111111"`),
		"version":    json.RawMessage(`"9007199254740993"`),
		"generation": json.RawMessage(`"0"`),
	}}
	if p.id("id", true) != "11111111-1111-4111-8111-111111111111" || p.integer("version", true, false) != 9007199254740993 || p.integer("generation", true, true) != 0 || p.err != nil {
		t.Fatalf("parse: %v", p.err)
	}
}

func TestInputRejectsNoncanonicalValues(t *testing.T) {
	for _, raw := range []string{`null`, `1`, `""`, `"01"`, `"+1"`, `"-1"`, `"0"`, `"9223372036854775808"`, `"1.0"`} {
		p := inputFields{fields: map[string]json.RawMessage{"version": json.RawMessage(raw)}}
		p.integer("version", true, false)
		if p.err == nil {
			t.Errorf("accepted integer %s", raw)
		}
	}
	for _, value := range []string{"", "00000000-0000-0000-0000-000000000000", "FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF", "11111111111141118111111111111111", "bad"} {
		if _, err := strictID(value); err == nil {
			t.Errorf("accepted ID %q", value)
		}
	}
	p := inputFields{fields: map[string]json.RawMessage{}}
	p.id("id", true)
	if p.err == nil {
		t.Fatal("accepted missing ID")
	}
}

func TestBotHeaderRequiresExactlyOneCanonicalIdentity(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	request := httptest.NewRequest("GET", "/", nil)
	if bot, err := botIdentity(request); bot != nil || err != nil {
		t.Fatal("absent Bot should be a user")
	}
	request.Header.Set("X-Daynight-Bot-Id", id)
	bot, err := botIdentity(request)
	if err != nil || bot == nil || *bot != id {
		t.Fatalf("bot: %v %v", bot, err)
	}
	for _, values := range [][]string{{""}, {"bad"}, {id, id}, {id + "," + id}} {
		request.Header["X-Daynight-Bot-Id"] = values
		if _, err := botIdentity(request); err == nil {
			t.Errorf("accepted header %v", values)
		}
	}
}

func TestAssistantTaskPageIsIndependentFromExistingPageLimit(t *testing.T) {
	for _, target := range []string{"/?limit=0", "/?limit=201", "/?limit=01", "/?limit=1&limit=2", "/?cursor=", "/?unknown=x"} {
		if _, err := pageRequest(httptest.NewRequest("GET", target, nil)); err == nil {
			t.Errorf("accepted %s", target)
		}
	}
	page, err := pageRequest(httptest.NewRequest("GET", "/?limit=200&cursor=next", nil))
	if err != nil || page.Limit != 200 || page.Cursor == nil || *page.Cursor != "next" {
		t.Fatalf("page: %+v %v", page, err)
	}
}

func TestOptionalInputFieldsRejectNullAndPreserveOmission(t *testing.T) {
	p := inputFields{fields: map[string]json.RawMessage{}}
	if p.id("id", false) != "" || p.integer("version", false, false) != 0 || p.optionalText("name") != nil || p.optionalID("id") != nil || p.token(false) != "" || p.err != nil {
		t.Fatal("omitted optional value changed")
	}
	for _, raw := range []string{`null`, `1`, `[null]`, `[1]`} {
		p := inputFields{fields: map[string]json.RawMessage{"records": json.RawMessage(raw)}}
		p.strings("records")
		if p.err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	p = inputFields{fields: map[string]json.RawMessage{"name": json.RawMessage(`null`)}}
	p.text("name", false)
	if p.err == nil {
		t.Fatal("accepted null name")
	}
	p = inputFields{fields: map[string]json.RawMessage{"claimToken": json.RawMessage(`"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="`)}}
	p.token(true)
	if p.err == nil {
		t.Fatal("accepted padded token")
	}
}

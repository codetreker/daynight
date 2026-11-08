package webhook

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func TestStoredDestinationRejectsMalformedConfiguration(t *testing.T) {
	for name, data := range map[string][]byte{
		"empty":                 nil,
		"oversized":             bytes.Repeat([]byte("x"), 256*1024+1),
		"not object":            []byte(`[]`),
		"unknown field":         []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://example.com/a"},"extra":true}`),
		"duplicate kind":        []byte(`{"kind":"http","kind":"http","adapterVersion":"1","configuration":{"url":"https://example.com/a"}}`),
		"missing configuration": []byte(`{"kind":"http","adapterVersion":"1"}`),
		"null configuration":    []byte(`{"kind":"http","adapterVersion":"1","configuration":null}`),
		"duplicate URL":         []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://example.com/a","url":"https://example.com/b"}}`),
		"unknown configuration": []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://example.com/a","token":"secret"}}`),
		"missing URL":           []byte(`{"kind":"http","adapterVersion":"1","configuration":{}}`),
		"null URL":              []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":null}}`),
		"wrong URL type":        []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":3}}`),
		"unsupported kind":      []byte(`{"kind":"platform","adapterVersion":"1","configuration":{"url":"https://example.com/a"}}`),
		"unsupported adapter":   []byte(`{"kind":"http","adapterVersion":"2","configuration":{"url":"https://example.com/a"}}`),
		"invalid URL":           []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"file:///secret"}}`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeDestination(data); err == nil {
				t.Fatal("invalid stored configuration accepted")
			}
		})
	}
	if _, err := encodeDestination(Destination{Kind: "http", AdapterVersion: "1", URL: strings.Repeat("x", 256*1024)}); err == nil {
		t.Fatal("oversized destination encoded")
	}
}

func TestStoredDestinationMetadataMustMatchConfiguration(t *testing.T) {
	want := Destination{Kind: "http", AdapterVersion: "1", URL: "https://example.com/path?token=private"}
	data, err := encodeDestination(want)
	if err != nil {
		t.Fatal(err)
	}
	ep := wm.Endpoint{DestinationKind: "http", AdapterVersion: "1", Origin: "https://example.com", DestinationConfiguration: data}
	if got, err := decodeEndpointDestination(ep); err != nil || got != want {
		t.Fatalf("endpoint destination: %+v %v", got, err)
	}
	d := store.WebhookDelivery{DestinationKind: "http", AdapterVersion: 1, DestinationOrigin: "https://example.com", DestinationConfiguration: data}
	if got, err := decodeDeliveryDestination(d); err != nil || got != want {
		t.Fatalf("delivery destination: %+v %v", got, err)
	}
	for _, damage := range []func(*wm.Endpoint){
		func(e *wm.Endpoint) { e.DestinationKind = "platform" },
		func(e *wm.Endpoint) { e.AdapterVersion = "2" },
		func(e *wm.Endpoint) { e.Origin = "https://other.example" },
		func(e *wm.Endpoint) { e.DestinationConfiguration = []byte("malformed") },
	} {
		candidate := ep
		damage(&candidate)
		if _, err := decodeEndpointDestination(candidate); err == nil {
			t.Fatal("endpoint metadata mismatch accepted")
		}
	}
	for _, damage := range []func(*store.WebhookDelivery){
		func(e *store.WebhookDelivery) { e.DestinationKind = "platform" },
		func(e *store.WebhookDelivery) { e.AdapterVersion = 2 },
		func(e *store.WebhookDelivery) { e.DestinationOrigin = "https://other.example" },
		func(e *store.WebhookDelivery) { e.DestinationConfiguration = []byte("malformed") },
	} {
		candidate := d
		damage(&candidate)
		if _, err := decodeDeliveryDestination(candidate); err == nil {
			t.Fatal("delivery metadata mismatch accepted")
		}
	}
}

func TestPlainHistoryCursorStrictPositionAndScope(t *testing.T) {
	s := &Service{}
	c := historyCursor{Version: 1, Kind: "deliveries", User: "user", OwnerKind: "personal", OwnerID: "owner", Endpoint: "endpoint", Filter: "filter", View: "view", ID: "11111111-1111-4111-8111-111111111111", Time: time.Now().UTC()}
	expected := c
	expected.ID, expected.Time = "", time.Time{}
	encoded, err := s.encodeHistoryCursor(c)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := s.readHistoryCursor(&encoded, expected); err != nil || got != c {
		t.Fatalf("cursor round trip: %+v %v", got, err)
	}
	for _, damage := range []func(*historyCursor){
		func(c *historyCursor) { c.User = "other" },
		func(c *historyCursor) { c.Filter = "other" },
		func(c *historyCursor) { c.ID = "invalid" },
		func(c *historyCursor) { c.Time = time.Time{} },
		func(c *historyCursor) { c.Sequence = 1 },
	} {
		candidate := c
		damage(&candidate)
		encoded, err := s.encodeHistoryCursor(candidate)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.readHistoryCursor(&encoded, expected); err == nil {
			t.Fatal("invalid cursor accepted")
		}
	}
	data, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{`,"Extra":true}`, `,"User":"user"}`} {
		invalid := base64.RawURLEncoding.EncodeToString(append(data[:len(data)-1:len(data)-1], []byte(suffix)...))
		if _, err := s.readHistoryCursor(&invalid, expected); err == nil {
			t.Fatal("unknown or duplicate cursor field accepted")
		}
	}
	if err := decodeCursor([]byte(`{}`), new(string)); err == nil {
		t.Fatal("unsupported cursor type accepted")
	}
	if err := decodeCursor([]byte(`{"At":"invalid","State":"full"}`), new(historyDisclosure)); err == nil {
		t.Fatal("invalid disclosure time accepted")
	}
}

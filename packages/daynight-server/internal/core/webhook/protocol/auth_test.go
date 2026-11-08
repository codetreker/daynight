package protocol

import (
	"encoding/base64"
	"os"
	"strings"
	"testing"
	"time"
)

func TestAuthenticationPublishedVector(t *testing.T) {
	body, err := os.ReadFile("testdata/event.json")
	if err != nil {
		t.Fatal(err)
	}
	key, err := base64.StdEncoding.DecodeString("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
	if err != nil {
		t.Fatal(err)
	}
	id := "a0be4d96-fb33-41ba-a7bd-7885c1e94247"
	auth, err := Authenticate(id, body, [][]byte{key}, time.Unix(1793952005, 0))
	if err != nil {
		t.Fatal(err)
	}
	if auth.Get("Webhook-Signature") != "v1,SXdZ2STrYaBRe9RlfGMiSwiKRp8Ss/gRz/0aN7Um9tY=" || auth.Get("Webhook-Id") != id || auth.Get("Webhook-Timestamp") != "1793952005" {
		t.Fatalf("incorrect authentication %v", auth)
	}
	second := append([]byte(nil), key...)
	second[0]++
	rotated, err := Authenticate(id, body, [][]byte{key, second}, time.Unix(1793952006, 0))
	if err != nil || len(strings.Split(rotated.Get("Webhook-Signature"), " ")) != 2 || rotated.Get("Webhook-Signature") == auth.Get("Webhook-Signature") {
		t.Fatalf("rotation: %v %v", rotated, err)
	}
	for _, tc := range []struct {
		id   string
		body []byte
		keys [][]byte
		at   time.Time
	}{
		{"00000000-0000-0000-0000-000000000000", body, [][]byte{key}, time.Now()},
		{id, []byte("{}"), [][]byte{key}, time.Now()}, {id, body, nil, time.Now()},
		{id, body, [][]byte{{1}}, time.Now()}, {id, body, [][]byte{key}, time.Time{}},
	} {
		if _, err := Authenticate(tc.id, tc.body, tc.keys, tc.at); err == nil {
			t.Fatal("invalid inputs accepted")
		}
	}
}

func TestClassifyAndRetryAfter(t *testing.T) {
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	for _, status := range []int{200, 202, 299} {
		if got := Classify(status, "", now); got.Category != "acknowledged" {
			t.Fatalf("%d: %+v", status, got)
		}
	}
	if got := Classify(410, "", now); got.Reason != "receiver_retired" {
		t.Fatal(got)
	}
	for _, tc := range []struct {
		raw     string
		want    time.Time
		invalid bool
	}{
		{"30", now.Add(30 * time.Second), false}, {"Sat, 07 Nov 2026 12:01:00 GMT", now.Add(time.Minute), false},
		{"-1", time.Time{}, true}, {"18446744073709551616", time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC), false}, {"garbage", time.Time{}, true},
	} {
		got := Classify(429, tc.raw, now)
		if got.RetryAfterInvalid != tc.invalid || (!tc.invalid && (got.RetryNotBefore == nil || !got.RetryNotBefore.Equal(tc.want))) {
			t.Fatalf("%q: %+v", tc.raw, got)
		}
	}
	if got := Classify(302, "20", now); got.RetryNotBefore != nil || got.Category != "http_error" {
		t.Fatal(got)
	}
}

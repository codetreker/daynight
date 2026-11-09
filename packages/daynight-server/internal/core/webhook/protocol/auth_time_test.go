package protocol

import (
	"bytes"
	"os"
	"testing"
	"time"
)

func TestAuthenticationUsesPerAttemptTimeAtSecondPrecision(t *testing.T) {
	body, err := os.ReadFile("testdata/event.json")
	if err != nil {
		t.Fatal(err)
	}
	const id = "a0be4d96-fb33-41ba-a7bd-7885c1e94247"
	key := bytes.Repeat([]byte{1}, 32)
	first, err := Authenticate(id, body, [][]byte{key}, time.Unix(1793952005, 100_000_000))
	if err != nil {
		t.Fatal(err)
	}
	sameSecond, err := Authenticate(id, body, [][]byte{key}, time.Unix(1793952005, 900_000_000))
	if err != nil {
		t.Fatal(err)
	}
	if first.Get("Webhook-Timestamp") != "1793952005" || sameSecond.Get("Webhook-Timestamp") != first.Get("Webhook-Timestamp") || sameSecond.Get("Webhook-Signature") != first.Get("Webhook-Signature") {
		t.Fatalf("same-second authentication: first=%v next=%v", first, sameSecond)
	}
	nextSecond, err := Authenticate(id, body, [][]byte{key}, time.Unix(1793952006, 0))
	if err != nil {
		t.Fatal(err)
	}
	if nextSecond.Get("Webhook-Timestamp") != "1793952006" || nextSecond.Get("Webhook-Signature") == first.Get("Webhook-Signature") {
		t.Fatalf("new attempt reused earlier authentication: first=%v next=%v", first, nextSecond)
	}
}

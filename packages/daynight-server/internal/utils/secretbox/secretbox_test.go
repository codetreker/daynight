package secretbox

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func keyringJSON(active string, keys map[string][]byte) []byte {
	encoded := make(map[string]string, len(keys))
	for id, key := range keys {
		encoded[id] = base64.StdEncoding.EncodeToString(key)
	}
	data, err := json.Marshal(struct {
		Active string            `json:"activeKeyId"`
		Keys   map[string]string `json:"keys"`
	}{active, encoded})
	if err != nil {
		panic(err)
	}
	return data
}

func TestKeyringRecoversRetainedKeysAndNewWritesUseActiveKey(t *testing.T) {
	oldKey, newKey := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	old, err := New(keyringJSON("old", map[string][]byte{"old": oldKey}))
	if err != nil {
		t.Fatal(err)
	}
	context := []byte("resource\x00original")
	plain := []byte("https://receiver.example/private?token=secret")
	oldEnvelope, err := old.Seal(plain, context)
	if err != nil {
		t.Fatal(err)
	}
	current, err := New(keyringJSON("new", map[string][]byte{"old": oldKey, "new": newKey}))
	if err != nil {
		t.Fatal(err)
	}
	decrypted, err := current.Open(oldEnvelope, context)
	if err != nil || !bytes.Equal(decrypted, plain) {
		t.Fatalf("retained key recovery failed: %v", err)
	}
	newEnvelope, err := current.Seal(decrypted, context)
	if err != nil || newEnvelope.MasterKeyID != "new" || current.ActiveKeyID() != "new" {
		t.Fatalf("new write did not use active key: %v", err)
	}
	if !current.HasKey("old") || current.HasKey("absent") || strings.Join(current.KeyIDs(), ",") != "new,old" {
		t.Fatal("key identity inventory is incorrect")
	}
	withoutOld, err := New(keyringJSON("new", map[string][]byte{"new": newKey}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := withoutOld.Open(oldEnvelope, context); !errors.Is(err, ErrKeyUnavailable) {
		t.Fatalf("missing recovery key was not exposed: %v", err)
	}
	if _, err := current.Open(newEnvelope, context); err != nil {
		t.Fatal(err)
	}
}

func TestSealUsesFreshNonceAndAuthenticatesEnvelopeAndResource(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	ring, err := New(keyringJSON("one", map[string][]byte{"one": key, "alias": key}))
	if err != nil {
		t.Fatal(err)
	}
	plain, context := []byte("private value"), []byte("owner\x00endpoint\x00record")
	first, err := ring.Seal(plain, context)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ring.Seal(plain, context)
	if err != nil || bytes.Equal(first.Nonce, second.Nonce) || bytes.Equal(first.Ciphertext, second.Ciphertext) || len(first.Nonce) != 12 {
		t.Fatalf("nonce was not fresh: %v", err)
	}
	checks := []struct {
		name string
		edit func(*Envelope)
		aad  []byte
	}{
		{"resource", func(*Envelope) {}, []byte("another resource")},
		{"nonce", func(e *Envelope) { e.Nonce[0] ^= 1 }, context},
		{"ciphertext", func(e *Envelope) { e.Ciphertext[0] ^= 1 }, context},
		{"tag", func(e *Envelope) { e.Ciphertext[len(e.Ciphertext)-1] ^= 1 }, context},
		{"same-key alias", func(e *Envelope) { e.MasterKeyID = "alias" }, context},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			envelope := first
			envelope.Nonce = bytes.Clone(first.Nonce)
			envelope.Ciphertext = bytes.Clone(first.Ciphertext)
			check.edit(&envelope)
			if _, err := ring.Open(envelope, check.aad); !errors.Is(err, ErrAuthentication) {
				t.Fatalf("tampering was not rejected: %v", err)
			}
		})
	}
	if bytes.Contains(first.Ciphertext, plain) {
		t.Fatal("ciphertext contains the plaintext")
	}
}

func TestKeyringRejectsInvalidConfiguration(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32))
	valid := string(keyringJSON("active", map[string][]byte{"active": bytes.Repeat([]byte{3}, 32)}))
	cases := []string{
		`null`, `[]`, `{}`, `{"activeKeyId":"active","keys":null}`,
		`{"activeKeyId":"active","keys":{}}`, `{"activeKeyId":null,"keys":{"active":"` + key + `"}}`,
		`{"activeKeyId":"missing","keys":{"active":"` + key + `"}}`,
		`{"activeKeyId":"active","keys":{"active":5}}`,
		`{"activeKeyId":"active","keys":{"active":"bad"}}`,
		`{"activeKeyId":"active","keys":{"active":"` + base64.StdEncoding.EncodeToString(make([]byte, 16)) + `"}}`,
		`{"activeKeyId":"active","keys":{"active":"` + strings.TrimSuffix(key, "=") + `"}}`,
		`{"activeKeyId":"active","keys":{"active":"` + key + `\n"}}`,
		`{"activeKeyId":"active","keys":{"active":"` + key + `","active":"` + key + `"}}`,
		`{"activeKeyId":"active","activeKeyId":"active","keys":{"active":"` + key + `"}}`,
		`{"activeKeyId":"active","unknown":true,"keys":{"active":"` + key + `"}}`,
		`{"activeKeyId":"active","keys":{".bad":"` + key + `"}}`,
		`{"activeKeyId":"bad/id","keys":{"active":"` + key + `"}}`,
		`{"activeKeyId":"active","keys":{"active":"` + key + `","\ud800":"` + key + `"}}`,
		valid + `{}`, valid[:len(valid)-1], string([]byte{0xff}),
		`{"activeKeyId":"` + strings.Repeat("x", 65) + `","keys":{"active":"` + key + `"}}`,
	}
	for index, data := range cases {
		ring, err := New([]byte(data))
		if err == nil || ring != nil {
			t.Fatalf("invalid configuration %d was accepted", index)
		}
		if strings.Contains(err.Error(), key) {
			t.Fatalf("configuration error %d exposed key bytes", index)
		}
	}
}

func TestOpenRejectsMalformedEnvelopeAndSealExposesRandomFailure(t *testing.T) {
	ring, err := New(keyringJSON("active", map[string][]byte{"active": make([]byte, 32)}))
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := ring.Seal(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if plain, err := ring.Open(envelope, nil); err != nil || len(plain) != 0 {
		t.Fatalf("empty plaintext recovery failed: %v", err)
	}
	for _, edit := range []func(*Envelope){
		func(e *Envelope) { e.Version = 2 },
		func(e *Envelope) { e.MasterKeyID = "invalid/key" },
		func(e *Envelope) { e.Nonce = nil },
		func(e *Envelope) { e.Ciphertext = make([]byte, 15) },
	} {
		invalid := envelope
		edit(&invalid)
		if _, err := ring.Open(invalid, nil); !errors.Is(err, ErrEnvelopeInvalid) {
			t.Fatalf("malformed envelope was not rejected: %v", err)
		}
	}
	ring.random = io.LimitReader(bytes.NewReader(make([]byte, 3)), 3)
	if _, err := ring.Seal([]byte("private"), nil); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("nonce failure did not retain its cause: %v", err)
	}
}

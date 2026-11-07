package secretbox

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"strings"
	"testing"
)

var master = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))

func ring(t *testing.T, data string) *Keyring {
	t.Helper()
	k, err := Parse([]byte(data))
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestParseStrict(t *testing.T) {
	valid := `{"activeKeyId":"active","keys":{"active":"` + master + `"}}`
	if got := ring(t, valid).ActiveKeyID(); got != "active" {
		t.Fatalf("active key = %q", got)
	}
	cases := map[string]string{
		"missing active":        `{"keys":{"active":"` + master + `"}}`,
		"missing keys":          `{"activeKeyId":"active"}`,
		"unknown":               `{"activeKeyId":"active","keys":{},"extra":1}`,
		"duplicate field":       `{"activeKeyId":"active","activeKeyId":"active","keys":{}}`,
		"duplicate key":         `{"activeKeyId":"active","keys":{"active":"` + master + `","active":"` + master + `"}}`,
		"escaped duplicate key": `{"activeKeyId":"active","keys":{"active":"` + master + `","\u0061ctive":"` + master + `"}}`,
		"null active":           `{"activeKeyId":null,"keys":{}}`,
		"null keys":             `{"activeKeyId":"active","keys":null}`,
		"null value":            `{"activeKeyId":"active","keys":{"active":null}}`,
		"no referenced key":     `{"activeKeyId":"absent","keys":{"active":"` + master + `"}}`,
		"short key":             `{"activeKeyId":"active","keys":{"active":"AQ=="}}`,
		"unquoted key value":    `{"activeKeyId":"active","keys":{"active":1}}`,
		"noncanonical base64":   `{"activeKeyId":"active","keys":{"active":"` + strings.TrimSuffix(master, "=") + `"}}`,
		"base64 newline":        `{"activeKeyId":"active","keys":{"active":"` + master + `\n"}}`,
		"invalid unicode":       `{"activeKeyId":"\ud800","keys":{}}`,
		"control id":            `{"activeKeyId":"bad\u0000id","keys":{}}`,
		"trailing object":       valid + `{}`,
		"bad UTF8":              valid + string([]byte{0xff}),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(data)); !errors.Is(err, ErrInvalidKeyring) {
				t.Fatalf("Parse error = %v", err)
			}
		})
	}
	// Valid Unicode identifiers need not conform to an undocumented ASCII rule.
	ring(t, `{"activeKeyId":"密钥","keys":{"密钥":"`+master+`"}}`)
}

func TestSealOpenAuthenticationAndRotation(t *testing.T) {
	k := ring(t, `{"activeKeyId":"new","keys":{"new":"`+master+`","old":"`+master+`"}}`)
	binding := []string{"team", "owner", "endpoint", "endpoint-current", "1"}
	plaintext := []byte("https://example.test/secret?token=private")
	e, err := k.Seal(plaintext, binding, bytes.NewReader(bytes.Repeat([]byte{3}, 12)))
	if err != nil {
		t.Fatal(err)
	}
	if e.MasterKeyID != "new" || e.Version != 1 || len(e.Nonce) != 12 || bytes.Contains(e.Ciphertext, plaintext) {
		t.Fatalf("invalid envelope: %+v", e)
	}
	got, err := k.Open(e, binding)
	if err != nil || !bytes.Equal(got, plaintext) {
		t.Fatalf("open = %q, %v", got, err)
	}
	for i := range binding {
		changed := append([]string(nil), binding...)
		changed[i] += "x"
		if _, err := k.Open(e, changed); !errors.Is(err, ErrAuthentication) {
			t.Errorf("binding %d: %v", i, err)
		}
	}
	altered := e
	altered.MasterKeyID = "old" // Same key material must not permit metadata swapping.
	if _, err := k.Open(altered, binding); !errors.Is(err, ErrAuthentication) {
		t.Fatalf("master ID swap: %v", err)
	}
	altered = e
	altered.Nonce = append([]byte(nil), e.Nonce...)
	altered.Nonce[0] ^= 1
	if _, err := k.Open(altered, binding); !errors.Is(err, ErrAuthentication) {
		t.Fatalf("nonce change: %v", err)
	}
	altered = e
	altered.Ciphertext = append([]byte(nil), e.Ciphertext...)
	altered.Ciphertext[0] ^= 1
	if _, err := k.Open(altered, binding); !errors.Is(err, ErrAuthentication) {
		t.Fatalf("ciphertext change: %v", err)
	}
	altered = e
	altered.MasterKeyID = "missing"
	if _, err := k.Open(altered, binding); !errors.Is(err, ErrMissingKey) {
		t.Fatalf("missing key: %v", err)
	}
	altered = e
	altered.Version++
	if _, err := k.Open(altered, binding); !errors.Is(err, ErrInvalidEnvelope) {
		t.Fatalf("version change: %v", err)
	}
	altered = e
	altered.Nonce = []byte{1}
	if _, err := k.Open(altered, binding); !errors.Is(err, ErrInvalidEnvelope) {
		t.Fatalf("short nonce: %v", err)
	}
	altered = e
	altered.Ciphertext = []byte{1}
	if _, err := k.Open(altered, binding); !errors.Is(err, ErrInvalidEnvelope) {
		t.Fatalf("short ciphertext: %v", err)
	}
	old := ring(t, `{"activeKeyId":"old","keys":{"old":"`+master+`"}}`)
	oldEnvelope, err := old.Seal(plaintext, binding, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := k.Open(oldEnvelope, binding); err != nil || !bytes.Equal(got, plaintext) {
		t.Fatalf("old master read: %q, %v", got, err)
	}
}

func TestSealFailuresAndNonce(t *testing.T) {
	k := ring(t, `{"activeKeyId":"a","keys":{"a":"`+master+`"}}`)
	for _, binding := range [][]string{nil, {""}, {"bad\x00part"}, {string([]byte{0xff})}} {
		if _, err := k.Seal(nil, binding, nil); !errors.Is(err, ErrInvalidEnvelope) {
			t.Fatalf("binding %q: %v", binding, err)
		}
	}
	if _, err := k.Seal(nil, []string{"owner"}, bytes.NewReader(nil)); !errors.Is(err, io.EOF) {
		t.Fatalf("random failure cause: %v", err)
	}
	a, err := k.Seal(nil, []string{"owner"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := k.Seal(nil, []string{"owner"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(a.Nonce, b.Nonce) {
		t.Fatal("random nonce unexpectedly reused")
	}
}

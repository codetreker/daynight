package oauth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/url"
	"strings"
	"unicode/utf8"
)

var (
	ErrInvalidAuthorization  = errors.New("invalid OAuth authorization")
	ErrInvalidGrant          = errors.New("invalid OAuth grant")
	ErrAuthorizationCapacity = errors.New("OAuth authorization capacity reached")
	ErrAuthorizationUnknown  = errors.New("OAuth authorization outcome unknown")
)

const CodePrefix = "dnoc_"
const BindingPrefix = "dnob_"

func ValidChallenge(s string) bool {
	b, e := base64.RawURLEncoding.DecodeString(s)
	return e == nil && len(b) == sha256.Size && base64.RawURLEncoding.EncodeToString(b) == s
}
func ValidVerifier(s string) bool {
	if len(s) < 43 || len(s) > 128 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-._~", c)) {
			return false
		}
	}
	return true
}
func VerifyChallenge(challenge, verifier string) bool {
	if !ValidChallenge(challenge) || !ValidVerifier(verifier) {
		return false
	}
	h := sha256.Sum256([]byte(verifier))
	actual := base64.RawURLEncoding.EncodeToString(h[:])
	return subtle.ConstantTimeCompare([]byte(actual), []byte(challenge)) == 1
}
func ValidState(s string) bool {
	return len(s) <= 4096 && utf8.ValidString(s) && !strings.ContainsRune(s, 0)
}

// CallbackURI rejects response-field collisions in the registered callback.
func CallbackURI(raw string, fields url.Values) (string, error) {
	if !ValidRedirect(raw) {
		return "", ErrInvalidAuthorization
	}
	u, e := url.Parse(raw)
	if e != nil {
		return "", ErrInvalidAuthorization
	}
	q, e := url.ParseQuery(u.RawQuery)
	if e != nil {
		return "", ErrInvalidAuthorization
	}
	for _, k := range []string{"code", "error", "state", "iss"} {
		if _, ok := q[k]; ok {
			return "", ErrInvalidAuthorization
		}
	}
	encoded := fields.Encode()
	if encoded == "" {
		return raw, nil
	}
	separator := "?"
	if u.RawQuery != "" {
		separator = "&"
	} else if u.ForceQuery {
		separator = ""
	}
	return raw + separator + encoded, nil
}

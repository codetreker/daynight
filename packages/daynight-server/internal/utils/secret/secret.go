package secret

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strings"
)

func Random(prefix string) string {
	bytes := make([]byte, 32)
	_, _ = rand.Read(bytes)
	return prefix + base64.RawURLEncoding.EncodeToString(bytes)
}

func Hash(secret string) []byte {
	hash := sha256.Sum256([]byte(secret))
	return hash[:]
}

func Valid(secret, prefix string) bool {
	if !strings.HasPrefix(secret, prefix) {
		return false
	}
	raw := strings.TrimPrefix(secret, prefix)
	if len(raw) != base64.RawURLEncoding.EncodedLen(32) {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == raw
}

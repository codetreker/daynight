package remote

import (
	"crypto/rsa"
	"math/big"
	"strings"
	"testing"
)

func TestAppJWTRejectsInvalidCredentialsAndSigningFailure(t *testing.T) {
	for _, tc := range []struct {
		name  string
		appID int64
		key   *rsa.PrivateKey
		want  string
	}{
		{"missing key", 1, nil, "invalid GitHub App credentials"},
		{"missing app id", 0, &rsa.PrivateKey{}, "invalid GitHub App credentials"},
		{"key too small for RS256", 1, &rsa.PrivateKey{PublicKey: rsa.PublicKey{N: big.NewInt(3), E: 3}, D: big.NewInt(1)}, "cannot sign GitHub App JWT"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newTokenSource(tc.appID, tc.key, nil)
			jwt, err := s.jwt()
			if jwt != "" || err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("jwt=%q error=%v", jwt, err)
			}
		})
	}
}

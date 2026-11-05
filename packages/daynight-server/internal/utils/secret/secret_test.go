package secret

import (
	"bytes"
	"testing"
)

func TestSecretFormatAndHash(t *testing.T) {
	a, b := Random("dnpat_"), Random("dnpat_")
	if a == b || !Valid(a, "dnpat_") || Valid(a, "dnst_") || Valid(a+"=", "dnpat_") || Valid("dnpat_short", "dnpat_") {
		t.Fatal("invalid secret generation or validation")
	}
	if len(Hash(a)) != 32 || !bytes.Equal(Hash(a), Hash(a)) || bytes.Equal(Hash(a), Hash(b)) {
		t.Fatal("invalid secret hash")
	}
}

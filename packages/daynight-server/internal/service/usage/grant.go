package usage

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
)

func mint(binding [32]byte) (string, []byte, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	verifier := core.GrantVerifier{TokenHash: sha256.Sum256([]byte(token)), Binding: binding}
	return token, verifier.Encode(), nil
}
func validateGrant(r model.UsageRecord, token string, now time.Time) error {
	verifier, err := core.ParseGrantVerifier(r.GrantHash)
	if err != nil {
		return err
	}
	h := sha256.Sum256([]byte(token))
	if len(token) != 43 || subtle.ConstantTimeCompare(h[:], verifier.TokenHash[:]) != 1 {
		return core.Fault("invalid_grant")
	}
	if r.GrantRevokedAt != nil {
		return core.Fault("permission_revoked")
	}
	if r.GrantExpiresAt == nil || !now.Before(*r.GrantExpiresAt) {
		return core.Fault("upload_expired")
	}
	return nil
}
func matchRegistration(old, candidate model.UsageRecord, instance, epoch string) error {
	verifier, err := core.ParseGrantVerifier(old.GrantHash)
	if err != nil {
		return err
	}
	binding, err := core.RegistrationBinding(candidate, instance, epoch)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare(verifier.Binding[:], binding[:]) != 1 {
		return core.Fault("registration_conflict")
	}
	return nil
}

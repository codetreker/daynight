package usage

import (
	"crypto/sha256"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

var ErrInvalidGrantVerifier = errors.New("invalid persisted usage grant verifier")

// GrantVerifier is a private versioned envelope, not part of the public DTO.
type GrantVerifier struct {
	TokenHash [32]byte
	Binding   [32]byte
}

func (g GrantVerifier) Encode() []byte {
	out := make([]byte, 65)
	out[0] = 1
	copy(out[1:33], g.TokenHash[:])
	copy(out[33:], g.Binding[:])
	return out
}
func ParseGrantVerifier(raw []byte) (GrantVerifier, error) {
	var verifier GrantVerifier
	if len(raw) != 65 || raw[0] != 1 {
		return verifier, ErrInvalidGrantVerifier
	}
	copy(verifier.TokenHash[:], raw[1:33])
	copy(verifier.Binding[:], raw[33:])
	return verifier, nil
}
func RegistrationBinding(r model.UsageRecord, instance, epoch string) ([32]byte, error) {
	raw, err := Canonical([]any{
		"daynight.usage.registration-binding.v1", Protocol, string(model.PATCredential),
		r.ID, r.Scope, r.ProjectID, r.TaskID, r.TestExecutionID, r.SessionID, r.ClaimID, r.Generation, r.WorkerID,
		r.AuthorityUserID, r.ParentCredentialID, r.Provider, r.NativeSessionID, r.AnchorStateID,
		r.RegistrationID, r.ProfileID, r.ProviderVersion, instance, epoch,
	})
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(raw), nil
}

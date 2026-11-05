package model

// IdentityProviderError separates backend integration failures from an expired
// product credential while retaining the SDK or context cause.
type IdentityProviderError struct {
	Code  string
	Cause error
}

func (e *IdentityProviderError) Error() string {
	switch e.Code {
	case "identity_configuration":
		return "The identity provider configuration is unavailable."
	case "identity_timeout":
		return "The identity provider request timed out."
	default:
		return "The identity provider is unavailable."
	}
}
func (e *IdentityProviderError) Unwrap() error { return e.Cause }

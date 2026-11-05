package model

import "github.com/google/uuid"

func CanonicalID(value string) (string, error) {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return "", &Fault{Code: "invalid_input", Message: "ID must be a hyphenated UUID."}
	}
	id, err := uuid.Parse(value)
	if err != nil {
		return "", &Fault{Code: "invalid_input", Message: "ID must be a hyphenated UUID."}
	}
	return id.String(), nil
}

func RequirePrincipal(principal Principal) error {
	if principal.Kind != SessionCredential && principal.Kind != PATCredential {
		return &Fault{Code: "unauthenticated", Message: "Authentication is required. Please log in again."}
	}
	if _, err := CanonicalID(principal.CredentialID); err != nil {
		return &Fault{Code: "unauthenticated", Message: "Authentication is required. Please log in again."}
	}
	if _, err := CanonicalID(principal.UserID); err != nil {
		return &Fault{Code: "unauthenticated", Message: "Authentication is required. Please log in again."}
	}
	return nil
}

func EqualOptional[T comparable](left, right *T) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

package identity

import (
	"errors"
	"strings"
)

// CanonicalUniAuthID preserves opaque upstream identities and gives both
// Microsoft identity encodings the same persistent account key.
func CanonicalUniAuthID(value string) (string, error) {
	if rest, ok := strings.CutPrefix(value, "microsoft:"); ok {
		tenant, object, found := strings.Cut(rest, ":")
		if !found || !validMicrosoftIDPart(tenant) || !validMicrosoftIDPart(object) {
			return "", errors.New("Microsoft identity must have the form microsoft:<tid>:<oid>")
		}
		return "msft:" + object + "@" + tenant, nil
	}
	if rest, ok := strings.CutPrefix(value, "msft:"); ok {
		object, tenant, found := strings.Cut(rest, "@")
		if !found || !validMicrosoftIDPart(object) || !validMicrosoftIDPart(tenant) {
			return "", errors.New("Microsoft identity must have the form msft:<oid>@<tid>")
		}
	}
	return value, nil
}

func validMicrosoftIDPart(value string) bool {
	return value != "" && !strings.ContainsAny(value, ":@")
}

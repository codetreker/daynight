package filestorage

import (
	"errors"

	"github.com/google/uuid"
)

// ArchiveGateKey validates the identities shared across the archive gate
// implementations and returns the pre-existing owner residency key.
func ArchiveGateKey(owner, session string, limit int, cleanup bool) (string, error) {
	canonical := func(value string) bool {
		id, err := uuid.Parse(value)
		return err == nil && id != uuid.Nil && id.String() == value
	}
	if !canonical(owner) || (!cleanup && !canonical(session)) || limit < 1 {
		return "", errors.New("archive gate requires canonical owner and Session IDs and a positive limit")
	}
	return "session/archive/owner/" + owner, nil
}

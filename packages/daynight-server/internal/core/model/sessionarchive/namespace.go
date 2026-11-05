// Package sessionarchive owns the physical namespace shared by archive writers,
// readers and cleanup.
package sessionarchive

import (
	"errors"
	"fmt"
	"regexp"

	"github.com/google/uuid"
)

const Bucket = "session-archives"

type Kind string

const (
	Projects Kind = "projects"
	Users    Kind = "users"
)

var ErrInvalidNamespace = errors.New("invalid session archive namespace")
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Namespace keeps the fixed ownership and Session components separate from
// arbitrary file paths. Its zero value is invalid.
type Namespace struct {
	kind      Kind
	ownerID   string
	sessionID string
}

func NewNamespace(kind Kind, ownerID, sessionID string) (Namespace, error) {
	namespace := Namespace{kind: kind, ownerID: ownerID, sessionID: sessionID}
	return namespace, namespace.Validate()
}

func (n Namespace) Validate() error {
	if n.kind != Projects && n.kind != Users {
		return fmt.Errorf("%w: ownership kind must be projects or users", ErrInvalidNamespace)
	}
	for _, component := range []struct{ name, value string }{{"owner", n.ownerID}, {"session", n.sessionID}} {
		id, err := uuid.Parse(component.value)
		if err != nil || id == uuid.Nil || id.String() != component.value {
			return fmt.Errorf("%w: %s ID must be a nonzero canonical UUID", ErrInvalidNamespace, component.name)
		}
	}
	return nil
}

// Directory requires a valid Namespace obtained from NewNamespace.
func (n Namespace) Directory() string {
	return string(n.kind) + "/" + n.ownerID + "/" + n.sessionID[:2] + "/" + n.sessionID
}

func (n Namespace) ObjectPath(digest string) (string, error) {
	if err := n.Validate(); err != nil {
		return "", err
	}
	if !digestPattern.MatchString(digest) {
		return "", fmt.Errorf("%w: archive SHA-256 must be 64 lowercase hexadecimal characters", ErrInvalidNamespace)
	}
	return n.Directory() + "/" + digest + ".json", nil
}

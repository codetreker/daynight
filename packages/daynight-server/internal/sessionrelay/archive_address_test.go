package sessionrelay

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionarchive"
)

func TestArchiveObjectAddressRejectsInvalidRegistryIdentity(t *testing.T) {
	valid := "7540b06e-11f4-4a2b-94af-f3e7ea790c85"
	for name, identity := range map[string]struct{ project, owner, session, digest string }{
		"project":           {"../another-project", valid, valid, strings.Repeat("a", 64)},
		"independent owner": {"", "00000000-0000-0000-0000-000000000000", valid, strings.Repeat("a", 64)},
		"session":           {valid, valid, "not-a-session", strings.Repeat("a", 64)},
		"digest":            {valid, valid, valid, "../another-object"},
	} {
		t.Run(name, func(t *testing.T) {
			path, err := archiveObjectPath(identity.project, identity.owner, identity.session, identity.digest)
			if !errors.Is(err, sessionarchive.ErrInvalidNamespace) || path != "" {
				t.Fatalf("invalid registry identity produced an archive address: %q %v", path, err)
			}
			if err := validateArchiveObjectPath(identity.project, identity.owner, identity.session, identity.digest, ""); !errors.Is(err, sessionarchive.ErrInvalidNamespace) {
				t.Fatalf("invalid registry identity was accepted for reading: %v", err)
			}
		})
	}
}

func testArchiveDirectory(t *testing.T, project, owner, session string) string {
	t.Helper()
	namespace, err := archiveNamespace(project, owner, session)
	if err != nil {
		t.Fatal(err)
	}
	return namespace.Directory()
}

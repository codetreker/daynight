package filestorage

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/google/uuid"
)

func TestArchiveStagingPathValidatesOwnershipAndFileIdentity(t *testing.T) {
	n, err := sessionarchive.NewNamespace(sessionarchive.Users, uuid.NewString(), uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	path, err := ArchiveStagingPath(n, id)
	if err != nil || path != n.Directory()+"/.staging/"+id {
		t.Fatalf("path %q: %v", path, err)
	}
	if _, err = ArchiveStagingPath(sessionarchive.Namespace{}, id); !errors.Is(err, ErrInvalidAddress) {
		t.Fatalf("zero namespace: %v", err)
	}
	for _, bad := range []string{"", uuid.Nil.String(), strings.ToUpper(id), "../" + id} {
		if _, err = ArchiveStagingPath(n, bad); !errors.Is(err, ErrInvalidAddress) {
			t.Errorf("identity %q: %v", bad, err)
		}
	}
}

package sessionarchive

import (
	"errors"
	"strings"
	"testing"
)

func TestArchiveNamespacesGroupOwnershipAndShardSessionIdentity(t *testing.T) {
	owner := "70b6f95f-23d4-4a9e-9f93-f24f29c066a9"
	session := "7540b06e-11f4-4a2b-94af-f3e7ea790c85"
	digest := strings.Repeat("a", 64)
	for _, kind := range []Kind{Projects, Users} {
		namespace, err := NewNamespace(kind, owner, session)
		if err != nil {
			t.Fatal(err)
		}
		expected := string(kind) + "/" + owner + "/75/" + session
		if namespace.Directory() != expected || namespace.SessionID() != session {
			t.Fatalf("namespace identity changed: %s", namespace.Directory())
		}
		path, err := namespace.ObjectPath(digest)
		if err != nil || path != expected+"/"+digest+".json" {
			t.Fatalf("archive object path: %q %v", path, err)
		}
	}
}

func TestArchiveNamespaceRejectsInvalidOwnershipAndIdentity(t *testing.T) {
	valid := "7540b06e-11f4-4a2b-94af-f3e7ea790c85"
	invalid := []string{"", "../other", "00000000-0000-0000-0000-000000000000", strings.ToUpper(valid), "7540b06e11f44a2b94aff3e7ea790c85", valid + "/child"}
	for _, id := range invalid {
		for _, components := range [][2]string{{id, valid}, {valid, id}} {
			if _, err := NewNamespace(Users, components[0], components[1]); !errors.Is(err, ErrInvalidNamespace) {
				t.Fatalf("accepted invalid namespace %q: %v", components, err)
			}
		}
	}
	if _, err := NewNamespace("other", valid, valid); !errors.Is(err, ErrInvalidNamespace) {
		t.Fatal("accepted arbitrary namespace kind", err)
	}
	if err := (Namespace{}).Validate(); !errors.Is(err, ErrInvalidNamespace) {
		t.Fatal("accepted zero namespace", err)
	}
	if _, err := (Namespace{}).ObjectPath(strings.Repeat("a", 64)); !errors.Is(err, ErrInvalidNamespace) {
		t.Fatal("accepted zero namespace object", err)
	}
	namespace, err := NewNamespace(Users, valid, valid)
	if err != nil {
		t.Fatal(err)
	}
	for _, digest := range []string{"", strings.Repeat("a", 63), strings.Repeat("A", 64), strings.Repeat("z", 64), "../other"} {
		if _, err := namespace.ObjectPath(digest); !errors.Is(err, ErrInvalidNamespace) {
			t.Fatalf("accepted digest %q: %v", digest, err)
		}
	}
}

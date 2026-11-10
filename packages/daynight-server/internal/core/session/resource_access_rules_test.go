package session

import (
	"context"
	"errors"
	"strings"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type resourceReferenceRuleDAO struct {
	store.SessionDAO
	store.SessionResourceDAO
	added []store.SessionResourceReference
	cause error
}

func (d *resourceReferenceRuleDAO) AddSessionResourceReference(_ context.Context, row store.SessionResourceReference) error {
	d.added = append(d.added, row)
	return d.cause
}

func TestResourceReferenceAdmissionPreservesOpaqueReferenceAndAuthorizedScope(t *testing.T) {
	session, resource := uuid.NewString(), uuid.NewString()
	for _, kind := range []string{"upload", "operation", "message", "unknown", "native_resume", "archive"} {
		t.Run(kind, func(t *testing.T) {
			d := &resourceReferenceRuleDAO{}
			a := &Access{tx: &operationTx{dao: d}, record: &record{Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: session}}}}}
			// References are opaque text, including historical entry/image keys.
			reference := "original/entry:image#0"
			if err := a.AddResourceReference(t.Context(), resource, kind, reference); err != nil {
				t.Fatal(err)
			}
			want := store.SessionResourceReference{SessionID: session, ResourceID: resource, Kind: kind, ReferenceID: reference}
			if len(d.added) != 1 || d.added[0] != want {
				t.Fatal("reference changed its authorized scope or opaque identity", d.added)
			}
			d.cause = errors.New("reference write failed")
			if err := a.AddResourceReference(t.Context(), resource, kind, reference); !errors.Is(err, d.cause) {
				t.Fatal("reference admission hid DAO failure", err)
			}
		})
	}
}

func TestResourceReferenceAdmissionRejectsInvalidIdentityBeforeDAO(t *testing.T) {
	session := "abcdef12-1234-4234-8234-123456789abc"
	resource := "bcdef123-1234-4234-8234-123456789abc"
	for _, tc := range []struct{ name, session, resource, kind, reference string }{
		{"unknown kind", session, resource, "other", "original"},
		{"empty kind", session, resource, "", "original"},
		{"empty reference", session, resource, "message", ""},
		{"invalid resource", session, "invalid", "message", "original"},
		{"uppercase resource", session, strings.ToUpper(resource), "message", "original"},
		{"zero resource", session, uuid.Nil.String(), "message", "original"},
		{"invalid session", "invalid", resource, "message", "original"},
		{"uppercase session", strings.ToUpper(session), resource, "message", "original"},
		{"zero session", uuid.Nil.String(), resource, "message", "original"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &resourceReferenceRuleDAO{}
			a := &Access{tx: &operationTx{dao: d}, record: &record{Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: tc.session}}}}}
			if err := a.AddResourceReference(t.Context(), tc.resource, tc.kind, tc.reference); err == nil || len(d.added) != 0 {
				t.Fatal("invalid reference reached storage", err, d.added)
			}
		})
	}
}

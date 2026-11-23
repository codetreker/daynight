package task

import (
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"testing"
)

func TestScopedPersonalInventorySkipsSessionSources(t *testing.T) {
	app, _, sources, observer, _, _ := personalFixture(t)
	a := scopedObservationAuth(t, "task:read")
	a.Principal = personalPrincipal()
	app = NewScopedObservations(app, a)
	page, err := app.PersonalTasks(t.Context(), a.Principal, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || !page.SessionPartial || len(sources.calls) != 0 || len(observer.projects) != 0 {
		t.Fatalf("page %#v sources %v observer %v", page, sources.calls, observer.projects)
	}
	for _, item := range page.Items {
		if item.Worker != nil || item.Session.Reason != "insufficient_scope" || item.SessionRow.CanOpen {
			t.Fatalf("leaked session projection %#v", item)
		}
	}
	a = scopedObservationAuth(t, "project:read")
	a.Principal = personalPrincipal()
	app = NewScopedObservations(app, a)
	if _, err := app.PersonalTasks(t.Context(), a.Principal, 0, nil); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("scope refusal %v", err)
	}
}

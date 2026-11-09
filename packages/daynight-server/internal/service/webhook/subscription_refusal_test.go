package webhook

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func TestProjectEligibilityRefusalDoesNotReportTeamManagementDenial(t *testing.T) {
	for _, status := range []string{"owner_scope_changed", "access_revoked", "resource_unavailable"} {
		for _, intent := range []string{"create", "enroll", "expand events", "confirm", "enable"} {
			t.Run(status+"/"+intent, func(t *testing.T) {
				f := newMgmtFixture(t)
				f.team("shared", model.ProjectAdmin)
				sub, bindings := mgmtSubscription(f)
				m := f.mutation("endpoint.update")
				switch intent {
				case "create":
					m.Kind, m.EndpointID, m.IfVersion = "endpoint.create", "", 0
					m.Name, m.Enabled = mgmtPtr("Endpoint"), mgmtPtr(true)
					m.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/hooks"}
					fallthrough
				case "enroll":
					m.HasSubscriptions = true
					m.Subscriptions = []core.SubscriptionInput{{ProjectID: sub.ProjectID, EventTypes: []string{"task.created"}}}
					mgmtInstallSubscriptions(f, nil, nil)
				case "expand events":
					m.HasSubscriptions = true
					m.Subscriptions = []core.SubscriptionInput{mgmtSubscriptionInput(sub, "task.created", "task.paused", "task.deleted")}
				case "confirm":
					sub.AuthorizationState = "confirmation_required"
					m.ConfirmProjectIDs = []string{sub.ProjectID}
				case "enable":
					f.endpoint.Enabled = false
					m.Enabled = mgmtPtr(true)
				}
				if intent != "create" && intent != "enroll" {
					mgmtInstallSubscriptions(f, []wm.Subscription{sub}, map[string][]wm.Binding{sub.ID: bindings})
				}
				reads := 0
				f.eligibility.ReadEligibilityFn = func(_ context.Context, owner wm.Owner, project, actor string) (store.WebhookEligibility, error) {
					mgmtWantEqual(t, owner, f.owner)
					mgmtWantEqual(t, project, sub.ProjectID)
					mgmtWantEqual(t, actor, f.principal.UserID)
					reads++
					return store.WebhookEligibility{Status: status}, nil
				}
				f.recordWrites()
				result, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
				mgmtWantFault(t, err, "webhook_project_ineligible")
				if result.Body != nil || result.Replay || reads != 1 {
					t.Fatalf("refused mutation: result=%#v eligibilityReads=%d", result, reads)
				}
				f.order("write.team.Team", "write.LockConfigurationSources", "write.team.Team", "eligibility.ReadEligibility")
				f.noEffects()
			})
		}
	}
}

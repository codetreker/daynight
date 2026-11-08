package webhook

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type subscriptionChanges struct {
	subscriptions []wm.Subscription
	bindings      []wm.Binding
	changed       bool
}

// configurationProjects collects the old and requested scope before source locks.
func configurationProjects(old []wm.Subscription, m Mutation) []string {
	ids := map[string]bool{}
	for _, sub := range old {
		ids[sub.ProjectID] = true
	}
	for _, sub := range m.Subscriptions {
		ids[sub.ProjectID] = true
	}
	for _, id := range m.ConfirmProjectIDs {
		ids[id] = true
	}
	result := make([]string, 0, len(ids))
	for id := range ids {
		result = append(result, id)
	}
	sort.Strings(result)
	return result
}

func validSubscriptionInput(m Mutation) error {
	ids := map[string]bool{}
	for _, sub := range m.Subscriptions {
		if core.CanonicalUUID(sub.ProjectID) != nil || sub.ProjectID == "00000000-0000-0000-0000-000000000000" || len(sub.EventTypes) == 0 {
			return fault("invalid_input", "Invalid subscription.")
		}
		if sub.ID != nil {
			if core.CanonicalUUID(*sub.ID) != nil || *sub.ID == "00000000-0000-0000-0000-000000000000" || ids[*sub.ID] {
				return fault("invalid_input", "Invalid subscription ID.")
			}
			ids[*sub.ID] = true
		}
		events := map[string]bool{}
		for _, event := range sub.EventTypes {
			if !core.ValidEventType(event) || events[event] {
				return fault("invalid_input", "Invalid subscription event types.")
			}
			events[event] = true
		}
	}
	seen := map[string]bool{}
	for _, id := range m.ConfirmProjectIDs {
		if core.CanonicalUUID(id) != nil || id == "00000000-0000-0000-0000-000000000000" || seen[id] {
			return fault("invalid_input", "Invalid project confirmation.")
		}
		seen[id] = true
	}
	return nil
}

func (s *Service) planSubscriptions(ctx context.Context, sc store.WebhookWriteScope, ep wm.Endpoint, actor string, m Mutation, old []wm.Subscription, reEnable bool, now time.Time) (subscriptionChanges, error) {
	var result subscriptionChanges
	oldByID := map[string]wm.Subscription{}
	bindings := map[string][]wm.Binding{}
	for _, sub := range old {
		if sub.EndpointID != ep.ID || sub.Owner != ep.Owner || sub.AuthorizationEpoch <= 0 || (sub.AuthorizationState != "active" && sub.AuthorizationState != "confirmation_required") {
			return result, fmt.Errorf("invalid stored subscription")
		}
		oldByID[sub.ID] = sub
		b, err := sc.WebhookWriter().Bindings(ctx, sub.ID)
		if err != nil {
			return result, err
		}
		events := map[string]bool{}
		for _, item := range b {
			if item.SubscriptionID != sub.ID || !core.ValidEventType(item.EventType) || events[item.EventType] {
				return result, fmt.Errorf("invalid stored binding")
			}
			events[item.EventType] = true
		}
		if len(b) == 0 {
			return result, fmt.Errorf("subscription has no active bindings")
		}
		bindings[sub.ID] = b
	}
	inputs := m.Subscriptions
	if !m.HasSubscriptions {
		inputs = make([]core.SubscriptionInput, 0, len(old))
		for _, sub := range old {
			id := sub.ID
			input := core.SubscriptionInput{ID: &id, ProjectID: sub.ProjectID}
			for _, b := range bindings[sub.ID] {
				input.EventTypes = append(input.EventTypes, b.EventType)
			}
			inputs = append(inputs, input)
		}
	}
	if m.Kind == "endpoint.delete" {
		inputs = nil
	}
	finalProjects := map[string]bool{}
	for _, input := range inputs {
		finalProjects[input.ProjectID] = true
	}
	confirms := map[string]bool{}
	for _, projectID := range m.ConfirmProjectIDs {
		if !finalProjects[projectID] {
			return result, fault("invalid_input", "Confirmed project must be in the final subscriptions.")
		}
		confirms[projectID] = true
	}
	eligible := map[string]bool{}
	requireEligible := func(projectID string) error {
		if eligible[projectID] {
			return nil
		}
		value, err := sc.EligibilityDAO().ReadEligibility(ctx, ep.Owner, projectID, actor)
		if err != nil {
			return err
		}
		if value.Status != "eligible" {
			return fault("forbidden", "Project is not eligible for this webhook.")
		}
		eligible[projectID] = true
		return nil
	}
	for projectID := range confirms {
		if err := requireEligible(projectID); err != nil {
			return result, err
		}
	}
	retained := map[string]bool{}
	for _, input := range inputs {
		var sub wm.Subscription
		newSub := input.ID == nil
		if newSub {
			if !s.ConfigurationExpansionAvailable {
				return result, fault("webhooks_unavailable", "Webhook configuration expansion is unavailable.")
			}
			if err := requireEligible(input.ProjectID); err != nil {
				return result, err
			}
			id, err := s.newID()
			if err != nil {
				return result, err
			}
			sub = wm.Subscription{ID: id, EndpointID: ep.ID, ProjectID: input.ProjectID, Owner: ep.Owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: now, UpdatedAt: now}
			result.subscriptions = append(result.subscriptions, sub)
			result.changed = true
		} else {
			var ok bool
			sub, ok = oldByID[*input.ID]
			if !ok || sub.ProjectID != input.ProjectID || retained[sub.ID] {
				return result, fault("invalid_input", "Unknown subscription or changed project.")
			}
			retained[sub.ID] = true
			if confirms[sub.ProjectID] && sub.AuthorizationState == "confirmation_required" {
				if !s.ConfigurationExpansionAvailable {
					return result, fault("webhooks_unavailable", "Webhook configuration expansion is unavailable.")
				}
				sub.AuthorizationState = "active"
				sub.UpdatedAt = now
				result.subscriptions = append(result.subscriptions, sub)
				result.changed = true
			}
		}
		oldEvents := map[string]wm.Binding{}
		for _, b := range bindings[sub.ID] {
			oldEvents[b.EventType] = b
		}
		selected := map[string]bool{}
		for _, event := range input.EventTypes {
			selected[event] = true
			if _, ok := oldEvents[event]; !ok {
				if !s.ConfigurationExpansionAvailable {
					return result, fault("webhooks_unavailable", "Webhook configuration expansion is unavailable.")
				}
				if err := requireEligible(sub.ProjectID); err != nil {
					return result, err
				}
				id, err := s.newID()
				if err != nil {
					return result, err
				}
				result.bindings = append(result.bindings, wm.Binding{ID: id, SubscriptionID: sub.ID, EventType: event, CreatedAt: now})
				result.changed = true
			}
		}
		for _, b := range oldEvents {
			if !selected[b.EventType] {
				b.DeletedAt = &now
				result.bindings = append(result.bindings, b)
				result.changed = true
			}
		}
		if reEnable {
			if err := requireEligible(sub.ProjectID); err != nil {
				return result, err
			}
		}
	}
	for _, sub := range old {
		if !retained[sub.ID] {
			sub.DeletedAt = &now
			sub.UpdatedAt = now
			result.subscriptions = append(result.subscriptions, sub)
			result.changed = true
			for _, b := range bindings[sub.ID] {
				b.DeletedAt = &now
				result.bindings = append(result.bindings, b)
			}
		}
	}
	return result, nil
}

func (c subscriptionChanges) save(ctx context.Context, w store.WebhookWriter) error {
	for _, sub := range c.subscriptions {
		if err := w.PutSubscription(ctx, sub); err != nil {
			return err
		}
	}
	// Retire old bindings before inserting replacements protected by the partial unique index.
	for _, b := range c.bindings {
		if b.DeletedAt != nil {
			if err := w.PutBinding(ctx, b); err != nil {
				return err
			}
		}
	}
	for _, b := range c.bindings {
		if b.DeletedAt == nil {
			if err := w.PutBinding(ctx, b); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) subscriptionViews(ctx context.Context, sc store.WebhookReadScope, ep wm.Endpoint, actor string) ([]any, error) {
	subs, err := sc.WebhookDAO().Subscriptions(ctx, ep.ID)
	if err != nil {
		return nil, err
	}
	result := make([]any, 0, len(subs))
	for _, sub := range subs {
		if sub.EndpointID != ep.ID || sub.Owner != ep.Owner || sub.AuthorizationEpoch <= 0 || (sub.AuthorizationState != "active" && sub.AuthorizationState != "confirmation_required") {
			return nil, fmt.Errorf("invalid stored subscription")
		}
		status, err := sc.EligibilityDAO().ReadEligibility(ctx, ep.Owner, sub.ProjectID, actor)
		if err != nil {
			return nil, err
		}
		switch status.Status {
		case "eligible", "access_revoked", "owner_scope_changed", "resource_unavailable":
		default:
			return nil, fmt.Errorf("invalid project eligibility")
		}
		if status.Status != "eligible" {
			status.ProjectName = nil
		}
		if status.Status == "eligible" && sub.AuthorizationState == "confirmation_required" {
			status.Status = "confirmation_required"
		}
		bindings, err := sc.WebhookDAO().Bindings(ctx, sub.ID)
		if err != nil {
			return nil, err
		}
		events := make([]string, 0, len(bindings))
		seen := map[string]bool{}
		for _, b := range bindings {
			if b.SubscriptionID != sub.ID || !core.ValidEventType(b.EventType) || seen[b.EventType] {
				return nil, fmt.Errorf("invalid stored binding")
			}
			seen[b.EventType] = true
			events = append(events, b.EventType)
		}
		if len(events) == 0 {
			return nil, fmt.Errorf("subscription has no active bindings")
		}
		sort.Strings(events)
		result = append(result, map[string]any{"id": sub.ID, "projectId": sub.ProjectID, "projectName": status.ProjectName, "eventTypes": events, "eligibility": status.Status})
	}
	return result, nil
}

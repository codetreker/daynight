package webhook

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

// destinationDocument is the canonical v1 plaintext stored under encryption.
type destinationDocument struct {
	Kind           string `json:"kind"`
	AdapterVersion string `json:"adapterVersion"`
	Configuration  struct {
		URL string `json:"url"`
	} `json:"configuration"`
}

func encodeDestination(d Destination) ([]byte, error) {
	v := destinationDocument{Kind: d.Kind, AdapterVersion: d.AdapterVersion}
	v.Configuration.URL = d.URL
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	if len(b) > 256*1024 {
		return nil, fault("invalid_input", "Destination configuration exceeds its limit.")
	}
	return b, nil
}
func decodeDestination(b []byte) (Destination, error) {
	var v destinationDocument
	if err := json.Unmarshal(b, &v); err != nil {
		return Destination{}, fmt.Errorf("decode stored destination: %w", err)
	}
	if v.Kind != "http" || v.AdapterVersion != "1" {
		return Destination{}, fmt.Errorf("invalid stored destination")
	}
	if _, err := core.ValidateURL(v.Configuration.URL); err != nil {
		return Destination{}, fmt.Errorf("invalid stored destination: %w", err)
	}
	return Destination{Kind: v.Kind, AdapterVersion: v.AdapterVersion, URL: v.Configuration.URL}, nil
}

func (s *Service) random() io.Reader {
	if s.Random != nil {
		return s.Random
	}
	return rand.Reader
}
func (s *Service) newID() (string, error) {
	id, e := uuid.NewRandomFromReader(s.random())
	return id.String(), e
}
func fingerprint(p model.Principal, o Owner, m Mutation) (string, error) {
	var dest *core.Destination
	if m.Destination != nil {
		dest = &core.Destination{Kind: m.Destination.Kind, AdapterVersion: m.Destination.AdapterVersion, URL: m.Destination.URL}
	}
	var ifVersion *int64
	if m.Kind != "endpoint.create" {
		ifVersion = &m.IfVersion
	}
	return core.Fingerprint(core.Intent{OperationID: m.OperationID, ActorID: p.UserID, OwnerKind: o.Kind, OwnerID: o.ID, Kind: m.Kind, TargetID: m.EndpointID, IssuedAt: m.IssuedAt, IfVersion: ifVersion, Name: m.Name, Enabled: m.Enabled, Destination: dest, HasSubscriptions: m.HasSubscriptions, Subscriptions: m.Subscriptions, ConfirmProjectIDs: m.ConfirmProjectIDs, Mode: m.Mode})
}
func checkTime(issued string, now time.Time, policy wm.Policy) error {
	switch err := core.CheckIssuedAtLimits(issued, now, time.Duration(policy.OperationMaxAgeSeconds)*time.Second, time.Duration(policy.OperationFutureSkewSeconds)*time.Second); {
	case errors.Is(err, core.ErrOperationExpired):
		return fault("operation_expired", "Operation has expired.")
	case errors.Is(err, core.ErrOperationInFuture):
		return fault("invalid_operation_time", "Operation time is too far in the future.")
	case err != nil:
		return fault("invalid_input", "Invalid operation time.")
	default:
		return nil
	}
}
func validateMutation(m *Mutation) error {
	if err := validSubscriptionInput(*m); err != nil {
		return err
	}
	if core.CanonicalUUID(m.OperationID) != nil || core.CanonicalUUID(m.ExpectedUserID) != nil {
		return fault("invalid_input", "Invalid operation identity.")
	}
	if _, err := core.ParseIssuedAt(m.IssuedAt); err != nil {
		return fault("invalid_input", "Invalid operation time.")
	}
	if m.Kind != "endpoint.create" && (core.CanonicalUUID(m.EndpointID) != nil || m.IfVersion <= 0) {
		return fault("invalid_input", "Invalid endpoint or version.")
	}
	if m.Name != nil {
		name, err := core.NormalizeName(*m.Name)
		if err != nil {
			return fault("invalid_input", "Invalid endpoint name.")
		}
		m.Name = &name
	}
	if m.Destination != nil {
		if m.Destination.Kind != "http" || m.Destination.AdapterVersion != "1" {
			return fault("destination_unsupported", "Unsupported destination.")
		}
		if _, err := core.ValidateURL(m.Destination.URL); err != nil {
			return fault("invalid_input", "Invalid destination URL.")
		}
	}
	return nil
}
func (s *Service) Mutate(ctx context.Context, p model.Principal, o Owner, m Mutation) (Result, error) {
	if err := validateMutation(&m); err != nil {
		return Result{}, err
	}
	if p.UserID != m.ExpectedUserID {
		return Result{}, fault("identity_mismatch", "Expected user differs from current identity.")
	}
	err := s.DB.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error { _, e := authorize(ctx, sc, p, o); return e })
	if err != nil {
		return Result{}, err
	}
	fp, err := fingerprint(p, o, m)
	if err != nil {
		return Result{}, err
	}
	var op wm.Operation
	replay := false
	conflict := false
	completion, err := s.DB.WriteWebhook(ctx, o, m.OperationID, func(sc store.WebhookWriteScope) error {
		w := sc.WebhookWriter()
		existing, e := w.Operation(ctx, o, m.OperationID)
		if e == nil {
			op = existing
			replay = true
			conflict = existing.Fingerprint != fp
			return nil
		}
		if !errors.Is(e, model.ErrNotFound) {
			return e
		}
		initialManage, authErr := authorize(ctx, sc, p, o)
		if authErr != nil {
			return authErr
		}
		if !initialManage {
			return fault("forbidden", "Webhook management permission is required.")
		}
		policy, e := w.Policy(ctx, 1)
		if e != nil {
			return e
		}
		now, e := sc.ObservedAt(ctx)
		if e != nil {
			return e
		}
		if e = checkTime(m.IssuedAt, now, policy); e != nil {
			return e
		}
		var plannedVersion int64
		var plannedSubscriptions []wm.Subscription
		if m.Kind != "endpoint.create" {
			planned, e := w.Endpoint(ctx, o, m.EndpointID)
			if e != nil {
				return notFound(e)
			}
			if planned.DeletedAt != nil {
				return fault("not_found", "Webhook resource was not found.")
			}
			plannedVersion = planned.ConfigVersion
			if plannedVersion != m.IfVersion {
				return fault("version_conflict", "Webhook configuration version changed.")
			}
			plannedSubscriptions, e = w.Subscriptions(ctx, planned.ID)
			if e != nil {
				return e
			}
		}
		authorityErr := sc.LockConfigurationSources(ctx, o, p.UserID, configurationProjects(plannedSubscriptions, m))
		if failed, _ := store.DatabaseErrorFacts(authorityErr); failed {
			return authorityErr
		}
		if authorityErr != nil {
			if _, e = sc.CredentialDAO().Credential(ctx, p); e != nil {
				if errors.Is(e, model.ErrNotFound) {
					return model.Unauthenticated(e)
				}
				return e
			}
			if errors.Is(authorityErr, model.ErrNotFound) {
				return fault("forbidden", "Webhook management permission is required.")
			}
			return authorityErr
		}
		manage, e := authorize(ctx, sc, p, o)
		if e != nil {
			return e
		}
		if !manage {
			return fault("forbidden", "Webhook management permission is required.")
		}
		var ep wm.Endpoint
		var oldKeys []wm.SigningKey
		var endpointErr error
		if m.Kind != "endpoint.create" {
			ep, endpointErr = w.LockEndpoint(ctx, o, m.EndpointID)
			if failed, _ := store.DatabaseErrorFacts(endpointErr); failed {
				return endpointErr
			}
		}
		if _, e = sc.CredentialDAO().Credential(ctx, p); e != nil {
			if errors.Is(e, model.ErrNotFound) {
				return model.Unauthenticated(e)
			}
			return e
		}
		now, e = sc.ObservedAt(ctx)
		if e != nil {
			return e
		}
		if e = checkTime(m.IssuedAt, now, policy); e != nil {
			return e
		}
		if endpointErr != nil {
			return notFound(endpointErr)
		}
		if m.Kind != "endpoint.create" {
			if ep.DeletedAt != nil {
				return fault("not_found", "Webhook resource was not found.")
			}
			if ep.ConfigVersion != plannedVersion {
				return fault("version_conflict", "Webhook configuration version changed.")
			}
			oldKeys, e = w.SigningKeys(ctx, ep.ID)
			if e != nil {
				return e
			}
		}
		oldEP := ep
		var oldSubscriptions []wm.Subscription
		if m.Kind != "endpoint.create" {
			oldSubscriptions, e = w.LockSubscriptions(ctx, ep.ID)
			if e != nil {
				return e
			}
		}
		keys := append([]wm.SigningKey(nil), oldKeys...)
		changed := false
		deleted := false
		var overlap *time.Time
		switch m.Kind {
		case "endpoint.create":
			if !s.ConfigurationExpansionAvailable {
				return fault("webhooks_unavailable", "Webhook configuration expansion is unavailable.")
			}
			if m.Name == nil || m.Enabled == nil || m.Destination == nil || !m.HasSubscriptions {
				return fault("invalid_input", "Missing endpoint configuration.")
			}
			id, e := s.newID()
			if e != nil {
				return e
			}
			keyID, e := s.newID()
			if e != nil {
				return e
			}
			secret := make([]byte, 32)
			if _, e = io.ReadFull(s.random(), secret); e != nil {
				return e
			}
			ep = wm.Endpoint{ID: id, Owner: o, Name: *m.Name, Enabled: *m.Enabled, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: m.Destination.Kind, AdapterVersion: m.Destination.AdapterVersion, Origin: destinationOrigin(m.Destination.URL), ActiveKeyID: keyID, CreatedAt: now, UpdatedAt: now}
			document, e := encodeDestination(*m.Destination)
			if e != nil {
				return e
			}
			ep.DestinationCiphertext, e = s.encrypt(document, binding(ep, "endpoint-current", "1"))
			if e != nil {
				return e
			}
			cipher, e := s.encrypt(secret, binding(ep, "signing-key", keyID))
			if e != nil {
				return e
			}
			keys = []wm.SigningKey{{EndpointID: id, ID: keyID, Ciphertext: cipher, CreatedAt: now, Slot: "current"}}
			changed = true
		case "endpoint.update":
			if m.Name != nil && *m.Name != ep.Name {
				ep.Name = *m.Name
				changed = true
			}
			if m.Enabled != nil && *m.Enabled != ep.Enabled {
				if *m.Enabled && !s.ConfigurationExpansionAvailable {
					return fault("webhooks_unavailable", "Webhook configuration expansion is unavailable.")
				}
				ep.Enabled = *m.Enabled
				changed = true
			}
			original, e := s.decrypt(ep.DestinationCiphertext, binding(ep, "endpoint-current", version(ep.DestinationRevision)))
			if e != nil {
				return e
			}
			originalDestination, e := decodeDestination(original)
			if e != nil {
				return e
			}
			newURL := originalDestination.URL
			if m.Destination != nil && (m.Destination.URL != newURL || m.Destination.Kind != ep.DestinationKind || m.Destination.AdapterVersion != ep.AdapterVersion) {
				if !s.ConfigurationExpansionAvailable {
					return fault("webhooks_unavailable", "Webhook configuration expansion is unavailable.")
				}
				if ep.DestinationRevision == math.MaxInt64 {
					return fault("version_exhausted", "Destination version exhausted.")
				}
				ep.DestinationRevision++
				ep.DestinationKind = m.Destination.Kind
				ep.AdapterVersion = m.Destination.AdapterVersion
				ep.Origin = destinationOrigin(m.Destination.URL)
				newURL = m.Destination.URL
				changed = true
			}
			if changed {
				document, e := encodeDestination(Destination{Kind: ep.DestinationKind, AdapterVersion: ep.AdapterVersion, URL: newURL})
				if e != nil {
					return e
				}
				ep.DestinationCiphertext, e = s.encrypt(document, binding(ep, "endpoint-current", version(ep.DestinationRevision)))
				if e != nil {
					return e
				}
			}
		case "endpoint.delete":
			ep.DeletedAt = &now
			ep.Enabled = false
			ep.DestinationCiphertext = nil
			ep.Name, ep.DestinationKind, ep.AdapterVersion, ep.Origin = "", "", "", ""
			ep.ActiveKeyID = ""
			keys = nil
			changed = true
			deleted = true
		case "signing.rotate":
			if m.Mode != "overlap" && m.Mode != "immediate" {
				return fault("invalid_input", "Invalid rotation mode.")
			}
			for _, k := range keys {
				if k.ID != ep.ActiveKeyID && k.RevokedAt == nil && k.OverlapUntil != nil && k.OverlapUntil.After(now) && m.Mode == "overlap" {
					return fault("operation_conflict", "Existing overlap must end before another overlap rotation.")
				}
			}
			var keep []wm.SigningKey
			for _, k := range keys {
				if k.ID == ep.ActiveKeyID && m.Mode == "overlap" {
					until := now.Add(time.Duration(policy.KeyOverlapDefaultSeconds) * time.Second)
					k.OverlapUntil = &until
					k.OverlapStartedAt = &now
					k.Slot = "overlap"
					overlap = &until
					keep = append(keep, k)
				}
			}
			keyID, e := s.newID()
			if e != nil {
				return e
			}
			secret := make([]byte, 32)
			if _, e = io.ReadFull(s.random(), secret); e != nil {
				return e
			}
			cipher, e := s.encrypt(secret, binding(ep, "signing-key", keyID))
			if e != nil {
				return e
			}
			keys = append(keep, wm.SigningKey{EndpointID: ep.ID, ID: keyID, Ciphertext: cipher, CreatedAt: now, Slot: "current"})
			ep.ActiveKeyID = keyID
			changed = true
		default:
			return fault("invalid_input", "Unsupported webhook operation.")
		}
		var subscriptionChanges subscriptionChanges
		if m.Kind == "endpoint.create" || m.Kind == "endpoint.update" || m.Kind == "endpoint.delete" {
			subscriptionChanges, e = s.planSubscriptions(ctx, sc, ep, p.UserID, m, oldSubscriptions, m.Kind == "endpoint.update" && !oldEP.Enabled && ep.Enabled, now)
			if e != nil {
				return e
			}
			changed = changed || subscriptionChanges.changed
		}
		if changed && m.Kind != "endpoint.create" {
			if ep.ConfigVersion == math.MaxInt64 {
				return fault("version_exhausted", "Configuration version exhausted.")
			}
			ep.ConfigVersion++
			ep.UpdatedAt = now
			if !deleted {
				if m.Kind != "endpoint.update" {
					plain, e := s.decrypt(oldEP.DestinationCiphertext, binding(oldEP, "endpoint-current", version(oldEP.DestinationRevision)))
					if e != nil {
						return e
					}
					ep.DestinationCiphertext, e = s.encrypt(plain, binding(ep, "endpoint-current", version(ep.DestinationRevision)))
					if e != nil {
						return e
					}
				}
				for i, k := range keys {
					if k.ID == ep.ActiveKeyID && m.Kind == "signing.rotate" {
						continue
					}
					plain, e := s.decrypt(k.Ciphertext, binding(oldEP, "signing-key", k.ID))
					if e != nil {
						return e
					}
					keys[i].Ciphertext, e = s.encrypt(plain, binding(ep, "signing-key", k.ID))
					if e != nil {
						return e
					}
				}
			}
		}
		credential, e := sc.LockCredential(ctx, p)
		if e != nil {
			if errors.Is(e, model.ErrNotFound) {
				return model.Unauthenticated(e)
			}
			return e
		}
		now, e = sc.ObservedAt(ctx)
		if e != nil {
			return e
		}
		if credential.ExpiresAt != nil && !credential.ExpiresAt.After(now) {
			return model.Unauthenticated(model.ErrNotFound)
		}
		if e = checkTime(m.IssuedAt, now, policy); e != nil {
			return e
		}
		if changed {
			ep.UpdatedAt = now
			if m.Kind == "endpoint.create" {
				ep.CreatedAt = now
			}
			if deleted {
				ep.DeletedAt = &now
			}
			if m.Kind == "endpoint.create" || m.Kind == "signing.rotate" {
				for i := range keys {
					if keys[i].ID == ep.ActiveKeyID {
						keys[i].CreatedAt = now
					}
					if m.Kind == "signing.rotate" && m.Mode == "overlap" && keys[i].ID == oldEP.ActiveKeyID {
						until := now.Add(time.Duration(policy.KeyOverlapDefaultSeconds) * time.Second)
						keys[i].OverlapUntil = &until
						keys[i].OverlapStartedAt = &now
						overlap = &until
					}
				}
			}
			if e = w.PutEndpoint(ctx, ep); e != nil {
				return e
			}
			if e = subscriptionChanges.save(ctx, w); e != nil {
				return e
			}
			if e = w.DeleteSigningKeys(ctx, ep.ID); e != nil {
				return e
			}
			for _, k := range keys {
				if e = w.PutSigningKey(ctx, k); e != nil {
					return e
				}
			}
		}
		effect := "unchanged"
		if changed {
			effect = "applied"
		}
		op = wm.Operation{Owner: o, ID: m.OperationID, ActorID: p.UserID, Kind: m.Kind, TargetID: ep.ID, IssuedAt: m.IssuedAt, RequestSHA256: m.RequestSHA256, Fingerprint: fp, Effect: effect, ConfigVersion: ep.ConfigVersion, DestinationRevisionAfter: ep.DestinationRevision, RecordedAt: now, ExpiresAt: now.Add(time.Duration(policy.OperationRetentionSeconds) * time.Second)}
		if m.Kind == "signing.rotate" {
			op.ActiveKeyID = ep.ActiveKeyID
			op.SigningMode = m.Mode
			op.OverlapUntil = overlap
		}
		return w.PutOperation(ctx, op)
	})
	if err != nil {
		if completion.Outcome == store.TransactionUnknown {
			return Result{}, &model.Fault{Code: "write_outcome_unknown", Message: "The write outcome is unknown. Check the original operation.", Cause: err}
		}
		return Result{}, err
	}
	if completion.Outcome != store.TransactionCommitted {
		return Result{}, fault("write_outcome_unknown", "The write outcome is unknown. Check the original operation.")
	}
	var body any
	err = s.DB.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		manage, e := authorize(ctx, sc, p, o)
		if e != nil {
			return e
		}
		cur, e := sc.WebhookDAO().Operation(ctx, o, op.ID)
		if e != nil {
			return notFound(e)
		}
		if !manage && cur.ActorID != p.UserID {
			return fault("forbidden", "Access to this operation is denied.")
		}
		if conflict {
			return fault("operation_conflict", "Operation ID was already used for a different intent.")
		}
		if m.Kind == "signing.rotate" {
			body = map[string]any{"operation": opView(cur), "signing": map[string]any{"activeKeyId": cur.ActiveKeyID, "overlapUntil": utcTime(cur.OverlapUntil)}}
			return nil
		}
		ep, e := sc.WebhookDAO().Endpoint(ctx, o, cur.TargetID)
		if e != nil {
			return notFound(e)
		}
		view, e := s.endpointView(ctx, sc, ep, p.UserID, manage)
		if e != nil {
			return e
		}
		body = map[string]any{"operation": opView(cur), "endpoint": view}
		return nil
	})
	if err != nil && !replay {
		return Result{}, &model.Fault{Code: "write_outcome_unknown", Message: "The write committed but its response could not be verified. Check the original operation.", Cause: err}
	}
	return Result{Body: body, Replay: replay}, err
}
func destinationOrigin(value string) string { origin, _ := core.ValidateURL(value); return origin }

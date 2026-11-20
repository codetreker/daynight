package usage

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
)

type Registration struct {
	Protocol             string `json:"protocol"`
	StateID              string `json:"stateId"`
	SessionID            string `json:"sessionId"`
	Generation           string `json:"executionGeneration"`
	ControllerInstanceID string `json:"controllerInstanceId"`
	ConnectionEpoch      string `json:"connectionEpoch"`
	NativeSessionID      string `json:"nativeSessionId"`
	ProfileID            string `json:"profileId"`
	ProviderVersion      string `json:"providerVersion"`
	RegistrationID       string `json:"registrationId"`
}
type Grant struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
}
type RegistrationResult struct {
	State   model.UsageRecord `json:"state"`
	Grant   *Grant            `json:"grant"`
	Created bool              `json:"-"`
}
type GrantRequest struct {
	ExpectedRowVersion   string `json:"expectedRowVersion"`
	SessionID            string `json:"sessionId,omitempty"`
	Generation           string `json:"executionGeneration,omitempty"`
	ControllerInstanceID string `json:"controllerInstanceId,omitempty"`
	ConnectionEpoch      string `json:"connectionEpoch,omitempty"`
}

func activeController(ctx context.Context, scope store.UsageScope, p model.Principal, session store.UsageSession, generation, instance, epoch, native string) (string, *string, error) {
	if p.Kind != model.PATCredential || p.UserID != session.OwnerID || p.CredentialID != session.ParentID || p.CredentialID != session.ConnectionParentID {
		return "", nil, core.Fault("permission_revoked")
	}
	r, err := scope.SessionDAO().LockSession(ctx, session.ID)
	if err != nil {
		return "", nil, err
	}
	snap := r.Snapshot
	if snap.SessionID != session.ID || session.Scope == "task" && snap.ClaimID != core.Value(session.ClaimID) || session.Scope == "test" && snap.TestExecutionID != core.Value(session.TestExecutionID) || snap.Lifecycle != "active" || snap.ExecutionGeneration != generation || snap.Identity.ControllerInstanceID != instance || snap.ConnectionEpoch != epoch || snap.Identity.NativeSessionID == nil || native != "" && *snap.Identity.NativeSessionID != native {
		return "", nil, core.Fault("registration_unavailable")
	}
	var worker *string
	if snap.Identity.WorkerID != "" {
		worker = core.Ptr(snap.Identity.WorkerID)
	}
	return snap.Identity.Provider, worker, nil
}
func (s *Service) Register(ctx context.Context, p model.Principal, input Registration) (RegistrationResult, error) {
	var result RegistrationResult
	if input.Protocol != core.Protocol || !core.UUID(input.StateID) || !core.UUID(input.SessionID) || !core.UUID(input.RegistrationID) || !core.UUID(input.ControllerInstanceID) || !core.Sequence(input.Generation, false) || !core.Sequence(input.ConnectionEpoch, false) || !core.Text(input.NativeSessionID, 256) || !core.Text(input.ProfileID, 128) || !core.Text(input.ProviderVersion, 128) {
		return result, core.Fault("invalid_registration")
	}
	err := s.write(ctx, func(scope store.UsageScope) error {
		dao := scope.UsageDAO()
		session, err := dao.Session(ctx, input.SessionID)
		if err != nil {
			return err
		}
		if session.Backend != "web" || session.BotID != nil {
			return core.Fault("unsupported_scope")
		}
		auth, err := s.authority(ctx, scope, session, p.UserID, p.CredentialID, true)
		if err != nil {
			return err
		}
		if session.Scope == "task" && (!auth.ClaimActive || auth.TaskType != model.TaskTypeTask) {
			return core.Fault("registration_unavailable")
		}
		provider, worker, err := activeController(ctx, scope, p, session, input.Generation, input.ControllerInstanceID, input.ConnectionEpoch, input.NativeSessionID)
		if err != nil {
			return err
		}
		if session.Scope == "task" && core.Value(worker) != core.Value(auth.WorkerID) {
			return core.Fault("registration_unavailable")
		}
		profile, err := s.profile(input.ProfileID, provider, input.ProviderVersion)
		if err != nil {
			return err
		}
		now, err := dao.Now(ctx)
		if err != nil {
			return err
		}
		if err = s.requireProducer(ctx, scope, p, now, true); err != nil {
			return err
		}
		r := model.UsageRecord{ID: input.StateID, Kind: "execution_state", Scope: session.Scope, ProjectID: session.ProjectID, TaskID: session.TaskID, TestExecutionID: session.TestExecutionID, SessionID: session.ID, ClaimID: session.ClaimID, Generation: input.Generation, WorkerID: worker, AuthorityUserID: p.UserID, Provider: provider, NativeSessionID: input.NativeSessionID, RegistrationID: core.Ptr(input.RegistrationID), ProfileID: input.ProfileID, ProviderVersion: input.ProviderVersion, ParentCredentialID: core.Ptr(p.CredentialID)}
		old, err := dao.Generation(ctx, session.ID, input.Generation)
		if err == nil {
			r.AnchorStateID = old.AnchorStateID
			if err = matchRegistration(old, r, input.ControllerInstanceID, input.ConnectionEpoch); err != nil {
				return err
			}
			result.State = old
			return nil
		}
		if !errors.Is(err, model.ErrNotFound) {
			return err
		}
		end := expiry(now, session.CreatedAt)
		if !now.Before(end) {
			return core.Fault("upload_expired")
		}
		r.Capability = &profile.Capability
		r.CollectionState = core.Ptr("collecting")
		r.StateSequence = core.Ptr("0")
		r.GrantExpiresAt = &end
		r.ObservedAt = now
		r.CreatedAt = now
		r.UpdatedAt = now
		r.RowVersion = "1"
		r.ReasonCodes = core.ProfileReasons(provider)
		if profile.Capability.Qualification == "unverified" {
			r.CollectionState = core.Ptr("unavailable")
			r.ReasonCodes = core.MergeReasons(r.ReasonCodes, "profile_unverified")
		}
		if profile.Capability.Qualification == "unsupported" {
			r.CollectionState = core.Ptr("unsupported")
			r.ReasonCodes = []string{"provider_unsupported"}
		}
		anchor, err := dao.Anchor(ctx, p.UserID, provider, input.NativeSessionID)
		if err == nil {
			if anchor.SessionID != r.SessionID || core.Value(anchor.TaskID) != core.Value(r.TaskID) || core.Value(anchor.TestExecutionID) != core.Value(r.TestExecutionID) {
				return core.Fault("source_conflict")
			}
			r.AnchorStateID = core.Ptr(anchor.ID)
		} else if !errors.Is(err, model.ErrNotFound) {
			return err
		}
		r.BodyHash, err = core.StateHash(r.ID, model.UsageEvent{StateSequence: "0", CollectionState: *r.CollectionState, Capability: r.Capability, ReasonCodes: r.ReasonCodes})
		if err != nil {
			return err
		}
		binding, err := core.RegistrationBinding(r, input.ControllerInstanceID, input.ConnectionEpoch)
		if err != nil {
			return err
		}
		token, hash, err := mint(binding)
		if err != nil {
			return err
		}
		r.GrantHash = hash
		if err = dao.Insert(ctx, r); err != nil {
			return err
		}
		result = RegistrationResult{State: r, Grant: &Grant{Token: token, ExpiresAt: end}, Created: true}
		return nil
	})
	return result, err
}
func (s *Service) Rotate(ctx context.Context, p model.Principal, id string, input GrantRequest) (RegistrationResult, error) {
	var result RegistrationResult
	if !core.Sequence(input.ExpectedRowVersion, false) || !core.UUID(input.SessionID) || !core.UUID(input.ControllerInstanceID) || !core.Sequence(input.Generation, false) || !core.Sequence(input.ConnectionEpoch, false) {
		return result, core.Fault("invalid_registration")
	}
	err := s.write(ctx, func(scope store.UsageScope) error {
		dao := scope.UsageDAO()
		r, err := dao.State(ctx, id)
		if err != nil {
			return err
		}
		session, err := dao.Session(ctx, r.SessionID)
		if err != nil {
			return err
		}
		var additional []string
		if s.producerAuthorization != nil {
			if r.AuthorityUserID != p.UserID || core.Value(r.ParentCredentialID) == "" {
				return core.Fault("permission_revoked")
			}
			additional = append(additional, core.Value(r.ParentCredentialID))
		}
		auth, err := s.authority(ctx, scope, session, p.UserID, p.CredentialID, true, additional...)
		if err != nil {
			return err
		}
		if session.Scope == "task" && !auth.ClaimActive {
			return core.Fault("registration_unavailable")
		}
		if input.SessionID != r.SessionID || input.Generation != r.Generation || r.SealedAt != nil || r.GrantRevokedAt != nil {
			return core.Fault("registration_unavailable")
		}
		if _, _, err = activeController(ctx, scope, p, session, input.Generation, input.ControllerInstanceID, input.ConnectionEpoch, r.NativeSessionID); err != nil {
			return err
		}
		now, err := dao.Now(ctx)
		if err != nil {
			return err
		}
		if err = s.requireProducer(ctx, scope, p, now, true); err != nil {
			return err
		}
		if len(additional) != 0 && additional[0] != p.CredentialID {
			original := model.Principal{Kind: model.PATCredential, UserID: r.AuthorityUserID, CredentialID: additional[0]}
			if err = s.requireProducer(ctx, scope, original, now, true); err != nil {
				return err
			}
		}
		if r.GrantExpiresAt == nil || !now.Before(*r.GrantExpiresAt) {
			return core.Fault("upload_expired")
		}
		if r.RowVersion != input.ExpectedRowVersion {
			return core.Fault("usage_changed")
		}
		end := expiry(now, session.CreatedAt)
		verifier, err := core.ParseGrantVerifier(r.GrantHash)
		if err != nil {
			return err
		}
		token, hash, err := mint(verifier.Binding)
		if err != nil {
			return err
		}
		r.RowVersion, err = core.Next(r.RowVersion)
		if err != nil {
			return err
		}
		r.UpdatedAt = now
		r.GrantExpiresAt = &end
		r.GrantHash = hash
		if err = dao.Replace(ctx, r, input.ExpectedRowVersion); err != nil {
			return err
		}
		result = RegistrationResult{State: r, Grant: &Grant{Token: token, ExpiresAt: end}}
		return nil
	})
	return result, err
}
func (s *Service) Revoke(ctx context.Context, p model.Principal, id, expected string) (model.UsageRecord, error) {
	var result model.UsageRecord
	if !core.Sequence(expected, false) {
		return result, core.Fault("invalid_registration")
	}
	err := s.write(ctx, func(scope store.UsageScope) error {
		dao := scope.UsageDAO()
		r, err := dao.State(ctx, id)
		if err != nil {
			return err
		}
		session, err := dao.Session(ctx, r.SessionID)
		if err != nil {
			return err
		}
		if session.Scope == "task" {
			if _, err = dao.LockTask(ctx, session); err != nil {
				return err
			}
		}
		if _, err = scope.SessionDAO().LockSession(ctx, session.ID); err != nil {
			return err
		}
		now, err := dao.Now(ctx)
		if err != nil {
			return err
		}
		if err = scope.SessionDAO().LockCredential(ctx, p, now); err != nil {
			return err
		}
		if session.Scope == "test" {
			if p.UserID != session.OwnerID {
				return core.Fault("resource_unavailable")
			}
		} else {
			a, e := dao.ProjectAccess(ctx, p.UserID, *session.ProjectID, true)
			if e != nil {
				return e
			}
			if p.UserID != session.OwnerID && a.Role != model.ProjectAdmin {
				return core.Fault("resource_unavailable")
			}
		}
		if err = s.requireProducer(ctx, scope, p, now, true); err != nil {
			return err
		}
		if r.RowVersion != expected {
			return core.Fault("usage_changed")
		}
		if r.GrantRevokedAt != nil {
			result = r
			return nil
		}
		r.RowVersion, err = core.Next(r.RowVersion)
		if err != nil {
			return err
		}
		r.UpdatedAt = now
		r.GrantRevokedAt = &now
		if err = dao.Replace(ctx, r, expected); err != nil {
			return err
		}
		result = r
		return nil
	})
	return result, err
}

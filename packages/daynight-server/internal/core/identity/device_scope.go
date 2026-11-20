package identity

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

// DeviceInspectionV2 augments the existing safe view only for a live pending request.
type DeviceInspectionV2 struct {
	DeviceInspection
	CatalogRevision *string `json:"catalogRevision,omitempty"`
}

// DecideDeviceScoped locks the browser session and device before sampling fresh
// database time. The decision and approved set are one transaction-bound write.
func (s *Identity) DecideDeviceScoped(ctx context.Context, dao store.IdentityDAO, scoped store.DeviceScopeDAO, p model.Principal, code, decision, expectedUserID string, selected []scopepolicy.ScopeID, now time.Time) error {
	code, status, err := ValidateDeviceDecision(p, code, decision, expectedUserID)
	if err != nil {
		return err
	}
	if status == "approved" {
		selected, err = scopepolicy.Normalize(scopepolicy.PAT, selected)
		if err != nil {
			return invalidInput("Invalid device scopes.")
		}
	} else if selected != nil {
		return invalidInput("A denied device request cannot include scopes.")
	}
	if err = dao.LockSession(ctx, p, now); err != nil {
		return deviceLookupError(err)
	}
	d, err := dao.DeviceByUserCode(ctx, p.UserID, code, true)
	if err != nil {
		return deviceLookupError(err)
	}
	fresh, err := scoped.FreshPATTime(ctx, now)
	if err != nil {
		return err
	}
	if err = dao.LockSession(ctx, p, fresh); err != nil {
		return deviceLookupError(err)
	}
	if !d.ExpiresAt.After(fresh) || d.Status != "pending" {
		return &model.Fault{Code: "invalid_transition", Message: "This device authorization can no longer be decided. Check its current status."}
	}
	return scoped.SetScopedDeviceDecision(ctx, d.ID, status, p.UserID, selected)
}

// RedeemDeviceScoped consumes the original device grant and stores its exact
// approved policy with the minted PAT in the same transaction.
func (s *Identity) RedeemDeviceScoped(ctx context.Context, dao store.IdentityDAO, scoped store.DeviceScopeDAO, clientID, grantType, code, deviceName string, now time.Time) (MintedPAT, error) {
	if err := ValidateDeviceRedemption(clientID, grantType, code, deviceName); err != nil {
		return MintedPAT{}, err
	}
	result := newDevicePAT(deviceName, now)
	d, err := dao.LockDeviceByHash(ctx, secret.Hash(code))
	if errors.Is(err, model.ErrNotFound) {
		return MintedPAT{}, &DeviceGrantError{Code: "invalid_grant"}
	}
	if err != nil {
		return MintedPAT{}, err
	}
	fresh, err := scoped.FreshPATTime(ctx, now)
	if err != nil {
		return MintedPAT{}, err
	}
	switch {
	case d.Status == "consumed":
		return MintedPAT{}, &DeviceGrantError{Code: "invalid_grant"}
	case !d.ExpiresAt.After(fresh):
		return MintedPAT{}, &DeviceGrantError{Code: "expired_token"}
	case d.Status == "denied":
		return MintedPAT{}, &DeviceGrantError{Code: "access_denied"}
	}
	if fresh.Before(d.NextPollAt) {
		if err := dao.DelayDevicePoll(ctx, d.ID, fresh, true); err != nil {
			return MintedPAT{}, err
		}
		return MintedPAT{}, &DeviceGrantError{Code: "slow_down"}
	}
	if d.Status == "pending" {
		if err := dao.DelayDevicePoll(ctx, d.ID, fresh, false); err != nil {
			return MintedPAT{}, err
		}
		return MintedPAT{}, &DeviceGrantError{Code: "authorization_pending"}
	}
	if d.Status != "approved" || d.UserID == nil {
		return MintedPAT{}, fmt.Errorf("invalid approved device state")
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, d.ApprovedScopes, 1)
	if err != nil {
		return MintedPAT{}, fmt.Errorf("invalid approved device scopes: %w", err)
	}
	result.Credential.UserID = *d.UserID
	result.Credential.CreatedAt = fresh.Truncate(time.Microsecond)
	result.Credential.ScopePolicy = &policy
	if err = dao.InsertPAT(ctx, result.Credential); err != nil {
		return MintedPAT{}, err
	}
	if err = dao.ConsumeDevice(ctx, d.ID); err != nil {
		return MintedPAT{}, err
	}
	return result, nil
}

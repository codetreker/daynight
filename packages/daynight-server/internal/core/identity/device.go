package identity

import (
	"context"
	"crypto/rand"
	"errors"
	"math/big"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

const DeviceClientID = "daynight-cli"
const DeviceGrantType = "urn:ietf:params:oauth:grant-type:device_code"
const DeviceLifetime = 10 * time.Minute
const deviceAlphabet = "BCDFGHJKLMNPQRSTVWXZ"

type DeviceGrantError struct{ Code string }

func (e *DeviceGrantError) Error() string { return "Device authorization failed: " + e.Code }

type DeviceStart struct {
	DeviceCode, UserCode string
	ExpiresAt            time.Time
}
type DeviceInspection struct {
	UserCode  string    `json:"userCode"`
	ExpiresAt time.Time `json:"expiresAt"`
	Status    string    `json:"status"`
}

func ValidateDeviceClient(id string) error {
	if id != DeviceClientID {
		return &DeviceGrantError{Code: "invalid_client"}
	}
	return nil
}
func ValidateDeviceBrowser(p model.Principal) error {
	if p.Kind != model.SessionCredential {
		return forbidden()
	}
	return nil
}
func (s *Identity) DeviceRate(ctx context.Context, dao store.IdentityDAO, operation, actor string, globalLimit, actorLimit int, now time.Time) error {
	allowed, err := s.TakeDeviceRate(ctx, dao, []model.DeviceRateBucket{{Hash: secret.Hash(operation), Limit: globalLimit}, {Hash: secret.Hash(operation + ":" + actor), Limit: actorLimit}}, now)
	if err != nil {
		return err
	}
	if !allowed {
		return &model.Fault{Code: "rate_limited", Message: "Too many device authorization attempts. Please wait before trying again."}
	}
	return nil
}
func (s *Identity) TakeDeviceRate(ctx context.Context, dao store.IdentityDAO, buckets []model.DeviceRateBucket, now time.Time) (bool, error) {
	if err := dao.PruneDeviceRates(ctx, now); err != nil {
		return false, err
	}
	for _, bucket := range buckets {
		attempts, err := dao.IncrementDeviceRate(ctx, bucket, now)
		if err != nil {
			return false, err
		}
		if attempts > bucket.Limit {
			return false, nil
		}
	}
	return true, nil
}
func (s *Identity) StartDevice(ctx context.Context, dao store.IdentityDAO, clientID string, now time.Time) (DeviceStart, error) {
	if err := ValidateDeviceClient(clientID); err != nil {
		return DeviceStart{}, err
	}
	var code strings.Builder
	for range 10 {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(deviceAlphabet))))
		if err != nil {
			return DeviceStart{}, err
		}
		code.WriteByte(deviceAlphabet[n.Int64()])
	}
	result := DeviceStart{DeviceCode: secret.Random(""), UserCode: code.String(), ExpiresAt: now.Add(DeviceLifetime)}
	if err := dao.PruneDevices(ctx, now); err != nil {
		return DeviceStart{}, err
	}
	if err := dao.InsertDevice(ctx, model.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: secret.Hash(result.DeviceCode), UserCode: result.UserCode, CreatedAt: now, ExpiresAt: result.ExpiresAt, NextPollAt: now.Add(5 * time.Second), PollIntervalSeconds: 5}); err != nil {
		return DeviceStart{}, err
	}
	result.UserCode = formatDeviceCode(result.UserCode)
	return result, nil
}
func formatDeviceCode(code string) string { return code[:5] + "-" + code[5:] }
func NormalizeDeviceCode(code string) (string, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	code = strings.NewReplacer("-", "", " ", "", "\t", "", "\r", "", "\n", "").Replace(code)
	if len(code) != 10 {
		return "", invalidInput("Enter the ten-letter device code shown by the CLI.")
	}
	for _, c := range code {
		if !strings.ContainsRune(deviceAlphabet, c) {
			return "", invalidInput("Enter the ten-letter device code shown by the CLI.")
		}
	}
	return code, nil
}
func deviceLookupError(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "not_found", Message: "Device authorization was not found."}
	}
	return err
}
func (s *Identity) InspectDevice(ctx context.Context, dao store.IdentityDAO, p model.Principal, code string, now time.Time) (model.DeviceAuthorization, error) {
	if err := ValidateDeviceBrowser(p); err != nil {
		return model.DeviceAuthorization{}, err
	}
	code, err := NormalizeDeviceCode(code)
	if err != nil {
		return model.DeviceAuthorization{}, err
	}
	if err = dao.LockSession(ctx, p, now); err != nil {
		return model.DeviceAuthorization{}, deviceLookupError(err)
	}
	d, err := dao.DeviceByUserCode(ctx, p.UserID, code, false)
	if err != nil {
		return model.DeviceAuthorization{}, deviceLookupError(err)
	}
	return d, nil
}
func (s *Identity) DeviceInspection(d model.DeviceAuthorization, now time.Time) DeviceInspection {
	status := d.Status
	if !d.ExpiresAt.After(now) && status != "consumed" {
		status = "expired"
	}
	return DeviceInspection{UserCode: formatDeviceCode(d.UserCode), ExpiresAt: d.ExpiresAt.UTC(), Status: status}
}
func ValidateDeviceDecision(p model.Principal, code, decision, expectedUserID string) (string, string, error) {
	if err := ValidateDeviceBrowser(p); err != nil {
		return "", "", err
	}
	code, err := NormalizeDeviceCode(code)
	if err != nil {
		return "", "", err
	}
	expected, err := model.CanonicalID(expectedUserID)
	if err != nil {
		return "", "", err
	}
	if expected != expectedUserID {
		return "", "", invalidInput("expectedUserId must be a canonical user UUID")
	}
	if expected != p.UserID {
		return "", "", &model.Fault{Code: "forbidden", Message: "The signed-in account changed. Review the device authorization again."}
	}
	status := "approved"
	switch decision {
	case "approve":
	case "deny":
		status = "denied"
	default:
		return "", "", invalidInput("decision must be approve or deny")
	}
	return code, status, nil
}
func (s *Identity) DecideDevice(ctx context.Context, dao store.IdentityDAO, p model.Principal, code, decision, expectedUserID string, now time.Time) error {
	code, status, err := ValidateDeviceDecision(p, code, decision, expectedUserID)
	if err != nil {
		return err
	}
	outcome, err := s.DecideGrant(ctx, dao, p, code, status, now)
	if err != nil {
		return deviceLookupError(err)
	}
	if outcome != "" {
		return &model.Fault{Code: "invalid_transition", Message: "This device authorization can no longer be decided. Check its current status."}
	}
	return nil
}
func (s *Identity) DecideGrant(ctx context.Context, dao store.IdentityDAO, p model.Principal, code, status string, now time.Time) (string, error) {
	if err := dao.LockSession(ctx, p, now); err != nil {
		return "", err
	}
	d, err := dao.DeviceByUserCode(ctx, p.UserID, code, true)
	if err != nil {
		return "", err
	}
	if !d.ExpiresAt.After(now) {
		return "expired", nil
	}
	if d.Status != "pending" {
		return d.Status, nil
	}
	return "", dao.SetDeviceDecision(ctx, d.ID, status, p.UserID)
}
func ValidateDeviceRedemption(clientID, grantType, code, deviceName string) error {
	if err := ValidateDeviceClient(clientID); err != nil {
		return err
	}
	if grantType != DeviceGrantType {
		return &DeviceGrantError{Code: "unsupported_grant_type"}
	}
	if !utf8.ValidString(deviceName) || strings.TrimSpace(deviceName) == "" || utf8.RuneCountInString(deviceName) > 255 || strings.ContainsFunc(deviceName, unicode.IsControl) {
		return &DeviceGrantError{Code: "invalid_request"}
	}
	if !secret.Valid(code, "") {
		return &DeviceGrantError{Code: "invalid_grant"}
	}
	return nil
}
func (s *Identity) RedeemDevice(ctx context.Context, dao store.IdentityDAO, clientID, grantType, code, deviceName string, now time.Time) (MintedPAT, error) {
	if err := ValidateDeviceRedemption(clientID, grantType, code, deviceName); err != nil {
		return MintedPAT{}, err
	}
	now = now.Truncate(time.Microsecond)
	result := MintedPAT{Secret: secret.Random("dnpat_")}
	name := []rune(deviceName)
	result.Credential = model.PersonalAccessToken{ID: uuid.NewString(), Name: "Daynight CLI (" + string(name[:min(len(name), 85)]) + ")", TokenHash: secret.Hash(result.Secret), CreatedAt: now}
	outcome, err := s.RedeemGrant(ctx, dao, secret.Hash(code), result.Credential)
	if err != nil {
		return MintedPAT{}, err
	}
	if outcome != "" {
		return MintedPAT{}, &DeviceGrantError{Code: outcome}
	}
	return result, nil
}
func (s *Identity) RedeemGrant(ctx context.Context, dao store.IdentityDAO, hash []byte, credential model.PersonalAccessToken) (string, error) {
	d, err := dao.LockDeviceByHash(ctx, hash)
	if errors.Is(err, model.ErrNotFound) {
		return "invalid_grant", nil
	}
	if err != nil {
		return "", err
	}
	switch {
	case d.Status == "consumed":
		return "invalid_grant", nil
	case !d.ExpiresAt.After(credential.CreatedAt):
		return "expired_token", nil
	case d.Status == "denied":
		return "access_denied", nil
	}
	if credential.CreatedAt.Before(d.NextPollAt) {
		if err := dao.DelayDevicePoll(ctx, d.ID, credential.CreatedAt, true); err != nil {
			return "", err
		}
		return "slow_down", nil
	}
	if d.Status == "pending" {
		if err := dao.DelayDevicePoll(ctx, d.ID, credential.CreatedAt, false); err != nil {
			return "", err
		}
		return "authorization_pending", nil
	}
	credential.UserID = *d.UserID
	if err := dao.InsertPAT(ctx, credential); err != nil {
		return "", err
	}
	if err := dao.ConsumeDevice(ctx, d.ID); err != nil {
		return "", err
	}
	return "", nil
}
func ValidateDeviceLogout(p model.Principal) error {
	if p.Kind != model.PATCredential {
		return &model.Fault{Code: "forbidden", Message: "A CLI Bearer credential is required for this operation."}
	}
	return nil
}
func (s *Identity) LogoutDevice(ctx context.Context, dao store.IdentityDAO, p model.Principal) error {
	if err := ValidateDeviceLogout(p); err != nil {
		return err
	}
	return dao.DeletePAT(ctx, p.UserID, p.CredentialID)
}

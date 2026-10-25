package service

import (
	"context"
	"crypto/rand"
	"errors"
	"math/big"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

const DeviceClientID = "daynight-cli"
const DeviceGrantType = "urn:ietf:params:oauth:grant-type:device_code"
const DeviceLifetime = 10 * time.Minute
const DeviceTokenLifetime = 30 * 24 * time.Hour
const deviceAlphabet = "BCDFGHJKLMNPQRSTVWXZ"

type DeviceGrantError struct{ Code string }

func (e *DeviceGrantError) Error() string { return "Device authorization failed: " + e.Code }

type DeviceStart struct {
	DeviceCode string
	UserCode   string
	ExpiresAt  time.Time
}
type DeviceInspection struct {
	UserCode  string    `json:"userCode"`
	ExpiresAt time.Time `json:"expiresAt"`
	Status    string    `json:"status"`
}

func deviceRateFault() error {
	return &Fault{Code: "rate_limited", Message: "Too many device authorization attempts. Please wait before trying again."}
}
func (s *Identity) deviceRate(ctx context.Context, operation, actor string, globalLimit, actorLimit int) error {
	allowed, err := s.store.TakeDeviceRate(ctx, []core.DeviceRateBucket{{Hash: secretHash(operation), Limit: globalLimit}, {Hash: secretHash(operation + ":" + actor), Limit: actorLimit}}, s.now().UTC())
	if err != nil {
		return err
	}
	if !allowed {
		return deviceRateFault()
	}
	return nil
}

func (s *Identity) StartDevice(ctx context.Context, clientID, source string) (DeviceStart, error) {
	if clientID != DeviceClientID {
		return DeviceStart{}, &DeviceGrantError{Code: "invalid_client"}
	}
	if err := s.deviceRate(ctx, "device-create", source, 120, 30); err != nil {
		return DeviceStart{}, err
	}
	now := s.now().UTC()
	for range 3 {
		var code strings.Builder
		for range 10 {
			n, err := rand.Int(rand.Reader, big.NewInt(int64(len(deviceAlphabet))))
			if err != nil {
				return DeviceStart{}, err
			}
			code.WriteByte(deviceAlphabet[n.Int64()])
		}
		result := DeviceStart{DeviceCode: randomSecret(""), UserCode: code.String(), ExpiresAt: now.Add(DeviceLifetime)}
		err := s.store.CreateDeviceAuthorization(ctx, core.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: secretHash(result.DeviceCode), UserCode: result.UserCode, CreatedAt: now, ExpiresAt: result.ExpiresAt, NextPollAt: now.Add(5 * time.Second), PollIntervalSeconds: 5})
		var conflict *pgconn.PgError
		if errors.As(err, &conflict) && conflict.Code == "23505" {
			continue
		}
		if err != nil {
			return DeviceStart{}, err
		}
		result.UserCode = formatDeviceCode(result.UserCode)
		return result, nil
	}
	return DeviceStart{}, errors.New("device authorization code generation exhausted collision attempts")
}

func formatDeviceCode(code string) string { return code[:5] + "-" + code[5:] }
func normalizeDeviceCode(code string) (string, error) {
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

func (s *Identity) deviceBrowser(ctx context.Context, p core.Principal, code string) (string, error) {
	if p.Kind != core.SessionCredential {
		return "", forbidden()
	}
	if err := s.deviceRate(ctx, "device-lookup", p.UserID, 120, 12); err != nil {
		return "", err
	}
	return normalizeDeviceCode(code)
}

func deviceLookupError(err error) error {
	if errors.Is(err, core.ErrNotFound) {
		return &Fault{Code: "not_found", Message: "Device authorization was not found."}
	}
	return err
}

func (s *Identity) InspectDevice(ctx context.Context, p core.Principal, code string) (DeviceInspection, error) {
	code, err := s.deviceBrowser(ctx, p, code)
	if err != nil {
		return DeviceInspection{}, err
	}
	d, err := s.store.InspectDeviceAuthorization(ctx, p, code, s.now().UTC())
	if err != nil {
		return DeviceInspection{}, deviceLookupError(err)
	}
	status := d.Status
	if !d.ExpiresAt.After(s.now().UTC()) && status != "consumed" {
		status = "expired"
	}
	return DeviceInspection{UserCode: formatDeviceCode(d.UserCode), ExpiresAt: d.ExpiresAt.UTC(), Status: status}, nil
}

func (s *Identity) DecideDevice(ctx context.Context, p core.Principal, code, decision, expectedUserID string) error {
	code, err := s.deviceBrowser(ctx, p, code)
	if err != nil {
		return err
	}
	expected, err := CanonicalID(expectedUserID)
	if err != nil {
		return err
	}
	if expected != expectedUserID {
		return invalidInput("expectedUserId must be a canonical user UUID")
	}
	if expected != p.UserID {
		return &Fault{Code: "forbidden", Message: "The signed-in account changed. Review the device authorization again."}
	}
	status := "approved"
	switch decision {
	case "approve":
	case "deny":
		status = "denied"
	default:
		return invalidInput("decision must be approve or deny")
	}
	outcome, err := s.store.DecideDeviceAuthorization(ctx, p, code, status, s.now().UTC())
	if err != nil {
		return deviceLookupError(err)
	}
	if outcome != "" {
		return &Fault{Code: "invalid_transition", Message: "This device authorization can no longer be decided. Check its current status."}
	}
	return nil
}

func (s *Identity) RedeemDevice(ctx context.Context, clientID, grantType, code string) (MintedPAT, error) {
	if clientID != DeviceClientID {
		return MintedPAT{}, &DeviceGrantError{Code: "invalid_client"}
	}
	if grantType != DeviceGrantType {
		return MintedPAT{}, &DeviceGrantError{Code: "unsupported_grant_type"}
	}
	if !validSecret(code, "") {
		return MintedPAT{}, &DeviceGrantError{Code: "invalid_grant"}
	}
	now := s.now().UTC()
	result := MintedPAT{Secret: randomSecret("dnpat_")}
	result.Credential = core.Credential{ID: uuid.NewString(), Kind: core.PATCredential, Name: "Daynight CLI", TokenHash: secretHash(result.Secret), CreatedAt: now, ExpiresAt: now.Add(DeviceTokenLifetime)}
	outcome, err := s.store.RedeemDeviceAuthorization(ctx, secretHash(code), result.Credential)
	if err != nil {
		return MintedPAT{}, err
	}
	if outcome != "" {
		return MintedPAT{}, &DeviceGrantError{Code: outcome}
	}
	return result, nil
}

func (s *Identity) LogoutDevice(ctx context.Context, p core.Principal) error {
	if p.Kind != core.PATCredential {
		return &Fault{Code: "forbidden", Message: "A CLI Bearer credential is required for this operation."}
	}
	return s.store.DeleteCurrentPAT(ctx, p)
}

package remote

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// InstallationStatus identifies an installation and whether GitHub has suspended it.
type InstallationStatus struct {
	ID        int64
	Suspended bool
}

// Installation reads the configured App's installation using App authentication.
// A 404 identifies a missing installation; other failures retain their classification.
func (c *Client) Installation(ctx context.Context, installationID int64) (InstallationStatus, error) {
	if installationID <= 0 {
		return InstallationStatus{}, errors.New("invalid installation ID")
	}
	resp, err := c.appGet(ctx, c.endpoint(fmt.Sprintf("/app/installations/%d", installationID)))
	if err != nil {
		return InstallationStatus{}, err
	}
	if resp.StatusCode != http.StatusOK {
		err = responseError(resp)
		resp.Body.Close()
		if e, ok := err.(*Error); ok && resp.StatusCode == http.StatusNotFound {
			e.Code = "installation_missing"
		}
		return InstallationStatus{}, err
	}
	var raw json.RawMessage
	if err = readJSON(resp, &raw); err != nil {
		return InstallationStatus{}, err
	}
	var fields map[string]json.RawMessage
	var dto struct {
		ID          *int64          `json:"id"`
		SuspendedAt json.RawMessage `json:"suspended_at"`
	}
	if decodeObservation(raw, &dto) != nil || json.Unmarshal(raw, &fields) != nil || dto.ID == nil || *dto.ID != installationID || fields["suspended_at"] == nil {
		return InstallationStatus{}, errInvalidObservation
	}
	var suspendedAt *time.Time
	if json.Unmarshal(dto.SuspendedAt, &suspendedAt) != nil || (suspendedAt != nil && suspendedAt.IsZero()) {
		return InstallationStatus{}, errInvalidObservation
	}
	return InstallationStatus{ID: *dto.ID, Suspended: suspendedAt != nil}, nil
}

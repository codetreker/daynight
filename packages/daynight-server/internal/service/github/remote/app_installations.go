package remote

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

// ErrInstallationScanIncomplete means an installation could not be inspected;
// it is distinct from a complete scan that found no matching repository.
var ErrInstallationScanIncomplete = errors.New("github installation scan incomplete")

// FindInstallationByRepository searches the configured App's installations by
// stable repository ID. Incomplete scans return an error rather than absence.
func (c *Client) FindInstallationByRepository(ctx context.Context, repositoryID int64) (githubpr.InstallationObservation, error) {
	if repositoryID <= 0 {
		return githubpr.InstallationObservation{}, errors.New("invalid repository ID")
	}
	target := c.endpoint("/app/installations")
	target.RawQuery = "per_page=100"
	seenPages := map[string]bool{}
	seenInstallations := map[int64]bool{}
	var incomplete error
	for target != nil {
		if seenPages[target.String()] {
			return githubpr.InstallationObservation{}, errors.New("github pagination cycle")
		}
		seenPages[target.String()] = true
		resp, err := c.appGet(ctx, target)
		if err != nil {
			return githubpr.InstallationObservation{}, err
		}
		if resp.StatusCode != http.StatusOK {
			err = responseError(resp)
			resp.Body.Close()
			return githubpr.InstallationObservation{}, err
		}
		next, err := c.next(resp)
		if err != nil {
			resp.Body.Close()
			return githubpr.InstallationObservation{}, err
		}
		var page []json.RawMessage
		if err := readJSON(resp, &page); err != nil {
			return githubpr.InstallationObservation{}, err
		}
		if page == nil {
			return githubpr.InstallationObservation{}, errors.New("invalid github installation page")
		}
		for _, raw := range page {
			installation, err := decodeInstallation(raw)
			if err != nil {
				return githubpr.InstallationObservation{}, err
			}
			if seenInstallations[installation.ID] {
				continue
			}
			seenInstallations[installation.ID] = true
			_, err = c.ResolveRepository(ctx, installation.ID, repositoryID)
			if err == nil {
				return installation, nil
			}
			if !errors.Is(err, errRepositoryAbsent) {
				var upstream *Error
				if errors.As(err, &upstream) && (upstream.Code == "not_found" || upstream.Code == "permission_denied" || upstream.Code == "unauthorized" || upstream.Code == "installation_missing") {
					incomplete = errors.Join(incomplete, ErrInstallationScanIncomplete, err)
					continue
				}
				return githubpr.InstallationObservation{}, err
			}
		}
		target = next
	}
	if incomplete != nil {
		return githubpr.InstallationObservation{}, incomplete
	}
	return githubpr.InstallationObservation{}, &Error{Code: "not_found", Status: http.StatusNotFound}
}

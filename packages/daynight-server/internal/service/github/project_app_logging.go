package github

import (
	"context"
	"fmt"
	"log/slog"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

type projectAppObservation struct {
	facts    *store.GitHubProjectAppFacts
	app      *store.GitHubProjectApp
	grantID  string
	proposed *store.GitHubProjectAppWrite
}

// Observe the operations already required by the core. Additional reads could
// change failure behavior or observe a different authorization snapshot.
type observedProjectAppDAO struct {
	store.GitHubProjectAppWriteDAO
	observation *projectAppObservation
}

func (d *observedProjectAppDAO) ProjectAppAccess(ctx context.Context, p model.Principal) (store.GitHubProjectAppAccess, error) {
	reader, ok := d.GitHubProjectAppWriteDAO.(store.GitHubProjectAppAdmissionReader)
	if !ok {
		return store.GitHubProjectAppAccess{}, fmt.Errorf("project App admission capability unavailable")
	}
	return reader.ProjectAppAccess(ctx, p)
}
func (d *observedProjectAppDAO) ProjectAppVersion(ctx context.Context, app, grant, team string) (int64, error) {
	reader, ok := d.GitHubProjectAppWriteDAO.(store.GitHubProjectAppAdmissionReader)
	if !ok {
		return 0, fmt.Errorf("project App admission capability unavailable")
	}
	return reader.ProjectAppVersion(ctx, app, grant, team)
}

func (d *observedProjectAppDAO) Facts(ctx context.Context, p model.Principal) (store.GitHubProjectAppFacts, error) {
	f, err := d.GitHubProjectAppWriteDAO.Facts(ctx, p)
	if err == nil && d.observation.facts == nil {
		d.observation.facts = &f
	}
	return f, err
}

func (d *observedProjectAppDAO) App(ctx context.Context, app, grant, team string) (store.GitHubProjectApp, error) {
	a, err := d.GitHubProjectAppWriteDAO.App(ctx, app, grant, team)
	if err == nil {
		d.observation.app = &a
		d.observation.grantID = grant
	}
	return a, err
}

func (d *observedProjectAppDAO) Save(ctx context.Context, w store.GitHubProjectAppWrite) (bool, error) {
	ok, err := d.GitHubProjectAppWriteDAO.Save(ctx, w)
	if ok && err == nil {
		d.observation.proposed = &w
	}
	return ok, err
}

func (m *ProjectAppManager) logProjectAppWrite(ctx context.Context, p model.Principal, id, action string, c store.Completion, err error, observed *projectAppObservation, out core.ProjectAppStatus, callbackSucceeded bool) {
	attrs := []any{"type", "github_project_app_transaction", "component", "github", "phase", action, "request_id", requestid.From(ctx), "user_id", p.UserID, "project_id", id, "write_outcome", string(c.Outcome)}
	if f := observed.facts; f != nil {
		attrs = append(attrs, "team_id", f.Project.Ownership.TeamID, "ownership_version", f.Project.Ownership.Version, "observed_version", f.Connection.Version, "observed_generation", f.Connection.Generation)
		if f.AppResourceID != nil {
			attrs = append(attrs, "app_resource_id", *f.AppResourceID)
		}
		if f.GrantID != nil {
			attrs = append(attrs, "grant_id", *f.GrantID)
		}
		if f.CredentialVersion != nil {
			attrs = append(attrs, "credential_version", *f.CredentialVersion)
		}
		if f.Connection.AppID != nil {
			attrs = append(attrs, "app_id", *f.Connection.AppID)
		}
	}
	// Selected App metadata supersedes the prior binding for connect. A disconnect
	// retains its observed binding because its resulting resource has none.
	if a := observed.app; a != nil {
		attrs = replaceProjectAppAttribute(attrs, "app_resource_id", a.ID)
		attrs = replaceProjectAppAttribute(attrs, "grant_id", observed.grantID)
		attrs = replaceProjectAppAttribute(attrs, "credential_version", a.CredentialVersion)
		attrs = replaceProjectAppAttribute(attrs, "app_id", a.GitHubAppID)
		attrs = append(attrs, "app_version", a.Version)
	}
	if c.Outcome == store.TransactionCommitted && callbackSucceeded {
		attrs = append(attrs, "version", out.Connection.Version, "generation", out.Connection.Generation)
	} else if w := observed.proposed; w != nil {
		attrs = append(attrs, "proposed_version", w.Configuration.Version, "proposed_generation", w.Configuration.Generation)
	}
	level := slog.LevelInfo
	if err != nil {
		level = slog.LevelWarn
		diagnostics := appErrorAttributes(err)
		for i := 0; i < len(diagnostics); i += 2 {
			// Completion is authoritative even when an error chain has other facts.
			if diagnostics[i] != "write_outcome" {
				attrs = append(attrs, diagnostics[i], diagnostics[i+1])
			}
		}
		if f, ok := operation.KnownFault(err); ok {
			attrs = replaceProjectAppAttribute(attrs, "result_code", f.Code)
		}
	}
	m.logger.Log(ctx, level, "github project App transaction completed", attrs...)
}

func replaceProjectAppAttribute(attrs []any, key string, value any) []any {
	for i := 0; i < len(attrs); i += 2 {
		if attrs[i] == key {
			attrs[i+1] = value
			return attrs
		}
	}
	return append(attrs, key, value)
}

package github

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

type UpdateAppInput struct {
	Version                            int64
	ExpectedUserID                     string
	Name, PrivateKeyPEM, WebhookSecret *string
}

type RemoveAppInput struct {
	Version, ImpactVersion int64
	ExpectedUserID         string
}

// AppUpdateProof binds a remote credential proof to the observed membership and configuration.
type AppUpdateProof struct {
	MembershipVersion, Version, GitHubAppID int64
	GitHubName, GitHubSlug                  string
}

func ValidateUpdateApp(p model.Principal, id string, in UpdateAppInput) error {
	if err := team.RequireActor(p, in.ExpectedUserID); err != nil {
		return err
	}
	if err := grantID(id); err != nil {
		return err
	}
	if in.Version < 1 {
		return invalid("Version must be positive.")
	}
	if in.Name == nil && in.PrivateKeyPEM == nil && in.WebhookSecret == nil {
		return invalid("At least one configuration field is required.")
	}
	if in.Name != nil && (!utf8.ValidString(*in.Name) || strings.ContainsRune(*in.Name, 0) || strings.TrimSpace(*in.Name) == "" || len(*in.Name) > 1024 || utf8.RuneCountInString(*in.Name) > 256) {
		return invalid("App name must be nonempty Unicode text of at most 256 characters and 1024 bytes without NUL.")
	}
	if in.PrivateKeyPEM != nil && (!utf8.ValidString(*in.PrivateKeyPEM) || len(*in.PrivateKeyPEM) == 0 || len(*in.PrivateKeyPEM) > 65536) {
		return invalid("Private key PEM must be nonempty UTF-8 of at most 65536 bytes.")
	}
	if in.WebhookSecret != nil && (!utf8.ValidString(*in.WebhookSecret) || len(*in.WebhookSecret) == 0 || len(*in.WebhookSecret) > 4096) {
		return invalid("Webhook secret must be nonempty UTF-8 of at most 4096 bytes.")
	}
	return nil
}

func ValidateRemoveApp(p model.Principal, id string, in RemoveAppInput) error {
	if err := team.RequireActor(p, in.ExpectedUserID); err != nil {
		return err
	}
	if err := grantID(id); err != nil {
		return err
	}
	if in.Version < 1 || in.ImpactVersion < 1 {
		return invalid("Versions must be positive.")
	}
	return nil
}

// ProposedAppCredentials preserves omitted secrets and reports actual changes.
func ProposedAppCredentials(f store.GitHubAppConfigFacts, in UpdateAppInput) (githubpr.AppCredentials, bool) {
	c := githubpr.AppCredentials{PrivateKeyPEM: f.Credentials.PrivateKeyPEM, WebhookSecret: f.Credentials.WebhookSecret}
	if in.PrivateKeyPEM != nil {
		c.PrivateKeyPEM = []byte(*in.PrivateKeyPEM)
	}
	if in.WebhookSecret != nil {
		c.WebhookSecret = []byte(*in.WebhookSecret)
	}
	return c, !bytes.Equal(c.PrivateKeyPEM, f.Credentials.PrivateKeyPEM) || !bytes.Equal(c.WebhookSecret, f.Credentials.WebhookSecret)
}

func appConfigFacts(ctx context.Context, dao store.GitHubAppConfigReader, actor string, version int64, proof *AppUpdateProof) (store.GitHubAppConfigFacts, error) {
	f, err := dao.Facts(ctx, actor)
	if errors.Is(err, model.ErrNotFound) {
		if proof != nil {
			return f, &model.Fault{Code: "github_admin_changed", Message: "App administrator changed.", Cause: err}
		}
		return f, &model.Fault{Code: "not_found", Message: "App was not found.", Cause: err}
	}
	if err != nil {
		return f, err
	}
	if proof != nil && f.MembershipVersion != proof.MembershipVersion {
		return f, &model.Fault{Code: "github_admin_changed", Message: "App administrator changed."}
	}
	if f.App.Version != version {
		return f, &model.Fault{Code: "version_conflict", Message: "App version changed."}
	}
	return f, nil
}

// admitAppConfig checks access and versions without reading credential material.
func admitAppConfig(ctx context.Context, dao store.GitHubAppConfigReader, actor string, version int64, proof *AppUpdateProof, impact *int64, admit func() error) error {
	if admit == nil {
		return nil
	}
	reader, ok := dao.(store.GitHubAppConfigAccessReader)
	if !ok {
		return fmt.Errorf("GitHub App configuration access capability unavailable")
	}
	access, err := reader.ConfigAccess(ctx, actor)
	if errors.Is(err, model.ErrNotFound) {
		if proof != nil {
			return &model.Fault{Code: "github_admin_changed", Message: "App administrator changed.", Cause: err}
		}
		return &model.Fault{Code: "not_found", Message: "App was not found.", Cause: err}
	}
	if err != nil {
		return err
	}
	if proof != nil && access.MembershipVersion != proof.MembershipVersion {
		return &model.Fault{Code: "github_admin_changed", Message: "App administrator changed."}
	}
	if access.AppVersion != version {
		return &model.Fault{Code: "version_conflict", Message: "App version changed."}
	}
	if impact != nil && access.ImpactVersion != *impact {
		return &model.Fault{Code: "impact_changed", Message: "App impact changed."}
	}
	return admit()
}

// ReadAppConfigForUpdate checks current authority and version before any secret comparison or remote proof.
func ReadAppConfigForUpdate(ctx context.Context, dao store.GitHubAppConfigReader, p model.Principal, in UpdateAppInput) (store.GitHubAppConfigFacts, error) {
	return ReadAppConfigForUpdateWithAdmission(ctx, dao, p, in, nil)
}

func ReadAppConfigForUpdateWithAdmission(ctx context.Context, dao store.GitHubAppConfigReader, p model.Principal, in UpdateAppInput, admit func() error) (store.GitHubAppConfigFacts, error) {
	if err := team.RequireActor(p, in.ExpectedUserID); err != nil {
		return store.GitHubAppConfigFacts{}, err
	}
	if err := admitAppConfig(ctx, dao, p.UserID, in.Version, nil, nil, admit); err != nil {
		return store.GitHubAppConfigFacts{}, err
	}
	return appConfigFacts(ctx, dao, p.UserID, in.Version, nil)
}

func UpdateApp(ctx context.Context, dao store.GitHubAppConfigWriter, p model.Principal, in UpdateAppInput, proof *AppUpdateProof) (AppMetadata, error) {
	return UpdateAppWithAdmission(ctx, dao, p, in, proof, nil)
}

func UpdateAppWithAdmission(ctx context.Context, dao store.GitHubAppConfigWriter, p model.Principal, in UpdateAppInput, proof *AppUpdateProof, admit func() error) (AppMetadata, error) {
	if err := team.RequireActor(p, in.ExpectedUserID); err != nil {
		return AppMetadata{}, err
	}
	if err := admitAppConfig(ctx, dao, p.UserID, in.Version, proof, nil, admit); err != nil {
		return AppMetadata{}, err
	}
	f, err := appConfigFacts(ctx, dao, p.UserID, in.Version, proof)
	if err != nil {
		return AppMetadata{}, err
	}
	c, credentialsChanged := ProposedAppCredentials(f, in)
	name := f.App.Name
	if in.Name != nil {
		name = *in.Name
	}
	if !credentialsChanged && name == f.App.Name {
		return f.App, nil
	}
	if f.App.Version == math.MaxInt64 || (credentialsChanged && f.CredentialVersion == math.MaxInt64) {
		return AppMetadata{}, &model.Fault{Code: "version_exhausted", Message: "App version is exhausted."}
	}
	githubName, githubSlug := f.App.GitHubName, f.App.GitHubSlug
	credentialVersion := f.CredentialVersion
	if credentialsChanged {
		if proof == nil || proof.Version != f.App.Version || proof.GitHubAppID != f.App.GitHubAppID {
			return AppMetadata{}, &model.Fault{Code: "github_admin_changed", Message: "App credential proof is no longer current."}
		}
		credentialVersion++
		githubName, githubSlug = proof.GitHubName, proof.GitHubSlug
	}
	out, err := dao.Update(ctx, store.GitHubAppConfigUpdate{Name: name, GitHubName: githubName, GitHubSlug: githubSlug, Version: f.App.Version + 1, CredentialVersion: credentialVersion, Credentials: c})
	if err != nil {
		return AppMetadata{}, err
	}
	if credentialsChanged {
		if err = dao.FenceConnections(ctx, store.GitHubAppCredentialFence{CredentialVersion: credentialVersion, AccessState: "unknown", ScheduleSyncAccess: true}); err != nil {
			return AppMetadata{}, err
		}
	}
	return out, nil
}

func RemoveApp(ctx context.Context, dao store.GitHubAppConfigWriter, p model.Principal, in RemoveAppInput) error {
	return RemoveAppWithAdmission(ctx, dao, p, in, nil)
}

func RemoveAppWithAdmission(ctx context.Context, dao store.GitHubAppConfigWriter, p model.Principal, in RemoveAppInput, admit func() error) error {
	if err := team.RequireActor(p, in.ExpectedUserID); err != nil {
		return err
	}
	if err := admitAppConfig(ctx, dao, p.UserID, in.Version, nil, &in.ImpactVersion, admit); err != nil {
		return err
	}
	f, err := appConfigFacts(ctx, dao, p.UserID, in.Version, nil)
	if err != nil {
		return err
	}
	if f.ImpactVersion != in.ImpactVersion {
		return &model.Fault{Code: "impact_changed", Message: "App impact changed."}
	}
	impact := f.ImpactVersion
	if f.HasImpact {
		if impact == math.MaxInt64 {
			return &model.Fault{Code: "version_exhausted", Message: "App impact version is exhausted."}
		}
		impact++
	}
	if err = dao.RemoveRelations(ctx); err != nil {
		return err
	}
	if err = dao.StopAppConnections(ctx, DisconnectionDecision()); err != nil {
		return err
	}
	return dao.Tombstone(ctx, impact)
}
